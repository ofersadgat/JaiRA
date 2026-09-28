/**
 * How each kind of file is drawn — the Appearance pane's File types screen (SHELL.md §6.3).
 *
 * It replaced a flat table: twenty types down one axis, three kinds across the other, one select per
 * cell and a third of the cells reading `one way` or `—`. That table could say only one thing per
 * type and kind, which turned out to be three things short. It could not say what a file looks like
 * when you are only READING it as against typing in it; it could not take a renderer off a menu; and
 * it had no way to set twenty types at once, so the answer to "draw all my source as coloured text"
 * was twelve separate clicks.
 *
 * The shape that fixes it is a hierarchy and one stage:
 *
 *  - **A tree of families**, one open at a time. Five groups (`PANE_FAMILIES`), each with an **All**
 *    row above its types.
 *  - **An All row shows what its types agree on**, and sits empty where they do not. Choosing on it
 *    makes them agree — see {@link resolveAll}, which is where most of the thinking in this file is.
 *  - **A mode strip** carrying what all three kinds currently resolve to, so the one-mode-at-a-time
 *    detail below costs nothing at a glance.
 *  - **Two views per mode.** `read` is what you get when you are not editing; `write` is what you
 *    type into. Only a renderer that WRITES can answer the second, which is the registry's own flag
 *    rather than a second thing to configure.
 *
 * Nothing here says WHERE those two views go. A surface may show only the reading, only the editor,
 * one control that toggles, or both at once; this screen says which renderer each view is, and the
 * surface spends that however it lays itself out. That is why no label in this file mentions halves
 * or dividers, and it is a correction of the vocabulary the old table used.
 */
import { Component, useEffect, useState, type ErrorInfo, type JSX, type ReactNode } from "react";
import {
  PANE_FAMILIES,
  typeNameOf,
  type EditorKind,
  type EditorLook,
  type PaneFamily,
  type RendererChoices,
  type RendererEdit,
  type RenderView,
} from "@jaira/shared/browser";
import { SelectInput } from "./controls";
import { EDITOR_THEMES, EDITOR_THEME_APP, editorPaint, editorThemeSpec } from "./editorThemes";
import { takeEditorFront } from "./editorFront";
import { EditorLookFields } from "./editorKnobs";
import { RENDER_KINDS, type FileRenderer, type RenderKind } from "./fileTypes";
// Imported for its REGISTRATIONS: this screen is derived from the registry, and the registry is
// populated by that module being read. Named here rather than left to arrive through somebody else's
// import graph — without it the tree draws its rows over nothing at all, which is exactly what
// happened where the shell is not what mounts the pane.
import "./fileSurfaces";
import { KINDS, VIEWS, fileTypesModel, sampleFor, typeIsSet, type Subject } from "./fileTypesModel";

/** The screen's logic over the app's own registry — `fileTypesModel.ts`, shared with the universal copy. */
const MODEL = fileTypesModel();
const { subjectMimeOf, modeSay, themeCaption } = MODEL;
export const { membersOf, contributors, unionOffered, capableOf, reachOf, resolveAll, offStateAll, offeredFor, anyFor, pickFor, mixedFor, spreadFor, offStateFor, liveFor, editsForPick, editsForOff, resolveTheme, viewsSharing, editsForTheme } = MODEL;
import { EMPTY_CONTEXT } from "./panes";
import type { FileSource } from "@jaira/shared/browser";

/** A picker that can be EMPTY — the position an All row takes when its types disagree. */
function ViewPicker({
  list,
  value,
  mixed,
  reach,
  busy,
  onPick,
}: {
  list: readonly FileRenderer[];
  value: string | null;
  mixed: boolean;
  /** How far each option reaches, on an All row — `null` everywhere else. */
  reach: ((renderer: FileRenderer) => string | null) | null;
  busy: boolean;
  onPick: (id: string) => void;
}): JSX.Element {
  const options: Array<[string, string]> = list.map((renderer, i) => {
    const far = reach?.(renderer) ?? null;
    // `ours` rather than "default", the word this pane already uses for the face JaiRA ships: same
    // meaning — this is what you get having said nothing.
    const label = i === 0 ? `${renderer.label} · ours` : renderer.label;
    return [far === null ? label : `${label} — ${far}`, renderer.id];
  });
  // Selected, and impossible to choose: "they disagree" is a true statement about the family and not
  // an answer a person can give back to it.
  if (mixed) options.unshift(["— types disagree —", ""]);
  return (
    <SelectInput
      value={mixed ? "" : (value ?? (list[0]?.id ?? ""))}
      disabled={busy}
      options={options}
      onChange={(next) => (next === "" ? undefined : onPick(next))}
    />
  );
}

/**
 * A palette, as the colours it is — its ground, then what a reader tells tokens apart by.
 *
 * Null for "Follows the app" and for a family that disagrees: neither is a set of colours, and five
 * squares of nothing in particular would be worse than an absence.
 */
function Swatches({ theme }: { theme: string | null }): JSX.Element | null {
  const spec = theme === null ? undefined : editorThemeSpec(theme);
  if (spec === undefined) return null;
  return (
    <span className="ft-swatches" title={spec.source}>
      {[spec.bg, spec.keyword, spec.string, spec.func, spec.type].map((colour, at) => (
        <span key={at} className="ft-swatch" style={{ background: colour }} />
      ))}
    </span>
  );
}

/** A tick that can be half-on, for a renderer only some of a family offers. */
function OfferBox({
  state,
  busy,
  onFlip,
}: {
  state: "on" | "off" | "mixed";
  busy: boolean;
  onFlip: () => void;
}): JSX.Element {
  return (
    <input
      className="ft-box"
      type="checkbox"
      checked={state === "on"}
      ref={(node) => {
        if (node !== null) node.indeterminate = state === "mixed";
      }}
      disabled={busy}
      title={
        state === "mixed"
          ? "some types in this family offer it and some do not"
          : state === "on"
            ? "offered — this renderer is on the menu for this type"
            : "not offered"
      }
      onChange={onFlip}
    />
  );
}

/**
 * A surface that threw, drawn as a note rather than as a blank window.
 *
 * The preview mounts REAL renderers against an inert context, and a few of them want a shell that is
 * not there — a board wants a run, a sync panel wants two layers to compare. That is a fact about
 * the renderer rather than a fault, and it is far better said than crashed: without this, one
 * renderer with a hard dependency takes the whole settings window down with it.
 */
class PreviewBoundary extends Component<{ children: ReactNode; label: string }, { failed: boolean }> {
  constructor(props: { children: ReactNode; label: string }) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Swallowed on purpose: it is not this window's error, and the renderer that threw is named in
    // the note below. The console still has the stack.
  }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="ft-preview-note app-secondary">
        {this.props.label} needs a file that is actually open — it draws a run, not a sample. Open one to see it.
      </div>
    );
  }
}

/**
 * The chosen renderer, drawing the chosen type.
 *
 * The REAL surface, mounted against `EMPTY_CONTEXT` — every channel present and inert — rather than
 * a picture of one. A picture cannot show you that your line spacing has made a six-line function
 * scroll, and it cannot be typed in; this can. It is also the only honest answer to "what does this
 * choice do", because the thing it does is exactly this component.
 *
 * Nothing here is a document. There is no draft store and no save: the text is local and thrown
 * away, which is what a sample is for.
 */
function RendererPreview({
  mime,
  renderer,
  view,
  theme,
}: {
  mime: string;
  renderer: FileRenderer | null;
  view: RenderView;
  /** The palette this pick is drawn in — see {@link themedStyle}. */
  theme: string | null;
}): JSX.Element {
  const [text, setText] = useState(() => sampleFor(mime));
  // Re-seeded when the subject changes: each type has its own sample, and the last one's text in
  // this one's renderer is a preview of the wrong thing.
  const [shown, setShown] = useState(mime);
  if (shown !== mime) {
    setShown(mime);
    setText(sampleFor(mime));
  }
  if (renderer === null || renderer.surface === null) {
    return (
      <div className="ft-preview-note app-secondary">
        {renderer === null ? "Nothing is drawn here." : "Nothing — this type has no view of that kind."}
      </div>
    );
  }
  const Surface = renderer.surface;
  const doc: FileSource = { layer: "project", path: "sample", file: "sample", mime, text, exists: true };
  /**
   * The palette, as variables on the container.
   *
   * Monaco ignores this — its colours come from `setTheme`, which is the window's — but every other
   * themed surface reads exactly these tokens: the markdown editor is CodeMirror and the JSON one is
   * a textarea over a coloured `<pre>`, and both are styled from `--tok-*`. Without it, choosing a
   * colour scheme for Markdown or JSON changed the swatches and nothing else, because the only
   * mapping was on `:root` and the root can hold one palette.
   */
  const painted = editorPaint(theme);
  return (
    <div
      className={`ft-preview-body ${view}${painted === null ? "" : ` ${painted.className}`}`}
      style={painted?.style}
    >
      <PreviewBoundary label={renderer.label}>
        <Surface
          doc={doc}
          busy={false}
          // A reading is read-only whatever the surface can do, so only the editor's text comes back.
          onSave={view === "write" ? setText : () => undefined}
          // Which half this is, so an editor mounted as the READING asks for the reading's palette.
          // Without it Monaco resolved the other view's, and choosing a colour scheme for a reading
          // changed nothing you could see.
          context={{ ...EMPTY_CONTEXT, view }}
        />
      </PreviewBoundary>
    </div>
  );
}

/** One row of the tree: a family, or a type inside the open one. */
function TreeRow({
  label,
  selected,
  title,
  lead,
  trail,
  onClick,
}: {
  label: string;
  selected: boolean;
  title?: string;
  lead?: ReactNode;
  trail?: ReactNode;
  onClick: () => void;
}): JSX.Element {
  return (
    <button className="ft-row" aria-selected={selected} title={title} onClick={onClick}>
      {lead}
      <span className="ellip">{label}</span>
      {trail}
    </button>
  );
}

export function FileTypesPane({
  renderers,
  editorTheme,
  editors,
  busy,
  onRenderer,
  onEditor,
}: {
  renderers: RendererChoices;
  /** What a pick with no palette of its own is drawn in — `Appearance.editorTheme`. */
  editorTheme: string;
  /**
   * How each editing surface is drawn, and how to change one.
   *
   * Here rather than in a section of its own, because "what draws this type" and "what does that
   * thing look like" are two halves of one question and they were a scroll apart. A renderer says
   * which surface it is (`FileRenderer.look`) and its knobs are drawn under it — so a person setting
   * up how they read TypeScript never has to work out that the answer lives under something called
   * "Code".
   */
  editors: Record<EditorKind, EditorLook>;
  busy: boolean;
  onRenderer: (edits: readonly RendererEdit[]) => void;
  onEditor: (kind: EditorKind, patch: Partial<EditorLook>) => void;
}): JSX.Element {
  // Code, opened, on its text renderers: the family whose All row has the cleanest answer, which is
  // what a screen should open on. Every other landing state is one click away.
  const [open, setOpen] = useState<PaneFamily | null>("code");
  const [at, setAt] = useState<Subject>({ family: "code", mime: null });
  const [kind, setKind] = useState<RenderKind>("text");
  const [view, setView] = useState<RenderView>("read");
  const [showMenu, setShowMenu] = useState(false);

  const family = PANE_FAMILIES.find((each) => each.id === at.family) ?? PANE_FAMILIES[0]!;
  const list = offeredFor(at, kind);
  /**
   * The type the preview actually draws.
   *
   * On an All row, the first member that the chosen renderer can REACH — otherwise picking
   * `Schema-aware`, which only the JSON types have, would preview it against a CSV that will never
   * use it.
   */
  const subjectMime = subjectMimeOf(at, kind, view, renderers);
  const named = at.mime === null ? null : typeNameOf(at.mime);
  /**
   * This preview owns the window's palette while it is on screen.
   *
   * Monaco has one, and the Editors section below mounts a Monaco of its own within a frame of this
   * one — so whichever lost that race owned the colours, and the theme control on THIS screen
   * appeared to do nothing. The pane whose subject the palette is says so, and says so again on
   * every change of subject or view. See `editorFront.ts`.
   */
  useEffect(() => {
    // The KEY this row stores under, not just the type: a palette for the diff renderer is filed
    // under its kind, and claiming the type alone previewed a value nothing would ever read.
    takeEditorFront({ mime: subjectMime, view, palette: { mime: subjectMime, kind, view } });
  }, [subjectMime, kind, view, renderers]);

  return (
    <div className="ft">
      <div className="ft-tree">
        {PANE_FAMILIES.map((each) => {
          const isOpen = open === each.id;
          return (
            <div className="ft-group" key={each.id}>
              <TreeRow
                label={each.label}
                selected={at.family === each.id && at.mime === null}
                title={each.note}
                lead={<span className="ft-caret">{isOpen ? "▾" : "▸"}</span>}
                trail={<span className="ft-count data-faint">{membersOf(each.id).length}</span>}
                onClick={() => {
                  // An accordion: opening one closes the other. With five families and nineteen
                  // types, a tree that keeps every branch anybody has touched turns back into the
                  // flat list this screen replaced.
                  setOpen(isOpen ? null : each.id);
                  setAt({ family: each.id, mime: null });
                }}
              />
              {isOpen ? (
                <div className="ft-kids">
                  <TreeRow
                    label={`All ${each.label.toLowerCase()}`}
                    selected={at.family === each.id && at.mime === null}
                    title="every type in this family — a value shows where they already agree"
                    onClick={() => setAt({ family: each.id, mime: null })}
                  />
                  {membersOf(each.id).map((mime) => (
                    <TreeRow
                      key={mime}
                      label={typeNameOf(mime).label}
                      selected={at.mime === mime}
                      // The MIME string on the tooltip rather than in the row: this is a tool for
                      // people who occasionally need it, and never what the control reads.
                      title={mime}
                      trail={
                        typeIsSet(mime, renderers) ? <span className="ft-dot" title="set here, on its own" /> : undefined
                      }
                      onClick={() => setAt({ family: each.id, mime })}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="ft-stage">
        <div className="ft-head">
          <span className="app-title">{named === null ? `All ${family.label.toLowerCase()}` : named.label}</span>
          <span className="grow" />
          <span className="app-secondary ellip" title={at.mime ?? undefined}>
            {at.mime === null ? `${membersOf(at.family).length} types — a value shows where they agree` : at.mime}
          </span>
        </div>

        {/* The mode strip, carrying what each kind currently resolves to. Three cards' worth of
            at-a-glance in the row that had to be here anyway, which is what makes it affordable to
            show the detail for one mode at a time underneath. */}
        <div className="ft-modes">
          {RENDER_KINDS.map((each) => {
            const has = anyFor(at, each);
            const live = has && liveFor(at, each, renderers);
            return (
              <button
                key={each}
                className={`ft-mode${live ? "" : " is-off"}`}
                aria-selected={kind === each}
                disabled={!has}
                title={has ? KINDS[each].hint : "this type has no rendering of that kind"}
                onClick={() => setKind(each)}
              >
                <span className="ft-mode-top">
                  <span className="ft-bulb" />
                  <span className="app-label">{KINDS[each].label}</span>
                </span>
                <span className={`ft-mode-say ellip${mixedFor(at, each, "read", renderers) ? " is-mixed" : ""}`}>
                  {modeSay(at, each, renderers)}
                </span>
              </button>
            );
          })}
        </div>

        <div className="ft-body">
          {!anyFor(at, kind) ? (
            <span className="app-secondary">
              This type has no rendering of that kind — a TypeScript file denotes no value, a CSV has nothing to render.
            </span>
          ) : (
            <>
              {/*
                * You are arranging a MENU, so this draws the menu.
                *
                * The thing being configured is the list the panel's own `▾` offers for this type, and
                * every other shape this screen was tried in described that list from outside it — a
                * table of ticks, a pair of pickers and a fold. Here what you arrange IS what you will
                * see: the ticked row is the one that leads, the ✕ takes a row off the menu and drops
                * it under the rule, and a `+` puts it back.
                *
                * ONE column rather than two, because the reading and the editor are two different
                * menus in the app and are two different menus here. The segmented control above says
                * which of them you are arranging, and a renderer that cannot be typed into greys out
                * when you switch to the editor rather than vanishing — its absence from that menu is
                * a fact about the renderer, and a row that disappeared would look like a setting you
                * had lost.
                */}
              <div className="ft-arranging">
                <span className="app-label">arranging</span>
                <span className="ft-seg">
                  {([["the read-only view", "read"], ["the editor", "write"]] as const).map(([label, each]) => (
                    <button key={each} aria-pressed={view === each} onClick={() => setView(each)}>
                      {label}
                    </button>
                  ))}
                </span>
              </div>

              {(() => {
                const writing = view === "write";
                const pick = pickFor(at, kind, view, renderers);
                const mixed = mixedFor(at, kind, view, renderers);
                const spread = spreadFor(at, kind, view, renderers);
                const shown = list.filter((one) => offStateFor(at, kind, one.id, renderers) !== "off");
                const hidden = list.filter((one) => offStateFor(at, kind, one.id, renderers) === "off");
                /** Only a renderer that WRITES may be an editor — and `Nothing`, where there is one to decline. */
                const usable = (one: FileRenderer): boolean =>
                  !writing || one.writes === true || (one.surface === null && list.some((each) => each.writes === true));
                return (
                  <div className="ft-menu">
                    <div className="ft-menu-head">
                      <span className="app-label">{KINDS[kind].label}</span>
                      {/* Both halves whole, and parallel. "the view that cannot" is a fragment that
                          reads as a truncation rather than as the other side of a pair. */}
                      <span className="app-secondary">
                        {writing ? "the view you type into" : "the view you cannot type into"}
                      </span>
                    </div>
                    {shown.map((one) => {
                      const leads = !mixed && pick !== null && pick.id === one.id;
                      const far = at.mime === null ? reachOf(at.family, kind, one.id) : null;
                      return (
                        <div
                          className={`ft-mm-row${leads ? (spread === null ? " is-lead" : " is-part") : ""}${
                            usable(one) ? "" : " is-dim"
                          }`}
                          key={one.id}
                        >
                          {/* Two buttons rather than one with something clickable inside it: both are
                              reachable from the keyboard, which a span with a handler is not. */}
                          <button
                            className="ft-mm-pick"
                            disabled={busy || !usable(one)}
                            title={
                              usable(one)
                                ? "make this the one that leads"
                                : "this renderer cannot be typed into, so it is never an editor"
                            }
                            onClick={() => onRenderer(editsForPick(at, kind, view, one.id))}
                          >
                            <span className="ft-mm-tick">{leads ? "✓" : ""}</span>
                            <span className="ft-mm-name">
                              <span className="app-text">
                                {one.label}
                                {list[0]?.id === one.id ? <span className="app-secondary"> ours</span> : null}
                                {far === null ? null : <span className="ft-reach data-faint">{far}</span>}
                              </span>
                              {one.note === undefined ? null : (
                                <span className="app-secondary ellip">{one.note}</span>
                              )}
                            </span>
                          </button>
                          <button
                            className="ft-mm-x"
                            disabled={busy}
                            title="take it off this menu"
                            onClick={() => onRenderer(editsForOff(at, kind, one.id, renderers))}
                          >
                            {"✕"}
                          </button>
                        </div>
                      );
                    })}
                    {hidden.length === 0 ? null : (
                      <>
                        <div className="ft-mm-sep" />
                        <div className="ft-mm-foot app-label">not offered</div>
                        {hidden.map((one) => (
                          <div className="ft-mm-row is-dim" key={one.id}>
                            <button
                              className="ft-mm-pick"
                              disabled={busy}
                              title="put it back on the menu"
                              onClick={() => onRenderer(editsForOff(at, kind, one.id, renderers))}
                            >
                              <span className="ft-mm-tick" />
                              <span className="ft-mm-name">
                                <span className="app-text">{one.label}</span>
                              </span>
                            </button>
                            <button
                              className="ft-mm-x"
                              disabled={busy}
                              title="put it back on the menu"
                              onClick={() => onRenderer(editsForOff(at, kind, one.id, renderers))}
                            >
                              +
                            </button>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                );
              })()}

              {mixedFor(at, kind, view, renderers) ? (
                <span className="app-secondary">
                  No row is ticked: the types in this family are set differently. Clicking one sets this view for every
                  type that can take it.
                </span>
              ) : spreadFor(at, kind, view, renderers) !== null ? (
                <span className="app-secondary">
                  The tick is hollow: {pickFor(at, kind, view, renderers)?.label} reaches{" "}
                  {spreadFor(at, kind, view, renderers)?.reaches} of these {spreadFor(at, kind, view, renderers)?.of}{" "}
                  types, and the rest keep what they had.
                </span>
              ) : null}

              {/*
                * The palette, for the menu you are arranging.
                *
                * Below rather than in a row, because it is not a fact about a row — three renderers do
                * not have three palettes — it is a fact about the one that leads, and it changes when
                * the leader does. Absent where that renderer has none, which is most of the data and
                * preview kinds: a tree, a form, a table and a board are drawn in the app's own tokens.
                */}
              {(() => {
                const palette = resolveTheme(at, kind, view, renderers, editorTheme);
                if (palette === null) return null;
                return (
                  <div className="ft-theme">
                    <span className="app-label">theme</span>
                    <SelectInput
                      value={palette === "mixed" ? "" : palette.theme}
                      disabled={busy}
                      options={[
                        ...(palette === "mixed" ? ([["— types disagree —", ""]] as Array<[string, string]>) : []),
                        ["Follows the app", EDITOR_THEME_APP],
                        ...EDITOR_THEMES.map((one): [string, string] => [one.label, one.id]),
                      ]}
                      onChange={(id) => (id === "" ? undefined : onRenderer(editsForTheme(at, kind, view, id, renderers)))}
                    />
                    {/* The palette as the colours it IS. A menu of names is the one thing that cannot
                        show that, and the preview below draws only ONE of the two views. */}
                    <Swatches theme={palette === "mixed" ? null : palette.theme} />
                    <span className="grow" />
                    <span className="app-secondary ellip">
                      {/* Both views where one renderer serves both, because that is what setting it
                          will do — and because a person who reads "the read-only view" while looking
                          at a file drawn by the editor has been told the opposite of the truth. */}
                      {themeCaption(at, kind, view, renderers)}
                      {view === "write" ? (
                        <span className="ft-caveat"> · editors share one, and the last one you were in wins</span>
                      ) : null}
                    </span>
                  </div>
                );
              })()}

              {!liveFor(at, kind, renderers) ? (
                <span className="app-secondary">
                  Every renderer is off, so this kind is off: nothing of it is drawn for this type.
                </span>
              ) : null}

              {/*
                * The knobs that move the surface you just chose.
                *
                * Only where the renderer IS one — a tree, a table and a board have none of these, and
                * a switch over a surface that would ignore it is the one failure a settings screen
                * cannot recover from, because it is invisible. Between the palette and the preview,
                * so the three things about one renderer sit together and the picture of them is last.
                */}
              {(() => {
                const look = pickFor(at, kind, view, renderers)?.look;
                if (look === undefined) return null;
                return (
                  <div className="ft-knobs">
                    {/* Named, because a box of switches that begins with a switch is a box nobody
                        knows the subject of. The surface rather than the type: these move every file
                        this renderer draws, which is the one thing about them worth saying twice. */}
                    <div className="ft-knobs-head">
                      <span className="app-label">how it is drawn</span>
                      <span className="app-secondary ellip">
                        every file {pickFor(at, kind, view, renderers)?.label} draws, not only this type
                      </span>
                    </div>
                    <EditorLookFields kind={look} look={editors[look]} busy={busy} onChange={(patch) => onEditor(look, patch)} />
                  </div>
                );
              })()}

              {/* Under the controls rather than beside them: it is what they DID, and a preview above
                  the control that moved it makes you look up to check your own click. */}
              <div className="ft-preview">
                <div className="ft-preview-bar">
                  <span className="app-label">preview</span>
                  {/* What is on screen, said in full. On an All row the TYPE is not the one selected
                      in the tree — it is the first member the chosen renderer can reach — so a bar
                      that named only the kind and the view would leave the one surprising fact out. */}
                  <span className="data-faint ellip">
                    {typeNameOf(subjectMime).label} · {KINDS[kind].label} ·{" "}
                    {pickFor(at, kind, view, renderers)?.label ?? "nothing"}
                  </span>
                  <span className="ft-tag">{VIEWS[view].label} view</span>
                </div>
                {mixedFor(at, kind, view, renderers) ? (
                  <div className="ft-preview-note app-secondary">
                    The types in this family are set differently, so there is nothing single to show. Choose above to
                    make them agree, or open one type in the tree to see it on its own.
                  </div>
                ) : (
                  <RendererPreview
                    key={`${subjectMime}:${kind}:${view}:${pickFor(at, kind, view, renderers)?.id ?? "none"}`}
                    mime={subjectMime}
                    renderer={pickFor(at, kind, view, renderers)}
                    view={view}
                    theme={(() => {
                      const palette = resolveTheme(at, kind, view, renderers, editorTheme);
                      return palette === null || palette === "mixed" ? null : palette.theme;
                    })()}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
