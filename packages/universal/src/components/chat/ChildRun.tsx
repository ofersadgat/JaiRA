import { useState, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import type { WorkflowOutcome } from "@jaira/shared/browser";
import { CUT, fitPills, secondLine, type PillLevel, type RunWait } from "@jaira/ui/childRunModel";
import { Press, Txt, edge, lengthToken, padToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { Icon } from "../panel/Icon";
import { InNoteContext } from "../panel/noteContext";
import { Pulse } from "./Pulse";

/**
 * A run its conversation started (`start_task`, decision 0005), as the Chat view draws it — the words
 * are `childRunModel.ts`'s. Two pieces:
 *
 * `ChildRunLine`, in place of the note the call left: the ringed button of an adoption's line turned to
 * point INTO the run (a press walks in: the run becomes the main view), what the run is doing — waiting
 * for something, or working on a step — and a phase's tail at its end, "8 steps · 1 h 26 min so far ⌄",
 * whose chevron opens the run in place, nested under the line as an adoption's history is.
 *
 *   the line          row, wrapping, centred, gap 8, padding 4; app 11.5/12.5 --dim
 *   go in             --control-pad, 1px --line, --control-radius, --panel-2; the chevron 1em, turned −90°
 *   the run's name    600 --text
 *   waiting           the pause 12 --warn; "waiting for" --warn, the step 600 data --warn, where and
 *                     what it holds --dim; several: "waiting for N things"
 *   working           the pulse; "running", the step in data --text, where --dim
 *   the tail          pushed right, 8 before, row, gap 4: data 10.5/12 --dim, tabular; the chevron 20 × 20,
 *                     radius 4, its glyph 13 --tok-hint (hovered --text on --fill-ghost-hover), turned
 *                     over while open
 *   the nest          the line's width, margin 4 0 8 18, padding-left 8, 2px --accent 45% into --line
 *
 * `WaitPills`, over the box: a pill per thing waited for (design W3) — "Waiting for answer" at the
 * line's size over "in feature › product · 5 questions · 9:37 PM" — or, while nothing waits and a run
 * works, the step it works on. A press anywhere on a pill goes to it: into the run, at the step that
 * asks. Every pill in the row says as much as the room lets them all say (`fitPills`), and what does
 * not fit at the least is "+N waiting".
 *
 *   the row           over the box, its foot 8 above the box's top, centred, gap 8, grows upward
 *   a pill            row, centred, gap 8, padding 5 14 5 12, radius 14 (one line: 999); --warn 10% into
 *                     --panel (hovered 18%), a --warn 30% into --line ring, 0 4 14 rgba(15,20,30,.12);
 *                     its step on screen: an --accent 70% ring and a 3px --accent 16% halo
 *   its mark          the pause, or an approval's shield, 12 --warn; working: the pulse
 *   its first line    "Waiting for" app 12.5/12.5 --warn, the step data 600 --warn
 *   its second line   app 10/12.5 --dim, one line
 */
export function ChildRunLine({
  outcome,
  waits,
  running,
  steps,
  took,
  open,
  onToggle,
  onWalkIn,
  children,
}: {
  outcome: WorkflowOutcome;
  /** This run's waits, their paths from inside it. */
  waits: readonly RunWait[];
  /** The step it works on, while nothing waits; its path from inside the run. */
  running?: { step: string; path: string[] } | undefined;
  steps: number;
  /** How long it has run, in words; "so far" while it goes. */
  took: string;
  open: boolean;
  onToggle: () => void;
  onWalkIn: () => void;
  children: ReactNode;
}): JSX.Element {
  const t = useTokens();
  const size = Number(t.scaled("size-app", 11.5 / 12.5)) || 11.5;
  const words = { voice: "app" as const, scale: 11.5 / 12.5, color: "dim" };
  const name = outcome.standsAt.split("/")[0] ?? outcome.standsAt;
  const step = (text: string, color: string): JSX.Element => (
    <Txt spec={{ ...words, voice: "data", weight: 600, color }} fontSize={t.scaled("size-app", 11.5 / 12.5)} flexShrink={0}>
      {text}
    </Txt>
  );
  const one = waits.length === 1 ? waits[0] : undefined;
  return (
    <View role="note" flexDirection="row" flexWrap="wrap" alignItems="center" gap={8} padding={4} minWidth={0}>
      <Press
        onPress={onWalkIn}
        label={`go into ${name}`}
        title={`make ${name}'s run the main view`}
        flexShrink={0}
        alignSelf="center"
        flexDirection="row"
        alignItems="center"
        justifyContent="center"
        paddingVertical={padToken(t, "control-pad", [3, 10])[0]}
        paddingHorizontal={padToken(t, "control-pad", [3, 10])[1]}
        borderWidth={1}
        borderStyle="solid"
        borderColor={t.v("line") as never}
        borderRadius={lengthToken(t, "control-radius", 7)}
        backgroundColor={t.v("panel-2") as never}
        transform={[{ rotate: "-90deg" }]}
      >
        <Icon name="chevron" size={size} color={String(t.v("dim"))} />
      </Press>
      <Txt spec={words} flexShrink={0}>
        {outcome.verb}
      </Txt>
      <Txt spec={{ ...words, weight: 600, color: "text" }} flexShrink={0}>
        {name}
      </Txt>
      {waits.length > 0 ? (
        <>
          <Txt spec={{ ...words, color: "faint" }}>·</Txt>
          <View alignSelf="center">
            <Icon name="pause" size={12} color={String(t.v("warn"))} />
          </View>
          <Txt spec={{ ...words, color: "warn" }} flexShrink={0}>
            waiting for
          </Txt>
          {one !== undefined ? (
            <>
              {one.verb !== undefined ? <Txt spec={{ ...words, color: "warn", weight: 600 }}>{one.verb}</Txt> : null}
              {step(one.step, "warn")}
              <Txt spec={words} flexShrink={1} minWidth={0} ellip>
                {[one.path.length > 0 ? `in ${one.path.join(" › ")}` : "", one.note ?? ""].filter((part) => part !== "").join(" · ")}
              </Txt>
            </>
          ) : (
            <Txt spec={{ ...words, color: "warn" }}>{waits.length} things</Txt>
          )}
        </>
      ) : running !== undefined ? (
        <>
          <Txt spec={{ ...words, color: "faint" }}>·</Txt>
          <View alignSelf="center">
            <Pulse />
          </View>
          <Txt spec={words} flexShrink={0}>
            running
          </Txt>
          {step(running.step, "text")}
          {running.path.length > 0 ? (
            <Txt spec={words} flexShrink={1} minWidth={0} ellip>
              in {running.path.join(" › ")}
            </Txt>
          ) : null}
        </>
      ) : null}
      {/* A phase's tail (`WorkSummary.tsx` PhaseTail): how many steps, how long, and the chevron that opens them here. */}
      <View flexShrink={0} marginLeft="auto" paddingLeft={8} flexDirection="row" alignItems="center" gap={4}>
        <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "dim", tabular: true }} paddingHorizontal={3}>
          {steps} {steps === 1 ? "step" : "steps"} · {took}
        </Txt>
        <Press
          onPress={onToggle}
          label={open ? `hide ${name}'s run` : `show ${name}'s run here`}
          {...({ "aria-expanded": open } as object)}
          width={20}
          height={20}
          alignItems="center"
          justifyContent="center"
          borderRadius={4}
          box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
        >
          {({ hovered }) => (
            <View flexDirection="row" transform={open ? [{ rotate: "180deg" }] : []}>
              <Icon name="chevron" size={13} color={String(t.v(hovered ? "text" : "tok-hint"))} />
            </View>
          )}
        </Press>
      </View>
      {open ? (
        <View flexBasis="100%" flexShrink={1} minWidth={0} marginTop={4} marginBottom={8} marginLeft={18} paddingLeft={8} {...(edge(t, { left: 2 }, t.mix(t.v("accent"), 45, t.v("line"))) as object)}>
          <InNoteContext.Provider value={true}>{children}</InNoteContext.Provider>
        </View>
      ) : null}
    </View>
  );
}

/** A pill's ground and ring: its step on screen wears the accent. */
function pillFrame(t: ReturnType<typeof useTokens>, here: boolean, hovered: boolean, radius: number): Record<string, unknown> {
  return {
    borderRadius: radius,
    backgroundColor: t.mix(t.v("warn"), hovered ? 18 : 10, t.v("panel")),
    ...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, here ? t.mix(t.v("accent"), 70, t.v("line")) : t.mix(t.v("warn"), 30, t.v("line"))) as object),
    boxShadow: here ? `0px 0px 0px 3px ${String(t.mix(t.v("accent"), 16, "transparent"))}, 0px 4px 14px rgba(15, 20, 30, 0.12)` : "0px 4px 14px rgba(15, 20, 30, 0.12)",
  };
}


function WaitPill({ wait, level, here, clock, onGo }: { wait: RunWait; level: PillLevel; here: boolean; clock: (at: number) => string; onGo: (wait: RunWait) => void }): JSX.Element {
  const t = useTokens();
  const face = { voice: "app" as const, scale: 12.5 / 12.5, color: "warn" };
  const second = secondLine(wait, level, clock);
  const name = level === 0 && wait.step.length > CUT ? `${wait.step.slice(0, CUT - 1)}…` : wait.step;
  return (
    <Press
      onPress={() => onGo(wait)}
      title={`go to ${wait.verb !== undefined ? `${wait.verb} ` : ""}${wait.step}${wait.path.length > 0 ? ` in ${wait.path.join(" › ")}` : ""}`}
      flexShrink={0}
      flexDirection="row"
      alignItems="center"
      gap={8}
      paddingVertical={second !== "" ? 5 : 6}
      paddingLeft={12}
      paddingRight={14}
      box={({ hovered }) => pillFrame(t, here, hovered, second !== "" ? 14 : 999) as never}
    >
      <Icon name={wait.kind === "approve" ? "shield" : "pause"} size={12} color={String(t.v("warn"))} />
      <View minWidth={0}>
        <View flexDirection="row" alignItems="baseline" gap={4}>
          <Txt spec={face}>Waiting for</Txt>
          {wait.verb !== undefined ? <Txt spec={{ ...face, weight: 600 }}>{wait.verb}</Txt> : null}
          <Txt spec={{ ...face, voice: "data", weight: 600 }} fontSize={t.scaled("size-app", 1)}>
            {name}
          </Txt>
        </View>
        {second !== "" ? (
          <Txt spec={{ voice: "app", scale: 10 / 12.5, color: "dim" }} numberOfLines={1}>
            {second}
          </Txt>
        ) : null}
      </View>
    </Press>
  );
}

/** While nothing waits and a run works: the step it works on, a press going to it. */
function RunningPill({ step, path, took, onGo }: { step: string; path: string[]; took: string; onGo: () => void }): JSX.Element {
  const t = useTokens();
  const face = { voice: "app" as const, scale: 12.5 / 12.5, color: "accent" };
  return (
    <Press
      onPress={onGo}
      title={`go to ${step}`}
      flexShrink={0}
      flexDirection="row"
      alignItems="center"
      gap={8}
      paddingVertical={5}
      paddingLeft={12}
      paddingRight={14}
      box={({ hovered }) => ({
        borderRadius: 14,
        backgroundColor: t.mix(t.v("accent"), hovered ? 12 : 6, t.v("panel")),
        ...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, t.mix(t.v("accent"), 30, t.v("line"))) as object),
        boxShadow: "0px 4px 14px rgba(15, 20, 30, 0.12)",
      })}
    >
      <Pulse />
      <View minWidth={0}>
        <View flexDirection="row" alignItems="baseline" gap={4}>
          <Txt spec={face}>Running</Txt>
          <Txt spec={{ ...face, voice: "data", weight: 600 }} fontSize={t.scaled("size-app", 1)}>
            {step}
          </Txt>
        </View>
        <Txt spec={{ voice: "app", scale: 10 / 12.5, color: "dim" }} numberOfLines={1}>
          {[path.length > 0 ? `in ${path.join(" › ")}` : "", took].filter((part) => part !== "").join(" · ")}
        </Txt>
      </View>
    </Press>
  );
}

/** How tall the pills stand over the thread — what the thread leaves free at its end while they show. */
export const WAIT_PILLS_HEIGHT = 56;

export function WaitPills({
  waits,
  running,
  onScreen,
  clock,
  onGo,
}: {
  /** The waits from where you stand (`scopedWaits`). */
  waits: readonly RunWait[];
  /** The step a run works on, while nothing waits. */
  running?: { step: string; path: string[]; took: string; onGo: () => void } | undefined;
  /** The steps on screen — a pill whose step is one wears the accent ring. */
  onScreen?: ReadonlySet<string> | undefined;
  clock: (at: number) => string;
  onGo: (wait: RunWait) => void;
}): JSX.Element | null {
  const t = useTokens();
  const [width, setWidth] = useState(0);
  if (waits.length === 0 && running === undefined) return null;
  const { level, shown } = width > 0 ? fitPills(waits, width - 40, clock) : { level: 4 as PillLevel, shown: waits.length };
  const rest = waits.length - shown;
  return (
    <View
      position="absolute"
      left={0}
      right={0}
      bottom="100%"
      paddingBottom={8}
      paddingHorizontal={20}
      alignItems="center"
      zIndex={5}
      pointerEvents="box-none"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      <View flexDirection="row" alignItems="center" gap={8} pointerEvents="box-none">
        {waits.length === 0 && running !== undefined ? <RunningPill {...running} /> : null}
        {waits.slice(0, shown).map((wait) => (
          <WaitPill key={`${wait.instanceId}:${wait.step}`} wait={wait} level={level} here={onScreen?.has(wait.instanceId) === true} clock={clock} onGo={onGo} />
        ))}
        {rest > 0 ? (
          <View paddingVertical={6} paddingHorizontal={12} flexShrink={0} {...(pillFrame(t, false, false, 999) as object)}>
            <Txt spec={{ voice: "app", scale: 11.5 / 12.5, weight: 600, color: "warn" }}>+{rest} waiting</Txt>
          </View>
        ) : null}
      </View>
    </View>
  );
}
