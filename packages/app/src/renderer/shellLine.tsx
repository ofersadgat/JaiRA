/**
 * A command line in the colours of its parts — the way an approval draws the line it asks about
 * (decision 0007 §4), wherever else a command is shown: a shell call's row in the conversation, the
 * work summary's "Ran `…`". The same parse (`takenApartOf`, the shared `takeApart`) and the same
 * segments (`lineSegments`), so a line reads alike before it is approved and after it ran.
 *
 * Only the tint: the underline an approval adds is the words of the permission-set line that matched,
 * and a line that is only being shown matched nothing.
 */
import { useMemo, type CSSProperties, type JSX } from "react";
import { hueOf, lineSegments } from "./approvalModel";
import { takenApartOf } from "./transcript";

export function ShellLine({ line, className }: { line: string; className?: string }): JSX.Element {
  const segments = useMemo(() => lineSegments(line, takenApartOf(line).requests.map((request) => ({ span: request.span, matched: [] }))), [line]);
  return (
    <span className={`shell-line${className !== undefined ? ` ${className}` : ""}`}>
      {segments.map((segment, at) =>
        segment.kind === "glue" ? (
          <span key={at} className="op">
            {segment.text}
          </span>
        ) : (
          <span key={at} className="part-c" style={{ "--hue": hueOf(segment.part) } as CSSProperties}>
            {segment.pieces.map((piece) => piece.text).join("")}
          </span>
        ),
      )}
    </span>
  );
}
