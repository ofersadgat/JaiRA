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
import { createContext, useContext, useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import type { WorkNotes, WorkRows } from "@jaira/shared/browser";
import { Icon } from "./icons";
import { Popover, useHoverCard } from "./popover";
import type { ToolEntry, WorkEntry } from "./transcript";
import {
  allOf,
  chipsOf,
  inFlight,
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

/** The three settings, as the transcript reads them. */
export interface WorkLook {
  phases: boolean;
  rows: WorkRows;
  thinking: boolean;
  /** Rate limits and system notes — see `WorkNotes`. */
  notes: WorkNotes;
}
export const DEFAULT_WORK_LOOK: WorkLook = { phases: true, rows: 3, thinking: true, notes: "hide-groups" };
/** Provided by the shell from `appearance.conversation`; the default wherever nothing provides it. */
export const WorkLookContext = createContext<WorkLook>(DEFAULT_WORK_LOOK);

/**
 * Where a phase's name learns which calls CHANGED something: the project's read-only permission set,
 * asked once per distinct call and remembered (`permissionSets:judgeReadOnly`, {@link isChange}).
 * Provided by the shell for the project it stands on, the Appearance preview's sample calls included;
 * where nothing provides it (a test's markup), a call that edits is a change and nothing else is.
 */
export interface ReadOnlyJudge {
  /** Answers, by {@link verdictKeyOf} — for the permission set as it was when they were asked. */
  known: Map<string, boolean | null>;
  asking: Set<string>;
  /** Asked, and the asking failed: not asked again until the set changes. */
  failed: Set<string>;
  /** Moves each time the set changes, so an answer asked of the old one is not kept. */
  generation: number;
  heard: Set<() => void>;
  ask: (calls: Array<{ id: string; name: string; args: unknown }>) => Promise<Record<string, boolean | null>>;
}
export function readOnlyJudgeOf(ask: ReadOnlyJudge["ask"]): ReadOnlyJudge {
  return { known: new Map(), asking: new Set(), failed: new Set(), generation: 0, heard: new Set(), ask };
}
/**
 * The permission sets changed: every answer is asked again. Remembered only so the conversation does
 * not ask main about every call on every streaming update — each answer reads the set's layered files
 * from disk — and never past a change to what it answered.
 */
export function forgetReadOnly(judge: ReadOnlyJudge): void {
  judge.generation++;
  judge.known.clear();
  judge.asking.clear();
  judge.failed.clear();
  for (const hear of judge.heard) hear();
}
export const ReadOnlyJudgeContext = createContext<ReadOnlyJudge | undefined>(undefined);

/** What the read-only set says of each call in `entries`, asking for the ones it has not been asked about; and a count that moves when an answer lands. */
function useReadOnlyVerdicts(entries: readonly WorkEntry[]): { verdicts: ReadOnlyVerdicts | undefined; heard: number } {
  const judge = useContext(ReadOnlyJudgeContext);
  const [heard, setHeard] = useState(0);
  useEffect(() => {
    if (judge === undefined) return;
    const hear = (): void => setHeard((n) => n + 1);
    judge.heard.add(hear);
    return () => void judge.heard.delete(hear);
  }, [judge]);
  useEffect(() => {
    if (judge === undefined) return;
    const wanted = new Map<string, ToolEntry>();
    for (const entry of entries) {
      if (entry.kind !== "tool") continue;
      const key = verdictKeyOf(entry);
      if (!judge.known.has(key) && !judge.asking.has(key) && !judge.failed.has(key)) wanted.set(key, entry);
    }
    if (wanted.size === 0) return;
    const generation = judge.generation;
    for (const key of wanted.keys()) judge.asking.add(key);
    void judge
      .ask([...wanted].map(([id, entry]) => ({ id, name: entry.name, args: entry.args ?? null })))
      .then(
        (said) => {
          if (judge.generation !== generation) return;
          for (const [key, verdict] of Object.entries(said)) judge.known.set(key, verdict);
        },
        () => {
          if (judge.generation === generation) for (const key of wanted.keys()) judge.failed.add(key);
        },
      )
      .finally(() => {
        if (judge.generation !== generation) return;
        for (const key of wanted.keys()) judge.asking.delete(key);
        for (const hear of judge.heard) hear();
      });
    // `heard`: after the set changes, what was answered is asked again.
  }, [entries, judge, heard]);
  const verdicts = useMemo<ReadOnlyVerdicts | undefined>(() => (judge === undefined ? undefined : (entry) => judge.known.get(verdictKeyOf(entry))), [judge]);
  return { verdicts, heard };
}

function Pulse(): JSX.Element {
  return (
    <span className="ts-pulse" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

/** A clock that moves once a second while something is running, and not otherwise. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

function SaidText({ said }: { said: readonly Said[] }): JSX.Element {
  return (
    <>
      {said.map((part, i) => ("code" in part ? <code key={i}>{part.code}</code> : <span key={i}>{part.text}</span>))}
    </>
  );
}

interface Rows {
  rowOf: (index: number) => ReactNode;
}

/** The hover card every summary part opens: the rows it stands for, as the transcript draws them. */
function RowsCard({ label, indices, rowOf, children }: Rows & { label: string; indices: readonly number[]; children: (bind: ReturnType<typeof useHoverCard<HTMLSpanElement>>) => ReactNode }): JSX.Element {
  const hover = useHoverCard<HTMLSpanElement>();
  return (
    <>
      {children(hover)}
      {hover.open ? (
        <Popover anchor={hover.anchor} side="below" className="ws-card" {...hover.cardBind}>
          <div className="ws-card-head">
            <span>{label}</span>
            <span>{indices.length === 1 ? "1 line" : `${indices.length} lines`}</span>
          </div>
          <div className="ts-work">{indices.map((i) => <div key={i}>{rowOf(i)}</div>)}</div>
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
function RunRow({ entries, run, live, now, clock, rowOf }: Rows & { entries: readonly WorkEntry[]; run: WorkRun; live?: number | undefined; now: number; clock: (at?: number) => string }): JSX.Element {
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
    <RowsCard label={running ? "Now" : "These steps"} indices={allOf(run)} rowOf={rowOf}>
      {(hover) => (
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
                  {win.shown.map((run) => (
                    <RunRow key={run.rows[0]} entries={entries} run={run} live={live} now={now} clock={clock} rowOf={rowOf} />
                  ))}
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
        <Popover anchor={foot.anchor} side="below" className="ws-card" {...foot.cardBind}>
          <div className="ws-card-head">
            <span>Every step</span>
            <span>{entries.length} lines</span>
          </div>
          <div className="ts-work">{all.map((i) => <div key={i}>{rowOf(i)}</div>)}</div>
        </Popover>
      ) : null}
      {open ? (
        <div className="ws-all ts-work">{all.map((i) => <div key={i}>{rowOf(i)}</div>)}</div>
      ) : kept.length > 0 ? (
        <div className="ws-kept ts-work">{kept.map((i) => <div key={i}>{rowOf(i)}</div>)}</div>
      ) : null}
    </div>
  );
}
