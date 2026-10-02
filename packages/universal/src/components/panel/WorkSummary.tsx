import { useContext, useMemo, useState, type JSX, type ReactNode } from "react";
import { ScrollView, useWindowDimensions } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import { approvalCallIndex } from "@jaira/ui/approvalCall";
import { ApprovalAskContext, WorkLookContext, useNow, useReadOnlyVerdicts } from "@jaira/ui/workSummaryContext";
import {
  ACTIVE_NAME,
  allOf,
  chipsOf,
  countOf,
  currentPhaseOf,
  isIdle,
  isQuiet,
  liveIndexOf,
  phasesOf,
  secondsOf,
  sentenceOf,
  spanOf,
  thoughtLineOf,
  windowOf,
  type Said,
  type WorkChip,
  type WorkKind,
  type WorkRun,
} from "@jaira/ui/workSummary";
import type { WorkEntry } from "@jaira/ui/transcript";
import { Press, Txt, edge, faceOf } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { Pulse } from "../chat/Pulse";
import { ApprovalSurface } from "../floats/ApprovalSurface";
import { Float } from "../floats/Float";
import { HoverFloatLayer, Tap, useHoverFloat, type HoverFloat } from "../floats/hoverFloat";
import { Icon, type IconName } from "./Icon";
import { ShellLine } from "./WorkRows";

/**
 * The work between two messages, summarised — a box of phases (a number, a name, a chip per kind of
 * work, the first line of its thinking, how long it took), the latest steps of the phase in progress,
 * and the foot, "Every step", that opens every row in place. Everything that counts something opens the
 * rows it counts in a card: on hover under a pointer, on a press under a finger, where it is a modal a
 * press outside closes (`floats/hoverFloat.tsx`; the foot's own press opens its rows in place instead). What it says is `workSummary.ts`'s; the
 * settings, the read-only judge and the approval its host can answer are `workSummaryContext.ts`'s
 * providers. How it looks:
 *
 *   the summary     margin 6 −6 10
 *   the box         column, gap 2, padding 5 6, 1px --line but the bottom, radius 8 8 0 0, --panel-2 55%
 *   a phase         radius 7; the current one --accent 5%, 3 under
 *   its head        row, centred, gap 8, at least 28 tall, padding 2 6
 *   its number      14 wide, right, data 600 10/12 (line normal), --tok-hint
 *   its name        92 wide, row, gap 5, app 600 12/12.5, --text (current --accent)
 *   "Earlier"       app 600 10/12.5 on 1, 0.07em, upper, --dim
 *   the chips       flex 0 1 auto, row, gap 4, clipped
 *   a chip          22 tall, padding 0 8 0 6, round, gap 5, the kind's hue 11% with an inset 1px ring at
 *                   22% (live: --accent, 1.5px); app 500 11.5/12.5 on 1, --text; its glyph 12 in the hue
 *   the thought     flex 1 1 0, row, gap 5, padding 0 3, radius 4, app 11.5/12.5 italic --dim; the glyph 11
 *                   --accent; hovered --text on --fill-ghost-hover
 *   how long        pushed right, 8 before, data 10.5/12 (line normal) --dim (current --accent), tabular
 *   the runs        margin 1 0 0 22
 *   a run           row (the time, 18 for the glyph, the sentence in what is left, how long so far),
 *                   gap 6, centred, padding 2 6, radius 6, app 12/12.5 --text; live --accent 7%; failed
 *                   its glyph --bad; wait all --warn
 *   the foot        row, centred, gap 8, padding 3 10, 1px --line, radius 0 0 8 8 (bare 8; open 0; bare
 *                   and open 8 8 0 0), --panel-2 55%, app 11.5/12.5 (line normal) --dim; hovered --text on
 *                   --panel-2
 *   every row, open padding 4 2 6, 1px --line but the top, radius 0 0 8 8
 *   the kept rows   6 above
 *   a hover card    at most 560 (the window less 32), padding 6, 1px --line, radius 10, --panel, --lift;
 *                   its head row, spaced, 4 under, padding 4 8 6, a --line under, app 11/12.5 --dim;
 *                   it stays where it opened while its rows are unfolded (`settle`), and follows
 *                   what it was opened from when the page scrolls under it
 *   what opens one  the pointer over it, or the keyboard's focus on it (each is in the Tab order); with
 *                   no pointer that hovers, a press on it, and a press outside the card closes it
 *   a called row    22 in, hooked to the call above: 1.5px --line left and bottom, 9 × 17, −13 · −5
 */

interface Rows {
  rowOf: (index: number) => ReactNode;
}

/** `line-height: normal`: the keyword itself on web, where the browser works it out; the figure below on a phone. */
export function normalLineOf(t: Tokens, voice: "app" | "data", scale: number): Record<string, unknown> {
  return isWeb ? { lineHeight: "normal" } : { lineHeight: normalLine(t, voice, scale) };
}

/** `line-height: normal` as Blink works it out for one font at one size: its ascent and descent, each rounded. */
export function normalLine(t: Tokens, voice: "app" | "data", scale: number): number {
  const size = Number(t.scaled(`size-${voice}`, scale)) || 12;
  return voice === "app" ? Math.round(size * 0.992) + Math.round(size * 0.31) : Math.round(size * 1.02) + Math.round(size * 0.3);
}

/** The hue a kind of work is drawn in, by token. */
const HUES: Record<WorkKind, string> = {
  think: "accent",
  read: "ws-read",
  search: "ws-search",
  write: "ws-write",
  run: "ws-run",
  git: "ws-run",
  web: "ws-web",
  agent: "ws-tool",
  tool: "ws-tool",
  wait: "warn",
  note: "tok-hint",
  approval: "tok-hint",
};
function hueOfKind(t: Tokens, kind: WorkKind): string {
  return String(t.v(HUES[kind]));
}

type HoverCard = HoverFloat;

/** In the Tab order (web): what opens a card under the pointer opens it under the keyboard's focus too. */
const REACHED: Record<string, unknown> = isWeb ? { tabIndex: 0 } : {};

/** The float a hover card is — placed under its anchor, in the layer over everything. */
function Card({ hover, label, count, children }: { hover: HoverCard; label: string; count?: string | undefined; children: ReactNode }): JSX.Element | null {
  const t = useTokens();
  const win = useWindowDimensions();
  if (!hover.open) return null;
  const card = (
    <Float
      anchor={hover.rect ?? { left: 0, top: 0, right: 0, bottom: 0 }}
      side="below"
      settle
      width={560}
      maxWidth={win.width - 32}
      padding={6}
      borderWidth={1}
      borderStyle="solid"
      borderColor={t.v("line") as never}
      borderRadius={10}
      backgroundColor={t.v("panel") as never}
      pointerEvents="auto"
      {...({ boxShadow: String(t.v("lift")) } as object)}
      {...hover.cardBind}
    >
      <View flexDirection="row" justifyContent="space-between" gap={10} marginBottom={4} paddingTop={4} paddingHorizontal={8} paddingBottom={6} {...(edge(t, { bottom: 1 }) as object)}>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{label}</Txt>
        {count !== undefined ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{count}</Txt> : null}
      </View>
      {/* Taller than the screen it scrolls inside: the box's own `overflow` does on web; a phone's needs a scroller. */}
      {isWeb ? children : <ScrollView nestedScrollEnabled>{children}</ScrollView>}
    </Float>
  );
  return <HoverFloatLayer hover={hover}>{card}</HoverFloatLayer>;
}

/** A row in a list of rows: a call a tool made sits under the call that made it. */
export function Nested({ entry, children }: { entry: WorkEntry | undefined; children: ReactNode }): JSX.Element {
  const t = useTokens();
  if (entry === undefined || entry.kind !== "tool" || entry.calledBy === undefined) return <View minWidth={0}>{children}</View>;
  return (
    <View position="relative" marginLeft={22} minWidth={0}>
      <View position="absolute" left={-13} top={-5} height={17} width={9} pointerEvents="none" borderBottomLeftRadius={6} {...(edge(t, { left: 1.5, bottom: 1.5 }) as object)} />
      {children}
    </View>
  );
}

/** The rows a card stands for, as the transcript draws them, in a column with no margins. */
function RowsList({ indices, rowOf, entries }: Rows & { indices: readonly number[]; entries?: readonly WorkEntry[] | undefined }): JSX.Element {
  return (
    <View flexDirection="column" minWidth={0}>
      {indices.map((i) => (
        <Nested key={i} entry={entries?.[i]}>
          {rowOf(i)}
        </Nested>
      ))}
    </View>
  );
}

const lines = (n: number): string => (n === 1 ? "1 line" : `${n} lines`);

/** `SaidText`: a run's sentence — words, and code in the data voice (a shell line in its parts' colours). */
function SaidText({ said }: { said: readonly Said[] }): JSX.Element {
  const t = useTokens();
  const size = t.scaled("size-data", 11 / 12);
  return (
    <>
      {said.map((part, i) =>
        "code" in part ? (
          <Text key={i} {...(faceOf(t, "data", 400, size) as object)} fontSize={size as never} color={t.v("dim") as never}>
            {part.shell === true ? <ShellLine line={part.code} /> : part.code}
          </Text>
        ) : (
          <Text key={i}>{part.text}</Text>
        ),
      )}
    </>
  );
}

function Chip({ chip, rowOf }: Rows & { chip: WorkChip }): JSX.Element {
  const t = useTokens();
  const hover = useHoverFloat();
  const hue = chip.live ? String(t.v("accent")) : chip.failed > 0 ? String(t.v("bad")) : hueOfKind(t, chip.kind);
  const [hovered, setHovered] = useState(false);
  const on = hover.open || hovered;
  return (
    <>
      <Tap hover={hover} style={{ flexShrink: 0 }}>
      <View
        ref={hover.anchor as never}
        testID="ws-chip"
        flexShrink={0}
        flexDirection="row"
        alignItems="center"
        gap={5}
        height={22}
        paddingLeft={6}
        paddingRight={8}
        borderRadius={999}
        backgroundColor={t.mix(hue, on ? 20 : 11, "transparent") as never}
        {...({ boxShadow: `inset 0px 0px 0px ${chip.live ? 1.5 : 1}px ${chip.live ? hue : t.mix(hue, 22, "transparent")}` } as object)}
        {...REACHED}
        {...(hover.hovers
          ? {
              ...hover.bind,
              onMouseEnter: () => {
                setHovered(true);
                (hover.bind.onMouseEnter as () => void)();
              },
              onMouseLeave: () => {
                setHovered(false);
                (hover.bind.onMouseLeave as () => void)();
              },
            }
          : {})}
      >
        {chip.live ? <Pulse color="accent" /> : <Icon name={chip.icon as IconName} size={12} color={hue} />}
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, weight: 500, color: "text", lineHeight: 1 }} numberOfLines={1}>
          {chip.label}
        </Txt>
        {chip.failed > 0 ? (
          <Txt spec={{ voice: "data", scale: 10 / (Number(t.scaled("size-data", 1)) || 12), weight: 700, color: "bad", lineHeight: 1 }}>
            {`${chip.failed}✕`}
          </Txt>
        ) : null}
      </View>
      </Tap>
      <Card hover={hover} label={chip.label} count={lines(chip.indices.length)}>
        <RowsList indices={chip.indices} rowOf={rowOf} />
      </Card>
    </>
  );
}

function Chips({ entries, indices, live, rowOf }: Rows & { entries: readonly WorkEntry[]; indices: readonly number[]; live?: number | undefined }): JSX.Element | null {
  if (indices.length === 0) return null;
  return (
    <View flexGrow={0} flexShrink={1} minWidth={0} flexDirection="row" flexWrap="nowrap" gap={4} overflow="hidden">
      {chipsOf(entries, indices, live).map((chip) => (
        <Chip key={chip.key} chip={chip} rowOf={rowOf} />
      ))}
    </View>
  );
}

/** `ThoughtLine`: the first line of a phase's reasoning, cut off before the time; the whole of it on hover. */
function ThoughtLine({ entries, indices }: { entries: readonly WorkEntry[]; indices: readonly number[] }): JSX.Element | null {
  const t = useTokens();
  const line = thoughtLineOf(entries, indices);
  const hover = useHoverFloat();
  if (line === undefined) return <View flexGrow={1} flexShrink={1} flexBasis={0} />;
  return (
    <>
      <Tap hover={hover} style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
      <View
        ref={hover.anchor as never}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minWidth={0}
        flexDirection="row"
        alignItems="center"
        gap={5}
        overflow="hidden"
        paddingHorizontal={3}
        borderRadius={4}
        backgroundColor={(hover.open ? t.v("fill-ghost-hover") : "transparent") as never}
        {...REACHED}
        {...hover.bind}
      >
        <Icon name="think" size={11} color={String(t.v("accent"))} />
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, italic: true, color: hover.open ? "text" : "dim" }} ellip minWidth={0} flexShrink={1}>
          {line.first}
        </Txt>
      </View>
      </Tap>
      <Card hover={hover} label="Thinking">
        <Txt spec={{ voice: "app", scale: 12.5 / 12.5, italic: true, color: "text", lineHeight: 1.55 }} whiteSpace="pre-wrap" paddingTop={4} paddingHorizontal={8} paddingBottom={6}>
          {line.full}
        </Txt>
      </Card>
    </>
  );
}

/** One of the phase's latest rows: consecutive calls of one kind, said in a sentence. */
function RunRow({ entries, run, live, now, clock, rowOf, below }: Rows & { entries: readonly WorkEntry[]; run: WorkRun; live?: number | undefined; now: number; clock: (at?: number) => string; below?: ReactNode }): JSX.Element {
  const t = useTokens();
  const hover = useHoverFloat();
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
  const wait = run.kind === "wait";
  const iconInk = failedCount > 0 ? "bad" : wait ? "warn" : "dim";
  const kind = chipsOf(entries, run.rows)[0]?.icon ?? "tool";
  return (
    <>
      <View flexDirection="row" alignItems="center" gap={6} minWidth={0} paddingVertical={2} paddingHorizontal={6} borderRadius={6} backgroundColor={(running ? t.mix(t.v("accent"), 7, "transparent") : "transparent") as never}>
        <Txt spec={{ voice: "data", scale: 10 / 12, color: "tok-hint", tabular: true }} {...normalLineOf(t, "data", 10 / 12)} flexShrink={0}>
          {clock(first.at)}
        </Txt>
        <View width={18} flexShrink={0} flexDirection="row" justifyContent="center">
          {running ? <Pulse color="dim" /> : <Icon name={kind as IconName} size={13} color={String(t.v(iconInk))} />}
        </View>
        <View flex={1} minWidth={0} flexDirection="row" alignItems="center" gap={6}>
          <Tap hover={hover} style={{ flexGrow: 0, flexShrink: 1, minWidth: 0 }}>
          <View ref={hover.anchor as never} flexGrow={0} flexShrink={1} minWidth={0} borderRadius={4} {...REACHED} {...hover.bind}>
            <Txt spec={{ voice: "app", scale: 12 / 12.5, color: wait ? "warn" : "text" }} ellip>
              <SaidText said={said} />
              {doing !== undefined ? (
                <Text color={t.v("accent") as never}>
                  <SaidText said={doing} />
                </Text>
              ) : null}
            </Txt>
          </View>
          </Tap>
          {failedCount > 0 ? (
            <View flexShrink={0} paddingHorizontal={5} borderRadius={4} backgroundColor={t.mix(t.v("bad"), 12, "transparent") as never}>
              <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600, color: "bad" }}>{`${failedCount} failed`}</Txt>
            </View>
          ) : null}
          {thoughtMs > 0 ? (
            <View flexShrink={0} flexDirection="row" alignItems="center" gap={3}>
              <Icon name="think" size={11} color={String(t.v("dim"))} />
              <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: "dim" }}>{secondsOf(thoughtMs)}</Txt>
            </View>
          ) : null}
          {run.notes.length > 0 ? (
            <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: "dim" }} flexShrink={0}>
              {`+${run.notes.length} system`}
            </Txt>
          ) : null}
        </View>
        <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "accent", tabular: true }} {...normalLineOf(t, "data", 10.5 / 12)} flexShrink={0}>
          {running && startedAt !== undefined ? secondsOf(Math.max(0, now - startedAt)) : ""}
        </Txt>
      </View>
      {below}
      <Card hover={hover} label={running ? "Now" : "These steps"} count={lines(allOf(run).length)}>
        <RowsList indices={allOf(run)} rowOf={rowOf} entries={entries} />
      </Card>
    </>
  );
}

/** The approval the step waits on, under its row. */
function Ask({ children, afterRow }: { children: ReactNode; afterRow: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <View
      marginTop={4}
      marginBottom={8}
      marginLeft={afterRow ? 30 : 104}
      paddingVertical={10}
      paddingHorizontal={12}
      borderWidth={1}
      borderStyle="solid"
      borderColor={t.v("line") as never}
      borderRadius={10}
      backgroundColor={t.v("panel") as never}
      minWidth={0}
    >
      {children}
    </View>
  );
}

/**
 * One stretch of work, summarised. `working`: the agent is still at it. `kept`: the rows no summary may
 * hide, drawn under it. `rowOf` draws one entry as the transcript's own row.
 */
export function WorkSummary({ entries, working, kept, rowOf, clock }: Rows & { entries: readonly WorkEntry[]; working: boolean; kept: readonly number[]; clock: (at?: number) => string }): JSX.Element {
  const t = useTokens();
  const look = useContext(WorkLookContext);
  const [open, setOpen] = useState(false);
  const live = useMemo(() => liveIndexOf(entries, working), [entries, working]);
  const now = useNow(working);
  const all = useMemo(() => entries.map((_, i) => i), [entries]);
  const dropIdle = look.notes !== "show";
  const { verdicts, heard } = useReadOnlyVerdicts(entries);
  const phases = useMemo(() => {
    if (look.phases) return phasesOf(entries, { merge: look.thinking ? "withheld" : "all", dropIdle, verdicts });
    return dropIdle && isIdle(entries, all) ? [] : [{ name: undefined, indices: all }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, look.phases, look.thinking, dropIdle, all, verdicts, heard]);
  const counted = (indices: readonly number[]): number[] => (look.notes === "hide" ? indices.filter((i) => !isQuiet(entries[i]!)) : [...indices]);
  const currentAt = currentPhaseOf(phases, live, working);
  const whole = spanOf(entries, all);
  const took = whole.start === undefined ? undefined : (working ? now : (whole.end ?? whole.start)) - whole.start;
  const foot = useHoverFloat();
  const ask = useContext(ApprovalAskContext);
  const askAt = working && ask !== undefined ? approvalCallIndex(entries, ask.pending.requestId) : -1;
  const prompt = (afterRow: boolean): ReactNode =>
    askAt >= 0 && ask !== undefined ? (
      <Ask afterRow={afterRow}>
        <ApprovalSurface key={ask.pending.requestId} pending={ask.pending} onDecide={ask.onDecide} heading={false} />
      </Ask>
    ) : null;
  let promptPlaced = false;
  const bare = phases.length === 0;
  const wash = t.mix(t.v("panel-2"), 55, "transparent");
  const footRadius = open ? (bare ? { borderTopLeftRadius: 8, borderTopRightRadius: 8, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : { borderRadius: 0 }) : bare ? { borderRadius: 8 } : { borderTopLeftRadius: 0, borderTopRightRadius: 0, borderBottomLeftRadius: 8, borderBottomRightRadius: 8 };
  return (
    <View testID="work-summary" marginTop={6} marginHorizontal={-6} marginBottom={10} minWidth={0}>
      {bare ? null : (
        <View flexDirection="column" gap={2} paddingVertical={5} paddingHorizontal={6} borderTopLeftRadius={8} borderTopRightRadius={8} backgroundColor={wash as never} minWidth={0} {...(edge(t, { top: 1, right: 1, left: 1 }) as object)}>
          {phases.map((phase, n) => {
            const current = n === currentAt;
            const win = current ? windowOf(entries, counted(phase.indices), look.rows) : { rolled: counted(phase.indices), shown: [] as WorkRun[] };
            const span = spanOf(entries, phase.indices);
            const phaseTook = span.start === undefined ? undefined : (current ? now : (span.end ?? span.start)) - span.start;
            return (
              <View key={n} minWidth={0} borderRadius={7} {...(current ? { backgroundColor: t.mix(t.v("accent"), 5, "transparent") as never, paddingBottom: 3 } : {})}>
                <View flexDirection="row" alignItems="center" gap={8} minWidth={0} minHeight={28} paddingVertical={2} paddingHorizontal={6}>
                  {phase.name !== undefined ? (
                    <>
                      <Txt spec={{ voice: "data", scale: 10 / 12, weight: 600, color: "tok-hint" }} {...normalLineOf(t, "data", 10 / 12)} width={14} flexShrink={0} textAlign="right">
                        {String(n + 1)}
                      </Txt>
                      <PhaseName name={current ? ACTIVE_NAME[phase.name] : phase.name} label={phase.name} current={current} indices={phase.indices} rowOf={rowOf} />
                    </>
                  ) : win.shown.length > 0 && win.rolled.length > 0 ? (
                    <Txt spec={{ voice: "app", scale: 10 / 12.5, weight: 600, ls: 0.07, upper: true, color: "dim", lineHeight: 1 }} flexShrink={0}>
                      Earlier
                    </Txt>
                  ) : null}
                  <Chips entries={entries} indices={win.rolled} live={live} rowOf={rowOf} />
                  {look.thinking ? <ThoughtLine entries={entries} indices={phase.indices} /> : <View flexGrow={1} flexShrink={1} flexBasis={0} />}
                  {phase.name !== undefined && phaseTook !== undefined ? (
                    <Txt spec={{ voice: "data", scale: 10.5 / 12, color: current ? "accent" : "dim", tabular: true }} {...normalLineOf(t, "data", 10.5 / 12)} flexShrink={0} marginLeft="auto" paddingLeft={8}>
                      {secondsOf(phaseTook)}
                    </Txt>
                  ) : null}
                </View>
                {win.shown.length > 0 ? (
                  <View marginTop={1} marginLeft={22} minWidth={0}>
                    {win.shown.map((run, k) => {
                      const here = askAt >= 0 && k === win.shown.length - 1 && run.rows.includes(askAt);
                      if (here) promptPlaced = true;
                      return <RunRow key={run.rows[0]} entries={entries} run={run} live={live} now={now} clock={clock} rowOf={rowOf} {...(here ? { below: prompt(false) } : {})} />;
                    })}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      )}
      {/* The foot's own box is what its card is opened from and placed against: the whole button, under
          the pointer or the keyboard's focus (the button is in the Tab order itself). */}
      <View ref={foot.anchor as never} minWidth={0} {...(!open ? foot.bind : {})}>
      <Press
        onPress={() => {
          foot.close();
          setOpen((was) => !was);
        }}
        {...({ "aria-expanded": open } as object)}
        width="100%"
        flexDirection="row"
        alignItems="center"
        gap={8}
        paddingVertical={3}
        paddingHorizontal={10}
        borderWidth={1}
        borderStyle="solid"
        borderColor={t.v("line") as never}
        {...footRadius}
        box={({ hovered }) => ({ backgroundColor: hovered ? t.v("panel-2") : wash })}
      >
        {({ hovered }) => (
          <View flex={1} flexDirection="row" alignItems="center" gap={8} minWidth={0}>
            <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: hovered ? "text" : "dim" }} {...normalLineOf(t, "app", 11.5 / 12.5)} flex={1} minWidth={0}>
              Every step
            </Txt>
            <Txt spec={{ voice: "data", scale: 10.5 / 12, color: hovered ? "text" : "dim", tabular: true }} {...normalLineOf(t, "data", 10.5 / 12)} flexShrink={0}>
              {`${countOf(entries)}${took !== undefined ? ` · ${secondsOf(took)}${working ? " so far" : ""}` : ""}`}
            </Txt>
            <View width={14} flexShrink={0} flexDirection="row" transform={open ? [{ rotate: "180deg" }] : []}>
              <Icon name="chevron" size={13} color={String(t.v("tok-hint"))} />
            </View>
          </View>
        )}
      </Press>
      </View>
      {!open ? (
        <Card hover={foot} label="Every step" count={`${entries.length} lines`}>
          <RowsList indices={all} rowOf={rowOf} entries={entries} />
        </Card>
      ) : null}
      {open ? (
        <View flexDirection="column" minWidth={0} paddingTop={4} paddingHorizontal={2} paddingBottom={6} borderBottomLeftRadius={8} borderBottomRightRadius={8} {...(edge(t, { right: 1, bottom: 1, left: 1 }) as object)}>
          <RowsList indices={all} rowOf={rowOf} entries={entries} />
        </View>
      ) : kept.length > 0 ? (
        <View flexDirection="column" minWidth={0} marginTop={6}>
          {kept.map((i) => (
            <View key={i} minWidth={0}>
              {rowOf(i)}
            </View>
          ))}
        </View>
      ) : null}
      {askAt >= 0 && !promptPlaced ? (
        <>
          {open ? null : (
            <View flexDirection="column" minWidth={0} marginTop={6}>
              {rowOf(askAt)}
            </View>
          )}
          {prompt(!open)}
        </>
      ) : null}
    </View>
  );
}

/** The phase's name (a pulse before it while it is the one in progress), and its rows on hover. */
function PhaseName({ name, label, current, indices, rowOf }: Rows & { name: string; label: string; current: boolean; indices: readonly number[] }): JSX.Element {
  const hover = useHoverFloat();
  return (
    <>
      <Tap hover={hover} style={{ width: 92, flexShrink: 0 }}>
      <View ref={hover.anchor as never} width={92} flexShrink={0} flexDirection="row" alignItems="center" gap={5} borderRadius={4} {...REACHED} {...hover.bind}>
        {current ? <Pulse /> : null}
        <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: current ? "accent" : "text" }} numberOfLines={1}>
          {name}
        </Txt>
      </View>
      </Tap>
      <Card hover={hover} label={label} count={lines(indices.length)}>
        <RowsList indices={indices} rowOf={rowOf} />
      </Card>
    </>
  );
}

