/**
 * The component gallery: every surface the app can put in front of a person, with nothing behind it.
 *
 * The Debug view asks "does a workflow run"; this asks the question a run cannot answer cheaply —
 * *what does the thing it parks at actually look like, and what does an answer to it return?* A UI
 * state's entire visible behaviour comes from a config an author writes inside a state file, and
 * reaching one otherwise costs a workflow, a provider, a task and a run.
 *
 * ## A row per surface, a carousel of its variations, and one bar that moves every row
 *
 * A component's config is a small language, and one sample of it shows one sentence. So the gallery
 * is a row per surface — a heading saying what it is for — holding a carousel with one slide per
 * variation the config can express: `comments` on, `custom` on, several questions, each with a note
 * saying what it turns on that `basic` did not. A carousel rather than a column, because a row is
 * ONE thing seen several ways, and the way to compare two variations of it is to flip between them
 * in place rather than to scroll past the other seven.
 *
 * The bar at the top slides every row to the same variant at once. It works because the variant
 * ids are one shared vocabulary (`GALLERY_VARIANT_ORDER`): `comments` on a chooser and `comments`
 * on a review are the same knob seen from two components, and putting the two side by side — every
 * row showing its `comments` — is how that gets checked.
 *
 * ## It is the real dialog, not a picture of one
 *
 * Each card parses its config with `parseComponentConfig` — the same call main makes on a live gate
 * — and hands the result to `InteractionDialog`, the same component the real gate renders. A
 * malformed config therefore produces the authoring error you would see in a run, an unknown
 * function falls through to the same JSON box, and a submitted answer is checked with
 * `validateComponentResult`, which is what main runs before an answer may enter the engine. The only
 * thing missing is the engine.
 *
 * ## Two ways to edit the config, one document
 *
 * The form and the JSON editor are views of the SAME text, so switching never loses anything: the
 * form writes the document, the editor validates it against the same schema the form was generated
 * from, and a field the form cannot express (an object with no declared properties) is still there
 * to be typed. That is the same bargain the config pane strikes with its raw-document escape hatch,
 * and for the same reason — a form that is the only way in is a form that decides what you may say.
 *
 * ## Why the surfaces render inline
 *
 * Every component is a render function, and where it goes is the caller's choice: the gallery is a
 * caller and it chooses a row. A question and an approval render as the same `QuestionSurface` and
 * `ApprovalSurface` the conversation hosts, with no modal to neutralise; the one dialog still modal
 * by construction (`.modal-backdrop` is fixed and covers the window) has its positioning
 * neutralised in CSS by the stage, so nothing about it changes.
 */
import { useRef, useState, type JSX } from "react";
import {
  GALLERY_GROUPS,
  GALLERY_VARIANT_ORDER,
  isComponentName,
  parseComponentConfig,
  schemaById,
  surfacesOfGroups,
  validateComponentResult,
  type ComponentConfig,
  type GalleryGroup,
  type GallerySurface,
  type PendingApproval,
  type PendingInteraction,
  type PendingQuestion,
  type ValidateSchemaResult,
} from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { ApprovalSurface, InteractionDialog, QuestionSurface } from "./components";
import { SchemaJsonEditor } from "./schemaEditor";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { Schema } from "./schemaForm/types";

/**
 * The project every fixture claims to belong to.
 *
 * A pending request carries the project whose database holds its task, and nothing here has either.
 * A visible placeholder is better than a plausible path: it appears in the dialog's subtitle, where
 * "gallery" reads as what it is and a real-looking project id would not.
 */
const GALLERY_PROJECT = "gallery";

/** What a card is currently showing its config as. */
type Editor = "form" | "json";

interface CardState {
  /** The document as text — the single source both editors write. */
  text: string;
  editor: Editor;
  /** The last answer the surface produced, and what the contract said about it. */
  result?: { value: unknown; check?: { ok: boolean; errors?: string } };
}

const initialState = (surface: GallerySurface): CardState => ({
  text: JSON.stringify(surface.sample, null, 2),
  editor: "form",
});

/** The document, parsed — or the parse error, which is itself worth showing. */
function parsedDoc(text: string): { doc?: Record<string, unknown>; error?: string } {
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { error: "the document must be a JSON object" };
    }
    return { doc: value as Record<string, unknown> };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** A string field of a parsed document, when it is one. */
const stringAt = (doc: Record<string, unknown>, key: string): string | undefined =>
  typeof doc[key] === "string" ? (doc[key] as string) : undefined;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export interface ComponentGalleryProps {
  /** The schema check, over IPC — the store's, the same one every JSON editor in the app uses. */
  validateSchema: (schemaId: string, text: string) => Promise<ValidateSchemaResult | null>;
  /**
   * What to show. Defaults to everything, which is what the Components view wants.
   *
   * A parameter rather than a constant because the gallery is a list of groups, and a caller that
   * wants only some of them should not have to reimplement the card to get them.
   */
  groups?: readonly GalleryGroup[];
}

/** The element id a row carries, so a link can land on it. */
function groupAnchor(groupId: string): string {
  return `gallery-${groupId}`;
}

/**
 * The variant ids these groups use, in the shared vocabulary's order, with how many rows have each.
 *
 * Derived rather than taken from the constant as-is: a caller showing three groups should get a
 * bar for those three, and an id the vocabulary does not know is appended rather than dropped — a
 * fixture nobody can reach is worse than one out of order.
 */
function variantsAcross(groups: readonly GalleryGroup[]): { id: string; rows: number }[] {
  const counts = new Map<string, number>();
  for (const group of groups) for (const v of group.variants) counts.set(v.id, (counts.get(v.id) ?? 0) + 1);
  const ordered = [...GALLERY_VARIANT_ORDER.filter((id) => counts.has(id)), ...[...counts.keys()].filter((id) => !GALLERY_VARIANT_ORDER.includes(id))];
  return ordered.map((id) => ({ id, rows: counts.get(id)! }));
}

/**
 * Which slide a track is showing: its scroll offset in slide widths, rounded.
 *
 * Read off the SCROLL rather than held as state, so the highlighted tab follows a finger on the
 * track as faithfully as it follows a click on the tab — one source of truth for "where is this
 * row", whichever way it got there.
 */
function slideOf(track: HTMLDivElement): number {
  return track.clientWidth === 0 ? 0 : Math.round(track.scrollLeft / track.clientWidth);
}

export function ComponentGallery({ validateSchema, groups = GALLERY_GROUPS }: ComponentGalleryProps): JSX.Element {
  // The same flattening the tests walk, so a card and a check are about the same fixture.
  const surfaces = surfacesOfGroups(groups);
  const [cards, setCards] = useState<Record<string, CardState>>(() =>
    Object.fromEntries(surfaces.map((s) => [s.id, initialState(s)])),
  );
  const patch = (id: string, next: Partial<CardState>): void =>
    setCards((held) => {
      // Seeded from the surface rather than assumed present: the list is a prop, so a card can
      // arrive after the state was built.
      const seed = held[id] ?? initialState(surfaces.find((s) => s.id === id)!);
      return { ...held, [id]: { ...seed, ...next } };
    });

  /**
   * One row per group, one slide per variant. Which slide a row shows is the track's own scroll
   * position (see `slideOf`); `showing` is a mirror of it, kept so the tabs and the counter can
   * draw without reading the DOM during render.
   */
  const tracks = useRef<Record<string, HTMLDivElement | null>>({});
  const [showing, setShowing] = useState<Record<string, number>>({});
  const slideTo = (group: GalleryGroup, index: number): void => {
    const track = tracks.current[group.id];
    if (track === null || track === undefined) return;
    const at = Math.max(0, Math.min(index, group.variants.length - 1));
    track.scrollTo({ left: at * track.clientWidth, behavior: "smooth" });
  };
  // The bar's whole point: every row that HAS this variant goes to it, and a row that does not
  // stays where it was rather than being sent somewhere that is not what was asked for.
  const slideAllTo = (variantId: string): void => {
    for (const group of groups) {
      const at = group.variants.findIndex((v) => v.id === variantId);
      if (at >= 0) slideTo(group, at);
    }
  };
  const across = variantsAcross(groups);

  return (
    <div className="gallery">
      <div className="gallery-common" role="toolbar" aria-label="Show every row's variant">
        <span className="sub">Every row to</span>
        {across.map(({ id, rows }) => (
          <button
            key={id}
            type="button"
            className="chip gallery-common-btn"
            title={`slide the ${rows === 1 ? "one row" : `${rows} rows`} that ${rows === 1 ? "has" : "have"} a "${id}" variant to it`}
            onClick={() => slideAllTo(id)}
          >
            <span className="mono">{id}</span>
            <span className="gallery-jump-n">{rows}</span>
          </button>
        ))}
      </div>

      {groups.map((group) => {
        const at = Math.min(showing[group.id] ?? 0, group.variants.length - 1);
        return (
          <section key={group.id} className="gallery-row" id={groupAnchor(group.id)}>
            {/* What the surface IS, said once for the row rather than once per slide. The wire name
                is here because an author writes it; the kind chip because the three kinds are three
                different things that appear in front of a person. */}
            <header className="gallery-row-head">
              <div className="gallery-row-title">
                <h3>
                  {group.title}
                  <span className="chip">{group.kind}</span>
                  {group.component !== undefined ? <span className="mono sub">{group.component}</span> : null}
                </h3>
                <p className="sub">{group.blurb}</p>
              </div>
              {/* The row's own controls: which variant, by name, and the two arrows. The tabs are the
                  app's segmented switch — the same markup as Form/JSON — because they mean the same
                  thing: views of one thing, one showing. */}
              <div className="gallery-row-nav">
                <div className="tabs seg gallery-tabs">
                  {group.variants.map((variant, i) => (
                    <button
                      key={variant.id}
                      type="button"
                      className={i === at ? "layer-on" : "ghost"}
                      title={variant.note}
                      onClick={() => slideTo(group, i)}
                    >
                      {variant.title}
                    </button>
                  ))}
                </div>
                {group.variants.length > 1 ? (
                  <div className="gallery-arrows">
                    <button type="button" className="ghost" aria-label="Previous variant" disabled={at === 0} onClick={() => slideTo(group, at - 1)}>
                      ‹
                    </button>
                    <span className="sub mono">
                      {at + 1}/{group.variants.length}
                    </span>
                    <button
                      type="button"
                      className="ghost"
                      aria-label="Next variant"
                      disabled={at === group.variants.length - 1}
                      onClick={() => slideTo(group, at + 1)}
                    >
                      ›
                    </button>
                  </div>
                ) : null}
              </div>
            </header>
            {/* The carousel: every slide mounted, so an edit made on one survives sliding away from
                it, and the track's scroll is the state. Snap keeps a drag from stopping between two
                cards, which for a dialog would be half of each. */}
            <div
              className="gallery-track"
              ref={(el) => {
                tracks.current[group.id] = el;
              }}
              onScroll={(e) => {
                const i = slideOf(e.currentTarget);
                if (i !== (showing[group.id] ?? 0)) setShowing((held) => ({ ...held, [group.id]: i }));
              }}
            >
              {group.variants.map((variant) => {
                const surface = surfaces.find((s) => s.group === group.id && s.variant === variant.id)!;
                return (
                  <div key={surface.id} className="gallery-slide">
                    <GalleryCard
                      surface={surface}
                      state={cards[surface.id] ?? initialState(surface)}
                      validateSchema={validateSchema}
                      onText={(text) => patch(surface.id, { text })}
                      onEditor={(editor) => patch(surface.id, { editor })}
                      onReset={() => patch(surface.id, { ...initialState(surface), result: undefined })}
                      onResult={(result) => patch(surface.id, { result })}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function GalleryCard({
  surface,
  state,
  validateSchema,
  onText,
  onEditor,
  onReset,
  onResult,
}: {
  surface: GallerySurface;
  state: CardState;
  validateSchema: ComponentGalleryProps["validateSchema"];
  onText: (text: string) => void;
  onEditor: (editor: Editor) => void;
  onReset: () => void;
  onResult: (result: CardState["result"]) => void;
}): JSX.Element {
  const parsed = parsedDoc(state.text);
  const entry = surface.schemaId === null ? undefined : schemaById(surface.schemaId);

  return (
    <section className="gallery-card" data-testid={`gallery-${surface.id}`}>
      {/* The variation, not the surface: what this card turns on, and what to look for. The
          surface's own description is on the group heading above, once. */}
      <header className="gallery-head">
        <h4>{surface.title}</h4>
        <p className="sub">{surface.note}</p>
      </header>

      {/* The thing itself on the left, what drives it on the right — reading order, and the order a
          person works in: you look at the dialog, then reach for the knob. The config is sized by
          the DIALOG rather than by its own length (see `.gallery-side`), so a long config scrolls
          beside the component instead of pushing the next card off the screen. */}
      <div className="gallery-body">
        <div className="gallery-stage">
          <Stage surface={surface} doc={parsed.doc} docError={parsed.error} onResult={onResult} />
        </div>

        <div className="gallery-side">
          <div className="gallery-config">
            <div className="gallery-config-head">
              {/* The app's own view switch, markup and all — Form/JSON means the same thing here as in
                  the state editor, and a second spelling of it would be a second thing to learn. */}
              <div className="tabs seg">
                <button
                  className={state.editor === "form" ? "layer-on" : "ghost"}
                  disabled={entry === undefined}
                  title={entry === undefined ? "no schema declares this document's shape" : "edit it as a form"}
                  onClick={() => onEditor("form")}
                >
                  Form
                </button>
                <button className={state.editor === "json" ? "layer-on" : "ghost"} onClick={() => onEditor("json")}>
                  JSON
                </button>
              </div>
              <span className="sub grow">
                {surface.kind === "interaction" ? "the state's authored args" : "the request the dialog was raised with"}
              </span>
              <button className="link" onClick={onReset}>
                reset
              </button>
            </div>

            {state.editor === "form" && entry !== undefined ? (
              parsed.doc === undefined ? (
                // The form cannot show a document it cannot parse, and inventing one would silently
                // discard what was typed. The JSON view is where a broken document is repaired.
                <p className="reason">
                  This is not JSON yet: {parsed.error}. Fix it in the JSON view — the form edits a parsed
                  document.
                </p>
              ) : (
                <SchemaForm
                  schema={entry.document as Schema}
                  value={parsed.doc}
                  onChange={(next) => onText(JSON.stringify(next, null, 2))}
                  ctx={{ path: "" }}
                />
              )
            ) : (
              <div className="gallery-json">
                <SchemaJsonEditor
                  text={state.text}
                  busy={false}
                  onChange={onText}
                  validate={validateSchema}
                  schemaId={surface.schemaId}
                  // The schema is a property of the SURFACE, not a choice: a `fill_form` config answers
                  // to `fill_form`'s contract or to nothing. So it is shown and not offered.
                  lockedSchema
                  onSchema={() => undefined}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {state.result !== undefined ? (
        <div className="gallery-result">
          <div className="gallery-result-head">
            <span className="sub">what it submitted</span>
            {state.result.check !== undefined ? (
              <span className={state.result.check.ok ? "chip chip-ok" : "chip chip-bad"}>
                {state.result.check.ok ? "contract ok" : "rejected"}
              </span>
            ) : null}
          </div>
          <pre className="outputs">{JSON.stringify(state.result.value, null, 2)}</pre>
          {state.result.check?.ok === false ? <p className="reason">{state.result.check.errors}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The dialog itself, built from the edited document exactly as main builds it from a run.
 *
 * The parse is deliberately the shared one: a config error here is the string an author would read
 * in a real run, in the same place, which is what makes editing the document above a way to learn
 * the contract rather than a way to drive a demo.
 */
function Stage({
  surface,
  doc,
  docError,
  onResult,
}: {
  surface: GallerySurface;
  doc: Record<string, unknown> | undefined;
  docError: string | undefined;
  onResult: (result: CardState["result"]) => void;
}): JSX.Element {
  if (doc === undefined) return <p className="reason">Not JSON yet: {docError}</p>;

  if (surface.kind === "approval") {
    const pending: PendingApproval = {
      requestId: `gallery-${surface.id}`,
      tool: stringAt(doc, "tool") ?? "Bash",
      ...(stringAt(doc, "command") !== undefined ? { command: stringAt(doc, "command")! } : {}),
      ...(stringAt(doc, "reason") !== undefined ? { reason: stringAt(doc, "reason")! } : {}),
      // The parts and the toolset are the engine's own shapes, typed in whole: the gallery has no
      // policy behind it to take a line apart, and a sample is the place to see exactly what one carries.
      ...(isRecord(doc["parts"]) ? { parts: doc["parts"] as unknown as NonNullable<PendingApproval["parts"]> } : {}),
      ...(isRecord(doc["toolset"]) ? { toolset: doc["toolset"] as unknown as NonNullable<PendingApproval["toolset"]> } : {}),
      input: (doc["input"] ?? {}) as Record<string, JsonValue>,
      project: GALLERY_PROJECT,
      at: 0,
    };
    return (
      <div className="inline-gate">
        <ApprovalSurface
          pending={pending}
          onDecide={(decision, scope, extras) => onResult({ value: { decision, scope, ...(extras ?? {}) } as JsonValue })}
        />
      </div>
    );
  }

  if (surface.kind === "question") {
    const questions = Array.isArray(doc["questions"]) ? (doc["questions"] as PendingQuestion["questions"]) : [];
    if (questions.length === 0) return <p className="reason">A question request needs at least one question.</p>;
    const pending: PendingQuestion = {
      requestId: `gallery-${surface.id}`,
      questions,
      project: GALLERY_PROJECT,
      at: 0,
    };
    return (
      <div className="inline-gate">
        <QuestionSurface
          pending={pending}
          // `undefined` is the dismissal the real channel carries — shown as itself rather than
          // collapsed into "no answer", because "let the agent decide" IS an answer the agent receives.
          onSubmit={(answers) => onResult({ value: answers === undefined ? { dismissed: true } : { answers } })}
        />
      </div>
    );
  }

  const component = surface.component ?? "";
  const inputs = (surface.inputs ?? {}) as Record<string, JsonValue>;
  let config: ComponentConfig | undefined;
  let configError: string | undefined;
  if (isComponentName(component)) {
    try {
      config = parseComponentConfig(component, doc);
    } catch (e) {
      configError = (e as Error).message;
    }
  }

  const pending: PendingInteraction = {
    requestId: `gallery-${surface.id}`,
    taskId: "gallery",
    project: GALLERY_PROJECT,
    // An unrecognised gate names whatever the document says it does, so the fallback can be reached
    // by typing a function name rather than by breaking something.
    component: isComponentName(component) ? component : (stringAt(doc, "function") ?? component),
    inputs,
    ...(config === undefined ? {} : { config }),
    ...(configError === undefined ? {} : { configError }),
  };

  return (
    <InteractionDialog
      pending={pending}
      onSubmit={(value) =>
        onResult({
          value,
          // The same check main runs before an answer may enter a run — including the changeset
          // gate's, which judges the answer against the changeset it was shown.
          ...(config === undefined ? {} : { check: checkOf(config, value, inputs) }),
        })
      }
      services={{
        // The gallery reads no files. A failing read is already the silent case in the reviewer's
        // drift check (see `readCurrent`), so this produces no badge rather than a wrong one.
        readUri: () => Promise.reject(new Error("the gallery reads no files")),
        // And it compiles none. `GALLERY_PROJECT` is a placeholder for a subtitle, not a project
        // main can resolve, so the compiler channels would ask about a tree that does not exist and
        // be refused once per side of every TypeScript change on screen.
        //
        // Stated as an explicit `undefined` rather than left out: these services are spread OVER the
        // renderer defaults (see `ChangesetGate`), so an absent key keeps the default rather than
        // dropping it. Undefined is the contract's own "no diagnostics here" — the same answer the
        // CLI gets — which is the honest one for a fixture nothing can type-check.
        checkFile: undefined,
        releaseFile: undefined,
      }}
    />
  );
}

function checkOf(
  config: ComponentConfig,
  value: unknown,
  inputs: Record<string, JsonValue>,
): { ok: boolean; errors?: string } {
  const checked = validateComponentResult(config, value, inputs);
  return checked.ok ? { ok: true } : { ok: false, errors: checked.errors };
}
