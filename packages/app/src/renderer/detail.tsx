/**
 * The journal read as turns — what the Debug view's self-test shows under its run (DESIGN §11.3).
 *
 * The task panel that lived here too is the side panel's task entry now (`panelFaces.tsx`), with its
 * facts split into tabs; its "Live events" dump of event types is gone — every one of them is a row
 * the conversation or the Steps index draws in place.
 */
import type { JSX } from "react";
import type { ConversationView } from "@jaira/shared/browser";
import { Badge } from "./board";

/** How each turn kind introduces itself. Short, because the column is narrow and repeated. */
const TURN_ROLE: Record<string, string> = {
  operation: "state",
  tool: "tool",
  output: "output",
  policy: "policy",
  interaction: "waiting",
  failure: "failed",
  blocked: "blocked",
  transition: "→",
};

/**
 * The conversation running inside one task.
 *
 * A projection of the journal and the command log rather than a stored transcript — there is no
 * other record, and this is the reading of it that answers "what is this run actually doing".
 */
export function Conversation({
  conversation,
  waiting,
  onAnswer,
}: {
  conversation: ConversationView | null;
  waiting?: { component: string } | undefined;
  onAnswer?: () => void;
}): JSX.Element {
  if (!conversation) return <p className="empty">Select a task to see its conversation.</p>;
  if (conversation.turns.length === 0) {
    return <p className="empty">This task has not run yet.</p>;
  }
  return (
    <div className="convo">
      <h3>
        <span>Conversation · {conversation.title}</span>
        <span className="sub">{conversation.turns.length} turns</span>
      </h3>
      <div className="turns">
        {conversation.turns.map((turn) => (
          <div key={`${turn.kind}-${turn.seq}`} className={`turn turn-${turn.kind}${turn.ok === false ? " turn-bad" : ""}`}>
            <span className="role">{TURN_ROLE[turn.kind] ?? turn.kind}</span>
            <div className="turn-body">
              {turn.stateId ? <span className="turn-state">{turn.stateId}</span> : null}
              {turn.tool ? <span className="turn-tool">{turn.tool}</span> : null}
              {turn.text ? <span className="turn-text">{turn.text}</span> : null}
              {turn.data !== undefined ? <span className="turn-data">{JSON.stringify(turn.data)}</span> : null}
            </div>
          </div>
        ))}
      </div>
      {waiting ? (
        // Pinned rather than in the flow: it is the one turn that is not history, and scrolling away
        // from the thing blocking the run is exactly the wrong behaviour.
        <div className="waiting-on">
          <Badge status="waiting_for_user" />
          <span className="grow">Waiting on you — {waiting.component}</span>
          {onAnswer ? <button className="primary" onClick={onAnswer}>Answer</button> : null}
        </div>
      ) : null}
    </div>
  );
}
