import { useEffect, useState, type JSX, type ReactNode } from "react";
import { View, isWeb } from "@tamagui/core";
import type { ChatPlanView, ChatSettings, InstanceNode, PendingInteraction, TaskDetail } from "@jaira/shared/browser";
import { actOnWaiting, useWaiting } from "@jaira/ui/limitsStore";
import { costOfConversation, lastContextOf, type ArmedRewind } from "@jaira/ui/runConversationModel";
import { invoke } from "@jaira/ui/store";
import { ChatError } from "../chat/ChatThread";
import { Composer } from "../chat/Composer";
import { WaitingLine } from "../chat/Waiting";
import { OfflineBanner } from "../panel/OfflineBanner";
import { CutStrip, CxDoing, RunActivity } from "../panel/RunActivity";
import { RunTranscript, type TranscriptSource } from "../panel/RunTranscript";
import { RAIL_WIDTH, StepsRail } from "../panel/StepsRail";
import { runFocus } from "../panel/panelBridge";
import { askingInstanceOf, hasAsking } from "@jaira/ui/stateSurfaceModel";
import { usePhone } from "../../app/phone";

/**
 * One run's conversation — the transcript's scroller (`RunTranscript`), and under it the composer or
 * what stands in its place (`RunComposer`). The same component reads a task's run in the side panel
 * (`TaskConversation`) and a run walked into in the middle column (`RunView`); `foot` is what the panel
 * adds under it (the gate the tree has no place for). A rewind armed on an entered row is held here:
 * the page fades from it and the strip under the scroller asks about it (`CutStrip`), cleared with the
 * task.
 *
 *   the whole          column, flex 1; the transcript flex 1, scrolls
 *
 * On a phone the run's Steps stand at the transcript's right edge as bookmarks into it (`StepsRail`), the
 * transcript 30 narrower for it. Where the host goes to a step for it (`focus`, the main view's), the rail
 * asks the same way; where it does not (the panel's sheet), the conversation keeps its own.
 */
export function RunConversation({
  detail,
  parent,
  source,
  project,
  gate,
  onGate,
  asking,
  onRerun,
  onResume,
  onOpenSidechain,
  foot,
  onLayout,
  focus,
  onHere,
}: {
  detail: TaskDetail;
  /** The run being read. */
  parent: InstanceNode | undefined;
  source: TranscriptSource;
  project: string | undefined;
  gate?: PendingInteraction | undefined;
  onGate?: ((value: unknown) => void) | undefined;
  /** A gate is on offer — so the run is WAITING, whatever its row says. */
  asking: boolean;
  onRerun?: ((taskId: string) => void) | undefined;
  onResume?: ((taskId: string) => void) | undefined;
  /** Where "walk in →" on a subagent's doorway goes, for this host (the panel's own stack). Else the trail. */
  onOpenSidechain?: ((node: InstanceNode, call: string, name: string) => void) | undefined;
  foot?: ReactNode;
  onLayout?: ((height: number) => void) | undefined;
  /** A state to go to, asked for by the Steps index beside this column — see `RunTranscript`. */
  focus?: { instance: string; at: number } | undefined;
  /** Where the reader is, reported as they scroll, for that index to mark. */
  onHere?: ((instance: string | undefined, onScreen?: ReadonlySet<string>) => void) | undefined;
}): JSX.Element {
  // A rewind the reader has ARMED from an entered row — cleared with the task, since a cut is a
  // question about one journal. A fork needs no arming: it starts at once.
  const [armed, setArmed] = useState<ArmedRewind | null>(null);
  useEffect(() => setArmed(null), [detail.taskId]);
  const { onRewind } = source;
  const cut =
    armed !== null && onRewind !== undefined
      ? {
          armed,
          onConfirm: () => {
            setArmed(null);
            onRewind(detail.taskId, armed.seq);
          },
          onCancel: () => setArmed(null),
        }
      : undefined;
  // A phone's Steps rail: where the reader is, and where it asked to go when the host keeps no such thing.
  const phone = usePhone();
  const [ownFocus, setOwnFocus] = useState<{ instance: string; at: number } | undefined>(undefined);
  const [reading, setReading] = useState<string | undefined>(undefined);
  const hostFocus = focus !== undefined || onHere !== undefined;
  const transcript = (
    <RunTranscript
      detail={detail}
      parent={parent}
      source={source}
      {...(gate !== undefined && onGate !== undefined ? { gate, onGate } : {})}
      armed={armed}
      onArm={setArmed}
      onOpenSidechain={onOpenSidechain}
      focus={focus ?? (phone ? ownFocus : undefined)}
      onHere={
        phone
          ? (instance, onScreen) => {
              onHere?.(instance, onScreen);
              setReading(instance);
            }
          : onHere
      }
    />
  );
  return (
    <View flex={1} minHeight={0} flexDirection="column" {...(onLayout !== undefined ? { onLayout: (e: { nativeEvent: { layout: { height: number } } }) => onLayout(e.nativeEvent.layout.height) } : {})}>
      {phone && detail.instances.length > 0 ? (
        <View flex={1} minHeight={0} flexDirection="column" paddingRight={RAIL_WIDTH} {...((isWeb ? { position: "relative" } : {}) as object)}>
          {transcript}
          <StepsRail
            instances={detail.instances}
            here={reading}
            {...(asking && detail.instances.some((node) => hasAsking(node)) ? { asking: askingInstanceOf(detail.instances) } : {})}
            onGoTo={(node) => (hostFocus ? runFocus.set({ instance: node.instanceId, at: Date.now() }) : setOwnFocus({ instance: node.instanceId, at: Date.now() }))}
          />
        </View>
      ) : (
        transcript
      )}
      {/* What stands under the scroller — the composer's place and the panel's foot. Nothing here asks
          for a layer: the scroller above is painted where it stands (`PLAIN_SCROLLER`), so Chromium gives
          these a layer only by overlap, where they touch it. */}
      <View flexShrink={0} flexDirection="column">
        <RunComposer detail={detail} instanceId={parent?.instanceId} source={source} project={project} asking={asking} onRerun={onRerun} onResume={onResume} cut={cut} />
        {foot}
      </View>
    </View>
  );
}

/**
 * `RunComposer`: the composer, bound to the run being read — or, over a run that holds no conversation
 * of its own (`chat:plan` answers `null`), the activity strip where the composer would stand. It owns the
 * overrides and asks for the plan again when they change and after each send (a stale plan would show
 * the model and "joins this turn" from before it). The rest stands in the same band: another machine's
 * run while it is away (`OfflineBanner`), a run refused for the allowance (`WaitingLine`, with its Stop),
 * what went wrong (`ChatError`), and an armed rewind's strip in place of the activity's.
 */
export function RunComposer({
  detail,
  instanceId,
  source,
  project,
  asking,
  onRerun,
  onResume,
  cut,
}: {
  detail: TaskDetail;
  instanceId: string | undefined;
  source: TranscriptSource;
  project: string | undefined;
  asking: boolean;
  onRerun?: ((taskId: string) => void) | undefined;
  onResume?: ((taskId: string) => void) | undefined;
  /** A rewind armed above — asked about here, in place of whatever the strip was showing. */
  cut?: { armed: ArmedRewind; onConfirm: () => void; onCancel: () => void } | undefined;
}): JSX.Element | null {
  const taskId = detail.taskId;
  const running = detail.status === "running";
  const [overrides, setOverrides] = useState<ChatSettings>({});
  // Three states: `undefined` not asked yet, `null` asked and there is no conversation, else the plan.
  const [plan, setPlan] = useState<ChatPlanView | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a turn, to ask for the plan again.
  const [sent, setSent] = useState(0);
  useEffect(() => {
    if (instanceId === undefined) {
      setPlan(null);
      return;
    }
    setPlan(undefined);
    let live = true;
    void invoke("chat:plan", { taskId, instanceId, overrides, ...(project !== undefined ? { project } : {}) })
      .then((next) => live && setPlan(next))
      .catch(() => live && setPlan(null));
    return () => {
      live = false;
    };
  }, [taskId, instanceId, overrides, project, sent]);

  const send = (message: string): void => {
    if (instanceId === undefined) return;
    setBusy(true);
    setError(null);
    void invoke("chat:send", { taskId, instanceId, message, overrides, ...(project !== undefined ? { project } : {}) })
      .then((result) => setError(result.failure ?? null))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy(false);
        setSent((n) => n + 1);
      });
  };
  // Stop what is actually going: the TASK while it runs or asks (`task:cancel` withdraws a gate too), a
  // turn typed into a settled run otherwise (`chat:cancel`).
  const stop = (): void => {
    if (running || asking) {
      void invoke("task:cancel", { taskId, ...(project !== undefined ? { project } : {}) }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
      return;
    }
    void invoke("chat:cancel", { taskId, ...(project !== undefined ? { project } : {}) }).catch(() => undefined);
  };
  // Skip, from the fast-forward strip (decision 0005 §4): enter the target now, what is between recorded `skipped`.
  const skip = (): void => {
    void invoke("task:skip", { taskId, ...(project !== undefined ? { project } : {}) }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const forwarding = detail.fastForward !== undefined;
  // Only nothing selected disables the box; a run with no conversation has the strip instead.
  const disabled = instanceId === undefined ? "Select a run to continue its conversation." : undefined;
  // A run refused because the account ran out waits for the reset — its line, with Try again at …,
  // Send now anyway and Stop the run (it stays stopped).
  const waitingRun = useWaiting().filter((item) => item.kind === "run" && item.taskId === taskId);
  const waitingLines =
    waitingRun.length > 0 ? (
      // A band of their own (`CxDoing`), the lines 4 apart.
      <CxDoing gap={4}>
        {waitingRun.map((item) => (
          <WaitingLine key={item.id} item={item} run onStop={() => actOnWaiting(item.id, "drop")} />
        ))}
      </CxDoing>
    ) : null;
  const model = plan?.effective.model ?? "";
  const onCompact = /^claude-(cli|code)\//.test(model) ? (focus?: string) => send(focus !== undefined ? `/compact ${focus}` : "/compact") : undefined;
  const cutStrip = cut !== undefined ? <CutStrip armed={cut.armed} onConfirm={cut.onConfirm} onCancel={cut.onCancel} /> : null;
  const errorLine = error !== null ? <ChatError text={error} /> : null;

  if (plan === null && instanceId !== undefined) {
    // One band: the offline banner, the waiting lines and the error over the strip (or the cut's).
    const lead = (
      <>
        <OfflineBanner project={project} />
        {waitingLines}
        {errorLine}
      </>
    );
    const strip =
      cutStrip !== null ? (
        <CxDoing>
          {lead}
          {cutStrip}
        </CxDoing>
      ) : (
        <RunActivity detail={detail} asking={asking} onStop={stop} onSkip={skip} onRerun={onRerun} onResume={onResume} lead={lead} />
      );
    return strip;
  }

  // How full the conversation being continued is, and what it has cost (the rows the panel holds).
  const contextReading = instanceId !== undefined ? lastContextOf(source.sessions[String(instanceId)]) : undefined;
  const conversationCost = instanceId !== undefined ? costOfConversation(source.sessionHistory, String(instanceId)) : undefined;
  return (
    <>
      <OfflineBanner project={project} />
      {cutStrip !== null ? <CxDoing>{cutStrip}</CxDoing> : null}
      {cutStrip === null && forwarding ? <RunActivity detail={detail} asking={false} onStop={stop} onSkip={skip} /> : null}
      {waitingLines}
      {errorLine}
      <Composer
        plan={plan ?? null}
        // Kept per conversation: the task, and the state's conversation within it when one is picked.
        draftKey={`task:${taskId}${instanceId !== undefined ? `#${instanceId}` : ""}`}
        usage={{ context: contextReading, onCompact, cost: conversationCost }}
        // A run in flight is busy whatever the box says: the button is the only handle on it…
        busy={busy || running}
        // …and a state that holds a conversation can be typed into while it runs.
        joinable={disabled === undefined}
        overrides={overrides}
        onOverrides={setOverrides}
        onSend={send}
        onStop={stop}
        onSavePermissionSet={(request) => invoke("permissionSet:save", { ...request, ...(project !== undefined ? { project } : {}) })}
        {...(disabled !== undefined ? { disabled } : {})}
      />
    </>
  );
}
