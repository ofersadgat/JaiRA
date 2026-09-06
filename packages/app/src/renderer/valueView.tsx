/**
 * A value, and the ways of looking at it — the app's one view toggle.
 *
 * Everything a model produces lands somewhere on screen, and until now each surface decided for
 * itself how: the transcript printed tool payloads as JSON, an assistant's answer was rendered as
 * markdown with no way back to the source, and a state's structured output was a `<pre>` whatever
 * was in it. Three surfaces, three answers, and none of them reversible.
 *
 * The rule here is that **a value is shown in the most useful form that applies, and every other
 * form it has is one click away**. `viewsFor` (in `shared/valueViews.ts`) decides which apply; this
 * file draws them. Reversibility is the part that matters: rendered markdown is a claim about what
 * the model wrote, and the way you check a claim is to look at the thing itself.
 *
 * ## The toggle only appears when there is a choice
 *
 * A JSON object has one honest rendering, so a value with one view gets no control. A row of
 * buttons over a value that can only be read one way is a control that can only be pressed to no
 * effect, and forty of them down a transcript is a pattern of noise the eye learns to skip — which
 * is exactly what you do not want the day the value IS a diff.
 *
 * ## Views on the left of the `…`, verbs on the right of it
 *
 * The toggle answers one question — how do I want to READ this — and every button in it changes what
 * is on screen and nothing else. Saving a file and moving a value into the side panel are not that,
 * so they are not in that group: they live behind an overflow button, which is also what keeps the
 * group's meaning intact as more of them arrive.
 *
 * ## Why the diff view lives here rather than in the reviewer
 *
 * `changesetReview.tsx` reviews a changeset: it decides, it edits, it submits. Reading one is a
 * different act with a different audience — a model just produced fourteen files and the question
 * is "what did it do", not "which of these do I accept". So the reading view is its own thing, it
 * takes no decisions, and it is available wherever a value happens to be a set of files: in the
 * transcript beside the call that produced them, in the sync report, in a structured output.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { textRendererFor, useRenderChoice } from "./renderChoice";
import type { Change, ParsedStructure, ParseSpot, PatchFile, RendererId, ServedArtifact, ViewHint, ViewId } from "@jaira/shared/browser";
import {
  artifactOf,
  changeStats,
  changesOf,
  delimiterOf,
  extensionForMime,
  mediaKindOf,
  mediaSrcOf,
  mimeOfPath,
  parseStructured,
  parseUnifiedDiff,
  patchStats,
  structuredFormatOf,
  renderersFor,
  totalStats,
  viewsFor,
} from "@jaira/shared/browser";
import { CodeDocument, MarkdownDocument } from "./documents";
import { highlightJson } from "./jsonHighlight";
/**
 * Loaded on first sight of a value with a schema, never with the view.
 *
 * The form is a tree of widgets and a presentation registry, and a transcript that shows one tool
 * result should not pay for either — the same rule the markdown editor and Monaco follow here.
 */
const SchemaForm = lazy(() => import("./schemaForm/SchemaForm").then((m) => ({ default: m.SchemaForm })));
type MarkdownDiff = import("./markdownEditor").MarkdownDiff;
import { Icon } from "./icons";
import { ContextMenu, MENU_WIDTH, type MenuAnchor } from "./menu";
import { useValuePanel } from "./valuePanel";
import { invoke } from "./store";

/**
 * Loaded on first expand, never with the view — the same rule the reviewer follows.
 *
 * Monaco is megabytes and touches `window` at module scope, so a static import would both cost the
 * transcript that weight to draw a list of filenames and drag a browser global into every node-side
 * test that renders one. A collapsed list is the default reading (see {@link ChangesView}); the
 * editor arrives when somebody asks to see a diff.
 */
const MonacoDiffPane = lazy(() => import("./monacoDiff").then((m) => ({ default: m.MonacoDiffPane })));

/** What each view is called on its button, and what the button's tooltip says it does. */
const VIEW_META: Record<ViewId, { label: string; hint: string }> = {
  changes: { label: "Files", hint: "The files this changes, as a diff" },
  media: { label: "Preview", hint: "Play or show it" },
  markdown: { label: "Rendered", hint: "As markdown, rendered" },
  html: { label: "Rendered", hint: "As HTML, rendered" },
  code: { label: "Code", hint: "Highlighted, in an editor" },
  text: { label: "Source", hint: "The text exactly as it was produced" },
  json: { label: "JSON", hint: "The value as JSON" },
  data: { label: "Data", hint: "Parsed — the value this document denotes" },
  patch: { label: "Diff", hint: "The change this patch describes" },
  table: { label: "Table", hint: "As rows and columns" },
  form: { label: "Form", hint: "As the fields its schema declares" },
};

/**
 * What each renderer is called on its menu, and what the item says it does.
 *
 * The hint names the CONSEQUENCE rather than the implementation, because that is what somebody
 * opening this menu is choosing between. Nobody wants Monaco or a `<pre>`; they want to type, or
 * they want to drag a selection through the block and copy it.
 *
 * EXPORTED, so the Appearance pane offers these two under the same names with the same explanations.
 * A settings screen that invented its own words for a choice a person also meets on a menu would be
 * two vocabularies for one decision, and the second one is always the one nobody recognises.
 */
export const RENDERER_META: Record<RendererId, { label: string; hint: string }> = {
  monaco: { label: "Monaco", hint: "A real editor — typing, a caret, its own selection" },
  // NOT "CodeMirror": both of these are Monaco. The editor is Monaco's editor and this is
  // `monaco.editor.colorize`, its tokenizer with no editor behind it — same grammars, same colours,
  // ordinary DOM. CodeMirror is the markdown editor this block is sitting inside.
  codeview: { label: "Code view", hint: "Coloured, but not an editor — so a selection can be dragged through it" },
};

/** How a diff is laid out. Two readings of one comparison — see {@link MonacoDiffProps.sideBySide}. */
type DiffLayout = "inline" | "split";

/**
 * What a surface knows about how a change fared AFTER it was produced.
 *
 * The mark at the end of a collapsed row. A model proposing a file and the app accepting it are two
 * different events, and a reader looking at a list of proposals is owed both — a run whose every
 * file was refused looked identical to one whose every file landed, which is the failure this
 * exists to make impossible.
 */
export interface ChangeOutcome {
  ok: boolean;
  /** Why, when it is not ok — the hover text on the ✕. */
  note?: string;
}

/** `+12` in green and `−3` in red, or the honest nothing for a change that moved no lines. */
function Stats({ added, removed }: { added: number; removed: number }): JSX.Element {
  return (
    <span className="vv-stats">
      {added > 0 ? <span className="vv-add">+{added}</span> : null}
      {removed > 0 ? <span className="vv-del">−{removed}</span> : null}
      {added === 0 && removed === 0 ? <span className="vv-same">no change</span> : null}
    </span>
  );
}

/**
 * One file's row in the collapsed list, and its diff underneath when opened.
 *
 * The diff is mounted only while open. A Monaco diff editor is two models, a worker round trip and
 * a layout observer; fourteen of them mounted to draw a list of fourteen filenames is a second of
 * frozen UI to render something nobody has asked to see yet.
 */
function ChangeRow({
  change,
  outcome,
  action,
  layout,
  onLayout,
}: {
  change: Change;
  outcome?: ChangeOutcome | undefined;
  /** Whatever else this row can do — the sync's "open it as a draft", say. Outside the fold button. */
  action?: ReactNode;
  /**
   * Inline or split, and the setter — held by the LIST rather than the row.
   *
   * A layout preference is about how you read diffs, not about which file you happened to open, so
   * choosing it on one file and finding the next one back on the other arrangement is the control
   * forgetting what you just told it.
   */
  layout: DiffLayout;
  onLayout: (next: DiffLayout) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const stats = changeStats(change);
  const shown = outcome === undefined ? null : outcome.ok ? (
    <span className="vv-mark vv-ok" title="applied">
      <Icon name="check" />
    </span>
  ) : (
    // The reason is on the mark rather than in a line below it: the list is scanned down its right
    // edge, and a ✕ you have to scroll to explain is a ✕ that only says something went wrong.
    <span className="vv-mark vv-bad" title={outcome.note ?? "not applied"}>
      <Icon name="cross" />
    </span>
  );

  return (
    <div className={`vv-change${open ? " open" : ""}`}>
      <div className="vv-change-line">
        <button type="button" className="vv-change-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="ts-chev">
            <Icon name="chevron" />
          </span>
          <span className={`chip vv-action vv-action-${change.action}`}>{change.action}</span>
          <span className="vv-path ellip" title={change.path}>
            {change.path}
          </span>
          <Stats {...stats} />
          {shown}
        </button>
        {/* Beside the fold rather than inside it: a button nested in a button is not a control, and
            opening the diff and acting on the file are different intentions. */}
        {action}
      </div>
      {open ? (
        <div className="vv-change-body">
          {change.unshowable !== undefined ? (
            <p className="empty">{change.unshowable}</p>
          ) : (
            <>
              <div className="vv-diff-bar">
                <span className="vv-toggle" role="group" aria-label="How to lay the diff out">
                  <button
                    type="button"
                    className={layout === "inline" ? "on" : undefined}
                    aria-pressed={layout === "inline"}
                    title="One column: removals above additions"
                    onClick={() => onLayout("inline")}
                  >
                    Inline
                  </button>
                  <button
                    type="button"
                    className={layout === "split" ? "on" : undefined}
                    aria-pressed={layout === "split"}
                    title="Two columns: before and after"
                    onClick={() => onLayout("split")}
                  >
                    Side by side
                  </button>
                </span>
              </div>
              <Suspense fallback={<div className="diff-pane-loading">loading the diff editor…</div>}>
                {/* READ-ONLY. This view takes no decisions — see the module header — so the modified
                    side is not an editing surface here the way it is in the reviewer. */}
                <MonacoDiffPane
                  original={change.before ?? ""}
                  modified={change.after ?? ""}
                  mime={mimeOfPath(change.path)}
                  sideBySide={layout === "split"}
                  readOnly
                />
              </Suspense>
            </>
          )}
          {change.reason !== undefined ? <p className="sub vv-reason">{change.reason}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A set of file changes, collapsed — the list first, a diff on demand.
 *
 * The list IS the primary reading. "Which files, how big, did they land" is what somebody asks of a
 * change first and almost always the whole of what they need; the diff is the follow-up question,
 * and making it the default means scrolling past two thousand lines to find out there were four
 * files.
 */
export function ChangesView({
  changes,
  outcomes,
  rowAction,
  empty,
}: {
  changes: readonly Change[];
  /** How each change fared, by path. Absent ⇒ nothing has decided yet, so no marks. */
  outcomes?: Record<string, ChangeOutcome> | undefined;
  /** An extra control per row — see {@link ChangeRow}'s `action`. */
  rowAction?: ((change: Change) => ReactNode) | undefined;
  empty?: string;
}): JSX.Element {
  // Inline by default. These lists are read in a transcript row and beside a board — panels narrow
  // enough that two columns of code are two columns of ellipsis — and side by side is one press away
  // for the rewrite that earns it.
  const [layout, setLayout] = useState<DiffLayout>("inline");
  if (changes.length === 0) return <p className="empty">{empty ?? "No files change."}</p>;
  const total = totalStats(changes);
  return (
    <div className="vv-changes">
      <div className="vv-changes-head">
        <span className="sub">
          {changes.length} {changes.length === 1 ? "file" : "files"}
        </span>
        <Stats {...total} />
      </div>
      {changes.map((change) => (
        <ChangeRow
          key={change.id}
          change={change}
          outcome={outcomes?.[change.path]}
          layout={layout}
          onLayout={setLayout}
          {...(rowAction !== undefined ? { action: rowAction(change) } : {})}
        />
      ))}
    </div>
  );
}

/**
 * A picture, a clip, or a track.
 *
 * `controls` on both players and nothing autoplaying: a transcript that starts making noise because
 * you scrolled past a tool result is a transcript people close. The source is still in the toggle,
 * which is what answers "why is this blank" when a `src` does not resolve.
 */
function Media({ src, kind }: { src: string; kind: "image" | "video" | "audio" }): JSX.Element {
  if (kind === "image") return <img className="vv-media" src={src} alt="" />;
  if (kind === "video") return <video className="vv-media" src={src} controls />;
  return <audio className="vv-media vv-audio" src={src} controls />;
}

/** The raw form: text as written, or JSON pretty-printed. Never rendered, never reflowed. */
function Source({ value }: { value: unknown }): JSX.Element {
  return <pre className="vv-source">{jsonTextOf(value)}</pre>;
}

/**
 * A patch, read as the description of a change it is.
 *
 * Deliberately NOT the changeset viewer above, and the reason is in `shared/unifiedDiff.ts`: a
 * `Change` carries both full texts and its `after` is what gets written to disk on merge, while a
 * patch carries neither side. Feeding one through `ChangesView` would mean synthesizing content that
 * the rest of the system is entitled to believe. What is reused is the VOCABULARY — the same `+n −m`
 * counts, the same add and delete colours, the same collapsed-row-per-file shape — so a patch reads
 * the way a changeset reads without pretending to be one.
 *
 * Two things this shows that a re-diff of synthesized text could not. The line numbers are the
 * PATCH's own, so a hunk at line 412 says 412; and the space between hunks is drawn as a break
 * rather than closed up, because lines 130 and 400 are not neighbours and a viewer that ran them
 * together would be claiming they were.
 */
function PatchFileView({ file }: { file: PatchFile }): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <div className="vv-patch-file">
      <button type="button" className="vv-patch-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevron" className={open ? "vv-patch-chev open" : "vv-patch-chev"} />
        <span className={`vv-patch-act act-${file.action}`}>{file.action}</span>
        <span className="vv-patch-path">
          {file.fromPath !== undefined && file.fromPath !== file.path ? (
            <>
              <span className="sub">{file.fromPath}</span> →{" "}
            </>
          ) : null}
          {file.path === "" ? <span className="sub">(no file named)</span> : file.path}
        </span>
        <span className="grow" />
        <Stats added={file.added} removed={file.removed} />
      </button>
      {!open ? null : file.binary !== undefined ? (
        <p className="empty vv-patch-binary">{file.binary}</p>
      ) : (
        <div className="vv-patch-body">
          {file.hunks.map((hunk, h) => (
            <div className="vv-patch-hunk" key={h}>
              <div className="vv-patch-at">
                <span className="vv-patch-at-range">{hunk.header}</span>
                {hunk.section !== undefined ? <span className="vv-patch-at-sec">{hunk.section}</span> : null}
              </div>
              {hunk.lines.map((line, l) => (
                <div className={`vv-patch-line ln-${line.kind}`} key={l}>
                  {/* Both gutters always, so the columns line up down the whole hunk — an absent
                      number is a blank cell rather than a missing one. */}
                  <span className="vv-patch-no">{line.oldLine ?? ""}</span>
                  <span className="vv-patch-no">{line.newLine ?? ""}</span>
                  <span className="vv-patch-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
                  <span className="vv-patch-text">
                    {line.text}
                    {line.noNewline === true ? <span className="sub"> ⏎̸ no newline at end of file</span> : null}
                  </span>
                </div>
              ))}
            </div>
          ))}
          {file.hunks.length === 0 ? <p className="empty">No lines change — a rename or a mode change.</p> : null}
        </div>
      )}
    </div>
  );
}

/** The whole patch: a heading with the totals, then one collapsible block per file. */
export function PatchView({ files }: { files: readonly PatchFile[] }): JSX.Element {
  if (files.length === 0) return <p className="empty">Nothing in this patch could be read.</p>;
  const total = patchStats(files);
  return (
    <div className="vv-patch">
      <div className="vv-changes-head">
        <span className="sub">
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        <Stats {...total} />
      </div>
      {files.map((file, i) => (
        <PatchFileView key={`${file.path}:${i}`} file={file} />
      ))}
    </div>
  );
}

/**
 * Why a document could not be read as the data it claims to be.
 *
 * A panel rather than a fallback to the source, and that is the point of having it at all. The source
 * is one button away and always was; what a reader does not have is the parser's opinion, and a
 * broken document is the only time that opinion is interesting. Naming the line is most of the value
 * — "unexpected end of stream" is a shrug, "line 14, column 3" is somewhere to look.
 */
function ParseProblem({ message, spot }: { message: string; spot?: ParseSpot }): JSX.Element {
  return (
    <div className="vv-parse-error">
      <Icon name="alert" className="vv-parse-icon" />
      <span>
        {message}
        {spot !== undefined ? <span className="sub"> — line {spot.line}, column {spot.column}</span> : null}
      </span>
    </div>
  );
}

/**
 * How many rows are drawn before the reading stops being a reading.
 *
 * A CSV is routinely tens of thousands of rows, and a table that puts all of them in the DOM is a
 * pane that takes seconds to open and then scrolls badly — which is worse than the wall of commas it
 * replaced. Nothing is hidden by this: the cut is stated on screen, and the `Source` view underneath
 * still holds every byte.
 */
const TABLE_ROW_LIMIT = 500;

/**
 * Rows and columns.
 *
 * The FIRST row is drawn as the header, unconditionally, because there is no way to tell a header
 * from a first record and guessing wrong in the other direction is worse: a mis-styled first row is
 * still on screen and still readable, whereas a table that decided there was no header would put the
 * column names in a cell and leave the columns unlabelled. Ragged rows stay ragged — `parseDelimited`
 * does not pad them, and neither does this, so a row with a field too many is visible as exactly that.
 */
export function TableView({ rows }: { rows: readonly string[][] }): JSX.Element {
  if (rows.length === 0) return <p className="empty">No rows.</p>;
  const [head, ...body] = rows;
  const shown = body.slice(0, TABLE_ROW_LIMIT);
  return (
    <div className="vv-table-wrap">
      <table className="vv-table">
        <thead>
          <tr>
            {head!.map((cell, i) => (
              <th key={i}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > shown.length ? (
        <p className="sub vv-table-cut">
          {body.length - shown.length} more {body.length - shown.length === 1 ? "row" : "rows"} — the whole file is
          under Source.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The value as text, and NEVER `undefined`.
 *
 * `JSON.stringify` answers `undefined` rather than a string for everything JSON cannot express —
 * `undefined` itself, a function, a symbol — while TypeScript types the overload as returning
 * `string`, so the hole is invisible until something downstream reads `.length` off it. That is not
 * a hypothetical: `viewsFor` offers the JSON reading for a value that is absent and puts it FIRST,
 * so an empty slot lands here on the app's normal path.
 *
 * The word `undefined` rather than an empty string, because a blank panel reads as "the value is an
 * empty document" and this reads as what is actually the case — there is no value.
 */
function jsonTextOf(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "undefined";
}

/**
 * One node of a parsed document. Objects and arrays nest; everything else is a leaf.
 *
 * Lives HERE rather than in `fileSurfaces.tsx`, which is where it started and where it could only
 * be reached by opening a file. The `data` view is the same reading of the same thing — what does
 * this document DENOTE — so a `.yaml` file in the tree and a ```yaml block in an answer have to draw
 * it identically or one of them is lying about the other. `fileSurfaces` imports it back, which is
 * the direction that already existed for {@link TableView} and {@link PatchView}.
 */
function DataNode({ name, value }: { name: string | null; value: unknown }): JSX.Element {
  const label = name === null ? null : <span className="doc-key">{name}</span>;

  if (value !== null && typeof value === "object") {
    const entries: Array<[string, unknown]> = Array.isArray(value)
      ? value.map((entry, i) => [String(i), entry])
      : Object.entries(value as Record<string, unknown>);
    return (
      <li>
        {label}
        <span className="sub">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span>
        {entries.length > 0 ? (
          <ul className="doc-tree">
            {entries.map(([key, entry]) => (
              <DataNode key={key} name={key} value={entry} />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <li>
      {label}
      <code className={`doc-value doc-${value === null ? "null" : typeof value}`}>{JSON.stringify(value)}</code>
    </li>
  );
}

/**
 * The value a structured document denotes, as a tree.
 *
 * The `data` view's renderer, and the missing half of the reading `structured.ts` was added for. The
 * parse is done by the caller — three views need it and re-parsing per branch would parse the same
 * megabyte twice — so this is handed the value and nothing else.
 */
export function DataView({ value }: { value: unknown }): JSX.Element {
  return (
    <ul className="doc-tree doc-root">
      <DataNode name={null} value={value} />
    </ul>
  );
}

/**
 * A structured value, coloured — and told what its own keys MEAN where a schema says so.
 *
 * The `json` view used to be {@link Source} with a different name on it, which is why a value with
 * a schema and a value without one looked identical and why nothing was ever gained by toggling
 * between them. This is the reading: the same highlighter the schema editor paints with, plus the
 * one thing a viewer can offer that an editor mostly cannot — the description of each key, ghosted
 * at the end of its line, taken from the schema the value was declared against.
 *
 * The descriptions are the whole reason the schema is optional rather than required. Without one
 * this is still the coloured form, which beats a wall of grey; with one it answers "what is
 * `threshold`" without leaving the value.
 */
function JsonView({ value, schema }: { value: unknown; schema?: unknown }): JSX.Element {
  const text = useMemo(() => jsonTextOf(value), [value]);
  /**
   * What each key means, by the path of the object it sits in.
   *
   * Walks the schema itself rather than going through the registry the editor uses: this is handed a
   * schema, not a document type, so there is nothing to look up. Absent members simply answer
   * `undefined`, which the highlighter reads as "no hint on this line".
   */
  const describe = useMemo(() => {
    if (schema === null || typeof schema !== "object") return undefined;
    return (path: readonly string[], key: string): string | undefined => {
      let node: unknown = schema;
      for (const step of path) {
        const props = propertiesOf(node);
        // An array index is a step in the VALUE's path and not in the schema's — the members of an
        // array all share one declaration, so walking into `items` is how the two stay in step.
        node = /^\d+$/.test(step) ? itemsOf(node) : props?.[step];
        if (node === undefined) return undefined;
      }
      const target = propertiesOf(node)?.[key];
      if (target === null || typeof target !== "object") return undefined;
      const described = (target as Record<string, unknown>)["description"];
      return typeof described === "string" ? described : undefined;
    };
  }, [schema]);

  const lines = useMemo(() => highlightJson(text, describe), [text, describe]);
  return (
    <pre className="vv-source vv-json">
      {lines.map((line, i) => (
        <span className="code-line" key={i}>
          {line.tokens.map((token, j) => (
            <span key={j} className={`tok tok-${token.kind}`}>
              {token.text}
            </span>
          ))}
          {line.hint !== undefined ? (
            // The slot takes no width, so a description can never change where a line breaks — the
            // same arrangement the schema editor uses, and for the same reason.
            <span className="line-hint-slot">
              <span className="line-hint">{line.hint.length > 80 ? `${line.hint.slice(0, 80)}…` : line.hint}</span>
            </span>
          ) : null}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

/** A schema node's declared members, or `undefined` for anything that has none. */
function propertiesOf(schema: unknown): Record<string, unknown> | undefined {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const props = (schema as Record<string, unknown>)["properties"];
  return props !== null && typeof props === "object" && !Array.isArray(props)
    ? (props as Record<string, unknown>)
    : undefined;
}

/** What an array's members are declared as. */
function itemsOf(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  return (schema as Record<string, unknown>)["items"];
}

/**
 * HTML a model produced, rendered in a sandbox.
 *
 * An `iframe` with no permissions rather than `dangerouslySetInnerHTML`: this is a privileged
 * renderer process, and the markdown path can afford an in-place sanitizer only because its parser
 * is configured to emit no HTML at all. Arbitrary HTML from a model has no such floor — `sandbox`
 * with an empty allow list means no scripts, no forms, no navigation and no same-origin access,
 * which is the only posture under which showing it is a rendering rather than an execution.
 *
 * A `srcdoc` frame also INHERITS this window's CSP, which is `script-src 'self'` — so even were the
 * sandbox opened, nothing in here could run. That is a second floor under the first, and it is the
 * reason {@link InteractiveArtifact} cannot be a variant of this component.
 */
function Html({ text }: { text: string }): JSX.Element {
  return <iframe className="vv-html" sandbox="" srcDoc={text} title="Rendered HTML" />;
}

/**
 * An artifact that RUNS — the interactive case, and the only thing in this app that executes code a
 * model wrote.
 *
 * Loaded from `jaira-artifact:` rather than `srcdoc`, because a `srcdoc` document inherits this
 * window's CSP and would have every inline script refused. The scheme's handler serves the bytes with
 * a policy of its own: inline script permitted, and network, frames, forms and base-uri all denied.
 *
 * `sandbox="allow-scripts"` WITHOUT `allow-same-origin`. The two together are not additive — a frame
 * granted both can reach its own `sandbox` attribute and remove it — so this pair is the whole
 * posture, and the missing flag matters more than the present one. The frame therefore has an opaque
 * origin, which is what keeps it away from this window's storage and DOM.
 *
 * ## Why the bridge fills the composer instead of sending
 *
 * A page a model wrote posting straight into a live run is closer to `bash` than to rendering: it
 * would let generated markup drive the conversation that generated it. So a message lands in the
 * composer, where a person reads it and presses send. That keeps the useful half — a button in a
 * mockup that says what it would ask — without the half nobody asked for.
 *
 * `event.source` is what authenticates it, NOT `event.origin`: an opaque origin serialises to the
 * string `"null"`, which every other sandboxed frame also reports, so matching on it would accept a
 * message from any of them. Identity here is the window object itself.
 */
function InteractiveArtifact({ url, onPrompt }: { url: string; onPrompt?: ((text: string) => void) | undefined }): JSX.Element {
  const frame = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (onPrompt === undefined) return;
    const onMessage = (event: MessageEvent): void => {
      // The window that sent it, not the origin it claims — see the component note.
      if (frame.current === null || event.source !== frame.current.contentWindow) return;
      const data = event.data as { type?: unknown; text?: unknown } | null;
      if (data === null || typeof data !== "object" || data.type !== "prompt") return;
      if (typeof data.text !== "string" || data.text.trim() === "") return;
      // Bounded: this is a message from a page that may have been generated wrong, and a composer is
      // not the place to discover that something posted a megabyte into it.
      onPrompt(data.text.slice(0, 4000));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onPrompt]);

  return <iframe className="vv-html" ref={frame} sandbox="allow-scripts" src={url} title="Interactive artifact" />;
}

/**
 * What a value should be called once it is a file on somebody's disk.
 *
 * An artifact already has a name and it is the one the producer chose, so that wins outright. For
 * everything else the name is invented, and the only part of it that carries information is the
 * EXTENSION — `value.md` and `value.json` open in different things, and a download with no extension
 * opens in nothing. The rest is a placeholder, which is honest: this value never had a name.
 */
function fileNameOf(artifactPath: string | undefined, mime: string | undefined, isText: boolean): string {
  if (artifactPath !== undefined && artifactPath !== "") return artifactPath.slice(artifactPath.lastIndexOf("/") + 1);
  const ext = mime === undefined ? undefined : extensionForMime(mime);
  return `value.${ext ?? (isText ? "txt" : "json")}`;
}

/** UTF-8 text as base64, which is what `shell:saveFile` takes. */
function base64Of(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * A value, in the best view that applies, with the others a click away.
 *
 * `hint` is what the caller already knows — a file's MIME type, a slot's schema. Absent, the value
 * is sniffed, and the sniffer only ever OFFERS a view: the source is always in the list and always
 * one press away, so a wrong guess costs a button rather than the content.
 */
export function ValueView({
  value,
  hint,
  label,
  actions,
  outcomes,
  serve,
  onPrompt,
  edit,
  diff,
  view: controlled,
  chrome,
  inline,
}: {
  value: unknown;
  hint?: ViewHint | undefined;
  /** A word above the value saying what it is — `arguments`, `result`, `output`. */
  label?: string | undefined;
  /** Anything else that belongs in the header row, to the right of the toggle. */
  actions?: ReactNode;
  /** Passed through to {@link ChangesView} when the value turns out to be a set of files. */
  outcomes?: Record<string, ChangeOutcome> | undefined;
  /**
   * How to have an artifact SERVED to a frame, for the interactive case — see the module note.
   *
   * Supplied by the surface rather than looked up here, because granting one takes a task and a
   * project and a `ValueView` has neither: it is handed a value. Absent ⇒ no grant is possible, and
   * an interactive artifact degrades to the static rendering, which shows the same page with its
   * scripts inert. Degrading is the correct failure: the content is still what it is.
   */
  serve?: ((path: string) => Promise<ServedArtifact>) | undefined;
  /** Where a message from an interactive artifact goes. Absent ⇒ the bridge is not connected. */
  onPrompt?: ((text: string) => void) | undefined;
  /**
   * Make the views WRITABLE rather than adding a second mode beside them.
   *
   * A "read or write" switch next to a "rendered or source" switch asks the same person the same
   * kind of question twice, and the two answers are not independent: what you want is to edit the
   * rendering you are looking at. So editability is a property of the value, supplied here, and
   * each view renders its editable counterpart when it has one — markdown becomes a live-preview
   * editor, source becomes a text editor, and a view with no editable form (a picture, a diff)
   * simply stays as it is.
   */
  edit?: ((next: string) => void) | undefined;
  /**
   * A change to show ALONGSIDE the value, for the views that can.
   *
   * Handed down rather than switched to, which is the whole point: a caller that swapped this
   * component out for a diff viewer the moment an edit existed re-mounted the editor on the first
   * keystroke, and the caret went with it. Only the markdown view reads it today.
   */
  diff?: MarkdownDiff | undefined;
  /**
   * Which view to show, decided by the caller — for a surface that draws the toggle itself.
   *
   * The transcript is the one that does. A message already has a row of controls under it, and a
   * second toggle inside the value would be the same question asked twice in the same two inches;
   * so the rail owns the choice and hands the answer down. Ignored where it names a view this value
   * does not have, which is what keeps a remembered pick from surviving a change of type.
   */
  view?: ViewId | undefined;
  /** `false` ⇒ draw no header at all. For a caller that has somewhere better to put the controls. */
  chrome?: boolean | undefined;
  /**
   * This value is EMBEDDED in a document, so it must take its height from its own contents.
   *
   * A value in a panel fills the panel — the container is the answer, and asking the text would make
   * the panel jump as it changed. A fenced block inside a markdown file has no container height to
   * fill, and an editor waiting to be given one draws a single line of code in a screenful of empty
   * grey. That was the whole of the defect; the flag is how a caller says which situation it is in.
   */
  inline?: boolean | undefined;
}): JSX.Element {
  const views = viewsFor(value, hint ?? {});
  const [picked, setPicked] = useState<ViewId | null>(null);
  /**
   * Which renderer each view is drawn by, where the view has a choice — see {@link renderersFor}.
   *
   * Per VIEW rather than one setting for the value, because the choice does not travel: asking for
   * the plain reading of the code says nothing about how you want the rendered markdown drawn. An
   * absent entry is the editor, which is what every one of these did before the choice existed.
   */
  const [drawnBy, setDrawnBy] = useState<Partial<Record<ViewId, RendererId>>>({});
  /**
   * The renderer menu, as the point it was opened at.
   *
   * A {@link MenuAnchor}, drawn by the app's own {@link ContextMenu}, because the bespoke popover
   * this replaced was `position: absolute` inside `.vv-head` — and a value view sits inside a fence
   * widget, inside `.cm-scroller`, inside a `.config-half` that is `overflow: hidden` on purpose.
   * A menu opened on a block near the bottom of the pane was cut off by every one of them.
   *
   * `ContextMenu` is `position: fixed` and clamps itself to the window, so none of those clip it. It
   * also brings Escape, outside-click and scrolled-away dismissal, which the popover had grown its
   * own half-versions of.
   */
  const [rendMenu, setRendMenu] = useState<MenuAnchor | null>(null);
  // The caller's answer first, then this component's own, then whatever leads. Each step only counts
  // if the view still applies: a value whose type just changed has a different list, and a pick that
  // is no longer on it is a pick at something that is not there.
  const view =
    controlled !== undefined && views.includes(controlled)
      ? controlled
      : picked !== null && views.includes(picked)
        ? picked
        : views[0]!;


  /** Where "open in the context panel" sends this, when there is a panel. See `valuePanel.ts`. */
  const panel = useValuePanel();
  const [more, setMore] = useState<MenuAnchor | null>(null);

  /**
   * An artifact is read as what it CARRIES — except on the raw view, where the envelope is the point.
   *
   * That exception is the whole reversibility argument applied one level up: the rendered views
   * answer "what did it make", and `JSON` answers "what exactly did the producer hand over, and what
   * did it claim the type was" — which is the question you have the moment the rendering looks wrong.
   */
  const artifact = artifactOf(value);
  const showing = artifact?.content !== undefined && view !== "json" ? artifact.content : value;
  // The artifact's declared type wins over the caller's hint, because it is the more specific
  // statement: the hint describes the slot, the envelope describes the bytes in it.
  const mime = (view === "json" ? undefined : artifact?.mime) ?? hint?.mime;

  /**
   * Which renderer is drawing the view on screen, and what that does to editability.
   *
   * Choosing the plain renderer IS choosing not to edit — the two are the same fact, which is why
   * there is no second switch. `writing` is the edit callback every view that has a choice reads
   * instead of `edit`, so one line here decides it for all three rather than each branch deciding
   * again and one of them forgetting.
   *
   * Views with no choice keep `edit` exactly as they had it.
   */
  const editable = edit !== undefined;
  /**
   * This person's standing answer for the type, behind whatever they picked on THIS block.
   *
   * The menu is a per-block override and stays one — it is opened when a particular block is the
   * wrong shape for what you are doing. What it lacked was a default to override: somebody who
   * always wants coloured text rather than an editor had to say so once per block, forever. That
   * default is the TEXT renderer in Appearance — the same one the Files panel opens the file with,
   * because "draw my source as coloured text" is one statement about a type rather than two.
   */
  const chosenRenderers = useRenderChoice();
  const preferred = textRendererFor(mime, chosenRenderers);
  const renderer: RendererId = drawnBy[view] ?? preferred ?? "monaco";
  const plainly = renderer === "codeview" && renderersFor(view, mime, editable).length > 1;
  const writing = plainly ? undefined : edit;

  /**
   * The address an interactive artifact is framed from, once it has been granted one.
   *
   * Asked for only when the value CLAIMS to be interactive and a grant is possible; the answer is
   * still checked, because the record is the authority on whether anything may run and this side is
   * only reporting what a tool result said. A refusal leaves this null and the static rendering
   * stands, which is why nothing here throws.
   */
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const wantsFrame = artifact?.interactive === true && artifact.path !== undefined && serve !== undefined;
  const framePath = wantsFrame ? artifact.path : undefined;
  useEffect(() => {
    if (framePath === undefined || serve === undefined) {
      setFrameUrl(null);
      return;
    }
    let live = true;
    void serve(framePath)
      .then((granted) => {
        // The GRANT decides, not the value we were handed: a record that never claimed to be
        // interactive is shown statically however the envelope described itself.
        if (live) setFrameUrl(granted.interactive ? granted.url : null);
      })
      .catch(() => {
        if (live) setFrameUrl(null);
      });
    return () => {
      live = false;
    };
  }, [framePath, serve]);

  /**
   * The value a structured DOCUMENT denotes — see `shared/structured.ts`.
   *
   * Done here, once, rather than inside the branches that need it, because three of them do: `data`
   * shows it, `table` lays it out, and `form` fills its fields from it. Memoised on the text because
   * this is drawn once per tool result down a whole transcript and re-parsing a document on every
   * hover of a button beside it is the kind of cost nobody profiles until it is everywhere.
   *
   * Only for a view that will actually READ it, which is the other half of the same argument. A
   * transcript full of YAML fences sitting on their `code` view would otherwise parse every one of
   * them to draw a button nobody has pressed — the offer costs nothing (`viewsFor` decides it from
   * the type alone) and the parse should not either until it is asked for.
   *
   * Null for anything that is not a structured document — a value that arrived parsed already has
   * its readings, and this is only the bridge for the ones that arrive as text.
   */
  const wantsParse = view === "data" || view === "table" || view === "form";
  const parsed = useMemo<ParsedStructure | null>(() => {
    if (!wantsParse || typeof showing !== "string") return null;
    const format = structuredFormatOf(mime);
    if (format === undefined) return null;
    return parseStructured(showing, format, delimiterOf(mime));
  }, [wantsParse, showing, mime]);

  /**
   * The patch this text describes, when the patch view is the one showing.
   *
   * Its own memo rather than a case inside {@link parsed}: a patch is a different question with a
   * different parser, and a value is in principle a candidate for both readings at once. Gated on
   * the view for the same reason that one is — a transcript full of diffs would otherwise parse
   * every one of them to draw a button nobody has pressed.
   */
  const patch = useMemo<PatchFile[]>(
    () => (view === "patch" && typeof showing === "string" ? parseUnifiedDiff(showing) : []),
    [view, showing],
  );

  const body = ((): ReactNode => {
    // `value`, not `showing`: a set of changes is never an artifact's payload, and reading the
    // envelope for one would be asking a different question of a different value.
    if (view === "changes") return <ChangesView changes={changesOf(value) ?? []} outcomes={outcomes} />;
    if (view === "media") {
      const src = mediaSrcOf(showing, mime);
      const kind = mediaKindOf(mime);
      // Both are guaranteed by `viewsFor` — it only offers this view when a player has something to
      // point at — and checked anyway, because the toggle's state outlives a value that changed.
      if (src !== undefined && kind !== undefined) return <Media src={src} kind={kind} />;
      return <Source value={showing} />;
    }
    if (view === "markdown") {
      // WHICH renderer is not decided here — see `markdownDocument.tsx`. This says what it has and
      // what may be done with it, and that is the whole of a caller's business.
      // A change drawn over the document FORCES the editing renderer — see `documents.tsx` — so it
      // goes with the editor. Asked for the plain reading, the plain reading is what this gives.
      return (
        <MarkdownDocument
          text={String(showing)}
          {...(writing === undefined ? {} : { onChange: writing })}
          {...(diff === undefined || plainly ? {} : { diff })}
        />
      );
    }
    if (view === "html") {
      // The frame only when one was actually granted; otherwise the same page, inert.
      if (frameUrl !== null) return <InteractiveArtifact url={frameUrl} onPrompt={onPrompt} />;
      return <Html text={String(showing)} />;
    }
    if (view === "code") {
      // Read with the tokenizer, edited with the editor — `documents.tsx` decides which, and this
      // says only what it has. It used to fall PAST this branch when the value was editable, because
      // the code view had no renderer that could accept a keystroke; it has one now, so the value
      // that said it could be changed is coloured and changeable in the same place.
      return (
        <CodeDocument
          text={String(showing)}
          mime={mime ?? "text/plain"}
          {...(writing === undefined ? {} : { onChange: writing })}
          {...(inline === true ? { autoHeight: true } : {})}
        />
      );
    }
    /**
     * A PATCH, as the change it describes — see {@link PatchView}.
     *
     * Its parse is `patch` above rather than {@link parsed}: a diff is a different grammar answering
     * a different question, and `parseUnifiedDiff` returns an empty list rather than a complaint, so
     * a text the sniffer offered this for and that turns out to hold no hunks says so plainly.
     */
    if (view === "patch") {
      if (patch.length === 0) return <p className="empty">No hunks in this patch.</p>;
      return <PatchView files={patch} />;
    }
    /**
     * Rows and columns — the same table `fileSurfaces.tsx` draws a `.csv` with.
     *
     * A parse that failed is REPORTED rather than fallen back from, which is the whole reason
     * `parseStructured` returns a complaint instead of throwing: the reader asked what this document
     * denotes, and "line 14, column 3" is the answer. Falling back to the source would answer a
     * question nobody asked and hide the one they did.
     */
    if (view === "table") {
      if (parsed !== null && !parsed.ok) {
        return <ParseProblem message={parsed.message} {...(parsed.spot !== undefined ? { spot: parsed.spot } : {})} />;
      }
      const rows = parsed?.ok === true && Array.isArray(parsed.value) ? (parsed.value as string[][]) : [];
      return <TableView rows={rows} />;
    }
    /** The value the document DENOTES — the reading `shared/structured.ts` exists for. */
    if (view === "data") {
      if (parsed !== null && !parsed.ok) {
        return <ParseProblem message={parsed.message} {...(parsed.spot !== undefined ? { spot: parsed.spot } : {})} />;
      }
      // A value that arrived parsed already (never a string) is its own denotation.
      return <DataView value={parsed?.ok === true ? parsed.value : showing} />;
    }
    if (view === "form") {
      // A structured DOCUMENT is filled in from its parse rather than from its text: handing a form
      // the YAML source would put the whole file in the first field it found a string slot for.
      if (parsed !== null && !parsed.ok) {
        return <ParseProblem message={parsed.message} {...(parsed.spot !== undefined ? { spot: parsed.spot } : {})} />;
      }
      const filling = parsed?.ok === true ? parsed.value : showing;
      // Read-only, which the form already knows how to be (`SchemaFormContext.disabled`) — this is
      // a reading of a value, not an editor for it, and `edit` here is a text callback the form has
      // no way to honour. One surface with a flag rather than a viewer that drifts from the editor.
      return (
        <Suspense fallback={<Source value={showing} />}>
          <div className="vv-form">
            <SchemaForm
              schema={(hint?.schema ?? {}) as never}
              value={filling}
              onChange={() => undefined}
              // `isSet` answers false for everything, which is not a lie by omission — it is the
              // only true answer here. The tag it drives means "this LAYER states this value", a
              // fact about editing a config file, and its default (`the key is present`) would put
              // a "set here" chip beside every field of a value nobody is editing at all.
              ctx={{ path: "", disabled: true, reading: true, isSet: () => false }}
            />
          </div>
        </Suspense>
      );
    }
    // The VIEWER, not the serialization — see {@link JsonView}. `text` falls through to `Source`
    // below, which is what keeps "what was actually written down" one click away from it.
    if (view === "json") return <JsonView value={showing} {...(hint?.schema !== undefined ? { schema: hint.schema } : {})} />;
    // `writing`, not `edit` — asked for the plain renderer, this view is the `<pre>` below, which is
    // the difference that matters: a `<textarea>` is a replaced element, so a selection cannot be
    // dragged into or through one any more than it can through Monaco.
    if (writing !== undefined && typeof showing === "string") {
      const change = writing;
      /**
       * Tall enough for what is in it, when it is EMBEDDED in a document.
       *
       * A textarea's height is its `rows`, and the default is two — which a stylesheet then stretched
       * to a band. In a panel that is right: the box is a place to type and it should fill what it
       * was given. Inside a fenced block it is a document inside a document, and a two-line block
       * drew a screenful of empty box below the text.
       *
       * Capped, because a four-hundred-line block embedded in prose is not something to render
       * whole — past the cap it scrolls, which is what a textarea does anyway.
       */
      const rows = inline === true ? Math.min(Math.max(showing.split("\n").length, 1), 24) : undefined;
      return (
        <textarea
          className={inline === true ? "code-editor vv-edit vv-edit-fit" : "code-editor vv-edit"}
          value={showing}
          spellCheck={false}
          {...(rows === undefined ? {} : { rows })}
          onChange={(e) => change(e.target.value)}
        />
      );
    }
    return <Source value={showing} />;
  })();

  /**
   * What a download of this would be CALLED. The bytes are not made until somebody asks — see below.
   *
   * Named from the view that is showing, not from the value: `showing` is a string for every rendered
   * view and the whole envelope for `json`, so downloading from the JSON view gets `value.json` and
   * downloading from the rendered view gets the document. Saving what is on screen is the only rule
   * that surprises nobody.
   */
  const downloadName = fileNameOf(artifact?.path, mime, typeof showing === "string");

  /**
   * The overflow: what belongs to this value without belonging in a row of buttons.
   *
   * Behind a `…` rather than beside the toggle, because the toggle answers one question — how do I
   * want to read this — and a fourth button that saved a file would be the first one in that group
   * that did not change what is on screen. These are verbs; those are views.
   */
  const openMore = (rect: DOMRect): void => {
    setMore({
      // Under the button and aligned to its right edge, so the menu grows into the pane rather than
      // over the value it is about.
      x: rect.right - MENU_WIDTH,
      y: rect.bottom + 2,
      items: [
        {
          label: "Download…",
          note: downloadName,
          // Serialised HERE rather than per render. This is drawn once per tool call down a whole
          // transcript, and base64-encoding every payload on screen on the chance that one of them
          // gets saved is a cost paid continuously for something that happens rarely.
          onSelect: () => {
            void invoke("shell:saveFile", { name: downloadName, data: base64Of(jsonTextOf(showing)) }).catch(
              () => undefined,
            );
          },
        },
        ...(panel === null
          ? []
          : [
              {
                label: "Open in context panel",
                separator: true,
                note: "keeps it on screen while you carry on",
                onSelect: () =>
                  panel.open({
                    title: artifact?.path ?? artifact?.name ?? label ?? "Value",
                    value,
                    ...(hint !== undefined ? { hint } : {}),
                    ...(label !== undefined ? { label } : {}),
                    ...(serve !== undefined ? { serve } : {}),
                    ...(onPrompt !== undefined ? { onPrompt } : {}),
                  }),
              },
            ]),
      ],
    });
  };

  return (
    /**
     * Inline, the controls sit OVER the block rather than on a shelf above it.
     *
     * A value in a panel can afford a header row: it is the whole surface, and a strip along its top
     * is where its controls belong. A fenced block is three lines inside a paragraph, and the same
     * strip is a second box stacked on the first — most of a block's height spent on chrome, and a
     * band of panel colour cutting the document in half wherever code appears.
     *
     * So the row is lifted into the block's top-right corner and the body starts at the top. It
     * overlaps the first line, which is the trade: the corner of a code block is nearly always
     * shorter than the pane, and buying the space back is worth more than the few characters it
     * covers when it is not.
     */
    <div className={inline === true ? "vv vv-inline" : "vv"}>
      {chrome !== false && (label !== undefined || views.length > 1 || actions !== undefined) ? (
        <div className="vv-head">
          {label !== undefined ? <span className="vv-label">{label}</span> : null}
          <span className="grow" />
          {actions}
          {/* Only where there is a choice — see the module header on why a dead control is worse
              than none. */}
          {views.length > 1 ? (
            <span className="vv-toggle" role="group" aria-label="How to show this">
              {views.flatMap((id) => {
                const choices = renderersFor(id, mime, editable);
                const label = (
                  <button
                    key={id}
                    type="button"
                    className={id === view ? "on" : undefined}
                    title={VIEW_META[id].hint}
                    aria-pressed={id === view}
                    onClick={() => {
                      setPicked(id);
                      setRendMenu(null);
                    }}
                  >
                    {VIEW_META[id].label}
                  </button>
                );
                // Only where there is a second renderer to pick — the same rule as the toggle
                // itself, one level down. See `renderersFor`.
                if (choices.length < 2) return [label];
                return [
                  label,
                  <button
                    key={`${id}-arrow`}
                    type="button"
                    className={`vv-arrow${id === view ? " on" : ""}`}
                    title="Which renderer draws this"
                    aria-haspopup="menu"
                    aria-expanded={rendMenu !== null && rendMenu.origin === undefined ? false : undefined}
                    aria-label={`Renderer for ${VIEW_META[id].label}`}
                    onClick={(e) => {
                      // Opening the menu also SELECTS the view. A choice about how to draw
                      // something you are not looking at is a choice you cannot see the result of.
                      setPicked(id);
                      const at = e.currentTarget.getBoundingClientRect();
                      const chosen = drawnBy[id] ?? preferred ?? "monaco";
                      setRendMenu({
                        x: at.left,
                        y: at.bottom + 3,
                        origin: e.currentTarget,
                        title: "Drawn by",
                        items: choices.map((how) => ({
                          label: RENDERER_META[how].label,
                          checked: chosen === how,
                          onSelect: () => setDrawnBy((was) => ({ ...was, [id]: how })),
                        })),
                      });
                    }}
                  >
                    ▾
                  </button>,
                ];
              })}
            </span>
          ) : null}
          <button
            type="button"
            className="vv-more"
            title="What else can be done with this"
            aria-haspopup="menu"
            aria-expanded={more !== null}
            onClick={(e) => openMore(e.currentTarget.getBoundingClientRect())}
          >
            …
          </button>
        </div>
      ) : null}
      <div className="vv-body">{body}</div>
      {more !== null ? <ContextMenu anchor={more} onClose={() => setMore(null)} /> : null}
      {rendMenu !== null ? <ContextMenu anchor={rendMenu} onClose={() => setRendMenu(null)} /> : null}
    </div>
  );
}
