/**
 * The transcript, as a chat.
 *
 * What replaced the two stacked panels — a session viewer over a journal projection — that between
 * them showed one state's words above the whole task's events and left the reader to interleave
 * them. There is one stream now, built by `transcript.ts`, and this file only decides how an entry
 * looks.
 *
 * ## The chrome rule
 *
 * Chrome marks a CHILD boundary and nothing else. A leaf renders {@link Transcript} bare. A
 * composite renders its OWN operation bare, in exactly the same way, and then one {@link RunCard}
 * per child run beneath it. So there is no "leaf mode" and "composite mode" — there is content, and
 * there are cards around children, and a leaf simply has no children.
 *
 * A run is the unit, so a state that ran three times is three sibling cards rather than one card
 * that has to explain itself. Each is headed by its call signature, which is the same line the board
 * card carries, because they are the same fact: a run, and what it was called with.
 */
import { useState, type JSX, type ReactNode } from "react";
import type { InstanceNode, SessionView } from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { Markdown } from "./markdown";
import {
  signatureOf,
  type SignatureParam,
  type ThoughtEntry,
  type ToolEntry,
  type TranscriptEntry,
} from "./transcript";

/** `09:14:02`. Seconds included: the gap between two calls is the thing being read. */
function clockOf(at: number | undefined): string {
  return at === undefined || at === 0 ? "" : new Date(at).toLocaleTimeString();
}

/** `2.4 s`, `1 m 12 s`. */
export function durationOf(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
}

/**
 * Which side of the chat a message sits on.
 *
 * What the workflow SENT is on the right and what came back is on the left, which is the arrangement
 * every chat client uses and therefore the one nobody has to learn. `system` goes left with the
 * model's own words because it is not something you typed either — it is the frame the run was given.
 */
function sideOf(role: string): "right" | "left" {
  return role === "user" ? "right" : "left";
}

/** The role line above a message, and the timestamp that ends it. */
function Who({ role, at, note }: { role: string; at?: number; note?: string }): JSX.Element {
  return (
    <div className={`ts-who ts-who-${sideOf(role)}`}>
      <span className={`ts-role ts-role-${role}`}>{role === "user" ? "you" : role}</span>
      {note !== undefined ? <span className="sub">{note}</span> : null}
      <span className="grow" />
      <span className="ts-at">{clockOf(at)}</span>
    </div>
  );
}

/** A payload block, or the honest statement that the record kept none. */
function Payload({ label, value }: { label: string; value: JsonValue | undefined }): JSX.Element {
  if (value === undefined) return <div className="ts-payload ts-payload-empty">no {label} was recorded</div>;
  return (
    <pre className="ts-payload">
      <span className="ts-payload-label">{label}</span>
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

/**
 * One tool call: a line, and its payload when asked for.
 *
 * Collapsed by default because an agent loop is mostly these — forty of them expanded is a
 * transcript nobody reads to the end. The line keeps the two things worth scanning: what was called
 * and whether it worked.
 *
 * Expanded shows BOTH halves, labelled. It used to show one — the result if there was one, the
 * arguments otherwise — so a call you opened to find out what it was asked answered with what it
 * returned instead, and a record that kept neither printed the word `null`.
 */
function Tool({ entry }: { entry: ToolEntry }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={`ts-tool${open ? " open" : ""}`}>
      <button type="button" className="ts-tool-line" onClick={() => setOpen((v) => !v)}>
        <span className="ts-caret">{open ? "▾" : "▸"}</span>
        <span className="ts-tool-name">{entry.name}</span>
        <span className="grow ellip">{entry.summary}</span>
        <span className="ts-at">{clockOf(entry.at)}</span>
        {entry.ok === undefined ? null : (
          <span className={`ts-verdict ${entry.ok ? "ok" : "bad"}`}>{entry.ok ? "✓" : "!"}</span>
        )}
      </button>
      {open ? (
        <div className="ts-payloads">
          <Payload label="arguments" value={entry.args} />
          {/* A call still in flight has no result, and saying so is different from showing an empty
              one — which is why this is absent rather than an empty block. */}
          {entry.ok === undefined && entry.result === undefined ? (
            <div className="ts-payload ts-payload-empty">still running</div>
          ) : (
            <Payload label="result" value={entry.result} />
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A block of the model's own reasoning.
 *
 * Folded, and dimmer than a message: it is not what the model said, it is what it was working
 * through on the way to saying it. The first line is on the summary, because that is usually enough
 * to decide whether the rest is worth opening.
 */
function Thought({ entry }: { entry: ThoughtEntry }): JSX.Element {
  const [open, setOpen] = useState(false);
  const firstLine = entry.text.replace(/\s+/g, " ").trim();
  return (
    <div className={`ts-think${open ? " open" : ""}`}>
      <button type="button" className="ts-think-line" onClick={() => setOpen((v) => !v)}>
        <span className="ts-caret">{open ? "▾" : "▸"}</span>
        <span className="ts-think-label">thinking</span>
        <span className="grow ellip">{open ? "" : firstLine}</span>
        <span className="ts-at">{clockOf(entry.at)}</span>
      </button>
      {open ? <pre className="ts-think-text">{entry.text}</pre> : null}
    </div>
  );
}

/** One entry, whatever kind it is. */
function Entry({ entry }: { entry: TranscriptEntry }): JSX.Element {
  if (entry.kind === "tool") return <Tool entry={entry} />;
  if (entry.kind === "thought") return <Thought entry={entry} />;
  if (entry.kind === "event") {
    return (
      <div className={`ts-event ts-${entry.tone}`}>
        <span className="grow">{entry.text}</span>
        <span className="ts-at">{clockOf(entry.at)}</span>
      </div>
    );
  }
  if (entry.kind === "live") {
    return (
      <div className="ts-msg ts-msg-assistant ts-left ts-live">
        <Who role="assistant" note="writing…" />
        {/* Plain text, not markdown: a half-arrived answer has half a fenced block in it, and
            rendering that produces a code block that swallows the rest of the stream. */}
        <pre className="ts-text-live">{entry.text}</pre>
      </div>
    );
  }
  return (
    <div className={`ts-msg ts-msg-${entry.role} ts-${sideOf(entry.role)}`}>
      <Who role={entry.role} at={entry.at} />
      {entry.text === undefined || entry.text.length === 0 ? null : entry.role === "assistant" ? (
        <Markdown text={entry.text} />
      ) : (
        // Sent and system messages are shown as written. They are the input, and reformatting an
        // input is how you stop being able to see what was actually sent.
        <pre className="ts-text">{entry.text}</pre>
      )}
    </div>
  );
}

/**
 * A run's conversation, with no chrome at all.
 *
 * This is what a leaf shows, and what a composite shows for its own operation. Both are "this state
 * speaking", and they look the same because they are the same.
 */
export function Transcript({
  session,
  entries,
  empty,
}: {
  session?: SessionView | null;
  entries: TranscriptEntry[];
  /** What to say when there is nothing — a function op ran no model call, which is an answer. */
  empty?: string | undefined;
}): JSX.Element {
  if (entries.length === 0) {
    return <p className="empty">{empty ?? session?.empty ?? "Nothing has been said here yet."}</p>;
  }
  return (
    <div className="ts">
      {entries.map((entry, i) => (
        <Entry key={i} entry={entry} />
      ))}
    </div>
  );
}

/** The `draft {goals=3 items, context="# Context…"}` line, or the run's own name when it has one. */
function Signature({ name, label, params }: { name: string; label?: string; params: SignatureParam[] }): JSX.Element {
  return (
    <span className="ts-sig ellip">
      <span className="ts-sig-name">{name}</span>
      {label !== undefined ? (
        <span className="ts-sig-label"> {label}</span>
      ) : params.length === 0 ? null : (
        <span className="ts-sig-args">
          {" {"}
          {params.map((param, i) => (
            <span key={param.name}>
              {i > 0 ? ", " : ""}
              {param.name}=<span className="ts-sig-value">{param.preview}</span>
            </span>
          ))}
          {"}"}
        </span>
      )}
    </span>
  );
}

/** The status dot. Colour only — the header already says everything in words. */
function Dot({ status }: { status: InstanceNode["status"] }): JSX.Element {
  return <span className={`ts-dot ts-dot-${status}`} />;
}

/**
 * One run of one child, as a card.
 *
 * Folded by default and opened on demand, which is what makes a five-state run five lines until you
 * ask. `onOpen` exists because the conversation behind a card is fetched, not held: loading every
 * child's transcript to render a list of headers would be one round trip per state on every
 * selection.
 */
export function RunCard({
  node,
  open,
  running,
  children,
  onToggle,
}: {
  node: InstanceNode;
  open: boolean;
  /** True while this run is the live one — the card it is worth opening by default. */
  running?: boolean;
  children?: ReactNode;
  onToggle: () => void;
}): JSX.Element {
  const sig = signatureOf(node);
  const took = node.endedAt !== undefined ? durationOf(node.endedAt - node.startedAt) : undefined;
  return (
    <section className={`ts-card${open ? " open" : ""}${running === true ? " live" : ""}`}>
      <button type="button" className="ts-card-head" onClick={onToggle}>
        <span className="ts-caret">{open ? "▾" : "▸"}</span>
        <Dot status={node.status} />
        <Signature {...sig} />
        <span className="ts-card-meta">
          {clockOf(node.startedAt)}
          {took !== undefined ? ` · ${took}` : ""}
        </span>
      </button>
      {open ? <div className="ts-card-body">{children}</div> : null}
    </section>
  );
}

/**
 * A composite's conversation: what this state said, then a card per child run.
 *
 * The children are taken in the order they STARTED rather than in declaration order, because this
 * is a transcript — the question it answers is what happened, and a sequence reset or an async child
 * makes those two orders differ exactly when it matters most.
 */
export function ChildRuns({
  nodes,
  openIds,
  onToggle,
  render,
}: {
  nodes: InstanceNode[];
  openIds: ReadonlySet<number>;
  onToggle: (instanceId: number) => void;
  /** The transcript for one child, fetched by the host — see {@link RunCard}. */
  render: (node: InstanceNode) => ReactNode;
}): JSX.Element {
  const ordered = [...nodes].sort((a, b) => a.startedAt - b.startedAt);
  return (
    <div className="ts-cards">
      {ordered.map((node) => (
        <RunCard
          key={node.instanceId}
          node={node}
          open={openIds.has(node.instanceId)}
          running={node.status === "running"}
          onToggle={() => onToggle(node.instanceId)}
        >
          {render(node)}
        </RunCard>
      ))}
    </div>
  );
}
