/**
 * The per-command approval (DESIGN §10.2), drawn as the requests its line is made of (decision 0007 §4).
 *
 * Distinct from a workflow gate: policy escalated a *tool call*, so what the person judges is a
 * command, and the answer carries a REACH — the reason they are not asked the same thing on every
 * call. A shell line is shown in the colours of its parts, with one row per part under it; the
 * answers are ONE Allow and ONE Deny, each a split button whose arrow asks what the answer covers
 * and then how far it reaches.
 *
 * A RENDER FUNCTION with no opinion about its place: a conversation hosts it under the state whose
 * agent proposed the command, the gallery draws it in a row, and `ApprovalDialog` is the one caller
 * that puts it in a modal, for a request no conversation can host. Everything it draws is worked out
 * in `approvalModel.ts`; this file is the elements and the two pieces of state a menu needs.
 */
import { Fragment, useEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import type { ApprovalScope, PendingApproval, WritableLayer } from "@jaira/shared/browser";
import { Icon } from "./icons";
import {
  answerMenu,
  approvalAnswerOf,
  hueOf,
  lineSegments,
  partRows,
  reasonLines,
  verdictLabel,
  type ChosenWidths,
  type HintPiece,
  type Piece,
  type Reach,
  type ReasonLine,
} from "./approvalModel";

/** What rides beside the scope: the part widths to remember, and the layer to write them into. */
export interface ApprovalAnswerExtras {
  remember?: string[];
  addTo?: WritableLayer;
}

export interface ApprovalSurfaceProps {
  pending: PendingApproval;
  error?: string | null;
  onDecide: (decision: "allow" | "deny", scope: ApprovalScope, extras?: ApprovalAnswerExtras) => void;
  /** Draw with this answer's menu open — for a still picture of it (the gallery, a mockup). */
  initialMenu?: "allow" | "deny";
}

const hueStyle = (index: number): CSSProperties => ({ "--hue": hueOf(index) }) as CSSProperties;

function Pieces({ pieces }: { pieces: readonly Piece[] }): JSX.Element {
  return (
    <>
      {pieces.map((piece, at) =>
        piece.matched ? (
          <span key={at} className="part-m">
            {piece.text}
          </span>
        ) : (
          piece.text
        ),
      )}
    </>
  );
}

function Hint({ hint }: { hint: readonly HintPiece[] }): JSX.Element {
  return (
    <>
      {hint.map((piece, at) =>
        typeof piece === "string" ? (
          piece
        ) : (
          <b key={at} className="mono">
            {piece.code}
          </b>
        ),
      )}
    </>
  );
}

/**
 * Which function decided a part — a star and its name, before the verdict it gave. The same glyph the
 * permission set card gives a line that names a function, so the two read as one thing.
 */
export function FunctionBy({ name }: { name: string }): JSX.Element {
  return (
    <span className="part-by" title={`decided by the function ${name}`}>
      <Icon name="star" /> <span className="mono">{name}</span>
    </span>
  );
}

function Reason({ line }: { line: ReasonLine }): JSX.Element {
  if (line.kind === "policy") return <p className="reason-note">Policy: {line.text}</p>;
  if (line.kind === "function") return <p className="reason-note">{line.text}</p>;
  const who = line.permissionSet !== undefined ? (
    <>
      Permission set <span className="mono">{line.permissionSet}</span>
    </>
  ) : (
    <>This state&rsquo;s permission set</>
  );
  const names = line.kind === "permissionSet" ? line.entries : line.subjects;
  const listed = names.map((name, at) => (
    <span key={name}>
      {at > 0 ? (at === names.length - 1 ? " and " : ", ") : null}
      <b>{name}</b>
    </span>
  ));
  return (
    <p className="reason-note">
      {who}
      {line.kind === "permissionSet" ? <>: {listed} {names.length === 1 ? "asks" : "ask"}</> : <> holds no line for {listed}, so {names.length === 1 ? "it asks" : "they ask"}</>}
    </p>
  );
}

export function ApprovalSurface({ pending, error, onDecide, initialMenu }: ApprovalSurfaceProps): JSX.Element {
  const [open, setOpen] = useState<"allow" | "deny" | null>(initialMenu ?? null);
  const [chosen, setChosen] = useState<ChosenWidths>({});
  /** The part under the pointer, lit on the line and in its row — see the model on "past four parts". */
  const [hot, setHot] = useState<number | null>(null);
  const answers = useRef<HTMLDivElement>(null);

  // A menu closes on a press anywhere else and on Escape, like every other menu in the app.
  useEffect(() => {
    if (open === null) return;
    const away = (event: MouseEvent): void => {
      if (answers.current !== null && !answers.current.contains(event.target as Node)) setOpen(null);
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(null);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const decide = (decision: "allow" | "deny", reach: Reach): void => {
    const { scope, remember, addTo } = approvalAnswerOf(pending, reach, chosen);
    setOpen(null);
    onDecide(decision, scope, remember !== undefined || addTo !== undefined ? { ...(remember !== undefined ? { remember } : {}), ...(addTo !== undefined ? { addTo } : {}) } : undefined);
  };

  const approval = pending.parts;
  const drawn = approval !== undefined && approval.parts.length > 0 && pending.command !== undefined;
  const rows = drawn ? partRows(approval) : [];

  return (
    <div className="approval-surface" data-testid="approval">
      <h3>
        <Icon name="shield" className="gate-icon" /> Approve this command?
      </h3>
      <div className="sub">{pending.tool}</div>

      {drawn ? (
        <>
          <pre className="artifact shell-line" data-testid="approval-command">
            {lineSegments(approval.line, approval.parts).map((segment, at) =>
              segment.kind === "glue" ? (
                <span key={at} className="op">
                  {segment.text}
                </span>
              ) : (
                <span
                  key={at}
                  className={hot === segment.part ? "part-c hot" : "part-c"}
                  style={hueStyle(segment.part)}
                  onMouseEnter={() => setHot(segment.part)}
                  onMouseLeave={() => setHot(null)}
                >
                  <Pieces pieces={segment.pieces} />
                </span>
              ),
            )}
          </pre>
          <ul className="approval-parts" data-testid="approval-parts">
            {rows.map((row) => (
              <li
                key={row.index}
                className={`part ${row.verdict}${hot === row.index ? " hot" : ""}${row.depth > 0 ? " inner" : ""}`}
                style={{ ...hueStyle(row.index), "--depth": row.depth } as CSSProperties}
                onMouseEnter={() => setHot(row.index)}
                onMouseLeave={() => setHot(null)}
              >
                <span className="part-swatch" aria-hidden="true" />
                <code className="part-text" title={row.pieces.map((p) => p.text).join("")}>
                  <Pieces pieces={row.pieces} />
                </code>
                <span className="part-arrow">→</span>
                <span className="part-subject mono">{row.subject}</span>
                {row.note !== undefined ? (
                  <span className="part-note" title={row.note}>
                    {row.note}
                  </span>
                ) : null}
                <span className="part-verdict">
                  {row.by !== undefined ? <FunctionBy name={row.by} /> : null}
                  {verdictLabel(row.verdict)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : pending.command !== undefined ? (
        <pre className="artifact" data-testid="approval-command">
          {pending.command}
        </pre>
      ) : (
        <pre className="artifact">{JSON.stringify(pending.input, null, 2)}</pre>
      )}

      {reasonLines(pending).map((line, at) => (
        <Reason key={at} line={line} />
      ))}

      <div className="options approval-answers" ref={answers}>
        {(["allow", "deny"] as const).map((decision) => {
          const look = decision === "allow" ? "primary" : "danger";
          const verb = decision === "allow" ? "Allow" : "Deny";
          const menu = open === decision ? answerMenu(pending, decision, chosen) : undefined;
          return (
            <div key={decision} className={`split ${look}`}>
              <button type="button" className={`split-main ${look}`} data-testid={`approval-${decision}`} onClick={() => decide(decision, "once")}>
                {verb}
              </button>
              <button
                type="button"
                className={`split-caret ${look}`}
                aria-expanded={open === decision}
                aria-haspopup="menu"
                aria-label={`${verb}: what it covers and how far it reaches`}
                data-testid={`approval-${decision}-more`}
                onClick={() => setOpen(open === decision ? null : decision)}
              >
                <Icon name="chevron" />
              </button>
              {menu !== undefined ? (
                <div className="cx-submenu answer-menu" role="menu" ref={(el) => el?.scrollIntoView?.({ block: "nearest" })}>
                  {menu.what.length > 0 ? (
                    <>
                      <div className="answer-what">
                        <span className="cx-opt-hint">{menu.whatLabel}</span>
                        {menu.what.map((choice) => (
                          <div key={choice.key} className="answer-what-row" style={hueStyle(choice.part)}>
                            {menu.what.length > 1 ? <span className="part-swatch" aria-hidden="true" /> : null}
                            <div className="verdict-seg" role="radiogroup" aria-label={menu.whatLabel}>
                              {choice.options.map((option) => (
                                <button
                                  key={option.width}
                                  type="button"
                                  role="radio"
                                  aria-checked={choice.chosen === option.width}
                                  className={choice.chosen === option.width ? "default on" : "default"}
                                  onClick={() => setChosen({ ...chosen, [choice.key]: option.width })}
                                >
                                  {option.program ? (
                                    <>
                                      every <span className="mono">{option.width}</span> command
                                    </>
                                  ) : (
                                    <span className="mono">{option.width}</span>
                                  )}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="answer-rule" />
                    </>
                  ) : null}
                  {menu.reach.map((item, at) => (
                    <Fragment key={item.reach}>
                      {item.reach.startsWith("add:") && menu.reach[at - 1]?.reach.startsWith("add:") !== true ? <div className="answer-rule" /> : null}
                      <button type="button" role="menuitem" className={item.isDefault ? "on" : undefined} data-testid={`approval-${decision}-${item.reach}`} onClick={() => decide(decision, item.reach)}>
                        <span className="cx-tick">{item.isDefault ? "✓" : ""}</span>
                        <span className="cx-opt-text">
                          <span className="cx-opt-name ellip">{item.name}</span>
                          <span className="cx-opt-hint">
                            <Hint hint={item.hint} />
                          </span>
                        </span>
                      </button>
                    </Fragment>
                  ))}
                  {menu.notes.length > 0 ? (
                    <>
                      <div className="answer-rule" />
                      {menu.notes.map((note) => (
                        <p key={note} className="answer-note">
                          {note}
                        </p>
                      ))}
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {error ? <p className="reason">{error}</p> : null}
    </div>
  );
}

/** The approval in a modal — a caller's choice of place, for a request that names no task. */
export function ApprovalDialog(props: ApprovalSurfaceProps): JSX.Element {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        {props.pending.taskId !== undefined ? <div className="sub">{props.pending.taskId}</div> : null}
        <ApprovalSurface {...props} />
      </div>
    </div>
  );
}
