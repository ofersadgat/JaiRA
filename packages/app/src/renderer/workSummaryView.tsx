/**
 * The work between two messages, summarised — see `workSummary.ts` for what it says and why.
 *
 * A box of PHASES, each one row — its name, a chip per kind of work, the first line of its thinking
 * where the provider kept it, how long it took — and a foot, "Every step", that opens every row in
 * place. While the agent works, the phase in progress keeps its latest steps as rows and its name
 * pulses. Everything that counts something is a hover card of the rows it counts, so nothing a
 * summary says is further than a pointer away from the evidence.
 *
 * Three settings shape it (Appearance → Conversation, {@link WorkLook}): phases on or off, how many
 * rows the phase in progress keeps, and the thinking line on or off.
 *
 * The rows themselves are the transcript's own (`rowOf`), passed in rather than imported, so this and
 * `transcriptView.tsx` do not import each other.
 */
import { useContext, useMemo, useState, type JSX, type ReactNode } from "react";
import { ApprovalSurface } from "./approvalSurface";
// The settings, the read-only judge, the approval being asked and the clock — `workSummaryContext.ts`,
// shared with the universal copy (decision 0015), so both trees read the same providers.
import { ApprovalAskContext, WorkLookContext, useNow, useReadOnlyVerdicts } from "./workSummaryContext";
export { ApprovalAskContext, DEFAULT_WORK_LOOK, ReadOnlyJudgeContext, WorkLookContext, forgetReadOnly, readOnlyJudgeOf, type ApprovalAsk, type ReadOnlyJudge, type WorkLook } from "./workSummaryContext";
import { Icon } from "./icons";
import { Popover, useHoverCard } from "./popover";
import { ShellLine } from "./shellLine";
import type { ToolEntry, WorkEntry } from "./transcript";
import { approvalCallIndex } from "./approvalCall";
// Where the pending approval's call is in a stretch — `approvalCall.ts` (pure, shared with the universal shell).
export { approvalCallIndex };

/** A call a tool made sits under the call that made it — in Every step and in a hover card's list. */
const nestOf = (entry: WorkEntry | undefined): string | undefined =>
  entry !== undefined && entry.kind === "tool" && entry.calledBy !== undefined ? "ts-called" : undefined;
import {
  allOf,
  chipsOf,
  inFlight,
  isApprovalCall,
  isIdle,
  isQuiet,
  phasesOf,
  secondsOf,
  sentenceOf,
  spanOf,
  countOf,
  thoughtLineOf,
  windowOf,
  verdictKeyOf,
  ACTIVE_NAME,
  type ReadOnlyVerdicts,
  type Said,
  type WorkChip,
  type WorkRun,
} from "./workSummary";

function Pulse(): JSX.Element {
  return (
    <span className="ts-pulse" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

function SaidText({ said }: { said: readonly Said[] }): JSX.Element {
  return (
    <>
      {said.map((part, i) =>
        "code" in part ? (
          <code key={i}>{part.shell === true ? <ShellLine line={part.code} /> : part.code}</code>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

interface Rows {
  rowOf: (index: number) => ReactNode;
}

/** The hover card every summary part opens: the rows it stands for, as the transcript draws them. */
function RowsCard({ label, indices, rowOf, entries, children }: Rows & { label: string; indices: readonly number[]; entries?: readonly WorkEntry[]; children: (bind: ReturnType<typeof useHoverCard<HTMLSpanElement>>) => ReactNode }): JSX.Element {
  const hover = useHoverCard<HTMLSpanElement>();
  return (
    <>
      {children(hover)}
      {hover.open ? (
        <Popover anchor={hover.anchor} side="below" settle className="ws-card" {...hover.cardBind}>
          <div className="ws-card-head">
            <span>{label}</span>
            <span>{indices.length === 1 ? "1 line" : `${indices.length} lines`}</span>
          </div>
          <div className="ts-work">
            {indices.map((i) => (
              <div key={i} className={nestOf(entries?.[i])}>
                {rowOf(i)}
              </div>
            ))}
          </div>
        </Popover>
      ) : null}
    </>
  );
}

function Chip({ chip, rowOf }: Rows & { chip: WorkChip }): JSX.Element {
  return (
    <RowsCard label={chip.label} indices={chip.indices} rowOf={rowOf}>
      {(hover) => (
        <span
          ref={hover.anchor}
          {...hover.bind}
          className={`ws-chip ws-k-${chip.kind}${chip.failed > 0 ? " failed" : ""}${chip.live ? " live" : ""}`}
          tabIndex={0}
          data-testid="ws-chip"
        >
          {chip.live ? <Pulse /> : <Icon name={chip.icon} />}
          <span>{chip.label}</span>
          {chip.failed > 0 ? <b className="ws-chip-failed">{chip.failed}✕</b> : null}
        </span>
      )}
    </RowsCard>
  );
}

function Chips({ entries, indices, live, rowOf }: Rows & { entries: readonly WorkEntry[]; indices: readonly number[]; live?: number | undefined }): JSX.Element | null {
  if (indices.length === 0) return null;
  return (
    <span className="ws-chips">
      {chipsOf(entries, indices, live).map((chip) => (
        <Chip key={chip.key} chip={chip} rowOf={rowOf} />
      ))}
    </span>
  );
}

/** The first line of a phase's reasoning, cut off before the time; the whole of it on hover. */
function ThoughtLine({ entries, indices }: { entries: readonly WorkEntry[]; indices: readonly number[] }): JSX.Element | null {
  const line = thoughtLineOf(entries, indices);
  const hover = useHoverCard<HTMLSpanElement>();
  if (line === undefined) return null;
  return (
    <>
      <span ref={hover.anchor} {...hover.bind} className="ws-think" tabIndex={0}>
        <Icon name="think" />
        <span className="ws-think-text">{line.first}</span>
      </span>
      {hover.open ? (
        <Popover anchor={hover.anchor} side="below" className="ws-card ws-card-think" {...hover.cardBind}>
          <div className="ws-card-head">
            <span>Thinking</span>
          </div>
          <p className="ws-card-text">{line.full}</p>
        </Popover>
      ) : null}
    </>
  );
}

/** One of J's rows: consecutive calls of one kind, said in a sentence. */
function RunRow({ entries, run, live, now, clock, rowOf, below }: Rows & { entries: readonly WorkEntry[]; run: WorkRun; live?: number | undefined; now: number; clock: (at?: number) => string; below?: ReactNode }): JSX.Element {
  const { said, now: doing } = sentenceOf(entries, run, live);
  const running = doing !== undefined;
  const failedCount = run.rows.filter((i) => {
    const e = entries[i]!;
    return e.kind === "tool" && e.ok === false;
  }).length;
  const thoughtMs = run.thoughts.reduce((sum, i) => {
    const e = entries[i]!;
    return sum + (e.kind === "thought" ? (e.durationMs ?? 0) : 0);
  }, 0);
  const first = entries[run.rows[0]!]!;
  const startedAt = live !== undefined ? entries[live]!.at : undefined;
  return (
    <RowsCard label={running ? "Now" : "These steps"} indices={allOf(run)} rowOf={rowOf} entries={entries}>
      {(hover) => (
        <>
        <div className={`ws-run${running ? " live" : ""}${failedCount > 0 ? " failed" : ""}${run.kind === "wait" ? " wait" : ""}`}>
          <span className="ws-run-at">{clock(first.at)}</span>
          <span className="ws-run-icon">{running ? <Pulse /> : <Icon name={kindIcon(entries, run)} />}</span>
          <span className="ws-run-line">
            <span ref={hover.anchor} {...hover.bind} className="ws-run-said" tabIndex={0}>
              <SaidText said={said} />
              {doing !== undefined ? (
                <span className="ws-now">
                  <SaidText said={doing} />
                </span>
              ) : null}
            </span>
            {failedCount > 0 ? <span className="ws-failed">{failedCount} failed</span> : null}
            {thoughtMs > 0 ? (
              <span className="ws-run-note">
                <Icon name="think" />
                {secondsOf(thoughtMs)}
              </span>
            ) : null}
            {run.notes.length > 0 ? <span className="ws-run-note">+{run.notes.length} system</span> : null}
          </span>
          <span className="ws-run-took">{running && startedAt !== undefined ? secondsOf(Math.max(0, now - startedAt)) : ""}</span>
        </div>
        {below}
        </>
      )}
    </RowsCard>
  );
}
function kindIcon(entries: readonly WorkEntry[], run: WorkRun): Parameters<typeof Icon>[0]["name"] {
  return chipsOf(entries, run.rows)[0]?.icon ?? "tool";
}

/**
 * One stretch of work, summarised.
 *
 * `working` says the agent is still at it — the stretch is the last thing in the transcript and a
 * call in it has no answer yet, or a status bar says a turn is live. `kept` are the rows no summary
 * may hide (a page the model made, a delivered output, a question it asked); they stay drawn under
 * it. `rowOf` draws one entry as the transcript's own row.
 */
export function WorkSummary({
  entries,
  working,
  kept,
  rowOf,
  clock,
}: Rows & {
  entries: readonly WorkEntry[];
  working: boolean;
  kept: readonly number[];
  clock: (at?: number) => string;
}): JSX.Element {
  const look = useContext(WorkLookContext);
  const [open, setOpen] = useState(false);
  const live = useMemo(() => {
    if (!working) return undefined;
    for (let i = entries.length - 1; i >= 0; i--) if (inFlight(entries[i]!)) return i;
    return undefined;
  }, [entries, working]);
  const now = useNow(working);
  const all = useMemo(() => entries.map((_, i) => i), [entries]);
  const dropIdle = look.notes !== "show";
  const { verdicts, heard } = useReadOnlyVerdicts(entries);
  const phases = useMemo(() => {
    if (look.phases) return phasesOf(entries, { merge: look.thinking ? "withheld" : "all", dropIdle, verdicts });
    // Without phases the stretch is the one group, and the same rule applies to it.
    return dropIdle && isIdle(entries, all) ? [] : [{ name: undefined, indices: all }];
    // `heard` moves when the read-only set answers, and a phase's name may move with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, look.phases, look.thinking, dropIdle, all, verdicts, heard]);
  /** What the summary counts: everything, or — hiding them — all but the rate limits and notes. */
  const counted = (indices: readonly number[]): number[] => (look.notes === "hide" ? indices.filter((i) => !isQuiet(entries[i]!)) : [...indices]);
  // The phase in progress: the one holding the running call — or, between calls, the last one.
  const currentAt = working ? (live !== undefined ? phases.findIndex((p) => p.indices.includes(live)) : phases.length - 1) : -1;
  const whole = spanOf(entries, all);
  const took = whole.start === undefined ? undefined : (working ? now : (whole.end ?? whole.start)) - whole.start;
  const foot = useHoverCard<HTMLButtonElement>();
  // The approval this stretch is waiting on, when the host can answer it: drawn in the latest row the
  // summary shows when that row is its step, and otherwise under the summary with its own row.
  const ask = useContext(ApprovalAskContext);
  const askAt = working && ask !== undefined ? approvalCallIndex(entries, ask.pending.requestId) : -1;
  const prompt =
    askAt >= 0 && ask !== undefined ? (
      <div className="inline-gate ws-ask">
        <ApprovalSurface key={ask.pending.requestId} pending={ask.pending} onDecide={ask.onDecide} />
      </div>
    ) : null;
  let promptPlaced = false;
  return (
    <div className={`ws${working ? " working" : ""}${open ? " open" : ""}${phases.length === 0 ? " bare" : ""}`} data-testid="work-summary">
      {/* Nothing left to summarise — every line was a rate limit or a note — leaves only the foot. */}
      {phases.length === 0 ? null : (
      <div className="ws-box">
        {phases.map((phase, n) => {
          const current = n === currentAt;
          const win = current ? windowOf(entries, counted(phase.indices), look.rows) : { rolled: counted(phase.indices), shown: [] as WorkRun[] };
          const span = spanOf(entries, phase.indices);
          const phaseTook = span.start === undefined ? undefined : (current ? now : (span.end ?? span.start)) - span.start;
          return (
            <div key={n} className={`ws-phase${current ? " current" : ""}`}>
              <div className="ws-head">
                {phase.name !== undefined ? (
                  <>
                    <span className="ws-n">{n + 1}</span>
                    <RowsCard label={phase.name} indices={phase.indices} rowOf={rowOf}>
                      {(hover) => (
                        <span ref={hover.anchor} {...hover.bind} className="ws-name" tabIndex={0}>
                          {current ? <Pulse /> : null}
                          {current ? ACTIVE_NAME[phase.name] : phase.name}
                        </span>
                      )}
                    </RowsCard>
                  </>
                ) : win.shown.length > 0 && win.rolled.length > 0 ? (
                  <span className="ws-earlier">Earlier</span>
                ) : null}
                <Chips entries={entries} indices={win.rolled} live={live} rowOf={rowOf} />
                {look.thinking ? <ThoughtLine entries={entries} indices={phase.indices} /> : <span className="ws-fill" />}
                {phase.name !== undefined && phaseTook !== undefined ? <span className="ws-took">{secondsOf(phaseTook)}</span> : null}
              </div>
              {win.shown.length > 0 ? (
                <div className="ws-runs">
                  {win.shown.map((run, k) => {
                    const here = prompt !== null && k === win.shown.length - 1 && run.rows.includes(askAt);
                    if (here) promptPlaced = true;
                    return <RunRow key={run.rows[0]} entries={entries} run={run} live={live} now={now} clock={clock} rowOf={rowOf} {...(here ? { below: prompt } : {})} />;
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      )}
      <button
        type="button"
        ref={foot.anchor}
        {...(open ? {} : foot.bind)}
        className="ws-foot"
        aria-expanded={open}
        onClick={() => {
          foot.close();
          setOpen((was) => !was);
        }}
      >
        <span className="ws-foot-label">Every step</span>
        <span className="ws-foot-count">
          {countOf(entries)}{took !== undefined ? ` · ${secondsOf(took)}${working ? " so far" : ""}` : ""}
        </span>
        <span className="ts-chev">
          <Icon name="chevron" />
        </span>
      </button>
      {foot.open && !open ? (
        <Popover anchor={foot.anchor} side="below" settle className="ws-card" {...foot.cardBind}>
          <div className="ws-card-head">
            <span>Every step</span>
            <span>{entries.length} lines</span>
          </div>
          <div className="ts-work">
            {all.map((i) => (
              <div key={i} className={nestOf(entries[i])}>
                {rowOf(i)}
              </div>
            ))}
          </div>
        </Popover>
      ) : null}
      {open ? (
        <div className="ws-all ts-work">
          {all.map((i) => (
            <div key={i} className={nestOf(entries[i])}>
              {rowOf(i)}
            </div>
          ))}
        </div>
      ) : kept.length > 0 ? (
        <div className="ws-kept ts-work">{kept.map((i) => <div key={i}>{rowOf(i)}</div>)}</div>
      ) : null}
      {/* Not in a row the summary shows — rows set to None, or phases off — so under the summary, with
          its own row (unless Every step is open, which already lists it). */}
      {prompt !== null && !promptPlaced ? (
        <>
          {open ? null : <div className="ws-kept ts-work ws-ask-row">{rowOf(askAt)}</div>}
          {prompt}
        </>
      ) : null}
    </div>
  );
}
