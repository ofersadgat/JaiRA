/**
 * The component gallery: every surface the app can put in front of a person, with nothing behind it.
 *
 * The Debug view's other half asks "does a workflow run"; this asks the question a run cannot answer
 * cheaply — *what does the thing it parks at actually look like, and what does an answer to it
 * return?* A UI state's entire visible behaviour comes from a config an author writes inside a state
 * file, and reaching one otherwise costs a workflow, a provider, a task and a run.
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
 * ## Why the dialogs render inline
 *
 * All three are modal by construction (`.modal-backdrop` is fixed and covers the window). A gallery
 * of nine modals opened one at a time is a gallery you cannot compare, so the stage neutralises the
 * backdrop's positioning in CSS and nothing about the dialogs themselves changes. What you see is
 * what the modal shows, minus the scrim.
 */
import { useState, type JSX } from "react";
import {
  GALLERY_SURFACES,
  isComponentName,
  parseComponentConfig,
  schemaById,
  validateComponentResult,
  type ComponentConfig,
  type GallerySurface,
  type PendingApproval,
  type PendingInteraction,
  type PendingQuestion,
  type ValidateSchemaResult,
} from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { ApprovalDialog, InteractionDialog, QuestionDialog } from "./components";
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

export interface ComponentGalleryProps {
  /** The schema check, over IPC — the store's, the same one every JSON editor in the app uses. */
  validateSchema: (schemaId: string, text: string) => Promise<ValidateSchemaResult | null>;
  /**
   * What to show. Defaults to everything, which is what the Debug view wants.
   *
   * A parameter rather than a constant because the gallery is a list of surfaces, and a caller that
   * wants two of them — the snapshot harness photographs a pair — should not have to reimplement the
   * card to get them.
   */
  surfaces?: readonly GallerySurface[];
}

export function ComponentGallery({ validateSchema, surfaces = GALLERY_SURFACES }: ComponentGalleryProps): JSX.Element {
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

  return (
    <div className="gallery">
      {surfaces.map((surface) => (
        <GalleryCard
          key={surface.id}
          surface={surface}
          state={cards[surface.id] ?? initialState(surface)}
          validateSchema={validateSchema}
          onText={(text) => patch(surface.id, { text })}
          onEditor={(editor) => patch(surface.id, { editor })}
          onReset={() => patch(surface.id, { ...initialState(surface), result: undefined })}
          onResult={(result) => patch(surface.id, { result })}
        />
      ))}
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
    <section className="gallery-card">
      <header className="gallery-head">
        <h4>
          {surface.title}
          <span className="chip">{surface.kind}</span>
        </h4>
        {surface.component !== undefined ? <div className="sub mono">{surface.component}</div> : null}
        <p className="sub">{surface.blurb}</p>
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
      input: (doc["input"] ?? {}) as Record<string, JsonValue>,
      project: GALLERY_PROJECT,
      at: 0,
    };
    return (
      <ApprovalDialog
        pending={pending}
        onDecide={(decision, scope) => onResult({ value: { decision, scope } })}
      />
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
      <QuestionDialog
        pending={pending}
        // `undefined` is the dismissal the real channel carries — shown as itself rather than
        // collapsed into "no answer", because "let the agent decide" IS an answer the agent receives.
        onSubmit={(answers) => onResult({ value: answers === undefined ? { dismissed: true } : { answers } })}
      />
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
