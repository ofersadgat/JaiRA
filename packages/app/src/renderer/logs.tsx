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
 */
import { useMemo, useState, type JSX } from "react";
import type { JobOutputChunk, LogEntry, LogLevel } from "@jaira/shared/browser";

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogsPanelProps {
  entries: LogEntry[];
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

export function LogsPanel({ entries, output, onOpenJob, onOpenTask, onClearOutput }: LogsPanelProps): JSX.Element {
  const [level, setLevel] = useState<LogLevel>("debug");
  const [text, setText] = useState("");
  const shown = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return entries.filter(
      (e) =>
        RANK[e.level] >= RANK[level] &&
        (needle === "" || e.message.toLowerCase().includes(needle) || e.source.toLowerCase().includes(needle)),
    );
  }, [entries, level, text]);

  return (
    <div className="logs">
      <div className="logs-bar">
        {/* A level filter means "this and worse", not "this exactly" — nobody wants errors hidden
            because they asked for warnings. */}
        <select value={level} onChange={(e) => setLevel(e.target.value as LogLevel)} aria-label="Minimum level">
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l} and worse
            </option>
          ))}
        </select>
        <input placeholder="Filter…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Filter" />
        <span className="grow" />
        <span className="sub">
          {shown.length} of {entries.length}
        </span>
      </div>
      <div className="logs-list">
        {shown.map((entry) => (
          <div key={entry.id} className={`log-row log-${entry.level}`}>
            <span className="log-at">{new Date(entry.at).toLocaleTimeString()}</span>
            <span className={`log-level log-${entry.level}`}>{entry.level}</span>
            <span className="log-source">{entry.source}</span>
            <span className="grow log-message">{entry.message}</span>
            {/* The two links that make a row actionable rather than merely informative. */}
            {entry.taskId !== undefined ? (
              <button className="link" onClick={() => onOpenTask(entry.taskId!)}>
                task
              </button>
            ) : null}
            {entry.jobId !== undefined ? (
              <button className="link" onClick={() => onOpenJob(entry.jobId!)}>
                output
              </button>
            ) : null}
          </div>
        ))}
        {shown.length === 0 ? <p className="empty">Nothing to show.</p> : null}
      </div>
      {output !== null ? <Console chunks={output.chunks} onClose={onClearOutput} /> : null}
    </div>
  );
}
