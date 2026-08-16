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
 * ## Why the diff view lives here rather than in the reviewer
 *
 * `changesetReview.tsx` reviews a changeset: it decides, it edits, it submits. Reading one is a
 * different act with a different audience — a model just produced fourteen files and the question
 * is "what did it do", not "which of these do I accept". So the reading view is its own thing, it
 * takes no decisions, and it is available wherever a value happens to be a set of files: in the
 * transcript beside the call that produced them, in the sync report, in a structured output.
 */
import { lazy, Suspense, useState, type JSX, type ReactNode } from "react";
import type { Change, ViewHint, ViewId } from "@jaira/shared/browser";
import { changeStats, changesOf, mediaKindOf, mediaSrcOf, mimeOfPath, totalStats, viewsFor } from "@jaira/shared/browser";
import { Markdown } from "./markdown";
import { Icon } from "./icons";

/**
 * Loaded on first expand, never with the view — the same rule the reviewer follows.
 *
 * Monaco is megabytes and touches `window` at module scope, so a static import would both cost the
 * transcript that weight to draw a list of filenames and drag a browser global into every node-side
 * test that renders one. A collapsed list is the default reading (see {@link ChangesView}); the
 * editor arrives when somebody asks to see a diff.
 */
const MonacoDiffPane = lazy(() => import("./monacoDiff").then((m) => ({ default: m.MonacoDiffPane })));
const MonacoCodePane = lazy(() => import("./monacoDiff").then((m) => ({ default: m.MonacoCodePane })));

/** What each view is called on its button, and what the button's tooltip says it does. */
const VIEW_META: Record<ViewId, { label: string; hint: string }> = {
  changes: { label: "Files", hint: "The files this changes, as a diff" },
  media: { label: "Preview", hint: "Play or show it" },
  markdown: { label: "Rendered", hint: "As markdown, rendered" },
  html: { label: "Rendered", hint: "As HTML, rendered" },
  code: { label: "Code", hint: "Highlighted, in an editor" },
  text: { label: "Source", hint: "The text exactly as it was produced" },
  json: { label: "JSON", hint: "The value as JSON" },
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
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre className="vv-source">{text}</pre>;
}

/**
 * HTML a model produced, rendered in a sandbox.
 *
 * An `iframe` with no permissions rather than `dangerouslySetInnerHTML`: this is a privileged
 * renderer process, and the markdown path can afford an in-place sanitizer only because its parser
 * is configured to emit no HTML at all. Arbitrary HTML from a model has no such floor — `sandbox`
 * with an empty allow list means no scripts, no forms, no navigation and no same-origin access,
 * which is the only posture under which showing it is a rendering rather than an execution.
 */
function Html({ text }: { text: string }): JSX.Element {
  return <iframe className="vv-html" sandbox="" srcDoc={text} title="Rendered HTML" />;
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
}: {
  value: unknown;
  hint?: ViewHint | undefined;
  /** A word above the value saying what it is — `arguments`, `result`, `output`. */
  label?: string | undefined;
  /** Anything else that belongs in the header row, to the right of the toggle. */
  actions?: ReactNode;
  /** Passed through to {@link ChangesView} when the value turns out to be a set of files. */
  outcomes?: Record<string, ChangeOutcome> | undefined;
}): JSX.Element {
  const views = viewsFor(value, hint ?? {});
  const [picked, setPicked] = useState<ViewId | null>(null);
  const view = picked !== null && views.includes(picked) ? picked : views[0]!;

  const mime = hint?.mime;
  const body = ((): ReactNode => {
    if (view === "changes") return <ChangesView changes={changesOf(value) ?? []} outcomes={outcomes} />;
    if (view === "media") {
      const src = mediaSrcOf(value, mime);
      const kind = mediaKindOf(mime);
      // Both are guaranteed by `viewsFor` — it only offers this view when a player has something to
      // point at — and checked anyway, because the toggle's state outlives a value that changed.
      if (src !== undefined && kind !== undefined) return <Media src={src} kind={kind} />;
      return <Source value={value} />;
    }
    if (view === "markdown") return <Markdown text={String(value)} />;
    if (view === "html") return <Html text={String(value)} />;
    if (view === "code") {
      return (
        <Suspense fallback={<div className="diff-pane-loading">loading the editor…</div>}>
          <MonacoCodePane text={String(value)} mime={mime ?? "text/plain"} />
        </Suspense>
      );
    }
    return <Source value={value} />;
  })();

  return (
    <div className="vv">
      {label !== undefined || views.length > 1 || actions !== undefined ? (
        <div className="vv-head">
          {label !== undefined ? <span className="vv-label">{label}</span> : null}
          <span className="grow" />
          {actions}
          {/* Only where there is a choice — see the module header on why a dead control is worse
              than none. */}
          {views.length > 1 ? (
            <span className="vv-toggle" role="group" aria-label="How to show this">
              {views.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={id === view ? "on" : undefined}
                  title={VIEW_META[id].hint}
                  aria-pressed={id === view}
                  onClick={() => setPicked(id)}
                >
                  {VIEW_META[id].label}
                </button>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="vv-body">{body}</div>
    </div>
  );
}
