import type { JSX } from "react";
import { View } from "@tamagui/core";
import type { BoardCard } from "@jaira/shared/browser";
import { processHeadlineOf, processStripOf, type ProcessScope, type ProcessStripStep } from "@jaira/ui/processTaskModel";
import { Press, Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";

/**
 * The `Process` workflow, opened (decision 0032, "The view", ruling 4; round 2's board 7): over its lanes,
 * what it is and how many it holds — `12 process tasks · 7 running · 1 waiting for input` — with
 * "This project | All projects" and "+ Mine" to widen it, then a strip in the shape of its states,
 * `starting → running → listening ⇄ waiting for input`, and its ends, each with its count. How it looks:
 *
 *   the head     row, centred, gap 10, padding 8 10 0: `Process` (app 13/12.5 600), `built in · its states
 *                are the process's` (app 11/12.5 --dim), the count (data 11/12 --dim), a spacer, the
 *                scope switch (two joined buttons, the chosen on --tint-accent in --accent) and `+ Mine`
 *   the strip    row, wrapping, centred, gap 6, padding 8 10, a --line under: each state a chip (data
 *                11/12, 1px --line, radius 6, padding 2 8) with its count (600; --dim at 0), the arrows
 *                between (--dim); waiting for input in --warn; `ENDS` (app 10/12.5 700 upper --dim) before
 *                the ends; exited ≠ 0 in --bad when it holds any
 */
export function ProcessStrip({
  cards,
  scope,
  onScope,
  mine,
  onMine,
}: {
  cards: readonly BoardCard[];
  scope: ProcessScope;
  onScope: (scope: ProcessScope) => void;
  mine: boolean;
  onMine: (mine: boolean) => void;
}): JSX.Element {
  const t = useTokens();
  const strip = processStripOf(cards);
  const [starting, running, listening, waiting] = strip.flow;
  return (
    <View flexDirection="column" testID="process-strip">
      <View flexDirection="row" alignItems="center" gap={10} paddingTop={8} paddingHorizontal={10} minWidth={0}>
        <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600 }}>Process</Txt>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} ellip flexShrink={1} minWidth={0}>
          built in · its states are the process's
        </Txt>
        <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }} flexShrink={0}>
          {processHeadlineOf(strip)}
        </Txt>
        <View flex={1} />
        <View flexDirection="row" borderRadius={6} overflow="hidden" {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
          {(["project", "projects"] as const).map((one) => (
            <Press
              key={one}
              onPress={() => onScope(one)}
              label={one === "project" ? "This project" : "All projects"}
              {...({ "aria-pressed": scope === one } as object)}
              paddingHorizontal={9}
              height={24}
              justifyContent="center"
              box={({ hovered }) => ({ backgroundColor: scope === one ? t.v("tint-accent") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
            >
              <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: scope === one ? 600 : 400, color: scope === one ? "accent" : "dim" }}>{one === "project" ? "This project" : "All projects"}</Txt>
            </Press>
          ))}
        </View>
        <Press
          onPress={() => onMine(!mine)}
          label="+ Mine"
          title="Add your own processes on this machine (the Terminals tab's Mine)"
          {...({ "aria-pressed": mine } as object)}
          paddingHorizontal={9}
          height={24}
          justifyContent="center"
          borderRadius={6}
          {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, mine ? String(t.mix(t.v("accent"), 40, "transparent")) : "line", mine ? "solid" : "dashed") as object)}
          box={({ hovered }) => ({ backgroundColor: mine ? t.v("tint-accent") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
        >
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: mine ? "accent" : "dim" }}>+ Mine</Txt>
        </Press>
      </View>
      <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={6} paddingVertical={8} paddingHorizontal={10} {...(edge(t, { bottom: 1 }) as object)}>
        <Step step={starting!} />
        <Arrow glyph="→" />
        <Step step={running!} />
        <Arrow glyph="→" />
        <Step step={listening!} />
        <Arrow glyph="⇄" />
        <Step step={waiting!} tone="warn" />
        <Txt spec={{ voice: "app", scale: 10 / 12.5, weight: 700, upper: true, ls: 0.08, color: "dim" }} marginLeft={14} marginRight={2}>
          Ends
        </Txt>
        {strip.ends.map((step) => (
          <Step key={step.state} step={step} {...(step.state === "failed" ? { tone: "bad" as const } : step.state === "exited" ? { tone: "ok" as const } : {})} />
        ))}
      </View>
    </View>
  );
}

function Arrow({ glyph }: { glyph: string }): JSX.Element {
  return <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }}>{glyph}</Txt>;
}

function Step({ step, tone }: { step: ProcessStripStep; tone?: "warn" | "bad" | "ok" }): JSX.Element {
  const t = useTokens();
  const lit = tone !== undefined && step.count > 0;
  return (
    <View
      flexDirection="row"
      alignItems="center"
      gap={6}
      paddingHorizontal={8}
      paddingVertical={2}
      borderRadius={6}
      backgroundColor={(lit ? t.tint(tone!, 12) : "transparent") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, lit ? String(t.mix(t.v(tone!), 40, "transparent")) : "line") as object)}
    >
      <Txt spec={{ voice: "data", scale: 11 / 12, color: lit ? tone! : "text" }}>{step.label}</Txt>
      <Txt spec={{ voice: "data", scale: 11 / 12, weight: 600, color: step.count === 0 ? "dim" : lit ? tone! : "text", tabular: true }}>{String(step.count)}</Txt>
    </View>
  );
}
