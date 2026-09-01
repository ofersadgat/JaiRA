/**
 * The conversation a state actually ran.
 *
 * Distinct from `Conversation` (detail.tsx), which projects the JOURNAL — states entered, tools
 * attempted, policy decisions. That was the only record there was, and its own doc said so. It is not
 * any more: every model call's messages, thinking, tool calls and results are stored verbatim, and
 * this is what reads them back.
 *
 * ## One state, one conversation
 *
 * A leaf state runs ONE operation, which is one record at one position — and when that operation is a
 * delegated agent, the single record contains the agent's entire loop. So there is nothing to page
 * through and no boundary to draw: the view is the whole thing, in order.
 *
 * What surrounds the operation — the state being entered, transitions, human gates — is not in here.
 * Those are state-level facts and belong to the history beside it, not inside a transcript.
 */
import type { JSX } from "react";
import type { SessionRef, SessionTurn, SessionView } from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";

/** A role chip. `user` is what the workflow sent; everything else is what came back. */
const ROLE_LABEL: Record<string, string> = { user: "sent", assistant: "reply", system: "system", tool: "tool" };

/**
 * The tool calls and results inside one turn, paired.
 *
 * Kept structured all the way from the record for this: a call and its result are two entries on the
 * wire, and the only place that can pair them is the place that knows both shapes.
 */
function Parts({ parts }: { parts: JsonValue }): JSX.Element | null {
  const list = Array.isArray(parts) ? parts : [];
  const calls = list.filter((p) => typeof (p as { type?: unknown })?.type === "string" && (p as { type: string }).type !== "text");
  if (calls.length === 0) return null;
  return (
    <div className="turn-parts">
      {calls.map((part, i) => {
        const p = part as { type: string; toolName?: string; args?: unknown; result?: unknown; text?: string };
        return (
          <details key={i} className={`part part-${p.type}`}>
            <summary>
              <span className="part-kind">{p.type}</span>
              {p.toolName !== undefined ? <span className="part-tool">{p.toolName}</span> : null}
            </summary>
            <pre>{JSON.stringify(p.args ?? p.result ?? p.text ?? p, null, 2)}</pre>
          </details>
        );
      })}
    </div>
  );
}

function Turn({ turn }: { turn: SessionTurn }): JSX.Element {
  return (
    <div className={`sturn sturn-${turn.role}`}>
      <span className="sturn-role">{ROLE_LABEL[turn.role] ?? turn.role}</span>
      <div className="sturn-body">
        {turn.text !== undefined ? <pre className="sturn-text">{turn.text}</pre> : null}
        {turn.parts !== undefined ? <Parts parts={turn.parts} /> : null}
      </div>
    </div>
  );
}

export interface SessionPanelProps {
  history: SessionRef[];
  session: SessionView | null;
  /** Which instance is being shown; null means the most recent. */
  showing: string | null;
  /**
   * The answer being written right now, before it is a turn.
   *
   * Shown only when it belongs to the conversation on screen — a delta from another state is another
   * state's, and rendering it here would attribute one run's words to a different one.
   */
  live?: { sessionId?: string; seq?: number; text: string } | null;
  onShow: (instanceId: string | null) => void;
}

/**
 * The task's history down one side, the chosen state's conversation down the other.
 *
 * The history is every state the executor went through, so "what happened before this" is one click
 * rather than a re-selection — and each row carries the outcome and the spend, because those are the
 * two things you look for before you read anything.
 */
export function SessionPanel({ history, session, showing, live, onShow }: SessionPanelProps): JSX.Element {
  if (session === null) return <p className="empty">Select a task to see what it ran.</p>;
  const at = showing ?? session.instanceId;
  // Matched on the POSITION, not on the state id: a loop runs one state several times, and each
  // iteration is its own conversation.
  const streaming =
    live != null && live.sessionId === session.sessionId && live.seq === session.seq ? live.text : undefined;
  return (
    <div className="session">
      <div className="session-history">
        <h3>
          <span>States</span>
          <span className="count">{history.length}</span>
        </h3>
        {history.map((row) => (
          <div
            key={row.instanceId}
            className={`session-row${row.instanceId === at ? " sel" : ""}`}
            onClick={() => onShow(row.instanceId)}
            title={`${row.sessionId} @ ${row.seq}`}
          >
            <span className={`dot ${row.status ?? "unknown"}`} />
            <span className="grow ellip">{row.stateId}</span>
            {row.costUsd !== undefined ? <span className="cost">${row.costUsd.toFixed(3)}</span> : null}
          </div>
        ))}
        {history.length === 0 ? <p className="empty">No model call yet.</p> : null}
      </div>
      <div className="session-body">
        <div className="session-head">
          <span className="grow ellip">{session.stateId || "—"}</span>
          {session.status !== undefined ? <span className={`dot ${session.status}`} /> : null}
          {session.costUsd !== undefined ? <span className="cost">${session.costUsd.toFixed(4)}</span> : null}
          {/* The agent's OWN handle, when it had one — what makes its native transcript findable. */}
          {session.providerSessionId !== undefined ? (
            <span className="sub mono ellip" title={session.providerSessionId}>
              {session.providerSessionId}
            </span>
          ) : null}
        </div>
        {/* An empty conversation is an ANSWER — a function op ran no model call, and a run recorded
            before transcripts were kept has none. A blank panel would read as a bug. */}
        {session.empty !== undefined ? <p className="empty">{session.empty}</p> : null}
        <div className="sturns">
          {session.turns.map((turn, i) => (
            <Turn key={i} turn={turn} />
          ))}
          {/* Marked as unfinished rather than shown as an ordinary turn: it has no tool calls yet and
              may still change, and a reader must be able to tell a draft from a record. */}
          {streaming !== undefined ? (
            <div className="sturn sturn-assistant sturn-live">
              <span className="sturn-role">writing</span>
              <div className="sturn-body">
                <pre className="sturn-text">{streaming}</pre>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
