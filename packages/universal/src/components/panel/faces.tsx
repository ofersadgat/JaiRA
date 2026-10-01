import { issueReveal } from "../../app/viewState";
import { useContext, type JSX, type ReactNode } from "react";
import type { ArtifactSummary, InstanceNode, PendingInteraction, StateView, TaskDetail } from "@jaira/shared/browser";
import { BADGE, CHAT_PANEL_SUB, chatPanelTitleOf, chatTabs, countSteps, indexCutOf, isEventsTask, tab, taskTabs, taskVerbsOf, type PanelVerb } from "@jaira/ui/panelFaceModel";
import { pop, push, selectStep, setTab, type PanelEntry, type PanelStack } from "@jaira/ui/panelStack";
import { View } from "@tamagui/core";
import type { ExecutorInfo, FileTree, WorkflowSource } from "@jaira/shared/browser";
import type { ConfigPanelServices } from "@jaira/ui/configPanelModel";
import { useEffectiveRead } from "@jaira/ui/configPanelModel";
import type { FileSurfaceContext, UiSurface } from "@jaira/ui/fileTypes";
import { useTaskRun } from "@jaira/ui/taskRun";
import { rerunStartsOf } from "@jaira/ui/panelHost";
import { checksCountOf, producedValueOf } from "@jaira/ui/panelViewsModel";
import type { TrailStep } from "@jaira/ui/trail";
import { taskNameOf } from "@jaira/ui/taskNameModel";
import type { PinnedValue } from "@jaira/ui/valuePanel";
import { invoke } from "@jaira/ui/store";
import type { ArtifactSurface } from "@jaira/ui/transcriptViewTypes";
import { Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { ChangesPanel } from "./ChangesPanel";
import { Icon } from "./Icon";
import { HeldView, OutputsView, PanelEmpty, ProducedView } from "./PanelViews";
import { PreviewCard } from "./PreviewCard";
import { RerunForm, type RerunSurface } from "./RerunForm";
import type { TranscriptSource } from "./RunTranscript";
import { GlyphSizeContext, SpIcon, type PanelFace } from "./SidePanel";
import { StateChecks } from "./StateChecks";
import { RunPanel } from "./RunPanel";
import type { RunSurface } from "@jaira/ui/runPanelTypes";
import { StepsBody } from "./StepsView";
import { TaskConversation } from "./TaskConversation";
import { ValueView } from "./ValueView";
import { SidechainConversation } from "../run/SidechainConversation";
import { ConfigCard as WorkflowConfigCard } from "../workflow/ConfigPanel";
import { StatePanel } from "../workflow/StatePanel";

type OnStack = (next: (stack: PanelStack) => PanelStack) => void;

/**
 * Everything a face needs from the shell, built once per render by `PanelColumn.tsx` from the store.
 */
export interface FaceHost {
  /** The SELECTED task's detail — the only one whose run the store has loaded. */
  detail: TaskDetail | null;
  /** Any task's detail the shell holds. */
  detailOf: (taskId: string) => TaskDetail | null;
  project: string | undefined;
  /** What a conversation is read from. */
  source: TranscriptSource;
  onStack: OnStack;
  /** The gate the selected task is parked on, and how to answer it. */
  gate: PendingInteraction | undefined;
  onGate: (value: unknown) => void;
  /** The gate any task is parked on, wherever its panel is — for a task the store is not holding (`OwnRun`). */
  gateOf?: ((taskId: string) => { gate: PendingInteraction; onGate: (value: unknown) => void } | undefined) | undefined;
  startAgain: (taskId: string) => void;
  resume: (taskId: string) => void;
  cancel: (taskId: string) => void;
  /** "Review these changes" — the task's worktree in the reviewer. */
  reviewChanges: (taskId: string) => void;
  /** ⇤ — the task's conversation into the main view. */
  adoptTask: (taskId: string, project: string | undefined, workflow: string) => void;
  /** ⇤ — a subagent's conversation into the main view (`useAdoptSubagent`). */
  adoptSubagent: (taskId: string, project: string | undefined, step: TrailStep) => void;
  /** ⇥ — the conversation back out of the main view, into the panel. */
  giveBack?: (() => void) | undefined;
  /** Take the main view's conversation to a step; absent when the main view is not the conversation. */
  goTo?: ((instanceId: string) => void) | undefined;
  /** The step being viewed in the main view's conversation, and what is on screen there. */
  viewed?: { current?: string | undefined; onScreen?: ReadonlySet<string> | undefined } | undefined;
  /** A state's view and run surface, when the store holds them. */
  stateOf: (stateId: string, project?: string | null) => { view: StateView | null; run?: RunSurface | undefined } | undefined;
  /** Whether the Files editor has this state's file open. */
  inEditor: (stateId: string) => boolean;
  /** ⇤ — open a state in the Files view. */
  openInFiles: (stateId: string) => void;
  held: readonly PinnedValue[];
  hold: (item: PinnedValue) => void;
  unhold: (item: PinnedValue) => void;
  stepsHeight: number;
  setStepsHeight: (height: number) => void;
  /** The New-task form, as a panel. */
  newTask: ReactNode;
  /** Where a re-run with changes starts: the task's workflow as a run form. */
  rerunSurface: (detail: TaskDetail) => RerunSurface;
  /** Fork a task at a journal position — a copy that starts before a state it entered. */
  onFork?: ((taskId: string, seq: number) => void) | undefined;
  /** Rewind a task to a journal position — the Steps index's other verb. */
  onRewind?: ((taskId: string, seq: number) => void) | undefined;
  /** The conversation's turns, for where a copy may start. */
  turns: readonly { kind: string; instanceId?: string | undefined; seq: number }[];
  /**
   * What the workflow editor needs in a configuration card and a state's Configuration.
   */
  config: {
    tree: FileTree | null;
    executors: ExecutorInfo[];
    busy: boolean;
    services: ConfigPanelServices;
    wrapJson?: boolean | undefined;
    onWrapJson?: ((wrap: boolean) => void) | undefined;
    readState?: ((stateId: string) => Promise<WorkflowSource | null>) | undefined;
    saveState?: ((source: WorkflowSource, text: string) => void) | undefined;
    ui?: UiSurface | undefined;
  };
  /** The events task's automations — Settings' Automations editor, for the task's project (or Shared's). */
  automationsOf: (project: string | undefined, onOpenConversation: () => void) => ReactNode;
}

/** A task's status glyph: 16 wide, at the glyph's size (15px in the head, 13 in the rail), coloured by status. */
function Badge({ status }: { status: string }): JSX.Element {
  const size = useContext(GlyphSizeContext);
  const hue = status === "running" || status === "interrupted" ? "accent" : status === "waiting_for_user" ? "warn" : status === "completed" ? "ok" : status === "failed" || status === "blocked" || status === "timeout" ? "bad" : "dim";
  return (
    <Txt spec={{ voice: "app", scale: 1, color: hue, lineHeight: { px: size * 1.5 } }} fontSize={size} width={16} textAlign="center" flexShrink={0}>
      {BADGE[status] ?? "·"}
    </Txt>
  );
}

/** An icon as a face's glyph: --dim at the glyph's size (15px in the head, 13 in the rail). */
function Glyph({ name }: { name: Parameters<typeof Icon>[0]["name"] }): JSX.Element {
  const t = useTokens();
  return <Icon name={name} size={useContext(GlyphSizeContext)} color={String(t.v("dim"))} />;
}

/** The head's line for a task: its status, its name, and what identifies it. */
function taskHeadOf(detail: TaskDetail | null, taskId: string): Pick<PanelFace, "glyph" | "title" | "titleText" | "sub"> {
  if (detail === null) return { title: taskId, titleText: taskId, glyph: <Badge status="queued" /> };
  return {
    glyph: <Badge status={detail.status} />,
    title: taskNameOf(detail),
    titleText: detail.title,
    // The id in its own run: one run for the whole line shapes differently at the seam.
    sub: (
      <>
        <Txt spec={{ voice: "app", scale: 0.92, color: "dim" }}>{detail.taskId}</Txt>
        {` · ${detail.workflow}`}
        {detail.branch !== undefined ? ` · ⎇ ${detail.branch}` : null}
      </>
    ),
  };
}

/** Another task on top of the stack — a subtask the Changes tab names. */
function openTask(host: FaceHost, taskId: string, project: string | undefined): void {
  host.onStack((was) => push(was, { kind: "task", key: `task:${taskId}`, taskId, ...(project !== undefined ? { project } : {}), tab: "conversation" }));
}

function pushPreview(host: FaceHost, item: PinnedValue): void {
  host.onStack((was) => push(was, { kind: "preview", key: `preview:${item.title}`, preview: item }));
}

/** A subagent's conversation on top of the panel's stack — where "walk in →" goes in the panel. */
function openSubagent(host: FaceHost, taskId: string, project: string | undefined, node: InstanceNode, call: string, name: string): void {
  host.onStack((was) =>
    push(was, {
      kind: "subagent",
      key: `subagent:${node.instanceId}:${call}`,
      taskId,
      ...(project !== undefined ? { project } : {}),
      step: { instanceId: node.instanceId, stateId: node.stateId, sidechain: call, name },
    }),
  );
}

/**
 * The artifact picked in the Produced tab (`ProducedView`): the value viewer, with the two icons in its
 * head (a row, gap 1; each an `SpIcon`) — open it on its own in this panel, hold it in Held. A live
 * artifact runs here (the task's grant, `serveOf`), and keeps its grant where it is opened or held.
 */
function produced(host: FaceHost, artifacts: ArtifactSurface): (row: ArtifactSummary, text: string) => ReactNode {
  return (row, text) => {
    const item: PinnedValue = { title: row.path, value: producedValueOf(row, text), serve: artifacts.serve, ...(artifacts.onPrompt !== undefined ? { onPrompt: artifacts.onPrompt } : {}) };
    return (
      <View minWidth={0}>
        <ValueView
          value={item.value as never}
          serve={artifacts.serve}
          {...(artifacts.onPrompt !== undefined ? { onPrompt: artifacts.onPrompt } : {})}
          actions={
            <View flexDirection="row" gap={1}>
              <SpIcon icon="read" label="Open it on its own, in this panel" onPress={() => pushPreview(host, item)} />
              <SpIcon icon="pin" label="Hold it — keep it in Held" onPress={() => host.hold(item)} />
            </View>
          }
        />
      </View>
    );
  };
}

/**
 * What lets a task's artifact run in the panel: a grant against the task that produced it, in its
 * project. No `onPrompt` — the panel has no composer for a page to write into.
 *
 * Kept, one per task: a value view asks for a grant again whenever its `serve` changes, and a new frame
 * address reloads the page — a fresh function on every draw of the panel would restart it each time.
 */
const surfaces = new Map<string, ArtifactSurface>();
function serveOf(taskId: string, project: string | undefined): ArtifactSurface {
  const key = `${taskId}\u0000${project ?? ""}`;
  let surface = surfaces.get(key);
  if (surface === undefined) {
    surface = { serve: (path: string) => invoke("artifact:serve", { taskId, path, ...(project !== undefined ? { project } : {}) }) };
    surfaces.set(key, surface);
  }
  return surface;
}

const reading = (): JSX.Element => <PanelEmpty>Reading the task…</PanelEmpty>;

/** The Steps tab, for a task or a conversation's context. */
function stepsBody(host: FaceHost, detail: TaskDetail, entry: { step?: string; project?: string }, convo: boolean): ReactNode {
  return (
    <StepsBody
      detail={detail}
      entry={entry}
      convo={convo}
      project={entry.project ?? host.project}
      host={{
        onStep: (step) => host.onStack((was) => selectStep(was, step)),
        ...(convo && host.viewed?.current !== undefined ? { current: host.viewed.current } : {}),
        ...(convo && host.viewed?.onScreen !== undefined ? { onScreen: host.viewed.onScreen } : {}),
        ...(convo && host.goTo !== undefined ? { onGoTo: host.goTo } : {}),
        asking: host.gate !== undefined,
        sessions: host.source.sessionHistory,
        onOpen: (title, value) => pushPreview(host, { title, value }),
        // A step's right-click: rewind to before it, or fork there (`indexCutOf`).
        ...(() => {
          const onCut = indexCutOf(host.turns, detail.taskId, host.onRewind, host.onFork);
          return onCut !== undefined ? { onCut } : {};
        })(),
        onConfig: (node) =>
          host.onStack((was) =>
            push(was, { kind: "config", key: `config:${node.instanceId}`, stateId: node.stateId, taskId: detail.taskId, instanceId: node.instanceId, ...(entry.project !== undefined ? { project: entry.project } : {}) }),
          ),
        boxHeight: host.stepsHeight,
        onBoxHeight: host.setStepsHeight,
      }}
    />
  );
}

/** The configuration a run resolved against — a card, and a tab. */
function ConfigCard({ host, stateId, taskId, instanceId, project }: { host: FaceHost; stateId: string; taskId?: string | undefined; instanceId?: string | undefined; project?: string | null | undefined }): JSX.Element {
  const read = useEffectiveRead(stateId, taskId, instanceId, project ?? host.project ?? null);
  return <WorkflowConfigCard read={read} stateId={stateId} tree={host.config.tree} executors={host.config.executors} services={host.config.services} onOpenState={host.openInFiles} />;
}

/** A state's configuration, editable — its own copy of the file. */
function StateConfig({ host, stateId }: { host: FaceHost; stateId: string }): JSX.Element {
  const { readState, saveState } = host.config;
  if (readState === undefined) return <PanelEmpty>This state&apos;s file cannot be read here.</PanelEmpty>;
  // The panel's scrolling body's padding (12 12 18), around a panel that fills it rather than scrolling in it.
  return (
    <View flex={1} minHeight={0} flexDirection="column" paddingTop={12} paddingHorizontal={12} paddingBottom={18}>
    <StatePanel
      stateId={stateId}
      read={readState}
      save={saveState ?? (() => undefined)}
      tree={host.config.tree}
      executors={host.config.executors}
      busy={host.config.busy}
      validateSchema={host.config.services.validateSchema}
      loadStateSlots={host.config.services.loadStateSlots}
      wrapJson={host.config.wrapJson}
      onWrapJson={host.config.onWrapJson}
      ui={host.config.ui}
      readFile={host.config.services.readFile}
      onOpenState={host.openInFiles}
    />
    </View>
  );
}

/** The ⨯ that lets go of a held value. */
const dropIcon = (host: FaceHost) => (item: PinnedValue): ReactNode => <SpIcon icon="cross" label="Let go of it" onPress={() => host.unhold(item)} />;

/**
 * `OwnRun`: an entry about a task the store is NOT holding — a subtask the Changes tab pushed, an entry
 * left under a pushed card after the selection moved on. It loads the task's run itself (`taskRun.ts`)
 * and draws the entry's body over a host that is about THAT task: its tree, its conversation, its gate.
 * The main view is not showing it, so there is nothing there to go to.
 */
function OwnRun({ host, entry, taskId, project }: { host: FaceHost; entry: PanelEntry; taskId: string; project: string | undefined }): JSX.Element {
  // `useTaskRun` lays the run over a surface context; the transcript's source is the part of one it reads.
  const run = useTaskRun(taskId, project, host.source as unknown as FileSurfaceContext);
  if (run.failed !== null) return <PanelEmpty>{"Could not read this task: "}{run.failed}</PanelEmpty>;
  if (run.detail === null) return reading();
  const gate = host.gateOf?.(taskId);
  const { context } = run;
  const own: FaceHost = {
    ...host,
    detail: run.detail,
    detailOf: (id) => (id === taskId ? run.detail : host.detailOf(id)),
    project,
    source: {
      ...host.source,
      conversation: context.conversation,
      sessions: context.sessions,
      sessionHistory: context.sessionHistory,
      records: context.records,
      liveTurn: context.liveTurn,
      onLoadSessions: context.onLoadSessions,
      project,
    },
    gate: gate?.gate,
    onGate: gate?.onGate ?? (() => undefined),
    turns: context.conversation?.turns ?? [],
    goTo: undefined,
    viewed: undefined,
    giveBack: undefined,
  };
  return <>{faceOf(own, entry).body}</>;
}

/** The face of any entry. */
export function faceOf(host: FaceHost, entry: PanelEntry, headOnly = false): PanelFace {
  const detail = "taskId" in entry && entry.taskId !== undefined ? host.detailOf(entry.taskId) : null;
  const loaded = detail !== null && host.detail?.taskId === detail.taskId;
  // A task-shaped entry whose run is not the loaded one draws its body over its own (`OwnRun`).
  if (!headOnly && (entry.kind === "task" || entry.kind === "convo" || entry.kind === "subagent" || entry.kind === "rerun") && host.detail?.taskId !== entry.taskId) {
    const face = faceOf({ ...host, detail }, entry, true);
    return { ...face, body: <OwnRun host={host} entry={entry} taskId={entry.taskId} project={entry.project ?? host.project} />, scroll: face.scroll };
  }
  switch (entry.kind) {
    case "task": {
      const head = taskHeadOf(detail, entry.taskId);
      const project = entry.project ?? host.project;
      const body = (): ReactNode => {
        if (detail === null) return reading();
        switch (entry.tab) {
          case "conversation":
            return loaded ? (
              <TaskConversation
                detail={detail}
                project={project}
                source={host.source}
                gate={host.gate}
                onGate={host.onGate}
                onRerun={host.startAgain}
                onResume={host.resume}
                onOpenSidechain={(node, call, name) => openSubagent(host, detail.taskId, project, node, call, name)}
              />
            ) : (
              reading()
            );
          case "steps":
            return stepsBody(host, detail, entry, false);
          case "changes":
            return <ChangesPanel taskId={detail.taskId} project={project} signal={`${detail.status}:${detail.timeline.length}`} onOpenTask={(taskId) => openTask(host, taskId, project)} {...(detail.worktreePath !== undefined ? { onReview: () => host.reviewChanges(detail.taskId) } : {})} />;
          case "outputs":
            return <OutputsView detail={detail} sessions={host.source.sessionHistory} onOpen={(title, value) => pushPreview(host, { title, value })} />;
          case "configuration":
            if (isEventsTask(detail)) return host.automationsOf(project, () => host.onStack((was) => setTab(was, "conversation")));
            return <ConfigCard host={host} stateId={detail.workflow} taskId={detail.taskId} project={project} />;
        }
      };
      return {
        ...head,
        verbs: detail === null ? [] : taskVerbsOf({ startAgain: host.startAgain, cancel: host.cancel, onStack: host.onStack, adoptTask: host.adoptTask }, detail, project, true),
        tabs: taskTabs(host.gate !== undefined ? { pending: host.gate } : undefined, detail, true),
        tab: entry.tab,
        body: body(),
        scroll: detail === null || !((entry.tab === "conversation" && loaded) || entry.tab === "steps"),
      };
    }

    case "convo": {
      const head = taskHeadOf(detail, entry.taskId);
      const project = entry.project ?? host.project;
      const body = (): ReactNode => {
        if (detail === null) return reading();
        switch (entry.tab) {
          case "steps":
            return stepsBody(host, detail, entry, true);
          case "produced":
            return <ProducedView taskId={detail.taskId} project={project} signal={detail.timeline.length} onShow={produced(host, serveOf(detail.taskId, project))} />;
          case "changes":
            return <ChangesPanel taskId={detail.taskId} project={project} signal={`${detail.status}:${detail.timeline.length}`} onOpenTask={(taskId) => openTask(host, taskId, project)} {...(detail.worktreePath !== undefined ? { onReview: () => host.reviewChanges(detail.taskId) } : {})} />;
          case "held":
            return <HeldView held={host.held} onOpen={(item) => pushPreview(host, item as PinnedValue)} onDrop={(item) => host.unhold(item as PinnedValue)} dropIcon={(item) => dropIcon(host)(item as PinnedValue)} />;
          case "configuration":
            // The conversation is the main view's already, so "open it" has nowhere else to go.
            return isEventsTask(detail) ? host.automationsOf(project, () => undefined) : null;
        }
      };
      const verbs: PanelVerb[] = [
        ...(detail === null ? [] : taskVerbsOf({ startAgain: host.startAgain, cancel: host.cancel, onStack: host.onStack, adoptTask: host.adoptTask }, detail, project, false)),
        ...(host.giveBack !== undefined ? [{ icon: "back" as const, label: "Give the conversation back to the panel", onClick: host.giveBack }] : []),
      ];
      return {
        ...head,
        verbs,
        tabs: [
          tab("steps", "Steps", detail !== null ? { count: countSteps(detail.instances) } : {}),
          tab("produced", "Produced"),
          tab("changes", "Changes"),
          tab("held", "Held", host.held.length > 0 ? { count: host.held.length } : {}),
          ...(isEventsTask(detail) ? [tab("configuration", "Automations")] : []),
        ],
        tab: entry.tab,
        body: body(),
        scroll: entry.tab !== "steps" || detail === null,
      };
    }

    case "chat": {
      const project = entry.project ?? host.project;
      const title = chatPanelTitleOf(detail);
      return {
        glyph: <ChatGlyph />,
        title,
        titleText: title,
        sub: CHAT_PANEL_SUB,
        tabs: chatTabs(host.held.length),
        tab: entry.tab,
        body:
          entry.tab === "produced" ? (
            <ProducedView taskId={entry.taskId} project={project} signal={detail?.timeline.length ?? 0} onShow={produced(host, serveOf(entry.taskId, project))} />
          ) : entry.tab === "changes" ? (
            <ChangesPanel taskId={entry.taskId} project={project} signal={`${detail?.status}:${detail?.timeline.length}`} onOpenTask={(taskId) => openTask(host, taskId, project)} />
          ) : (
            <HeldView held={host.held} onOpen={(item) => pushPreview(host, item as PinnedValue)} onDrop={(item) => host.unhold(item as PinnedValue)} dropIcon={(item) => dropIcon(host)(item as PinnedValue)} />
          ),
      };
    }

    case "state": {
      const found = host.stateOf(entry.stateId, entry.project);
      const view = found?.view;
      const editing = host.inEditor(entry.stateId);
      const name = entry.stateId.split("/").pop() ?? entry.stateId;
      const tabs = [tab("run", "Run"), tab("checks", "Checks", checksCountOf(view ?? null)), ...(editing ? [] : [tab("configuration", "Configuration")])];
      const open = editing && entry.tab === "configuration" ? "run" : entry.tab;
      const body = (): ReactNode => {
        if (view === undefined || view === null) return <PanelEmpty>Reading {name}…</PanelEmpty>;
        switch (open) {
          case "run":
            return found?.run !== undefined ? <RunPanel state={view} run={found.run} /> : <PanelEmpty>Nothing here can start a run of this state.</PanelEmpty>;
          case "checks":
            return (
              <StateChecks
                state={view}
                onOpenConfig={() => host.onStack((was) => push(was, { kind: "config", key: `config:${entry.stateId}`, stateId: entry.stateId, project: entry.project }))}
                onOpenState={host.openInFiles}
                onRevealIssue={(path) => issueReveal.set({ path, nonce: (issueReveal.get()?.nonce ?? 0) + 1 })}
              />
            );
          case "configuration":
            return <StateConfig host={host} stateId={entry.stateId} />;
        }
      };
      return {
        glyph: <Glyph name="workflow" />,
        title: name,
        titleText: entry.stateId,
        sub: entry.stateId,
        verbs: editing ? [] : [{ icon: "adopt", label: "Open in the Files view", onClick: () => host.openInFiles(entry.stateId) }],
        tabs,
        tab: open,
        body: body(),
        // The state panel fills the body and scrolls its own form, so the body is not a scroller
        // around it.
        ...(open === "configuration" && view !== undefined && view !== null ? { scroll: false } : {}),
      };
    }

    case "newTask":
      return { glyph: <Glyph name="play" />, title: "New task", titleText: "New task", body: host.newTask };

    case "config": {
      const name = entry.stateId.split("/").pop() ?? entry.stateId;
      return {
        title: name,
        titleText: `${name} · configuration`,
        sub: entry.instanceId,
        body: <ConfigCard host={host} stateId={entry.stateId} taskId={entry.taskId} instanceId={entry.instanceId} project={entry.project} />,
      };
    }

    case "preview": {
      const held = host.held.some((one) => one.title === entry.preview.title);
      return {
        title: entry.preview.title,
        titleText: entry.preview.title,
        verbs: [{ icon: "pin", label: held ? "Held — let go of it" : "Hold it — keep it in Held", onClick: () => (held ? host.unhold(entry.preview) : host.hold(entry.preview)) }],
        body: <PreviewCard item={entry.preview} />,
      };
    }

    case "subagent": {
      const name = entry.step.name ?? entry.step.sidechain ?? entry.step.stateId;
      return {
        title: name,
        titleText: name,
        verbs: [{ icon: "adopt", label: "Show this conversation in the main view", onClick: () => host.adoptSubagent(entry.taskId, entry.project, entry.step) }],
        body: !loaded ? (
          reading()
        ) : (
          // The conversation lays itself out to the column; its doorways push further in.
          <View flex={1} minHeight={0} flexDirection="column">
            <SidechainConversation step={entry.step} detail={detail} source={host.source} onOpen={(node, call, nested) => openSubagent(host, entry.taskId, entry.project, node, call, nested)} />
          </View>
        ),
        scroll: false,
      };
    }

    case "rerun":
      return {
        title: "Re-run with changes",
        titleText: "Re-run with changes",
        sub: detail !== null ? `a new task from ${detail.workflow}, its inputs as this one had them` : undefined,
        body:
          detail === null ? (
            reading()
          ) : (
            <RerunForm
              run={{
                ...host.rerunSurface(detail),
                starts: rerunStartsOf(detail, host.turns),
                ...(host.onFork !== undefined
                  ? {
                      onFork: (seq: number) => {
                        host.onFork?.(detail.taskId, seq);
                        host.onStack((was) => ({ ...was, entries: was.entries.slice(0, 1), motion: "pop" }));
                      },
                    }
                  : {}),
              }}
              onCancel={() => host.onStack(pop)}
            />
          ),
      };
  }
}

/** The chat entry's glyph, as the Chat room's panel draws it: an icon, at the glyph's size. */
function ChatGlyph(): JSX.Element {
  return <Glyph name="comment" />;
}
