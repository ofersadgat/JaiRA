import { useEffect, useState, type JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import { processEnded, type ProcessSummary } from "@jaira/shared/browser";
import { fromLabelOf, nextStatesOf, processStepsOf } from "@jaira/ui/processTaskModel";
import { processes } from "@jaira/ui/processStore";
import { Press, Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { MachineChip } from "../MachineChip";
import { ProcessCard } from "./ProcessCard";
import { ProcessPlaces } from "./ProcessCardFace";
import { FromLine, OriginChip, ProcessBadge, ProcessGlyph, useProcess, useProcessIndex } from "./ProcessBits";

/**
 * A process task, opened (decision 0032, "The view", ruling 5; round 2's board 8): its task view, which
 * is its card. Above the card, the task's own head — the glyph, the name, its state, its id and type, where
 * it came from, `↰ from` its parent and its machine, Stop and the three places — and under it the states
 * it went through, the way a task shows its steps, with what can come next. Then the card (`ProcessCard`,
 * filling and bare: the head above carries its Stop and places), from its stats line — ports as links,
 * pid, CPU, memory, the load trace — down. While it shows, the engine samples readings often
 * (`process:sampling`). How it looks:
 *
 *   the head     column, padding 12 16 10, a --line under; row 1 centred, gap 8: glyph (20), name (app
 *                15/12.5 600), badge, a spacer, Stop (while live), places; row 2, 4 above, gap 8: the id
 *                (data 11/12 --dim), origin chip, from line, machine chip
 *   the steps    row, wrapping, gap 4, padding 7 16, a --line under: each a chip (data 11/12, 1px --line,
 *                radius 5, padding 1 7; the current on --tint-accent in --accent), `→` between (--dim),
 *                then `next: …` (data 11/12 --dim)
 *   the card     the rest
 */
export function ProcessTaskView({ taskId, project, onParent }: { taskId: string; project?: string | undefined; onParent?: ((taskId: string) => void) | undefined }): JSX.Element {
  const t = useTokens();
  const process = useProcess(taskId, project);
  // While a process's readings show, the engine samples them every couple of seconds.
  useEffect(() => {
    processes.sampling(true);
    return () => processes.sampling(false);
  }, []);
  if (process === undefined) {
    return (
      <View flex={1} padding={16} backgroundColor={t.v("bg") as never}>
        <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }}>{processes.isGone(taskId) ? "This process is not kept any more: its task let it go." : "Reading the process…"}</Txt>
      </View>
    );
  }
  return (
    <View flex={1} minHeight={0} flexDirection="column" backgroundColor={t.v("bg") as never} testID="process-task-view">
      <ProcessHead process={process} taskId={taskId} project={project} onParent={onParent} />
      <ProcessSteps process={process} />
      <View flex={1} minHeight={0}>
        <ProcessCard process={process} project={project} bare />
      </View>
    </View>
  );
}

function ProcessHead({ process, taskId, project, onParent }: { process: ProcessSummary; taskId: string; project?: string | undefined; onParent?: ((taskId: string) => void) | undefined }): JSX.Element {
  const t = useTokens();
  const index = useProcessIndex();
  const live = !processEnded(process.state);
  const [why, setWhy] = useState<string | null>(null);
  const parent = process.taskId;
  return (
    <View paddingTop={12} paddingHorizontal={16} paddingBottom={10} {...(edge(t, { bottom: 1 }) as object)}>
      <View flexDirection="row" alignItems="center" gap={8} minWidth={0}>
        <ProcessGlyph size={20} />
        <Txt spec={{ voice: "app", scale: 15 / 12.5, weight: 600 }} ellip flexShrink={1} minWidth={0} {...((isWeb ? { title: process.command } : {}) as object)}>
          {process.name}
        </Txt>
        <ProcessBadge facts={process} />
        <View flex={1} />
        {why !== null ? (
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }} ellip flexShrink={1} minWidth={0}>
            {why}
          </Txt>
        ) : null}
        {live && process.protected === undefined ? (
          <Press
            onPress={() => void processes.stop(process.key, "stop", project ?? process.project).then((r) => setWhy(r.stopped ? null : (r.why ?? "it could not be stopped")), (e: unknown) => setWhy((e as Error).message))}
            label={`Stop ${process.name}`}
            title="Stop it, and what it started"
            flexDirection="row"
            alignItems="center"
            gap={4}
            height={24}
            paddingHorizontal={8}
            borderRadius={6}
            {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, String(t.mix(t.v("bad"), 45, "transparent"))) as object)}
            box={({ hovered }) => ({ backgroundColor: hovered ? t.tint("bad", 12) : "transparent" })}
          >
            <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600, color: "bad" }}>■ Stop</Txt>
          </Press>
        ) : null}
        <ProcessPlaces taskId={taskId} project={project} />
      </View>
      <View flexDirection="row" alignItems="center" gap={8} marginTop={4} minWidth={0} overflow="hidden">
        <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }} flexShrink={0} {...((isWeb ? { title: `${taskId} · pid ${process.pid}` } : {}) as object)}>
          {`${taskId} · process`}
        </Txt>
        {process.origin !== undefined ? <OriginChip origin={process.origin} why={process.why} /> : null}
        <View flexShrink={1} minWidth={0} flexDirection="row">
          <FromLine words={fromLabelOf({ parentTaskId: parent }, index.titleOf)} onGo={parent !== undefined && onParent !== undefined ? () => onParent(parent) : undefined} />
        </View>
        <MachineChip label={process.machine} voice={String(t.v("font-data"))} />
      </View>
    </View>
  );
}

function ProcessSteps({ process }: { process: ProcessSummary }): JSX.Element {
  const t = useTokens();
  const [now, setNow] = useState(() => Date.now());
  const live = !processEnded(process.state);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [live]);
  const steps = processStepsOf(process, now);
  const next = nextStatesOf(process.state);
  return (
    <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={4} paddingVertical={7} paddingHorizontal={16} {...(edge(t, { bottom: 1 }) as object)} testID="process-steps">
      {steps.map((step, i) => (
        <View key={`${step.state}-${i}`} flexDirection="row" alignItems="center" gap={4}>
          {i > 0 ? <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }}>→</Txt> : null}
          <View
            paddingHorizontal={7}
            paddingVertical={1}
            borderRadius={5}
            backgroundColor={(step.current ? t.v("tint-accent") : "transparent") as never}
            {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, step.current ? String(t.mix(t.v("accent"), 40, "transparent")) : "line") as object)}
          >
            <Txt spec={{ voice: "data", scale: 11 / 12, color: step.current ? "accent" : "text" }} whiteSpace="nowrap">
              {step.text}
            </Txt>
          </View>
        </View>
      ))}
      {next.length > 0 ? (
        <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }} marginLeft={8}>
          {`next: ${next}`}
        </Txt>
      ) : null}
    </View>
  );
}
