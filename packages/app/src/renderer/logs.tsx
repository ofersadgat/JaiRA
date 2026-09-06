/**
 * What the app did, and what went wrong doing it.
 *
 * There was nowhere to look. No logger, no console output, no channel — an IPC handler's failure
 * died in a renderer catch, a workflow that would not load was swallowed so the board did not blank,
 * and an agent's stderr went to `/dev/null`. Each of those silences is defensible on its own and
 * together they meant a broken machine had no story.
 *
 * Three sources, one list, because they answer one question — "what happened, and where do I look
 * next" — and three panels nobody correlates would answer it worse. What makes a row useful is its
 * POINTERS: `taskId` opens the task, `jobId` opens what that process printed.
 *
 * ## A table: one line per entry, newest at the top
 *
 * A row is the message as it was written, on ONE line, and clicking it UNFOLDS that row — the whole
 * message, wrapped where it was clipped, with the stack under it. Wrapping every row instead was the
 * obvious thing and it was wrong: a list where one entry is nine lines tall and the next is one has
 * no scannable shape at all, and the entries that wrap are exactly the ones carrying a stack, so the
 * noisiest rows crowded out the rest.
 *
 * The row itself grows rather than a copy of the message appearing beneath it. A second copy is the
 * easier build and it reads as a different thing from the row it came from — and for the many
 * entries whose message already fitted, it is the same sentence printed twice.
 *
 * Newest first, because that is the end a log is read from. Older pages arrive as the list is
 * scrolled (see {@link LogsPanelProps.onOlder}) rather than being held in memory — the mirror on
 * disk spans every launch, and none of it needs to be in this process to be reachable.
 *
 * ## Columns, not a row of words
 *
 * Every row is the same grid, declared once as `--log-cols` and shared with the header. Content-sized
 * columns were the obvious build and they defeat the point of columns: `run` and
 * `jaira.persistence.views` are one cell in two rows, so every message started at a different place
 * and the eye had to find the sentence again on each line. Fixed cells clip, which is why the source
 * carries a `title` and the message unfolds — a column that is honest about being narrow is worth
 * more than one that is wide because of the worst row in the page.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  LOG_SOURCES,
  type JobOutputChunk,
  type LogEntry,
  type LogLevel,
  type LogOverride,
  type LogPolicy,
  type LogQuery,
} from "@jaira/shared/browser";

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

/**
 * What a row is hiding — the whole message, the stack, the fields.
 *
 * `detail` has been arriving on entries since there was a log, and this panel drew none of it: every
 * crash in the file carried the frames that named the line, and the only way to read them was to
 * open the NDJSON by hand. The message was the entry as far as anyone could tell — which is how a
 * `TypeError` and a missing file came to look like the same kind of thing.
 *
 * The STACK is lifted out and printed as itself. Inside JSON it is one long line with its newlines
 * spelled out, which is the form it is least readable in; whatever else the detail holds is printed
 * beside it as JSON, which is what that is.
 */
function Detail({ detail }: { detail: unknown }): JSX.Element | null {
  const { stack, rest } = useMemo((): { stack?: string; rest?: unknown } => {
    if (detail === null || detail === undefined || typeof detail !== "object" || Array.isArray(detail)) {
      return detail === undefined ? {} : { rest: detail };
    }
    const { stack: held, ...others } = detail as Record<string, unknown>;
    return {
      ...(typeof held === "string" ? { stack: held } : {}),
      ...(Object.keys(others).length > 0 ? { rest: others } : {}),
    };
  }, [detail]);
  // Nothing under this one. The row above has already unfolded to show the whole message, which for
  // most entries IS the whole entry — an empty box beneath it would be a promise of more that is not
  // there.
  if (stack === undefined && rest === undefined) return null;
  return (
    <div className="log-detail">
      {stack !== undefined ? <pre className="log-stack">{stack}</pre> : null}
      {rest !== undefined ? <pre className="log-fields">{JSON.stringify(rest, null, 2)}</pre> : null}
    </div>
  );
}

/**
 * When it happened, as TWO columns.
 *
 * The date is its own cell and is empty for today, which is the only arrangement that satisfies both
 * halves of the problem: an entry paged in from last Tuesday has to say so — `14:02:11` alone is a
 * claim about this afternoon — and a session's own rows must not be shifted sideways by the ones
 * around them. One column carrying sometimes-a-date-and-sometimes-not is ragged by construction; two
 * columns, each fixed, are not.
 */
function stamp(at: number): { day: string; time: string } {
  const when = new Date(at);
  return {
    day: when.toDateString() === new Date().toDateString() ? "" : when.toLocaleDateString(),
    time: when.toLocaleTimeString(),
  };
}

/**
 * A row's identity, across launches.
 *
 * `id` says where an entry sits in its day of the mirror, which does not distinguish two days; paired
 * with the timestamp it is unique in practice and stable across a refetch, which is what keeps an
 * expanded row expanded when a page arrives above it.
 */
const keyOf = (entry: LogEntry): string => `${entry.at}-${entry.id}`;

export interface LogsPanelProps {
  /** The pages fetched so far, newest first. */
  entries: LogEntry[];
  /** Whether anything older exists — the panel asks for it as the list is scrolled. */
  hasOlder: boolean;
  loading: boolean;
  /** Ask the log a different question. The filters are applied where the entries are read. */
  onSearch: (query: LogQuery) => void;
  /** The next page towards the past. */
  onOlder: (query: LogQuery) => void;
  /** What is kept at all, and the control that changes it — see {@link LogPolicy}. */
  policy: LogPolicy;
  onPolicy: (policy: LogPolicy) => void;
  /** The process output being read, when a row opened one. */
  output: { jobId: number; chunks: JobOutputChunk[] } | null;
  onOpenJob: (jobId: number) => void;
  onOpenTask: (taskId: string) => void;
  onClearOutput: () => void;
}

/**
 * A process's captured output.
 *
 * Head and tail with the middle elided, so the marker is not decoration — without it the tail reads
 * as the whole, which is exactly the misreading that makes a truncated log worse than none.
 */
function Console({ chunks, onClose }: { chunks: JobOutputChunk[]; onClose: () => void }): JSX.Element {
  const streams = useMemo(() => {
    const byStream = new Map<string, JobOutputChunk[]>();
    for (const chunk of chunks) byStream.set(chunk.stream, [...(byStream.get(chunk.stream) ?? []), chunk]);
    return [...byStream.entries()];
  }, [chunks]);
  return (
    <div className="console">
      <div className="console-head">
        <span className="grow">Process output</span>
        <button onClick={onClose}>Close</button>
      </div>
      {streams.length === 0 ? <p className="empty">This process printed nothing.</p> : null}
      {streams.map(([stream, list]) => (
        <div key={stream} className={`console-stream console-${stream}`}>
          <h4>{stream}</h4>
          {list.map((chunk) => (
            <div key={chunk.id}>
              {chunk.dropped > 0 ? (
                <p className="console-gap">… {chunk.dropped.toLocaleString()} bytes not kept …</p>
              ) : null}
              <pre>{chunk.chunk}</pre>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function LogsPanel({
  entries,
  hasOlder,
  loading,
  onSearch,
  onOlder,
  policy,
  onPolicy,
  output,
  onOpenJob,
  onOpenTask,
  onClearOutput,
}: LogsPanelProps): JSX.Element {
  const [level, setLevel] = useState<LogLevel>("debug");
  const [source, setSource] = useState("");
  const [text, setText] = useState("");
  /** Which rows are open. By {@link keyOf}, so the set survives a refetch and a page arriving. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [showConfig, setShowConfig] = useState(false);

  /**
   * The filters as one value, so the two callers that need them cannot disagree.
   *
   * The scroll handler asks for the next page with the SAME question the visible page answered —
   * anything else and scrolling would quietly widen the search.
   */
  const query = useMemo(
    (): LogQuery => ({
      level,
      ...(source === "" ? {} : { source }),
      ...(text.trim() === "" ? {} : { text: text.trim() }),
    }),
    [level, source, text],
  );

  /**
   * The filters are read where the entries ARE, so changing one is a refetch.
   *
   * Debounced, for the text box's sake: a level or a source is one deliberate act, whereas typing a
   * file name is twenty, and twenty reads of the mirror for one word is how a search box becomes the
   * reason the window stutters. Skipped on the first render — the panel's own arrival already
   * fetched, and re-asking the same question would only make the list flicker.
   */
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return undefined;
    }
    const t = setTimeout(() => onSearch(query), 180);
    return () => clearTimeout(t);
  }, [query, onSearch]);

  const toggle = (key: string): void =>
    setExpanded((held) => {
      const next = new Set(held);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  /**
   * Ask for the next page when the end of the list comes into view.
   *
   * On the SCROLL rather than on a button, because the question a reader is asking as they scroll is
   * already "and before that?". The guard is on the far side too — a scroll gesture fires this many
   * times, and each one would otherwise be a separate read of the same bytes.
   */
  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (!hasOlder || loading) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) onOlder(query);
    },
    [hasOlder, loading, onOlder, query],
  );

  /** The catalogue, plus whatever is actually in the log — see {@link LOG_SOURCES}. */
  const sources = useMemo(() => [...new Set([...LOG_SOURCES, ...entries.map((e) => e.source)])].sort(), [entries]);

  /**
   * Is any of this from another day?
   *
   * The date column exists for the entries paged in from earlier launches, and a session that has
   * not scrolled that far has none — so the column would be ten characters of nothing down the left
   * of every row. It appears when it has something to say and the table is five columns until then,
   * which is the same rule the date inside the cell already follows.
   */
  const dated = useMemo(() => entries.some((e) => stamp(e.at).day !== ""), [entries]);

  return (
    <div className="logs">
      <div className="logs-bar">
        {/* A level filter means "this and worse", not "this exactly" — nobody wants errors hidden
            because they asked for warnings. This one filters what is SHOWN; the Configure panel
            decides what is written down at all, and the two are deliberately separate. */}
        <select value={level} onChange={(e) => setLevel(e.target.value as LogLevel)} aria-label="Minimum level">
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l} and worse
            </option>
          ))}
        </select>
        <SourceSelect value={source} sources={sources} onChange={setSource} />
        <input placeholder="Filter…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Filter" />
        <span className="grow" />
        <button className={showConfig ? "on" : ""} onClick={() => setShowConfig((v) => !v)}>
          Configure
        </button>
        <span className="sub">
          {entries.length}
          {hasOlder ? "+" : ""} shown
        </span>
      </div>
      {showConfig ? <ConfigPanel policy={policy} onPolicy={onPolicy} sources={sources} /> : null}
      {/* The header is a row of the same grid — `--log-cols` is declared once, on `.logs`, and every
          row measures against it. Two grids that happened to agree would stop agreeing the first
          time one of them was edited. */}
      <div className={`logs-head${dated ? " logs-dated" : ""}`}>
        {dated ? <span>date</span> : null}
        <span>time</span>
        <span>level</span>
        <span>source</span>
        <span>message</span>
        <span />
      </div>
      <div className={`logs-list${dated ? " logs-dated" : ""}`} onScroll={onScroll}>
        {entries.map((entry) => {
          const key = keyOf(entry);
          const open = expanded.has(key);
          const { day, time } = stamp(entry.at);
          return (
            <div key={key} className={`log-line${open ? " log-shown" : ""}`}>
              {/* The whole row is the control. A message that does not fit is the commonest reason to
                  want it open, so the target has to be the message rather than a caret beside it. */}
              <div
                className={`log-row log-${entry.level}${dated ? " logs-dated" : ""}`}
                onClick={() => toggle(key)}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle(key);
                  }
                }}
              >
                {dated ? <span className="log-day">{day}</span> : null}
                <span className="log-at">{time}</span>
                <span className={`log-level log-${entry.level}`}>{entry.level}</span>
                {/* `title`, because this cell is fixed and a library's scope is long: the ellipsis is
                    what keeps the column a column, and the tooltip is what stops that costing the
                    reader the one fact the cell is for. */}
                <span className="log-source" title={entry.source}>
                  {entry.source}
                </span>
                <span className="log-message">{entry.message}</span>
                {/* Their own column, held open on every row. Inline they sat at wherever the message
                    happened to end, which put the same control in a different place on each line —
                    and pushed the message column's width around with it. They stop the click here:
                    opening a task is not the same gesture as expanding the row. */}
                <span className="log-links">
                  {entry.taskId !== undefined ? (
                    <button
                      className="link"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenTask(entry.taskId!);
                      }}
                    >
                      task
                    </button>
                  ) : null}
                  {entry.jobId !== undefined ? (
                    <button
                      className="link"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenJob(entry.jobId!);
                      }}
                    >
                      output
                    </button>
                  ) : null}
                </span>
              </div>
              {open ? <Detail detail={entry.detail} /> : null}
            </div>
          );
        })}
        {entries.length === 0 && !loading ? <p className="empty">Nothing to show.</p> : null}
        {/* The foot says which of the two silences this is: more to fetch, or the beginning of the
            log. A list that simply stopped would look the same either way. */}
        {loading ? (
          <p className="empty">Reading…</p>
        ) : hasOlder ? (
          <p className="empty">Scroll for older entries.</p>
        ) : null}
      </div>
      {output !== null ? <Console chunks={output.chunks} onClose={onClearOutput} /> : null}
    </div>
  );
}

/**
 * Which source to show, grouped by its first dot-segment.
 *
 * The app's own sources are flat words (`run`, `ipc`); a library's is a dot-path it chose for itself
 * (`jaira.persistence.views`). Grouping on the first segment gives the second kind a heading and an
 * "everything under here" entry, which is the only way to say "the persistence layer" without typing
 * out its four scopes.
 */
function SourceSelect({
  value,
  sources,
  onChange,
  label = "Source",
}: {
  value: string;
  sources: string[];
  onChange: (value: string) => void;
  label?: string;
}): JSX.Element {
  const groups = useMemo(() => {
    const held = new Map<string, string[]>();
    for (const s of sources) {
      const top = s.includes(".") ? s.slice(0, s.indexOf(".")) : s;
      held.set(top, [...(held.get(top) ?? []), s]);
    }
    return [...held.entries()];
  }, [sources]);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">all sources</option>
      {groups.map(([top, list]) =>
        // A group of one is its own option: an `optgroup` around a single entry is a heading
        // repeating the thing under it.
        list.length === 1 && list[0] === top ? (
          <option key={top} value={top}>
            {top}
          </option>
        ) : (
          <optgroup key={top} label={top}>
            <option value={top}>{top} (all)</option>
            {list
              .filter((s) => s !== top)
              .map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
          </optgroup>
        ),
      )}
    </select>
  );
}

/**
 * What the app KEEPS — as distinct from what this panel shows.
 *
 * The two are easy to confuse and must not be: the filters above hide entries that were written, and
 * this decides whether they are written at all. Both matter, for opposite reasons — a filter cannot
 * recover what was dropped, and a policy that keeps everything makes a run's own trace the only
 * thing anybody can see.
 *
 * One setting, both producers: the libraries are gated inside `@declarative-ai/log` before a record
 * is formatted, and the app's own entries as they are recorded. It takes effect on the next entry,
 * not on the next launch.
 */
function ConfigPanel({
  policy,
  onPolicy,
  sources,
}: {
  policy: LogPolicy;
  onPolicy: (policy: LogPolicy) => void;
  sources: string[];
}): JSX.Element {
  const [match, setMatch] = useState<LogOverride["match"]>("scope");
  const [key, setKey] = useState("");
  const [minLevel, setMinLevel] = useState<LogLevel>("debug");

  /** Written by key, so editing a rule replaces it rather than adding a second one nobody can see. */
  const put = (next: LogOverride): void =>
    onPolicy({
      ...policy,
      overrides: [...policy.overrides.filter((o) => !(o.match === next.match && o.key === next.key)), next],
    });
  const drop = (o: LogOverride): void =>
    onPolicy({ ...policy, overrides: policy.overrides.filter((h) => !(h.match === o.match && h.key === o.key)) });

  return (
    <div className="log-config">
      <div className="log-config-head">
        <label className="field-inline">
          <span>Keep</span>
          <select
            value={policy.minLevel}
            onChange={(e) => onPolicy({ ...policy, minLevel: e.target.value as LogLevel })}
            aria-label="Minimum level kept"
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l} and worse
              </option>
            ))}
          </select>
        </label>
        <span className="sub">
          everywhere, unless a rule below says otherwise. An error is kept whatever this says.
        </span>
      </div>
      <table className="log-rules">
        <thead>
          <tr>
            <th>match</th>
            <th>key</th>
            <th>keep</th>
            <th>sample</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {policy.overrides.length === 0 ? (
            <tr>
              <td className="sub" colSpan={5}>
                No rules — the level above applies everywhere.
              </td>
            </tr>
          ) : null}
          {policy.overrides.map((o) => (
            <tr key={`${o.match}:${o.key}`}>
              <td className="sub">{o.match}</td>
              <td className="log-rule-key">{o.key}</td>
              <td>
                <select
                  value={o.minLevel}
                  onChange={(e) => put({ ...o, minLevel: e.target.value as LogLevel })}
                  aria-label={`Minimum level for ${o.key}`}
                >
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                {/* The fraction of matching non-errors kept. A chatty scope you want SOME of — one
                    call in ten is a shape, where none is a blind spot and all is a flood. */}
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  value={o.samplingRate ?? 1}
                  aria-label={`Sampling for ${o.key}`}
                  onChange={(e) => {
                    const rate = e.target.value === "" ? 1 : Number(e.target.value);
                    if (!Number.isFinite(rate) || rate < 0 || rate > 1) return;
                    const { samplingRate: _held, ...rest } = o;
                    put(rate === 1 ? rest : { ...rest, samplingRate: rate });
                  }}
                />
              </td>
              <td>
                <button className="link" onClick={() => drop(o)}>
                  remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="log-config-add">
        <select
          value={match}
          onChange={(e) => {
            setMatch(e.target.value as LogOverride["match"]);
            setKey("");
          }}
          aria-label="Rule kind"
        >
          <option value="scope">scope</option>
          <option value="tag">tag</option>
        </select>
        {/* A scope is picked from what exists; a tag is a library's own word for a KIND of record and
            nothing here can enumerate them, so it stays free text. */}
        {match === "scope" ? (
          <SourceSelect value={key} sources={sources} onChange={setKey} label="Rule scope" />
        ) : (
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="tag (e.g. llm)" aria-label="Rule tag" />
        )}
        <select value={minLevel} onChange={(e) => setMinLevel(e.target.value as LogLevel)} aria-label="Rule level">
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <button
          disabled={key.trim() === ""}
          onClick={() => {
            put({ match, key: key.trim(), minLevel });
            setKey("");
          }}
        >
          Add rule
        </button>
      </div>
    </div>
  );
}
