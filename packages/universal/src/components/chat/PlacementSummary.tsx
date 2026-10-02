import { useState, type JSX } from "react";
import { View } from "@tamagui/core";
import type { MachineFace } from "@jaira/ui/environmentModel";
import type { PlaceChip, PlaceHue, PlacePhase, PlaceRow, PlaceSummary } from "@jaira/ui/placementSummary";
import { secondsOf } from "@jaira/ui/workSummary";
import { useNow } from "@jaira/ui/workSummaryContext";
import { Press, Txt, edge } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { MachineIcon } from "../MachineIcon";
import { Icon } from "../panel/Icon";
import { SaidText, normalLineOf } from "../panel/WorkSummary";
import { Pulse } from "./Paper";

/**
 * How a conversation came to run where it does, above the message that started it — the message is not
 * sent until it has somewhere to go (decision 0013 §5, ruled 2026-10-02). Drawn as the work between two
 * messages is (`WorkSummary.tsx`): a box of phases, each a number, a name, a chip for each kind of
 * action and how long it took; the latest actions of the phase in progress under it; and the foot,
 * "Every step", that opens every action in place. What it says is `placementSummary.ts`'s. How it
 * looks — the work summary's measures, with these of its own:
 *
 *   a phase waiting      --warn 7% in place of the current phase's --accent 5%; its name, its glyph (a
 *                        clock in place of the pulse) and its time --warn
 *   a chip               its hue by what it counts: asked --ws-web (--bad once any refused, with the
 *                        count and ✕), waits --warn, where it went --ok, a snapshot --ws-read, the
 *                        worktree --ws-run, the launch --ws-tool
 *   an action's glyph    the machine it was about, as its icon (13), where one was; --bad when refused
 *   why it was refused   a tag after the sentence: padding 0 5, radius 4, --bad 12%, app 600 11/12.5 --bad
 */
export function PlacementSummary({ summary, faces, clock, at }: { summary: PlaceSummary; /** Each machine's icon, by id — what an action about it wears. */ faces?: Readonly<Record<string, MachineFace>>; clock: (at?: number) => string; /** The moment it is drawn as of, for a still picture; absent, now. */ at?: number }): JSX.Element {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const live = summary.until === undefined;
  const ticking = useNow(live && at === undefined);
  const now = at ?? ticking;
  const wash = t.mix(t.v("panel-2"), 55, "transparent");
  const took = (live ? now : summary.until!) - summary.since;
  return (
    <View testID="placement-summary" marginTop={6} marginHorizontal={-6} marginBottom={10} minWidth={0}>
      <View flexDirection="column" gap={2} paddingVertical={5} paddingHorizontal={6} borderTopLeftRadius={8} borderTopRightRadius={8} backgroundColor={wash as never} minWidth={0} {...(edge(t, { top: 1, right: 1, left: 1 }) as object)}>
        {summary.phases.map((phase, n) => (
          <Phase key={phase.name} t={t} phase={phase} n={n + 1} now={now} faces={faces} clock={clock} />
        ))}
      </View>
      <Press
        onPress={() => setOpen((was) => !was)}
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
        {...(open ? { borderRadius: 0 } : { borderTopLeftRadius: 0, borderTopRightRadius: 0, borderBottomLeftRadius: 8, borderBottomRightRadius: 8 })}
        box={({ hovered }) => ({ backgroundColor: hovered ? t.v("panel-2") : wash })}
      >
        {({ hovered }) => (
          <>
            <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: hovered ? "text" : "dim" }} {...normalLineOf(t, "app", 11.5 / 12.5)} flex={1} minWidth={0}>
              Every step
            </Txt>
            <Txt spec={{ voice: "data", scale: 10.5 / 12, color: hovered ? "text" : "dim", tabular: true }} {...normalLineOf(t, "data", 10.5 / 12)} flexShrink={0}>
              {`${summary.steps > 0 ? `${summary.steps} ${summary.steps === 1 ? "step" : "steps"} · ` : ""}${secondsOf(Math.max(0, took))}${live ? " so far" : ""}`}
            </Txt>
            <View width={14} flexShrink={0} flexDirection="row" transform={open ? [{ rotate: "180deg" }] : []}>
              <Icon name="chevron" size={13} color={String(t.v("tok-hint"))} />
            </View>
          </>
        )}
      </Press>
      {open ? (
        <View flexDirection="column" minWidth={0} paddingTop={4} paddingHorizontal={2} paddingBottom={6} borderBottomLeftRadius={8} borderBottomRightRadius={8} {...(edge(t, { right: 1, bottom: 1, left: 1 }) as object)}>
          {summary.every.map((row) => (
            <Action key={row.key} t={t} row={row} now={now} faces={faces} clock={clock} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const HUES: Record<PlaceHue, string> = { ask: "ws-web", wait: "warn", found: "ok", pin: "ws-read", git: "ws-run", launch: "ws-tool" };

function Phase({ t, phase, n, now, faces, clock }: { t: Tokens; phase: PlacePhase; n: number; now: number; faces: Readonly<Record<string, MachineFace>> | undefined; clock: (at?: number) => string }): JSX.Element {
  const going = phase.state !== "done";
  const tone = phase.state === "waiting" ? "warn" : "accent";
  const took = (phase.until ?? now) - phase.since;
  return (
    <View minWidth={0} borderRadius={7} {...(going ? { backgroundColor: t.mix(t.v(tone), phase.state === "waiting" ? 7 : 5, "transparent") as never, paddingBottom: 3 } : {})}>
      <View flexDirection="row" alignItems="center" gap={8} minWidth={0} minHeight={28} paddingVertical={2} paddingHorizontal={6}>
        <Txt spec={{ voice: "data", scale: 10 / 12, weight: 600, color: "tok-hint" }} {...normalLineOf(t, "data", 10 / 12)} width={14} flexShrink={0} textAlign="right">
          {String(n)}
        </Txt>
        <View width={92} flexShrink={0} flexDirection="row" alignItems="center" gap={5}>
          {phase.state === "current" ? <Pulse /> : phase.state === "waiting" ? <Icon name="clock" size={13} color={String(t.v("warn"))} /> : null}
          <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: going ? tone : "text" }} numberOfLines={1}>
            {phase.name}
          </Txt>
        </View>
        <View flexGrow={0} flexShrink={1} minWidth={0} flexDirection="row" flexWrap="nowrap" gap={4} overflow="hidden">
          {phase.chips.map((chip) => (
            <Chip key={chip.key} t={t} chip={chip} />
          ))}
        </View>
        <View flexGrow={1} flexShrink={1} flexBasis={0} />
        <Txt spec={{ voice: "data", scale: 10.5 / 12, color: going ? tone : "dim", tabular: true }} {...normalLineOf(t, "data", 10.5 / 12)} flexShrink={0} marginLeft="auto" paddingLeft={8}>
          {secondsOf(Math.max(0, took))}
        </Txt>
      </View>
      {going && phase.rows.length > 0 ? (
        <View marginTop={1} marginLeft={22} minWidth={0}>
          {phase.rows.map((row) => (
            <Action key={row.key} t={t} row={row} now={now} faces={faces} clock={clock} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Chip({ t, chip }: { t: Tokens; chip: PlaceChip }): JSX.Element {
  const hue = String(t.v(chip.live === true ? "accent" : chip.failed > 0 ? "bad" : HUES[chip.hue]));
  return (
    <View
      testID="ws-chip"
      flexShrink={0}
      flexDirection="row"
      alignItems="center"
      gap={5}
      height={22}
      paddingLeft={6}
      paddingRight={8}
      borderRadius={999}
      backgroundColor={t.mix(hue, 11, "transparent") as never}
      {...({ boxShadow: `inset 0px 0px 0px ${chip.live === true ? 1.5 : 1}px ${chip.live === true ? hue : t.mix(hue, 22, "transparent")}` } as object)}
    >
      {chip.live === true ? <Pulse color="accent" /> : <Icon name={chip.icon} size={12} color={hue} />}
      <Txt spec={{ voice: "app", scale: 11.5 / 12.5, weight: 500, color: "text", lineHeight: 1 }} numberOfLines={1}>
        {chip.label}
      </Txt>
      {chip.failed > 0 ? (
        <Txt spec={{ voice: "data", scale: 10 / (Number(t.scaled("size-data", 1)) || 12), weight: 700, color: "bad", lineHeight: 1 }}>
          {`${chip.failed}✕`}
        </Txt>
      ) : null}
    </View>
  );
}

/** One action: when, what it was about, what was done in a sentence, why it failed, how long so far. */
function Action({ t, row, now, faces, clock }: { t: Tokens; row: PlaceRow; now: number; faces: Readonly<Record<string, MachineFace>> | undefined; clock: (at?: number) => string }): JSX.Element {
  const failed = row.refused !== undefined;
  const ink = failed ? "bad" : row.wait === true ? "warn" : "dim";
  const face = row.machineId !== undefined ? faces?.[row.machineId] : undefined;
  const took = row.since !== undefined ? now - row.since : row.tookMs;
  return (
    <View flexDirection="row" alignItems="center" gap={6} minWidth={0} paddingVertical={2} paddingHorizontal={6} borderRadius={6} backgroundColor={(row.live === true ? t.mix(t.v("accent"), 7, "transparent") : "transparent") as never}>
      <Txt spec={{ voice: "data", scale: 10 / 12, color: "tok-hint", tabular: true }} {...normalLineOf(t, "data", 10 / 12)} flexShrink={0}>
        {clock(row.at)}
      </Txt>
      <View width={18} flexShrink={0} flexDirection="row" justifyContent="center">
        {row.live === true ? <Pulse color="dim" /> : face !== undefined ? <MachineIcon face={{ shape: face.shape, ...(face.mark !== undefined ? { mark: face.mark } : {}) }} size={13} color={String(t.v(ink))} /> : <Icon name={row.icon} size={13} color={String(t.v(ink))} />}
      </View>
      <View flex={1} minWidth={0} flexDirection="row" alignItems="center" gap={6}>
        <Txt spec={{ voice: "app", scale: 12 / 12.5, color: row.wait === true ? "warn" : row.live === true ? "accent" : "text" }} ellip minWidth={0} flexShrink={1}>
          <SaidText said={row.said} />
        </Txt>
        {failed ? (
          <View flexShrink={0} paddingHorizontal={5} borderRadius={4} backgroundColor={t.mix(t.v("bad"), 12, "transparent") as never}>
            <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600, color: "bad" }} numberOfLines={1}>
              {row.refused}
            </Txt>
          </View>
        ) : null}
      </View>
      <Txt spec={{ voice: "data", scale: 10.5 / 12, color: row.wait === true ? "warn" : row.live === true ? "accent" : "dim", tabular: true }} {...normalLineOf(t, "data", 10.5 / 12)} flexShrink={0}>
        {took !== undefined && (row.since !== undefined || took >= 1000) ? secondsOf(Math.max(0, took)) : ""}
      </Txt>
    </View>
  );
}
