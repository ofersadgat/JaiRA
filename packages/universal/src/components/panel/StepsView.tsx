import { useEffect, useState, type JSX } from "react";
import { ScrollView } from "react-native";
import { View } from "@tamagui/core";
import type { EffectiveStateValues, InstanceNode, SessionRef, TaskDetail } from "@jaira/shared/browser";
import { BADGE } from "@jaira/ui/panelFaceModel";
import { callLine, pathOf, stepRowsOf, stepTookOf, useStepFollow, useStepsFit } from "@jaira/ui/panelViewsModel";
import { keyOfNode } from "@jaira/ui/runIndexModel";
import { isLiveNode } from "@jaira/ui/sessionRows";
import { askingInstanceOf, hasAsking } from "@jaira/ui/stateSurfaceModel";
import { invoke } from "@jaira/ui/store";
import { nodeAt } from "@jaira/ui/trail";
import { useNow } from "@jaira/ui/workSummaryContext";
import { PLAIN_SCROLLER, Txt, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { NoneRow, PanelRow, PanelSection, valueRows } from "./PanelViews";
import { RunIndex } from "./RunIndex";
import { SpIcon } from "./SidePanel";

/** What the Steps tab needs from the panel's host (`faces.tsx`'s `stepsBody`). */
export interface StepsHost {
  onStep: (step: string | undefined) => void;
  current?: string | undefined;
  onScreen?: ReadonlySet<string> | undefined;
  /** Take the conversation beside the panel to a step, when there is one. */
  onGoTo?: ((instanceId: string) => void) | undefined;
  /** A gate is on offer for this task. */
  asking: boolean;
  sessions: readonly SessionRef[];
  onOpen: (title: string, value: unknown) => void;
  onConfig: (node: InstanceNode) => void;
  /** A step's right-click (a long press on a phone): rewind to before it, or fork there (`indexCutOf`). */
  onCut?: { rewind: (node: InstanceNode) => void; fork: (node: InstanceNode) => void } | undefined;
  boxHeight: number;
  onBoxHeight: (height: number) => void;
}

/**
 * The Steps tab: the run's index in a box that FITS (`stepCompaction.ts`), and under it the card of the
 * step that is selected. With no step selected the index takes the whole column. What decides when the
 * card closes and how the index fits is `panelViewsModel.ts`'s (`useStepFollow`, `useStepsFit`).
 *
 *   the tab            column, flex 1
 *   blocked states     a warning notice each: --tint-warn, --warn at 11/12.5, padding 7 9
 *   the index's box    padding 4 8 4 10, clipped, at least 128 tall; alone, it takes the column and scrolls
 *   the divider        9 tall, 0 10 either side: a 1px --line at 4, a 34 × 5 --rule handle at 2
 *                      (radius 3); dragging it sets the box's height (web)
 *   the card           flex 1, scrolls, padding 6 12 16
 */
export function StepsBody({ detail, entry, convo, project, host }: { detail: TaskDetail; entry: { step?: string }; convo: boolean; project: string | undefined; host: StepsHost }): JSX.Element {
  const t = useTokens();
  const selected = entry.step === undefined ? undefined : nodeAt(detail.instances, entry.step);
  const step = selected === undefined ? undefined : entry.step;
  const asking = host.asking && detail.instances.some((node) => hasAsking(node)) ? askingInstanceOf(detail.instances) : undefined;
  const [rows, setRows] = useState(12);
  useStepFollow(step, host.current, host.onStep);
  const fit = useStepsFit(rows, step, host.current, host.onScreen, convo && host.onGoTo !== undefined);
  const index = (
    <RunIndex
      instances={detail.instances}
      fit={fit}
      {...(step !== undefined ? { here: step } : host.current !== undefined ? { here: host.current } : {})}
      {...(asking !== undefined ? { asking } : {})}
      {...(host.onCut !== undefined ? { onCut: host.onCut } : {})}
      // A row is a way to its card first — the conversation is one link further, on the card.
      onGoTo={(node) => {
        host.onStep(keyOfNode(node));
        host.onGoTo?.(node.instanceId);
      }}
    />
  );
  return (
    <View flex={1} minHeight={0} flexDirection="column">
      {detail.blocked.length > 0 ? (
        <View flexShrink={0} flexDirection="column" gap={6} paddingTop={8} paddingHorizontal={10}>
          {detail.blocked.map((b) => (
            <View key={b.stateId} backgroundColor={t.v("tint-warn") as never} borderRadius={t.v("control-radius") as never} paddingVertical={7} paddingHorizontal={9}>
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }}>
                <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn", weight: 700 }}>{b.stateId.split("/").pop()}</Txt> — {b.reason}
              </Txt>
            </View>
          ))}
        </View>
      ) : null}
      {step === undefined ? (
        <ScrollView
          {...(scrollbarProps(t) as object)}
          // `PLAIN_SCROLLER`: the index's scroller is not composited, so its text stays subpixel.
          style={{ flex: 1, minHeight: 0, ...PLAIN_SCROLLER } as never}
          contentContainerStyle={{ paddingTop: 4, paddingRight: 8, paddingBottom: 4, paddingLeft: 10, ...PLAIN_SCROLLER } as never}
          onLayout={(e) => setRows(stepRowsOf(e.nativeEvent.layout.height))}
        >
          {index}
        </ScrollView>
      ) : (
        <>
          <View flexShrink={0} height={host.boxHeight} minHeight={128} overflow="hidden" paddingTop={4} paddingRight={8} paddingBottom={4} paddingLeft={10} onLayout={(e) => setRows(stepRowsOf(e.nativeEvent.layout.height))}>
            {index}
          </View>
          <Split height={host.boxHeight} onHeight={host.onBoxHeight} />
          <ScrollView {...(scrollbarProps(t) as object)} style={{ flex: 1, minHeight: 0, ...PLAIN_SCROLLER } as never} contentContainerStyle={{ paddingTop: 6, paddingHorizontal: 12, paddingBottom: 16, ...PLAIN_SCROLLER } as never}>
            <StepCard
              detail={detail}
              node={selected!}
              project={project}
              sessions={host.sessions}
              onClose={() => host.onStep(undefined)}
              onOpen={host.onOpen}
              onConfig={() => host.onConfig(selected!)}
              {...(host.onGoTo !== undefined && convo ? { onGoTo: () => host.onGoTo?.(selected!.instanceId) } : {})}
            />
          </ScrollView>
        </>
      )}
    </View>
  );
}

/** The divider between the index and the card, dragged to size the index (web). */
function Split({ height, onHeight }: { height: number; onHeight: (height: number) => void }): JSX.Element {
  const t = useTokens();
  const [hot, setHot] = useState(false);
  const drag = (e: { clientY: number; preventDefault?: () => void }): void => {
    const start = e.clientY;
    const from = height;
    const move = (ev: PointerEvent): void => onHeight(Math.round(Math.max(30 * 4 + 8, Math.min(2000, from + ev.clientY - start))));
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <View
      flexShrink={0}
      height={9}
      marginHorizontal={10}
      position="relative"
      role="separator"
      {...({ onPointerDown: drag, onMouseEnter: () => setHot(true), onMouseLeave: () => setHot(false), cursor: "row-resize", title: "Drag to resize the list" } as object)}
    >
      <View position="absolute" left={0} right={0} top={4} height={1} backgroundColor={t.v("line") as never} />
      <View position="absolute" left="50%" top={2} width={34} height={5} marginLeft={-17} borderRadius={3} backgroundColor={t.v(hot ? "accent" : "rule") as never} />
    </View>
  );
}

/** A status's glyph (`panelFaceModel.ts`' `BADGE`) in a line of the panel's text. */
function Badge({ status }: { status: string }): JSX.Element {
  const hue = status === "running" || status === "interrupted" ? "accent" : status === "waiting_for_user" ? "warn" : status === "completed" ? "ok" : status === "failed" || status === "blocked" || status === "timeout" ? "bad" : "dim";
  return (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: hue }} width={16} textAlign="center" flexShrink={0}>
      {BADGE[status] ?? "·"}
    </Txt>
  );
}

/**
 * One step, densely — what went in and came out first, then how it ran.
 *
 *   the card        column, gap 10
 *   its head        row, centred, gap 7: the badge, the name (600, --text), the path (the data size
 *                   10/12, --dim, right-aligned, ellipsed, flex 1), and the card's two icons
 */
function StepCard({
  detail,
  node,
  project,
  sessions,
  onClose,
  onOpen,
  onConfig,
  onGoTo,
}: {
  detail: TaskDetail;
  node: InstanceNode;
  project?: string | undefined;
  sessions: readonly SessionRef[];
  onClose: () => void;
  onOpen: (title: string, value: unknown) => void;
  onConfig: () => void;
  onGoTo?: (() => void) | undefined;
}): JSX.Element {
  const t = useTokens();
  const [values, setValues] = useState<EffectiveStateValues | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setValues(undefined);
    void invoke("state:effective", { stateId: node.stateId, taskId: detail.taskId, instanceId: node.instanceId, ...(project !== undefined ? { project } : {}) })
      .then((found) => live && setValues(found?.values ?? null))
      .catch(() => live && setValues(null));
    return () => {
      live = false;
    };
  }, [node.stateId, node.instanceId, detail.taskId, project, node.status]);
  const path = pathOf(detail.instances, node);
  const inputs = values?.inputs ?? node.inputs;
  const output = values?.output;
  const ran = sessions.filter((one) => one.instanceId === node.instanceId);
  const cost = node.operation?.costUsd ?? ran.reduce((sum, one) => sum + (one.costUsd ?? 0), 0);
  const name = path[path.length - 1] ?? node.stateId;
  const open = (slot: string, value: unknown): void => onOpen(`${name} · ${slot}`, value);
  // How long so far, for a step still going: by a clock that moves only while it is.
  const now = useNow(node.endedAt === undefined && isLiveNode(node));
  return (
    <View flexDirection="column" gap={10} minWidth={0}>
      <View flexDirection="row" alignItems="center" gap={7} minWidth={0}>
        <Badge status={node.status} />
        {/* Neither is in the data face: the name is the body's 13/12.5 at 600, the path the app face at
            the data voice's 10/12. */}
        <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600 }} flexShrink={0}>
          {name}
        </Txt>
        <Txt spec={{ voice: "app", scale: 1, color: "dim" }} fontSize={t.scaled("size-data", 10 / 12)} lineHeight={t.replayed ? Number(t.scaled("size-data", (10 / 12) * 1.5)) : undefined} ellip flex={1} minWidth={0} textAlign="right" title={path.join(" › ")}>
          {path.slice(0, -1).join(" › ")}
        </Txt>
        {onGoTo !== undefined ? <SpIcon icon="comment" label="Go to it in the conversation" onPress={onGoTo} /> : null}
        <SpIcon icon="cross" label="Close the card" onPress={onClose} />
      </View>
      <PanelSection title="Inputs">{inputs === undefined ? <NoneRow>{values === undefined ? "reading…" : "none recorded"}</NoneRow> : valueRows(inputs, open)}</PanelSection>
      <PanelSection title="Output">
        {output === undefined ? <NoneRow>{values === undefined ? "reading…" : node.status === "running" ? "not yet" : "none published"}</NoneRow> : valueRows(output, open)}
      </PanelSection>
      <PanelSection title="How it ran">
        <PanelRow name="status" value={node.superseded ? `${node.status} · superseded` : node.status} />
        <PanelRow name="took" value={stepTookOf(node, now)} title={new Date(node.startedAt).toLocaleString()} />
        {node.operationCalls !== undefined
          ? node.operationCalls.map((call, i) => (call === undefined ? null : <PanelRow key={i} name={`call ${i + 1}`} value={callLine(call)} title={call.status === "failed" ? call.reason : undefined} />))
          : node.operation !== undefined
            ? <PanelRow name="operation" value={node.operation.kind} />
            : null}
        {node.operation?.status === "failed" && node.operation.reason !== undefined ? <PanelRow name="why" value={node.operation.reason} /> : null}
        {cost > 0 ? <PanelRow name="cost" value={`$${cost.toFixed(cost < 0.1 ? 3 : 2)}`} /> : null}
        {ran.length > 0 ? <PanelRow name="sessions" value={ran.length} title={ran.map((one) => one.sessionId).join("\n")} /> : null}
        <PanelRow name="instance" value={node.instanceId} mono />
        <PanelRow name="configuration" value="as it ran ›" onPress={onConfig} />
      </PanelSection>
    </View>
  );
}
