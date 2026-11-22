import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type JSX, type MouseEvent as ReactMouseEvent } from "react";
import { View, isWeb } from "@tamagui/core";
import type { ProcessCount, ProcessOrigin, ProcessSummary, ProcessTaskFacts } from "@jaira/shared/browser";
import { countChipOf, originLabelOf, originLookOf, processBadgeOf, processCountsByParent, type ProcessTone } from "@jaira/ui/processTaskModel";
import { processes } from "@jaira/ui/processStore";
import { syncCache } from "@jaira/ui/store";
import { Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";

/**
 * The small parts a process task is drawn with wherever it is (decision 0032, "The view", round 2's
 * boards 6–9): its badge, the origin chip, a port chip, the `↰ from` link, the glyph, and the parent's
 * count chip. How they look:
 *
 *   the badge        the status pill's shape (gap 3, padding 1 6 1 5, radius 999), data 0.8 × --size-data
 *                    600, in its tone, its tone at 15% under it (an end: flat)
 *   the origin chip  data 10/12, --dim on --panel-2, 1px --line, radius 4, padding 0 5; escaped --warn on
 *                    its tint; left running a dashed --line
 *   a port chip      data 10/12 600, --accent on its tint, radius 4, padding 0 5
 *   the from line    data 0.84, --accent; hovered underlined
 *   the glyph        16 square, radius 4, --panel-3, `⌞` in --dim
 *   the count chip   data 10.5/12, --accent on its tint, 1px --accent at 35%, radius 4, padding 0 5,
 *                    then the rest of the count in --dim
 */
const INK: Record<ProcessTone, string> = { accent: "accent", ok: "ok", warn: "warn", bad: "bad", dim: "dim" };

export function ProcessBadge({ facts, title }: { facts: Pick<ProcessTaskFacts, "state" | "ports" | "exitCode" | "signal">; title?: string }): JSX.Element {
  const t = useTokens();
  const badge = processBadgeOf(facts);
  const flat = badge.tone === "dim";
  return (
    <View
      {...((isWeb && title !== undefined ? { title } : {}) as object)}
      flexDirection="row"
      alignItems="center"
      gap={3}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={flat ? 3 : 5}
      paddingRight={flat ? 3 : 6}
      borderRadius={999}
      flexShrink={0}
      backgroundColor={(flat ? "transparent" : t.tint(INK[badge.tone], 15)) as never}
    >
      <Txt spec={{ voice: "data", scale: 0.78, weight: 600, color: INK[badge.tone], lineHeight: 1 }}>{badge.glyph}</Txt>
      <Txt spec={{ voice: "data", scale: 0.8, weight: 600, color: INK[badge.tone], lineHeight: { px: 15 }, tabular: true }} whiteSpace="nowrap">
        {badge.text}
      </Txt>
    </View>
  );
}

/** A small boxed word: the origin, a port, an exit. */
function Chip({ words, ink, ground, line, dashed = false, weight = 400, title, shrink = true }: { words: string; ink: string; ground: string; line: string; dashed?: boolean; weight?: number; title?: string | undefined; shrink?: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <View
      {...((isWeb && title !== undefined ? { title } : {}) as object)}
      flexShrink={shrink ? 1 : 0}
      minWidth={shrink ? 0 : undefined}
      paddingHorizontal={5}
      borderRadius={4}
      backgroundColor={ground as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, line, dashed ? "dashed" : "solid") as object)}
    >
      <Txt spec={{ voice: "data", scale: 10 / 12, weight, color: ink, lineHeight: { px: 15 } }} ellip>
        {words}
      </Txt>
    </View>
  );
}

export function OriginChip({ origin, why }: { origin: ProcessOrigin; why?: string | undefined }): JSX.Element {
  const t = useTokens();
  const look = originLookOf(origin);
  const words = `${origin === "left" ? "⇥ " : ""}${originLabelOf({ origin, why })}`;
  if (look === "warn") return <Chip words={words} ink={String(t.v("warn"))} ground={String(t.tint("warn", 12))} line={String(t.mix(t.v("warn"), 40, "transparent"))} title={why} />;
  return <Chip words={words} ink={String(t.v("dim"))} ground={String(t.v("panel-2"))} line="line" dashed={look === "dashed"} title={why} />;
}

export function PortChip({ ports }: { ports: readonly number[] }): JSX.Element | null {
  const t = useTokens();
  if (ports.length === 0) return null;
  return <Chip words={ports.map((p) => `:${p}`).join(" ")} ink={String(t.v("accent"))} ground={String(t.tint("accent", 12))} line={String(t.mix(t.v("accent"), 25, "transparent"))} weight={600} shrink={false} />;
}

export function ExitChip({ facts }: { facts: Pick<ProcessTaskFacts, "state" | "exitCode" | "signal"> }): JSX.Element | null {
  const t = useTokens();
  if (facts.state !== "exited" && facts.state !== "failed") return null;
  const words = facts.exitCode !== undefined && facts.exitCode !== null ? `exit ${facts.exitCode}` : (facts.signal ?? "exit ?");
  const tone = facts.state === "failed" ? "bad" : "ok";
  return <Chip words={words} ink={String(t.v(tone))} ground={String(t.tint(tone, 12))} line={String(t.mix(t.v(tone), 30, "transparent"))} weight={600} shrink={false} />;
}

/** The process glyph: what stands where a task row's status square or a card's head would. */
export function ProcessGlyph({ size = 16 }: { size?: number }): JSX.Element {
  const t = useTokens();
  return (
    <View width={size} height={size} borderRadius={4} flexShrink={0} alignItems="center" justifyContent="center" backgroundColor={t.v("panel-3") as never}>
      <Txt spec={{ voice: "data", scale: (size * 0.62) / 12, color: "dim", lineHeight: 1 }}>⌞</Txt>
    </View>
  );
}

/** `↰ from Dev server and the gutter`: pressed, it goes to the parent (and only there: the card is not selected on the way). */
export function FromLine({ words, onGo }: { words: string; onGo?: (() => void) | undefined }): JSX.Element {
  const web =
    isWeb && onGo !== undefined
      ? {
          onClick: (e: ReactMouseEvent) => {
            e.stopPropagation();
            onGo();
          },
          onDoubleClick: (e: ReactMouseEvent) => e.stopPropagation(),
          cursor: "pointer",
          title: "Open the task that started it",
        }
      : {};
  return (
    <View flexDirection="row" minWidth={0} flexShrink={1} {...(web as object)} hoverStyle={onGo !== undefined ? ({ textDecorationLine: "underline" } as never) : undefined}>
      <Txt spec={{ voice: "data", scale: 0.84, color: onGo !== undefined ? "accent" : "dim" }} ellip>
        {words}
      </Txt>
    </View>
  );
}

/** The parent's count chip (board 6): `↳ 6 processes` boxed, then `4 running · 1 escaped`. */
export function CountChip({ count }: { count: ProcessCount }): JSX.Element | null {
  const t = useTokens();
  const chip = countChipOf(count);
  if (chip === undefined) return null;
  return (
    <View flexDirection="row" alignItems="center" gap={6} marginTop={4} minWidth={0} overflow="hidden">
      <View paddingHorizontal={5} borderRadius={4} flexShrink={0} backgroundColor={t.tint("accent", 10) as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, String(t.mix(t.v("accent"), 35, "transparent"))) as object)}>
        <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "accent", lineHeight: { px: 16 } }} whiteSpace="nowrap">{`↳ ${chip.head}`}</Txt>
      </View>
      {chip.rest.length > 0 ? (
        <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "dim" }} ellip flex={1} minWidth={0}>
          {chip.rest}
        </Txt>
      ) : null}
    </View>
  );
}

// --- what a board needs from the window's index ---------------------------------------------------

/** Each parent's count of its processes, and every task's title: what a card on a board reads. */
export interface ProcessIndex {
  counts: ReadonlyMap<string, ProcessCount>;
  titleOf: (taskId: string) => string | undefined;
}

const EMPTY: ProcessIndex = { counts: new Map(), titleOf: () => undefined };

export const ProcessIndexContext = createContext<ProcessIndex>(EMPTY);

/** The window's index of tasks (`syncCache`), as a process index: read again as it changes. */
export function useProcessIndex(): ProcessIndex {
  const cache = syncCache();
  const tasks = useSyncExternalStore(
    (on) => cache.subscribe(on),
    () => cache.tasks(),
    () => cache.tasks(),
  );
  return useMemo(() => {
    const titles = new Map(tasks.map((task) => [task.taskId, task.title] as const));
    return { counts: processCountsByParent(tasks), titleOf: (taskId: string) => titles.get(taskId) };
  }, [tasks]);
}

export function useProcessIndexHere(): ProcessIndex {
  return useContext(ProcessIndexContext);
}

/** A process task's process, as the window holds it: read once, kept current by the pushes. */
export function useProcess(taskId: string, project?: string): ProcessSummary | undefined {
  useSyncExternalStore(processes.subscribe, processes.version, processes.version);
  const found = processes.ofTask(taskId);
  const missing = found === undefined;
  useEffect(() => {
    if (missing) processes.ensureTask(taskId, project);
  }, [missing, taskId, project]);
  return found;
}
