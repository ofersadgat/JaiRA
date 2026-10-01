import type { JSX, ReactNode } from "react";
import { View } from "@tamagui/core";
import type { TaskDetail } from "@jaira/shared/browser";
import { activityOf, durationOf, startedAtOf, useElapsed } from "@jaira/ui/runActivityModel";
import { listed, type ArmedRewind } from "@jaira/ui/runConversationModel";
import { Press, Txt } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { Button } from "../settings/Button";
import { lengthOf } from "./SidePanel";

/**
 * What is happening here and the button that ends it, in the band where a composer would stand. It says
 * what `activityOf` says (`runActivityModel.ts`), the fast-forward strip among it; an armed rewind's
 * strip is {@link CutStrip}, in its place. How it looks:
 *
 *   the band             padding 10 16 14, --bg
 *   the strip            row, centred, gap 9, padding 6 8 6 13, 1px --line, radius --card-radius,
 *                        --panel, --dim at --size-app × 11.5/12.5, at most 900 wide, centred
 *   waiting              --warn 42% into --line for the edge, 7% into --panel for the ground; the
 *                        pulse's three 4px dots still, --warn at 0.75
 *   warn or bad          the same at 40% / 6%
 *   a name in it         600, --text
 *   the `·`              0.5 opaque; the clock data, --size-data × 10.5/12, tabular
 *   the mark             a 6px dot, --rule (--bad, --warn by tone)
 *   a danger button      --bad on nothing, the edge --bad 40% into --line (hover: --tint-bad, 60%);
 *                        a button's radius --control-radius, padding --control-pad, the strip's font
 *   the primary button   --size-app × 11/12.5, 500, padding 3 12, --on-accent on --fill-accent
 */
export function RunActivity({ detail, asking, onStop, onRerun, onResume, onSkip, lead }: { detail: TaskDetail; asking: boolean; onStop: () => void; onRerun?: ((taskId: string) => void) | undefined; onResume?: ((taskId: string) => void) | undefined; onSkip?: (() => void) | undefined; /** What stands in the same band before the strip (the offline banner). */ lead?: ReactNode }): JSX.Element | null {
  const t = useTokens();
  const activity = activityOf(detail, asking, { rerun: onRerun !== undefined, resume: onResume !== undefined });
  const elapsed = useElapsed(startedAtOf(detail), activity.kind === "going", 1000);
  // A run that did what it was asked says nothing — but the band still stands there, empty: its
  // padding (10 over 14) is the room kept under the conversation either way.
  if (activity.kind === "none") {
    return (
      <View paddingTop={10} paddingHorizontal={16} paddingBottom={14} backgroundColor={t.v("bg") as never} flexShrink={0}>
        {lead}
      </View>
    );
  }
  const base = { voice: "app" as const, scale: 11.5 / 12.5, color: "dim" };
  const at = (where: string): JSX.Element => <Txt spec={{ ...base, weight: 600, color: "text" }}>{where.length > 0 ? where : "this run"}</Txt>;
  const tone = activity.kind === "going" && activity.waiting ? { pct: 42, ground: 7, hue: "warn" } : activity.kind === "stopping" ? { pct: 40, ground: 6, hue: "warn" } : activity.kind === "stopped" && (activity.tone === "bad" || activity.tone === "warn") ? { pct: 40, ground: 6, hue: activity.tone } : undefined;
  const strip = (mark: ReactNode, words: ReactNode, after: ReactNode, button: ReactNode): JSX.Element => (
    <View
      flexDirection="row"
      alignItems="center"
      gap={9}
      maxWidth={900}
      width="100%"
      alignSelf="center"
      paddingTop={6}
      paddingRight={8}
      paddingBottom={6}
      paddingLeft={13}
      borderWidth={1}
      borderStyle="solid"
      borderRadius={lengthOf(t, "card-radius", 10)}
      borderColor={(tone !== undefined ? t.mix(t.v(tone.hue), tone.pct, t.v("line")) : t.v("line")) as never}
      backgroundColor={(tone !== undefined ? t.mix(t.v(tone.hue), tone.ground, t.v("panel")) : t.v("panel")) as never}
    >
      {mark}
      <Txt spec={base} ellip flexShrink={1} minWidth={0}>
        {words}
      </Txt>
      {after}
      <View flex={1} minWidth={0} />
      {button}
    </View>
  );
  const pulse = (still: boolean): JSX.Element => (
    <View flexDirection="row" gap={3} flexShrink={0}>
      {[0, 1, 2].map((i) => (
        <View key={i} width={4} height={4} borderRadius={2} backgroundColor={(still ? t.v("warn") : t.v("dim")) as never} opacity={still ? 0.75 : 0.6} />
      ))}
    </View>
  );
  const mark = (hue: string): JSX.Element => <View width={6} height={6} borderRadius={3} flexShrink={0} backgroundColor={t.v(hue) as never} />;
  let body: JSX.Element;
  if (activity.kind === "forward") {
    // The fast-forward strip: "Fast-forwarding to X · at Y · 1 of 3", Skip to X beside Stop. No clock:
    // what it counts is states, not seconds.
    const forward = detail.fastForward!;
    const of = forward.through.length;
    const cut = (
      <Txt spec={base} opacity={0.5} flexShrink={1}>
        ·
      </Txt>
    );
    body = strip(
      pulse(false),
      <>
        Fast-forwarding to <Txt spec={{ ...base, weight: 600, color: "text" }}>{forward.targetLabel}</Txt>
      </>,
      <>
        {forward.at !== undefined ? (
          <>
            {cut}
            <Txt spec={base} ellip flexShrink={1} minWidth={0}>
              at <Txt spec={{ ...base, weight: 600, color: "text" }}>{forward.at}</Txt>
            </Txt>
          </>
        ) : null}
        {of > 0 ? (
          <>
            {cut}
            <Txt spec={{ voice: "data", scale: 1, color: "dim" }} fontSize={t.scaled("size-app", 11 / 12.5)} flexShrink={0} title={forward.through.join(", ")}>
              {Math.max(forward.step, 1)} of {of}
            </Txt>
          </>
        ) : null}
      </>,
      <>
        {onSkip !== undefined ? <StripButton kind="plain" words={`Skip to ${forward.targetLabel}`} title={`Stop what is running and go straight to ${forward.targetLabel}; what is between is recorded as skipped`} onPress={onSkip} t={t} /> : null}
        <StripButton kind="danger" words="Stop" onPress={onStop} t={t} />
      </>,
    );
  } else if (activity.kind === "stopping") {
    body = strip(pulse(false), <>Stopping {at(activity.where)} — waiting for the agent to finish what it is doing</>, null, <StripButton kind="danger" words="Force stop" onPress={onStop} t={t} />);
  } else if (activity.kind === "listening") {
    body = strip(mark("rule"), <>Listening for <Txt spec={{ ...base, weight: 600, color: "text" }}>{activity.listening.join(", ")}</Txt></>, null, <StripButton kind="quiet" words="Stop" onPress={onStop} t={t} />);
  } else if (activity.kind === "going") {
    body = strip(
      pulse(activity.waiting),
      <>
        {activity.waiting ? "Waiting for you in " : "Running "}
        {at(activity.where)}
      </>,
      elapsed !== undefined ? (
        <>
          <Txt spec={base} opacity={0.5} flexShrink={1}>
            ·
          </Txt>
          <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "dim", tabular: true, lineHeight: { px: t.replayed ? Number(t.scaled("size-data", (10.5 / 12) * 1.5)) : 15.75 } }} flexShrink={1} minWidth={0}>
            {durationOf(elapsed)}
          </Txt>
        </>
      ) : null,
      <StripButton kind="danger" words="Stop" onPress={onStop} t={t} />,
    );
  } else {
    const act = activity.resuming ? onResume! : onRerun!;
    body = strip(
      mark(activity.tone === "bad" || activity.tone === "warn" ? activity.tone : "rule"),
      <>
        {activity.said} {detail.activePath.length > 0 ? <>in {at(activity.where)}</> : null}
      </>,
      null,
      <StripButton kind="primary" words={activity.verb} title={activity.hint} onPress={() => act(detail.taskId)} t={t} />,
    );
  }
  return (
    <View paddingTop={10} paddingHorizontal={16} paddingBottom={14} backgroundColor={t.v("bg") as never} flexShrink={0}>
      {lead}
      {body}
    </View>
  );
}

/** The composer's own padded band, on --bg — where the strips stand. */
export function CxDoing({ children, gap }: { children: ReactNode; gap?: number }): JSX.Element {
  const t = useTokens();
  return (
    <View paddingTop={10} paddingHorizontal={16} paddingBottom={14} backgroundColor={t.v("bg") as never} flexShrink={0} {...(gap !== undefined ? { gap } : {})}>
      {children}
    </View>
  );
}

/**
 * `CutStrip`: the strip while a rewind is armed — the sentence, and the one filled button in the danger
 * colour — in `RunActivity`'s place, where this task already reports what is happening to it.
 *
 *   the strip              --bad 40% into --line for the edge, 6% into --panel for the ground
 *   the sentence           wraps: it names every state that goes
 *   Cancel                 a ghost button, in the strip's font, --text
 *   Rewind                 --bad ground and ring, #fff at 600, --sheen; hovered --bad 88% into black
 */
export function CutStrip({ armed, onConfirm, onCancel }: { armed: ArmedRewind; onConfirm: () => void; onCancel: () => void }): JSX.Element {
  const t = useTokens();
  const gone = armed.doomed.length === 0 ? [armed.name] : armed.doomed;
  const base = { voice: "app" as const, scale: 11.5 / 12.5, color: "dim" };
  const [padV, padH] = padOf(t);
  return (
    <View
      role="alertdialog"
      aria-label={`Rewind to before ${armed.name}`}
      flexDirection="row"
      alignItems="center"
      gap={9}
      maxWidth={900}
      width="100%"
      alignSelf="center"
      paddingTop={6}
      paddingRight={8}
      paddingBottom={6}
      paddingLeft={13}
      borderWidth={1}
      borderStyle="solid"
      borderRadius={lengthOf(t, "card-radius", 10)}
      borderColor={t.mix(t.v("bad"), 40, t.v("line")) as never}
      backgroundColor={t.mix(t.v("bad"), 6, t.v("panel")) as never}
    >
      <View width={6} height={6} borderRadius={3} flexShrink={0} backgroundColor={t.v("bad") as never} />
      <Txt spec={base} flexShrink={1} minWidth={0} overflow="hidden">
        Rewind to before <Txt spec={{ ...base, weight: 600, color: "text" }}>{armed.name}</Txt> — {listed(gone)} {gone.length === 1 ? "is" : "are"} deleted and the run enters{" "}
        {armed.name} again. Files edited in the worktree stay as they are.
      </Txt>
      <View flex={1} minWidth={0} />
      <Button kind="ghost" onPress={onCancel} font={{ scale: 11.5 / 12.5 }} flexShrink={0}>
        Cancel
      </Button>
      <Press
        onPress={onConfirm}
        flexShrink={0}
        paddingVertical={padV}
        paddingHorizontal={padH}
        borderWidth={1}
        borderStyle="solid"
        borderRadius={lengthOf(t, "control-radius", 7)}
        flexDirection="row"
        alignItems="center"
        justifyContent="center"
        box={({ hovered }) => {
          const ground = hovered ? t.mix(t.v("bad"), 88, "black") : t.v("bad");
          return { backgroundColor: ground, borderColor: ground, boxShadow: t.v("sheen") };
        }}
      >
        <Txt spec={{ ...base, weight: 600, color: "#fff" }} numberOfLines={1}>
          Rewind
        </Txt>
      </Press>
    </View>
  );
}

/** `--control-pad` as its two lengths (`3px 10px`). */
function padOf(t: Tokens): [number, number] {
  const raw = t.replayed ? String(t.v("control-pad")) : "3px 10px";
  const [v, h] = raw.split(/\s+/).map((one) => parseFloat(one));
  return [Number.isFinite(v) ? v! : 3, Number.isFinite(h) ? h! : Number.isFinite(v) ? v! : 10];
}

/** The strip's one button: `danger`, `quiet`, or the rerun `primary`. */
function StripButton({ kind, words, title, onPress, t }: { kind: "danger" | "quiet" | "primary" | "plain"; words: string; title?: string; onPress: () => void; t: Tokens }): JSX.Element {
  const [padV, padH] = kind === "primary" ? [3, 12] : padOf(t);
  return (
    <Press
      onPress={onPress}
      {...(title !== undefined ? { title } : {})}
      flexShrink={0}
      paddingVertical={padV}
      paddingHorizontal={padH}
      borderWidth={1}
      borderStyle="solid"
      borderRadius={lengthOf(t, "control-radius", 7)}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      box={({ hovered }) =>
        kind === "danger"
          ? { backgroundColor: hovered ? t.v("tint-bad") : "transparent", borderColor: t.mix(t.v("bad"), hovered ? 60 : 40, t.v("line")) }
          : kind === "quiet"
            ? { backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent", borderColor: "transparent" }
            : kind === "plain"
              ? { backgroundColor: t.v(hovered ? "panel-3" : "panel-2"), borderColor: t.v(hovered ? "rule" : "line") }
            : // The primary keeps a primary button's --sheen: the strip gives it no shadow of its own.
              { backgroundColor: hovered ? t.v("fill-accent-hover") : t.v("fill-accent"), borderColor: "transparent", boxShadow: t.v("sheen") }
      }
    >
      {({ hovered }) => (
        <Txt spec={kind === "primary" ? { voice: "app", scale: 11 / 12.5, weight: 500, color: "on-accent" } : { voice: "app", scale: 11.5 / 12.5, color: kind === "danger" ? "bad" : kind === "plain" || hovered ? "text" : "dim" }} numberOfLines={1}>
          {words}
        </Txt>
      )}
    </Press>
  );
}
