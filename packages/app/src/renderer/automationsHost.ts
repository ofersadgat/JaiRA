/**
 * Settings → Tools → Automations' host (`AutomationsSection.tsx`): the layers' copies it reads, what is
 * edited and not written yet, and the writes — as a hook and pure functions. Every one of the settings'
 * six layers holds automations (decision 0023, amended 2026-11-18), so a page writes its own layer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AUTOMATION_LAYERS,
  EVENT_SPECS,
  isEventName,
  type ConfigLayer,
  type EventsStatusView,
  type JairaEventsConfig,
  type SetLayer,
  type WorkflowLayer,
  type WorkflowSource,
  type WritableSetLayer,
} from "@jaira/shared/browser";
import {
  automationStateIdOf,
  automationsReadOf,
  automationsWritesOf,
  EVENTS_STATE_ID,
  linesProblem,
  sharedStepsWritesOf,
  shownLinesOf,
  type AutomationLine,
  type AutomationWrite,
  type Copies,
  type LayerFiles,
  type LineLayer,
  type ShownLine,
} from "./automationsModel";
import { connectionBadgeOf, JAIRA_BADGE, type ConnectionBadge } from "./eventsModel";
import type { RunField } from "./runForm";

/** A layer as "Wrote ___'s copy of …" names it. */
export const INTO_NAME: Readonly<Record<WritableSetLayer, string>> = {
  base: "Shared",
  project: "this project",
  machine: "this machine",
  projectMachine: "this project on this machine",
  you: "Just you",
  projectYou: "you in this project",
};

/** A layer as a heading over its lines names it, and where its files are. */
export const LAYER_HEADING: Readonly<Record<LineLayer, { name: string; dir: string }>> = {
  system: { name: "Built in", dir: "as JaiRA ships it" },
  base: { name: "Shared", dir: "~/.jaira" },
  project: { name: "This project", dir: ".jaira" },
  machine: { name: "This machine", dir: "~/.jaira/machine" },
  projectMachine: { name: "This project on this machine", dir: ".jaira/local" },
  you: { name: "Just you", dir: "~/.jaira/personal" },
  projectYou: { name: "You in this project", dir: "~/.jaira/projects" },
};

/** "here", on a layer's page: `in this project`, `for just you`. */
export const LAYER_HERE: Readonly<Record<WritableSetLayer, string>> = {
  base: "in Shared",
  project: "in this project",
  machine: "on this machine",
  projectMachine: "in this project on this machine",
  you: "for just you",
  projectYou: "for you in this project",
};

/** The layers a page reads: the six with a project open, else the three that are no project's. */
export const automationLayersOf = (hasProject: boolean): WritableSetLayer[] =>
  AUTOMATION_LAYERS.filter((layer) => hasProject || (layer !== "project" && layer !== "projectMachine" && layer !== "projectYou"));

/** Everything the view is drawn from, and every write it asks for — `AutomationsView`'s props. */
export interface AutomationsViewProps {
  /** Which layer's file the section's own lines are. */
  reads: WritableSetLayer;
  /**
   * Where those lines come from: the layer's own copy, the built-in (Shared with no copy yet), or
   * nothing (a layer above Shared with no copy — its own lines are none, and the ones under it are all
   * spliced in).
   */
  source: "copy" | "built in" | "none";
  shown: readonly ShownLine[];
  /** The `events` block in effect — which events are switched on. */
  events: JairaEventsConfig;
  status: EventsStatusView | null;
  /** The workflows a step can start. */
  workflows: ReadonlyArray<{ id: string; label?: string | undefined }>;
  /** Each workflow's declared inputs, once read — absent: not read yet; null: unreadable. */
  forms: Readonly<Record<string, RunField[] | null>>;
  locked: boolean;
  /** Why what is on screen is not written yet, or why a write was refused. */
  problem: string | null;
  told: string | null;
  /** Where the events task runs: the project's name, or Shared. */
  layerName: string;
  /** The events task exists, so its conversation can be opened. */
  hasTask: boolean;
  onLines: (lines: AutomationLine[]) => void;
  /** A line from under this layer edited on its page — `before` as that layer has it, `next` as it is now. */
  onSharedLine: (before: AutomationLine, next: AutomationLine) => void;
  /** Take this layer's own copy of a line's steps away: the steps from under it run here again. */
  onUseSharedSteps: (name: string) => void;
  onIgnore: (name: string, ignored: boolean) => void;
  onOpenConversation: () => void;
  onEditFile: () => void;
  onOpenEvents: () => void;
  onOpenConnections?: () => void;
}

/** The connection a line's event comes through: the remote its filter names, else the first. */
export function badgeFor(line: AutomationLine, status: EventsStatusView | null): ConnectionBadge | undefined {
  if (!isEventName(line.event)) return undefined;
  if (EVENT_SPECS[line.event].group === "task") return JAIRA_BADGE;
  const remotes = status?.remotes ?? [];
  const named = typeof line.filter.remote === "string" ? remotes.find((remote) => remote.name === line.filter.remote) : undefined;
  const remote = named ?? remotes[0];
  return remote === undefined ? undefined : connectionBadgeOf(remote);
}

/** A fresh line: `git.pushed`, one step to fill in. */
export function newLineOf(name: string): AutomationLine {
  return { name, event: "git.pushed", filter: {}, steps: [{ kind: "start", workflow: "", inputs: {} }] };
}

/** What the host asks main for: a file of a layer — the events root, or an automation's state (`automations:*`). */
export interface AutomationsChannel {
  read: (layer: SetLayer, stateId: string) => Promise<WorkflowSource>;
  write: (layer: WritableSetLayer, stateId: string, text: string) => Promise<unknown>;
  remove: (layer: WritableSetLayer, stateId: string) => Promise<unknown>;
}

const docOf = (source: WorkflowSource | undefined): unknown => {
  if (source === undefined || !source.exists || source.text.trim().length === 0) return undefined;
  return JSON.parse(source.text) as unknown;
};

/** Every name a root's lines and children use — the automations whose states are read beside it. */
function namesOf(root: unknown): string[] {
  if (root === null || typeof root !== "object" || Array.isArray(root)) return [];
  const doc = root as Record<string, unknown>;
  const children = doc["children"] !== null && typeof doc["children"] === "object" && !Array.isArray(doc["children"]) ? Object.keys(doc["children"] as object) : [];
  const rules = Array.isArray(doc["transitions"]) ? doc["transitions"].flatMap((rule) => (rule !== null && typeof rule === "object" && typeof (rule as { name?: unknown }).name === "string" ? [(rule as { name: string }).name] : [])) : [];
  return [...new Set([...children, ...rules])].filter((name) => name !== "$ref" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

export interface AutomationsPaneProps {
  channel: AutomationsChannel;
  /** The page's layer. */
  layer: ConfigLayer;
  /** A project is open — so there are the project's three layers to read and write. */
  hasProject: boolean;
  busy: boolean;
  events: JairaEventsConfig;
  status: EventsStatusView | null;
  workflows: ReadonlyArray<{ id: string; label?: string | undefined }>;
  forms: Readonly<Record<string, RunField[] | null>>;
  onWorkflow: (id: string) => void;
  projectName: string;
  /** The events task of the layer read, when there is one. */
  hasTask: boolean;
  onOpenConversation: () => void;
  /** Open a layer's events workflow as a workflow file. */
  onEditFile: (layer: WorkflowLayer) => void;
  onOpenEvents: () => void;
  onOpenConnections: () => void;
}

/** How long an edit rests before it is written — a name or a value is typed a letter at a time. */
const SETTLE_MS = 600;

/** What is edited and not yet written: the layer's own lines, and Shared lines edited on a project page. */
interface Pending {
  own?: AutomationLine[];
  /** By Shared's name for the line, the line as it is now. */
  shared: Record<string, { before: AutomationLine; next: AutomationLine }>;
}

const NOTHING_PENDING: Pending = { shared: {} };

/**
 * The state `AutomationsView` is drawn from, and the writes it asks for (`AutomationsSection`'s body) —
 * or, until the copies are read (or when they cannot be), what the section says instead.
 */
export function useAutomationsHost(props: AutomationsPaneProps): { props: AutomationsViewProps } | { waiting: string; warn: boolean } {
  const [copies, setCopies] = useState<Copies | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(NOTHING_PENDING);
  const [writing, setWriting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [told, setTold] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const { channel } = props;
  const load = useCallback(async (): Promise<void> => {
    const read = async (layer: SetLayer, stateId: string): Promise<WorkflowSource | undefined> => {
      try {
        return await channel.read(layer, stateId);
      } catch {
        return undefined;
      }
    };
    const layers = automationLayersOf(props.hasProject);
    const [system, ...held] = await Promise.all([read("system", EVENTS_STATE_ID), ...layers.map((layer) => read(layer, EVENTS_STATE_ID))]);
    const roots = layers.map((layer, i) => [layer, docOf(held[i])] as const);
    // Every automation any of the roots names, read in every layer: a layer's own copy of a line's state
    // from under it is how that line's steps change for that layer alone.
    const names = [...new Set([...roots.flatMap(([, root]) => namesOf(root)), ...namesOf(docOf(system))])];
    const statesOf = async (layer: WritableSetLayer): Promise<Record<string, unknown>> => {
      const found = await Promise.all(names.map(async (name) => [name, docOf(await read(layer, automationStateIdOf(name)))] as const));
      return Object.fromEntries(found.filter(([, doc]) => doc !== undefined));
    };
    const states = await Promise.all(layers.map((layer) => statesOf(layer)));
    const next: Copies = {};
    roots.forEach(([layer, root], i) => {
      const files: LayerFiles = { ...(root !== undefined ? { root } : {}), states: states[i]! };
      next[layer] = files;
    });
    const systemRoot = docOf(system);
    if (systemRoot !== undefined) next.system = { root: systemRoot };
    setCopies(next);
  }, [channel, props.hasProject]);
  useEffect(() => {
    load().catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
  }, [load]);
  useEffect(() => {
    setPending(NOTHING_PENDING);
    setTold(null);
    setProblem(null);
  }, [props.layer]);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Every layer holds files: a page reads and writes its own. A project's layer with no project open is
  // not there to write, so the page reads Shared's.
  const reads: WritableSetLayer = props.hasProject || !(["project", "projectMachine", "projectYou"] as const).includes(props.layer as "project") ? props.layer : "base";
  let read: ReturnType<typeof automationsReadOf> | undefined;
  let unreadable: string | undefined;
  try {
    if (copies !== null) read = automationsReadOf(copies, reads);
  } catch (e) {
    unreadable = (e as Error).message;
  }
  const lines = pending.own ?? read?.own.lines ?? [];
  const sharedNow = (read?.shared ?? []).map((line) => pending.shared[line.name]?.next ?? line);

  // Every workflow a step names has its inputs read, once.
  const named = [...new Set([...lines, ...sharedNow].flatMap((line) => line.steps.flatMap((step) => (step.kind === "start" && step.workflow.length > 0 ? [step.workflow] : []))))];
  useEffect(() => {
    for (const id of named) if (props.forms[id] === undefined && props.workflows.some((w) => w.id === id)) props.onWorkflow(id);
  });

  if (copies === null || read === undefined) {
    return {
      waiting: unreadable !== undefined ? `The events workflow does not parse — ${unreadable}. Fix it in the Files view.` : failed !== null ? `The events workflow could not be read — ${failed}` : "Reading the events workflow…",
      warn: unreadable !== undefined,
    };
  }
  const readNow = read;
  const shown = shownLinesOf({ ...readNow.own, lines }, readNow.shared === undefined ? undefined : sharedNow, readNow.stepsOf, readNow.sharedFrom).map((one) =>
    // A line from under this layer edited here draws its steps as edited, wherever they are read from.
    one.from === "shared" && pending.shared[one.line.name] !== undefined ? { ...one, line: pending.shared[one.line.name]!.next } : one,
  );

  const run = (writes: readonly AutomationWrite[], wrote: (writes: readonly AutomationWrite[]) => string | null): void => {
    setWriting(true);
    setProblem(null);
    void (async () => {
      for (const one of writes) {
        if ("remove" in one) await props.channel.remove(one.layer, one.stateId);
        else await props.channel.write(one.layer, one.stateId, one.text);
      }
    })()
      .then(
        () => {
          setPending(NOTHING_PENDING);
          setTold(wrote(writes));
        },
        (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
      )
      .then(load)
      .finally(() => setWriting(false));
  };

  /** What was made that was not there: "Wrote Just you's copy of system/events/push_main." */
  const madeOf = (writes: readonly AutomationWrite[]): string | null => {
    const made = writes.filter((one) => !("remove" in one) && (one.stateId === EVENTS_STATE_ID ? copies[one.layer]?.root === undefined : copies[one.layer]?.states[one.stateId.slice(EVENTS_STATE_ID.length + 1)] === undefined));
    return made.length > 0 ? `Wrote ${made.map((one) => `${INTO_NAME[one.layer]}'s copy of ${one.stateId}`).join(" and ")}.` : null;
  };

  /** Everything pending, as the files it writes — lines from under this layer edited here folded in as its own. */
  const writesOf = (now: Pending, ignored?: string[]): AutomationWrite[] => {
    let own = now.own ?? readNow.own.lines;
    const ignoring = [...(ignored ?? readNow.own.splice?.ignored ?? [])];
    const out: AutomationWrite[] = [];
    let rules = now.own !== undefined || ignored !== undefined;
    for (const { before, next } of Object.values(now.shared)) {
      const stepsOnly = before.name === next.name && before.event === next.event && JSON.stringify(before.filter) === JSON.stringify(next.filter);
      if (stepsOnly) {
        out.push(...sharedStepsWritesOf(copies, before.name, next.steps, reads));
        continue;
      }
      // Its event, filter or name changed here: the line from under is ignored on this layer, and this
      // layer gets a line of its own in its place.
      own = [...own.filter((line) => line.name !== next.name), next];
      if (!ignoring.includes(before.name)) ignoring.push(before.name);
      rules = true;
    }
    if (rules) out.push(...automationsWritesOf(copies, reads, readNow.own.lines, own, reads !== "base" ? ignoring : undefined));
    return out;
  };

  const settle = (now: Pending): void => {
    setPending(now);
    setTold(null);
    clearTimeout(timer.current);
    const wrong = linesProblem([...(now.own ?? lines), ...Object.values(now.shared).map((edit) => edit.next)]);
    setProblem(wrong !== undefined ? `Not saved yet — ${wrong}` : null);
    if (wrong !== undefined) return;
    timer.current = setTimeout(() => run(writesOf(now), madeOf), SETTLE_MS);
  };

  const ignore = (name: string, on: boolean): void => {
    const now = readNow.own.splice?.ignored ?? [];
    const ignored = on ? [...new Set([...now, name])] : now.filter((one) => one !== name);
    // Put back: the line from under again — and this layer's own line of that name, which stood in for it, goes.
    const own = on ? lines : lines.filter((line) => line.name !== name);
    run(writesOf({ own, shared: {} }, ignored), madeOf);
  };

  // The copy the page reads: its own, else the nearest one under it, else what ships.
  const fileLayer: WritableSetLayer | "system" = [...AUTOMATION_LAYERS.slice(0, AUTOMATION_LAYERS.indexOf(reads) + 1)].reverse().find((layer) => copies[layer]?.root !== undefined) ?? "system";

  return {
    props: {
      reads,
      source: readNow.source,
      shown,
      events: props.events,
      status: props.status,
      workflows: props.workflows,
      forms: props.forms,
      locked: props.busy || writing,
      problem,
      told,
      layerName: props.hasProject ? props.projectName : "Shared",
      hasTask: props.hasTask,
      onLines: (next) => settle({ ...pending, own: next }),
      onSharedLine: (before, next) => {
        const original = pending.shared[before.name]?.before ?? before;
        settle({ ...pending, shared: { ...pending.shared, [original.name]: { before: original, next } } });
      },
      onUseSharedSteps: (name) => run([{ layer: reads, stateId: automationStateIdOf(name), remove: true }], () => `${INTO_NAME[reads].replace(/^./, (c) => c.toUpperCase())} runs the steps from under it for ${name} again.`),
      onIgnore: ignore,
      onOpenConversation: props.onOpenConversation,
      onEditFile: () => props.onEditFile(fileLayer),
      onOpenEvents: props.onOpenEvents,
      onOpenConnections: props.onOpenConnections,
    },
  };
}
