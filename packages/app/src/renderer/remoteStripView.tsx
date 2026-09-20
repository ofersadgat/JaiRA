/**
 * The gate's second door, drawn (decision 0004, "What draws").
 *
 * Render functions with no opinion about their place: the reviewer puts the strip under its base
 * line because it is about the whole set, and a settled gate puts the settled-by line where its
 * answer is. Neither knows whether it is in a conversation, a pane or a gallery. What they SAY is in
 * `remoteStrip.ts`, where it can be tested; this file only places the words.
 */
import { useEffect, useState, type JSX } from "react";
import type { RemoteStatusView, ReviewNote, ReviewRemote } from "@jaira/shared/browser";
import { BrandIcon, Icon } from "./icons";
import { SourceMark } from "./reviewNotes";
import { settledByLines, stripWords } from "./remoteStrip";

export function RemoteStrip({
  remote,
  status,
  busy,
  onCheck,
}: {
  remote: ReviewRemote;
  status: RemoteStatusView | undefined;
  busy: boolean;
  /** Absent on a settled gate, where there is nothing left to check. */
  onCheck?: (() => void) | undefined;
}): JSX.Element {
  // "checked 40 s ago" is a sentence about NOW, so it has to be redrawn as now moves.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const words = stripWords(remote, status, now);
  return (
    <div className={`review-remote${words.error !== undefined ? " is-error" : ""}`} data-testid="review-remote">
      <span className="rr-forge">
        <BrandIcon name={remote.provider ?? ""} /> {words.forge}
      </span>
      {words.href !== undefined ? (
        <a href={words.href} target="_blank" rel="noreferrer">
          {words.label}
        </a>
      ) : (
        <span className="rr-link">{words.label}</span>
      )}
      <span className="rr-branch">{words.branch}</span>
      <span className="rr-grow" />
      {words.who !== undefined ? <span className="rr-who">{words.who}</span> : null}
      {words.error !== undefined ? (
        <span className="rr-window" title={status?.error}>
          <Icon name="alert" /> {words.error}
        </span>
      ) : words.window !== undefined ? (
        <span className="rr-window" title={words.window.title}>
          <Icon name="clock" /> {words.window.text}
        </span>
      ) : null}
      {words.checked !== undefined ? <span className="rr-checked">{words.checked}</span> : null}
      {onCheck === undefined ? null : (
        <button type="button" className="ghost" disabled={busy} onClick={onCheck}>
          Check now
        </button>
      )}
    </div>
  );
}

/** Comments on the request as a whole: about the set, so they sit with the review-level comment. */
export function ReviewThread({ notes }: { notes: readonly ReviewNote[] }): JSX.Element | null {
  if (notes.length === 0) return null;
  return (
    <div className="review-thread" data-testid="review-thread">
      {notes.map((note, i) => (
        <div className="note-msg" key={`${note.at}-${i}`}>
          <div className="note-msg-by">
            <Icon name="comment" className="note-icon" /> {note.author}
            {note.source === undefined ? null : <SourceMark source={note.source} />}
          </div>
          <div className="note-msg-body">{note.body}</div>
        </div>
      ))}
    </div>
  );
}

/** How a gate answered elsewhere says so. Nothing at all for a gate answered here. */
export function SettledBy({ recorded }: { recorded: Record<string, unknown> }): JSX.Element | null {
  const said = settledByLines(recorded);
  if (said === undefined) return null;
  return (
    <div className="gate-settled-by" data-testid="gate-settled-by">
      <Icon name="check" />
      <div>
        {said.head}
        {said.lines.length === 0 ? null : (
          <ul>
            {said.lines.map((line) => (
              <li key={line.text} className={line.warned === true ? "warned" : undefined}>
                {line.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
