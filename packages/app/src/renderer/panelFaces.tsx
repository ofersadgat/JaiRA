/**
 * What each kind of panel entry SAYS — its face: name, verbs, tabs and body (the person's rulings,
 * 2026-09-24). The frame (`sidePanel.tsx`) draws the furniture; the stack (`panelStack.ts`) decides
 * what is on top; this is the one place that knows what a task, a state, a conversation's context or
 * a pushed card looks like in the column.
 *
 * Everything it needs from the shell comes through {@link PanelHost}, assembled once in `App.tsx`.
 * The views themselves are in `panelViews.tsx`.
 *
 * ## The entries, and their tabs
 *
 *  - **task** — Conversation · Steps · Changes · Outputs · Configuration. Its verbs are icons on the
 *    head's line: start/re-run, cancel, re-run with changes, and ⇤ — show the conversation in the
 *    main view, which hands the panel over to the conversation's context.
 *  - **convo** — beside a conversation that IS in the main view: Steps · Produced · Changes · Held.
 *    No conversation tab: the same conversation is never on screen twice.
 *  - **chat** — beside a plain chat: Produced · Changes · Held. A chat has no workflow, so no steps.
 *  - **state** — Run (the form over its history) · Checks · Configuration. Configuration is hidden
 *    while the Files editor has the same file open — the editor IS its configuration.
 *  - **newTask**, **config** (as it ran), **preview** (a value), **subagent** (a sub-conversation),
 *    **rerun** (a copy with changes) — pushed cards, with no tabs of their own.
 */
import type { JSX, ReactNode } from "react";
import type { InstanceNode, PendingInteraction, StateView, TaskDetail } from "@jaira/shared/browser";
import { Badge } from "./board";
import type { ComponentServices } from "./changesetReview";
import { GateSurface, type EditorServices } from "./components";
import { ConfigPanel, type ConfigPanelServices } from "./configPanel";
import type { FileSurfaceContext } from "./fileTypes";
import { Icon } from "./icons";
import { pop, push, selectStep, type PanelEntry, type PanelStack } from "./panelStack";
import {
  ChangesView,
  HeldView,
  OutputsView,
  PreviewCard,
  RerunForm,
  type RerunSurface,
  ProducedView,
  StateChecks,
  StepCard,
  StepsView,
  checksCountOf,
  useEffectiveRead,
} from "./panelViews";
import { RunPanel, type RunSurface } from "./runPanel";
import { RunConversation, SidechainConversation, askingInstanceOf, hasAsking } from "./runViews";
import { TAB_ICONS, type PanelFace, type PanelTabSpec, type PanelVerb } from "./sidePanel";
import { StatePanel } from "./statePanel";
import { stoppedAction } from "./taskAction";
import { TaskName } from "./taskName";
import { nodeAt, type TrailStep } from "./trail";
import type { ArtifactSurface } from "./transcriptView";
import type { PinnedValue } from "./valuePanel";

/** A gate a task's conversation hosts — the same four things `TaskContext` took. */
export interface HostedGate {
  pending: PendingInteraction;
  onGate: (value: unknown) => void;
  services?: Partial<ComponentServices> | undefined;
  editor?: EditorServices | undefined;
}

/** Everything a face needs from the shell. One bag, built once per render in `App.tsx`. */
export interface PanelHost {
  /** The SELECTED task's detail — the only one whose run the store has LOADED (sessions, records). */
  detail: TaskDetail | null;
  /**
   * Any task's detail: the selected one's, or a copy the shell fetched for a panel still showing a
   * task that is no longer selected (a pinned stack). Enough for Steps, Changes, Outputs and
   * Configuration; the Conversation needs the run loaded, which only selecting it does.
   */
  detailOf: (taskId: string) => TaskDetail | null;
  /** Its project. */
  project: string | undefined;
  /** The file surfaces' context: sessions, records, the live turn — what a conversation draws from. */
  context: FileSurfaceContext;
  onStack: (next: (stack: PanelStack) => PanelStack) => void;
  /** The gate the selected task is parked on, when its conversation is the place to answer it. */
  gate?: HostedGate | undefined;

  /* Tasks */
  select: (taskId: string, project?: string) => void;
  startAgain: (taskId: string) => void;
  cancel: (taskId: string) => void;
  reviewChanges: (taskId: string) => void;
  /** ⇤ — the task's conversation into the main view. */
  adoptTask: (taskId: string, project: string | undefined, workflow: string) => void;
  /** ⇥ — the conversation back out of the main view, into the panel. */
  giveBack?: (() => void) | undefined;
  /** ⇤ — a subagent's conversation into the main view. */
  adoptSubagent: (taskId: string, project: string | undefined, step: TrailStep) => void;
  /** Take the main view's conversation to a step. Absent ⇒ the main view is not the conversation. */
  goTo?: ((node: InstanceNode) => void) | undefined;
  /** The step being viewed in the main view's conversation, and what is on screen there. */
  viewed?: { current?: string | undefined; onScreen?: ReadonlySet<string> | undefined } | undefined;
  /** Where a re-run with changes starts: the task's workflow as a run form. */
  rerunSurface: (detail: TaskDetail) => RerunSurface;

  /* States */
  /** A state's view and run surface, when the store holds them. */
  stateOf: (stateId: string) => { view: StateView | null; run?: RunSurface | undefined } | undefined;
  /** Whether the Files editor has this state's file open. */
  inEditor: (stateId: string) => boolean;
  /** ⇤ — open a state in the Files view. */
  openInFiles: (stateId: string) => void;
  onRevealIssue?: ((path: string) => void) | undefined;
  config: { tree: FileSurfaceContext["tree"]; executors: FileSurfaceContext["executors"]; services: ConfigPanelServices; busy: boolean; wrapJson?: boolean | undefined; onWrapJson?: ((wrap: boolean) => void) | undefined };

  /* Values */
  held: readonly PinnedValue[];
  hold: (item: PinnedValue) => void;
  unhold: (item: PinnedValue) => void;
  serveOf: (taskId: string, project: string | undefined) => ArtifactSurface;

  /* The Steps box */
  stepsHeight: number;
  setStepsHeight: (height: number) => void;

  /** The New-task form, as a panel. */
  newTask: ReactNode;
}

/** A tab with its icon filled in from the shared table. */
const tab = (id: string, label: string, extra: Omit<PanelTabSpec, "id" | "label" | "icon"> = {}): PanelTabSpec => ({ id, label, icon: TAB_ICONS[id] ?? "note", ...extra });

/** What a task entry says when the store is holding a different task — the one case a pinned stack meets. */
function NotSelected({ host, taskId, project }: { host: PanelHost; taskId: string; project?: string | undefined }): JSX.Element {
  return (
    <div className="pv-empty-act">
      <p className="empty">Another task is selected, so this one&apos;s conversation is not loaded.</p>
      <button type="button" onClick={() => host.select(taskId, project)}>
        Load it
      </button>
    </div>
  );
}

/** The head's line for a task: its status, its name, and what identifies it. */
function taskHeadOf(detail: TaskDetail | null, taskId: string): Pick<PanelFace, "glyph" | "title" | "titleText" | "sub"> {
  if (detail === null) return { title: taskId, titleText: taskId, glyph: <Badge status="queued" /> };
  return {
    glyph: <Badge status={detail.status} />,
    title: <TaskName task={detail} />,
    titleText: detail.title,
    sub: (
      <>
        <span className="mono">{detail.taskId}</span> · {detail.workflow}
        {detail.branch !== undefined ? <> · ⎇ {detail.branch}</> : null}
      </>
    ),
  };
}

/** The verbs every task-shaped entry carries, as icons. */
function taskVerbsOf(host: PanelHost, detail: TaskDetail, project: string | undefined, adopt: boolean): PanelVerb[] {
  const action = stoppedAction(detail);
  const live = detail.status === "running" || detail.status === "queued" || detail.status === "stopping";
  const verbs: PanelVerb[] = [];
  if (!live) {
    verbs.push({ icon: "play", label: action?.verb ?? (detail.runs.length > 0 ? "Re-run" : "Start"), primary: true, onClick: () => host.startAgain(detail.taskId) });
  }
  if (live || detail.status === "interrupted") verbs.push({ icon: "stop", label: "Cancel", onClick: () => host.cancel(detail.taskId) });
  if (detail.runs.length > 0 && !live) {
    verbs.push({
      icon: "pencil",
      label: "Re-run with changes",
      onClick: () => host.onStack((was) => push(was, { kind: "rerun", key: `rerun:${detail.taskId}`, taskId: detail.taskId, ...(project !== undefined ? { project } : {}) })),
    });
  }
  if (adopt) verbs.push({ icon: "adopt", label: "Show the conversation in the main view", onClick: () => host.adoptTask(detail.taskId, project, detail.workflow) });
  return verbs;
}

/** A pinned value, pushed on top of whatever is there. */
function pushPreview(host: PanelHost, item: PinnedValue): void {
  host.onStack((was) => push(was, { kind: "preview", key: `preview:${item.title}`, preview: item }));
}

/** The Steps tab, for a task or a conversation's context. */
function stepsBody(host: PanelHost, detail: TaskDetail, entry: { step?: string; project?: string }, convo: boolean): ReactNode {
  const selected = entry.step === undefined ? undefined : nodeAt(detail.instances, entry.step);
  const asking = host.gate !== undefined && detail.instances.some((node) => hasAsking(node)) ? askingInstanceOf(detail.instances) : undefined;
  const indexCut =
    host.context.onRewind !== undefined && host.context.onFork !== undefined
      ? {
          rewind: (node: InstanceNode) => {
            const seq = host.context.conversation?.turns.find((turn) => turn.kind === "entered" && turn.instanceId === node.instanceId)?.seq;
            if (seq !== undefined) host.context.onRewind?.(detail.taskId, seq);
          },
          fork: (node: InstanceNode) => {
            const seq = host.context.conversation?.turns.find((turn) => turn.kind === "entered" && turn.instanceId === node.instanceId)?.seq;
            if (seq !== undefined) host.context.onFork?.(detail.taskId, seq);
          },
        }
      : undefined;
  return (
    <StepsView
      detail={detail}
      step={selected === undefined ? undefined : entry.step}
      onStep={(step) => host.onStack((was) => selectStep(was, step))}
      {...(convo && host.viewed?.current !== undefined ? { current: host.viewed.current } : {})}
      {...(convo && host.viewed?.onScreen !== undefined ? { onScreen: host.viewed.onScreen } : {})}
      convo={convo && host.goTo !== undefined}
      {...(asking !== undefined ? { asking } : {})}
      {...(convo && host.goTo !== undefined ? { onGoTo: host.goTo } : {})}
      {...(indexCut !== undefined ? { onCut: indexCut } : {})}
      boxHeight={host.stepsHeight}
      onBoxHeight={host.setStepsHeight}
      card={
        selected === undefined ? null : (
          <StepCard
            detail={detail}
            node={selected}
            project={entry.project ?? host.project}
            sessions={host.context.sessionHistory}
            onClose={() => host.onStack((was) => selectStep(was, undefined))}
            onOpen={(title, value) => pushPreview(host, { title, value })}
            onConfig={() =>
              host.onStack((was) =>
                push(was, {
                  kind: "config",
                  key: `config:${selected.instanceId}`,
                  stateId: selected.stateId,
                  taskId: detail.taskId,
                  instanceId: selected.instanceId,
                  ...(entry.project !== undefined ? { project: entry.project } : {}),
                }),
              )
            }
            {...(convo && host.goTo !== undefined ? { onGoTo: () => host.goTo?.(selected) } : {})}
          />
        )
      }
    />
  );
}

/**
 * A task's conversation, in the panel: the root's run with a subagent's doorway pushing a card, and
 * the gate this task is parked on drawn where its state asked it — or, when the tree has no place
 * for it yet, at the end, so a question never goes missing.
 */
function TaskConversation({ host, detail, project }: { host: PanelHost; detail: TaskDetail; project: string | undefined }): JSX.Element {
  const gate = host.gate;
  const hosted = gate !== undefined && detail.instances.some((node) => hasAsking(node));
  return (
    <div className="pv-convo">
      <RunConversation
        parent={detail.instances[0]}
        detail={detail}
        context={host.context}
        onOpenSidechain={(node, call, name) =>
          host.onStack((was) =>
            push(was, {
              kind: "subagent",
              key: `subagent:${node.instanceId}:${call}`,
              taskId: detail.taskId,
              ...(project !== undefined ? { project } : {}),
              step: { instanceId: node.instanceId, stateId: node.stateId, sidechain: call, name },
            }),
          )
        }
        {...(gate !== undefined
          ? {
              asking: true,
              gate: gate.pending,
              onGate: gate.onGate,
              ...(gate.services !== undefined ? { gateServices: gate.services } : {}),
              ...(gate.editor !== undefined ? { gateEditor: gate.editor } : {}),
            }
          : {})}
      />
      {gate !== undefined && !hosted ? (
        <section className="inline-gate" data-testid="inline-gate">
          <GateSurface pending={gate.pending} onSubmit={gate.onGate} services={gate.services} {...(gate.editor !== undefined ? { editor: gate.editor } : {})} />
        </section>
      ) : null}
    </div>
  );
}

/** The configuration a run resolved against — a card, and a tab. */
function ConfigCard({ host, stateId, taskId, instanceId, project }: { host: PanelHost; stateId: string; taskId?: string | undefined; instanceId?: string | undefined; project?: string | null | undefined }): JSX.Element {
  const read = useEffectiveRead(stateId, taskId, instanceId, project ?? host.project ?? null);
  return (
    <div className="pv-config">
      <div className="pv-actions">
        <button type="button" className="link" onClick={() => host.openInFiles(stateId)} title="Edit it in the Files view — a built-in is copied to Shared first">
          <Icon name="adopt" /> Open in the Files view
        </button>
      </div>
      <ConfigPanel read={read} tree={host.config.tree} executors={host.config.executors} services={host.config.services} onOpenState={host.openInFiles} />
    </div>
  );
}

/** A state's configuration, editable — its own copy of the file (`StatePanel`). */
function StateConfig({ host, stateId }: { host: PanelHost; stateId: string }): JSX.Element {
  const { readState, saveState } = host.context;
  if (readState === undefined) return <p className="empty">This state&apos;s file cannot be read here.</p>;
  return (
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
      ui={host.context.ui}
      readFile={host.config.services.readFile}
      onOpenState={host.openInFiles}
    />
  );
}

/** Badges for a task's tabs: a question waiting, a run going. */
function taskTabs(host: PanelHost, detail: TaskDetail | null, withConversation: boolean): PanelTabSpec[] {
  const waiting = host.gate !== undefined && detail !== null && (host.gate.pending.taskId === detail.taskId || host.gate.pending.about === detail.taskId);
  const live = detail?.status === "running";
  const steps = detail === null ? 0 : countSteps(detail.instances);
  return [
    ...(withConversation ? [tab("conversation", "Conversation", waiting ? { count: "!", tone: "amber" } : live ? { count: "•", tone: "accent" } : {})] : []),
    tab("steps", "Steps", steps > 0 ? { count: steps } : {}),
    tab("changes", "Changes", {}),
    tab("outputs", "Outputs", {}),
    ...(withConversation ? [tab("configuration", "Configuration")] : []),
  ];
}

function countSteps(nodes: readonly InstanceNode[]): number {
  return nodes.reduce((sum, node) => sum + (node.children.length === 0 ? 1 : countSteps(node.children)), 0);
}

/** The face of any entry. */
export function faceOf(host: PanelHost, entry: PanelEntry): PanelFace {
  const detail = "taskId" in entry && entry.taskId !== undefined ? host.detailOf(entry.taskId) : null;
  /** Whether that task's run is the one loaded — what a conversation drawn here reads from. */
  const loaded = detail !== null && host.detail?.taskId === detail.taskId;
  switch (entry.kind) {
    case "task": {
      const head = taskHeadOf(detail, entry.taskId);
      const project = entry.project ?? host.project;
      const body = (): ReactNode => {
        if (detail === null) return <p className="empty">Reading the task…</p>;
        switch (entry.tab) {
          case "conversation":
            return loaded ? <TaskConversation host={host} detail={detail} project={project} /> : <NotSelected host={host} taskId={entry.taskId} project={entry.project} />;
          case "steps":
            return stepsBody(host, detail, entry, false);
          case "changes":
            return <ChangesView taskId={detail.taskId} project={project} signal={detail.status} {...(detail.worktreePath !== undefined ? { onReview: () => host.reviewChanges(detail.taskId) } : {})} />;
          case "outputs":
            return <OutputsView detail={detail} sessions={host.context.sessionHistory} onOpen={(title, value) => pushPreview(host, { title, value })} />;
          case "configuration":
            return <ConfigCard host={host} stateId={detail.workflow} taskId={detail.taskId} project={project} />;
        }
      };
      return {
        ...head,
        verbs: detail === null ? [] : taskVerbsOf(host, detail, project, true),
        tabs: taskTabs(host, detail, true),
        tab: entry.tab,
        body: body(),
        scroll: detail === null || !((entry.tab === "conversation" && loaded) || entry.tab === "steps"),
      };
    }

    case "convo": {
      const head = taskHeadOf(detail, entry.taskId);
      const project = entry.project ?? host.project;
      const body = (): ReactNode => {
        if (detail === null) return <p className="empty">Reading the task…</p>;
        switch (entry.tab) {
          case "steps":
            return stepsBody(host, detail, entry, true);
          case "produced":
            return <ProducedView taskId={detail.taskId} project={project} signal={detail.timeline.length} artifacts={host.serveOf(detail.taskId, project)} onOpen={(item) => pushPreview(host, item)} onHold={host.hold} />;
          case "changes":
            return <ChangesView taskId={detail.taskId} project={project} signal={detail.status} {...(detail.worktreePath !== undefined ? { onReview: () => host.reviewChanges(detail.taskId) } : {})} />;
          case "held":
            return <HeldView held={host.held} onOpen={(item) => pushPreview(host, item)} onDrop={host.unhold} />;
        }
      };
      return {
        ...head,
        verbs: [
          ...(detail === null ? [] : taskVerbsOf(host, detail, project, false)),
          ...(host.giveBack !== undefined ? [{ icon: "back" as const, label: "Give the conversation back to the panel", onClick: host.giveBack }] : []),
        ],
        tabs: [tab("steps", "Steps", detail !== null ? { count: countSteps(detail.instances) } : {}), tab("produced", "Produced"), tab("changes", "Changes"), tab("held", "Held", host.held.length > 0 ? { count: host.held.length } : {})],
        tab: entry.tab,
        body: body(),
        scroll: entry.tab !== "steps" || detail === null,
      };
    }

    case "chat": {
      const project = entry.project ?? host.project;
      const title = detail?.title ?? "This conversation";
      return {
        glyph: <Icon name="comment" />,
        title,
        titleText: title,
        sub: "beside the conversation",
        tabs: [tab("produced", "Produced"), tab("changes", "Changes"), tab("held", "Held", host.held.length > 0 ? { count: host.held.length } : {})],
        tab: entry.tab,
        body:
          entry.tab === "produced" ? (
            <ProducedView taskId={entry.taskId} project={project} signal={detail?.timeline.length ?? 0} artifacts={host.serveOf(entry.taskId, project)} onOpen={(item) => pushPreview(host, item)} onHold={host.hold} />
          ) : entry.tab === "changes" ? (
            <ChangesView taskId={entry.taskId} project={project} signal={detail?.status} />
          ) : (
            <HeldView held={host.held} onOpen={(item) => pushPreview(host, item)} onDrop={host.unhold} />
          ),
      };
    }

    case "state": {
      const found = host.stateOf(entry.stateId);
      const view = found?.view ?? null;
      const editing = host.inEditor(entry.stateId);
      const name = entry.stateId.split("/").pop() ?? entry.stateId;
      const tabs = [tab("run", "Run"), tab("checks", "Checks", checksCountOf(view)), ...(editing ? [] : [tab("configuration", "Configuration")])];
      const open = editing && entry.tab === "configuration" ? "run" : entry.tab;
      const body = (): ReactNode => {
        if (found === undefined || view === null) return <p className="empty">Reading {name}…</p>;
        switch (open) {
          case "run":
            return found.run !== undefined ? <RunPanel state={view} run={found.run} /> : <p className="empty">Nothing here can start a run of this state.</p>;
          case "checks":
            return (
              <StateChecks
                state={view}
                onRevealIssue={editing ? host.onRevealIssue : undefined}
                onOpenConfig={() => host.onStack((was) => push(was, { kind: "config", key: `config:${entry.stateId}`, stateId: entry.stateId, project: entry.project }))}
                onOpenState={host.openInFiles}
              />
            );
          case "configuration":
            return <StateConfig host={host} stateId={entry.stateId} />;
        }
      };
      return {
        glyph: <Icon name="workflow" />,
        title: <span className="mono">{name}</span>,
        titleText: entry.stateId,
        sub: <span className="mono">{entry.stateId}</span>,
        verbs: editing ? [] : [{ icon: "adopt", label: "Open in the Files view", onClick: () => host.openInFiles(entry.stateId) }],
        tabs,
        tab: open,
        body: body(),
      };
    }

    case "newTask":
      return { glyph: <Icon name="play" />, title: "New task", titleText: "New task", body: host.newTask };

    case "config": {
      const name = entry.stateId.split("/").pop() ?? entry.stateId;
      return {
        title: <span className="mono">{name}</span>,
        titleText: `${name} · configuration`,
        sub: entry.instanceId !== undefined ? <span className="mono">{entry.instanceId}</span> : undefined,
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
        body:
          !loaded ? (
            <NotSelected host={host} taskId={entry.taskId} project={entry.project} />
          ) : (
            <div className="pv-convo">
              <SidechainConversation
                step={entry.step}
                context={host.context}
                onOpen={(node, call, nested) =>
                  host.onStack((was) =>
                    push(was, {
                      kind: "subagent",
                      key: `subagent:${node.instanceId}:${call}`,
                      taskId: entry.taskId,
                      ...(entry.project !== undefined ? { project: entry.project } : {}),
                      step: { instanceId: node.instanceId, stateId: node.stateId, sidechain: call, name: nested },
                    }),
                  )
                }
              />
            </div>
          ),
        scroll: false,
      };
    }

    case "rerun": {
      const run = detail === null ? undefined : host.rerunSurface(detail);
      return {
        title: "Re-run with changes",
        titleText: "Re-run with changes",
        sub: detail !== null ? <>a new task from {detail.workflow}, its inputs as this one had them</> : undefined,
        body:
          detail === null ? (
            <NotSelected host={host} taskId={entry.taskId} project={entry.project} />
          ) : (
            <RerunForm run={run!} onCancel={() => host.onStack(pop)} />
          ),
      };
    }
  }
}
