/**
 * Settings → Tools → Automations' host (`automationsPane.tsx`): the layers' copies it reads, what is
 * edited and not written yet, and the writes — as a hook and pure functions in a module of their own,
 * so the universal copy (decision 0015) holds and does exactly what the DOM pane does.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { EVENT_SPECS, isEventName, type ConfigLayer, type EventsStatusView, type JairaEventsConfig, type WorkflowLayer, type WorkflowSource, type WritableLayer } from "@jaira/shared/browser";
import {
  automationStateIdOf,
  automationsReadOf,
  automationsWritesOf,
  EVENTS_STATE_ID,
  linesProblem,
  rebaseLines,
  sharedStepsWritesOf,
  shownLinesOf,
  type AutomationLine,
  type AutomationWrite,
  type Copies,
  type LayerFiles,
  type ShownLine,
} from "./automationsModel";
import { connectionBadgeOf, JAIRA_BADGE, type ConnectionBadge } from "./eventsModel";
import type { RunField } from "./runForm";

export const INTO_NAME: Readonly<Record<WritableLayer, string>> = { base: "Shared", project: "this project" };

/** Everything the view is drawn from, and every write it asks for — `AutomationsView`'s props. */
export interface AutomationsViewProps {
  /** Which layer's file the section's own lines are. */
  reads: WritableLayer;
  /**
   * Where those lines come from: the layer's own copy, the built-in (Shared with no copy yet), or
   * nothing (a project with no copy — its own lines are none, and Shared's are all spliced in).
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
  /** The personal layer's first change is held: where does it go? */
  asking: readonly WritableLayer[] | null;
  /** The layer's name in the footer: the project's, or Shared. */
  layerName: string;
  /** The events task exists, so its conversation can be opened. */
  hasTask: boolean;
  onLines: (lines: AutomationLine[]) => void;
  /** A Shared line edited on a project page — `before` as Shared has it, `next` as it is now. */
  onSharedLine: (before: AutomationLine, next: AutomationLine) => void;
  /** Take a project's own copy of a Shared line's steps away: Shared's run here again. */
  onUseSharedSteps: (name: string) => void;
  onIgnore: (name: string, ignored: boolean) => void;
  onAnswer: (into: WritableLayer | null) => void;
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

/** A fresh line: `git.push`, one step to fill in. */
export function newLineOf(name: string): AutomationLine {
  return { name, event: "git.push", filter: {}, steps: [{ kind: "start", workflow: "", inputs: {} }] };
}

/** What the host asks main for: a state file of a layer — the events root, or an automation's state. */
export interface AutomationsChannel {
  read: (layer: WorkflowLayer, stateId: string) => Promise<WorkflowSource>;
  write: (layer: WritableLayer, stateId: string, text: string) => Promise<unknown>;
  remove: (layer: WritableLayer, stateId: string) => Promise<unknown>;
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
  /** A project is open — so there is a project layer to read and write. */
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
 * The state `AutomationsView` is drawn from, and the writes it asks for (`AutomationsPane`'s body) —
 * or, until the copies are read (or when they cannot be), what the section says instead.
 */
export function useAutomationsHost(props: AutomationsPaneProps): { props: AutomationsViewProps } | { waiting: string; warn: boolean } {
  const [copies, setCopies] = useState<Copies | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(NOTHING_PENDING);
  const [writing, setWriting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [told, setTold] = useState<string | null>(null);
  const [held, setHeld] = useState<{ before: AutomationLine[]; after: AutomationLine[] } | null>(null);
  const [sentTo, setSentTo] = useState<WritableLayer | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const { channel } = props;
  const load = useCallback(async (): Promise<void> => {
    const read = async (layer: WorkflowLayer, stateId: string): Promise<WorkflowSource | undefined> => {
      try {
        return await channel.read(layer, stateId);
      } catch {
        return undefined;
      }
    };
    const [project, base, system] = await Promise.all([props.hasProject ? read("project", EVENTS_STATE_ID) : Promise.resolve(undefined), read("base", EVENTS_STATE_ID), read("system", EVENTS_STATE_ID)]);
    const roots = { project: docOf(project), base: docOf(base), system: docOf(system) };
    // Every automation any of the roots names, read in both writable layers: a project's own copy of a
    // Shared line's state is how that line's steps change for the project alone.
    const names = [...new Set([...namesOf(roots.project), ...namesOf(roots.base), ...namesOf(roots.system)])];
    const statesOf = async (layer: WritableLayer): Promise<Record<string, unknown>> => {
      const found = await Promise.all(names.map(async (name) => [name, docOf(await read(layer, automationStateIdOf(name)))] as const));
      return Object.fromEntries(found.filter(([, doc]) => doc !== undefined));
    };
    const [projectStates, baseStates] = await Promise.all([props.hasProject ? statesOf("project") : Promise.resolve({}), statesOf("base")]);
    const layerOf = (root: unknown, states: Record<string, unknown>): LayerFiles => ({ ...(root !== undefined ? { root } : {}), states });
    setCopies({
      ...(props.hasProject ? { project: layerOf(roots.project, projectStates) } : {}),
      base: layerOf(roots.base, baseStates),
      ...(roots.system !== undefined ? { system: { root: roots.system } } : {}),
    });
  }, [channel, props.hasProject]);
  useEffect(() => {
    load().catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
  }, [load]);
  useEffect(() => {
    setPending(NOTHING_PENDING);
    setHeld(null);
    setTold(null);
    setProblem(null);
  }, [props.layer]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const writesTo: WritableLayer | undefined = props.layer === "you" ? (sentTo ?? undefined) : props.layer;
  const reads: WritableLayer = props.layer === "you" ? (props.hasProject ? "project" : "base") : props.layer;
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
  const shown = shownLinesOf({ ...readNow.own, lines }, readNow.shared === undefined ? undefined : sharedNow, readNow.stepsOf).map((one) =>
    // A Shared line edited here draws its steps as edited, wherever they are read from.
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

  /** What was made that was not there: "Wrote this project's copy of system/events/push_main." */
  const madeOf = (writes: readonly AutomationWrite[]): string | null => {
    const made = writes.filter((one) => !("remove" in one) && (one.stateId === EVENTS_STATE_ID ? copies[one.layer]?.root === undefined : copies[one.layer]?.states[one.stateId.slice(EVENTS_STATE_ID.length + 1)] === undefined));
    return made.length > 0 ? `Wrote ${made.map((one) => `${INTO_NAME[one.layer]}'s copy of ${one.stateId}`).join(" and ")}.` : null;
  };

  /** Everything pending, as the files it writes — Shared lines edited here folded in as the project's. */
  const writesOf = (into: WritableLayer, now: Pending, ignored?: string[]): AutomationWrite[] => {
    let own = now.own ?? (into === reads ? readNow.own.lines : automationsReadOf(copies, into).own.lines);
    const ignoring = [...(ignored ?? readNow.own.splice?.ignored ?? [])];
    const out: AutomationWrite[] = [];
    let rules = now.own !== undefined || ignored !== undefined;
    for (const { before, next } of Object.values(now.shared)) {
      const stepsOnly = before.name === next.name && before.event === next.event && JSON.stringify(before.filter) === JSON.stringify(next.filter);
      if (stepsOnly) {
        out.push(...sharedStepsWritesOf(copies, before.name, next.steps));
        continue;
      }
      // Its event, filter or name changed here: Shared's line is ignored in this project, and the
      // project gets a line of its own in its place.
      own = [...own.filter((line) => line.name !== next.name), next];
      if (!ignoring.includes(before.name)) ignoring.push(before.name);
      rules = true;
    }
    if (rules) {
      const before = automationsReadOf(copies, into).own.lines;
      out.push(...automationsWritesOf(copies, into, before, own, into === "project" ? ignoring : undefined));
    }
    return out;
  };

  const settle = (now: Pending): void => {
    setPending(now);
    setTold(null);
    clearTimeout(timer.current);
    const wrong = linesProblem([...(now.own ?? lines), ...Object.values(now.shared).map((edit) => edit.next)]);
    setProblem(wrong !== undefined ? `Not saved yet — ${wrong}` : null);
    if (wrong !== undefined) return;
    timer.current = setTimeout(() => {
      // Shared lines edited on a project page are that project's — whichever page layer it is.
      const sharedOnly = now.own === undefined;
      if (sharedOnly) {
        run(writesOf("project", now), madeOf);
        return;
      }
      if (writesTo !== undefined) {
        const onto = writesTo === reads ? now.own! : rebaseLines(readNow.own.lines, now.own!, automationsReadOf(copies, writesTo).own.lines);
        run(writesOf(writesTo, { ...now, own: onto }), madeOf);
      } else setHeld({ before: readNow.own.lines, after: now.own! });
    }, SETTLE_MS);
  };

  const ignore = (name: string, on: boolean): void => {
    const now = readNow.own.splice?.ignored ?? [];
    const ignored = on ? [...new Set([...now, name])] : now.filter((one) => one !== name);
    // Put back: Shared's line again — and the project's own line of that name, which stood in for it, goes.
    const own = on ? lines : lines.filter((line) => line.name !== name);
    run(writesOf("project", { own, shared: {} }, ignored), madeOf);
  };

  const fileLayer: WorkflowLayer = reads === "project" && copies.project?.root !== undefined ? "project" : copies.base?.root !== undefined ? "base" : "system";

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
      asking: held !== null ? (props.hasProject ? ["project", "base"] : ["base"]) : null,
      layerName: reads === "project" ? props.projectName : "Shared",
      hasTask: props.hasTask,
      onLines: (next) => settle({ ...pending, own: next }),
      onSharedLine: (before, next) => {
        const original = pending.shared[before.name]?.before ?? before;
        settle({ ...pending, shared: { ...pending.shared, [original.name]: { before: original, next } } });
      },
      onUseSharedSteps: (name) => run([{ layer: "project", stateId: automationStateIdOf(name), remove: true }], () => `This project runs Shared's steps for ${name} again.`),
      onIgnore: ignore,
      onAnswer: (into) => {
        if (held === null) return;
        const change = held;
        setHeld(null);
        if (into === null) {
          setPending(NOTHING_PENDING);
          setProblem(null);
          return;
        }
        setSentTo(into);
        const onto = into === reads ? change.after : rebaseLines(change.before, change.after, automationsReadOf(copies, into).own.lines);
        run(writesOf(into, { own: onto, shared: {} }), madeOf);
      },
      onOpenConversation: props.onOpenConversation,
      onEditFile: () => props.onEditFile(fileLayer),
      onOpenEvents: props.onOpenEvents,
      onOpenConnections: props.onOpenConnections,
    },
  };
}
