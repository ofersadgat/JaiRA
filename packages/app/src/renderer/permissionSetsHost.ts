/**
 * Settings → Tools → Permission sets' host (`permissionSetsPane.tsx`): the state the view is drawn from,
 * the writes it asks main for, and what the rail lists — as a hook and pure functions in a module of
 * their own, so the universal copy (decision 0015) holds and does exactly what the DOM pane does.
 */
import { useCallback, useEffect, useState } from "react";
import {
  copiedFrom,
  declOfPermissionSet,
  overridesOf,
  parsePermissionSet,
  permissionSetBucketProblem,
  permissionSetFileLabel,
  permissionSetNameProblem,
  permissionSetOfAt,
  permissionSetRailOf,
  permissionSetRailSummary,
  permissionSetStanding,
  permissionSetsAt,
  rebasePermissionSetChange,
  resolvePermissionSetChoice,
  PERMISSION_SET_LAYER_LABELS,
  type ConfigLayer,
  type McpServerStatus,
  type PermissionSet,
  type PermissionSetAt,
  type PermissionSetDecl,
  type PermissionSetDrafts,
  type PermissionSetsView as PermissionSetsData,
  type WorkflowLayer,
  type WritableLayer,
} from "@jaira/shared/browser";

/** What the rail has chosen: a permission set, the `+ permission set` of one bucket, or `+ bucket`. */
export type PermissionSetChoiceOf = { permissionSet: string } | { newIn: string } | "bucket";

export const permissionSetTab = (id: string): string => `permissionSet:${id}`;
export const newTab = (bucket: string): string => `new:${bucket}`;
export const BUCKET_TAB = "+bucket";

export function choiceOfTab(id: string): PermissionSetChoiceOf {
  if (id === BUCKET_TAB) return "bucket";
  return id.startsWith("new:") ? { newIn: id.slice("new:".length) } : { permissionSet: id.slice("permissionSet:".length) };
}

export function tabOfChoice(choice: PermissionSetChoiceOf | undefined): string | undefined {
  if (choice === undefined) return undefined;
  if (choice === "bucket") return BUCKET_TAB;
  return "newIn" in choice ? newTab(choice.newIn) : permissionSetTab(choice.permissionSet);
}

/**
 * What the pane reads, and where a change lands, for the layer the page's switch is on.
 *
 * A layer that holds files reads its own and writes its own. Any other — the personal layer, one
 * settings file with no `permission-sets/` beside it — reads as the nearest layer that does (this
 * project when one is open, else Shared), and has nowhere to write until the person says which.
 */
export function permissionSetLayersOf(layer: ConfigLayer, layers: readonly WorkflowLayer[]): { reads: WritableLayer; writesTo: WritableLayer | undefined } {
  if (layer === "project" || layer === "base") return { reads: layer, writesTo: layer };
  return { reads: layers.includes("project") ? "project" : "base", writesTo: undefined };
}

/**
 * Which buckets of the rail are open, and how to open or close one — an accordion (the person's
 * note, 2026-09-25). The host opens the bucket a set is chosen in; the rest is the person's clicks.
 */
export interface RailFolds {
  open: ReadonlySet<string>;
  onFold: (bucket: string) => void;
}

/** One row of the permission-set rail, before it is drawn. */
export type PermissionSetRailRow =
  | { kind: "bucket"; id: string; path: string; name: string; layerLabel: string; depth: number; fold?: { open: boolean; onFold: () => void } }
  | { kind: "set"; id: string; name: string; depth: number; dot: boolean; copy: string | undefined; summary: string }
  | { kind: "add"; id: string; depth?: number; summary: string; title: string };

/**
 * The rail, as rows. With nowhere to write there are no `+` rows and no dots: the dot means "the layer
 * you are editing states it", and that layer states nothing. With `folds`, each bucket is a fold; a
 * closed one lists nothing under it, a bucket inside it included.
 */
export function permissionSetRailRows(ats: readonly PermissionSetAt[], writesTo: WritableLayer | undefined, drafts: PermissionSetDrafts, folds?: RailFolds): PermissionSetRailRow[] {
  const writable = writesTo !== undefined;
  const rows: PermissionSetRailRow[] = [];
  const isOpen = (path: string): boolean => folds === undefined || folds.open.has(path);
  const closed: string[] = [];
  for (const { bucket, permissionSets } of permissionSetRailOf(ats)) {
    if (closed.some((path) => bucket.path.startsWith(`${path}/`))) continue;
    const open = isOpen(bucket.path);
    if (!open) closed.push(bucket.path);
    rows.push({
      kind: "bucket",
      id: `bucket:${bucket.path}`,
      path: bucket.path,
      name: bucket.name,
      layerLabel: PERMISSION_SET_LAYER_LABELS[bucket.layer],
      depth: bucket.depth,
      ...(folds !== undefined ? { fold: { open, onFold: () => folds.onFold(bucket.path) } } : {}),
    });
    if (!open) continue;
    for (const at of permissionSets) {
      // A copy says so beside its name, in the words its head's pill uses — the bucket's own pill
      // names the layer that DEFINES the bucket, which for a copy of what ships is still built in.
      rows.push({
        kind: "set",
        id: permissionSetTab(at.id),
        name: at.name,
        depth: bucket.depth,
        // The dot means "the layer you are EDITING states it".
        dot: at.here && writable,
        copy: copiedFrom(at) !== undefined ? permissionSetStanding(at).label : undefined,
        summary: permissionSetRailSummary(at, drafts[at.id]),
      });
    }
    if (writable) rows.push({ kind: "add", id: newTab(bucket.path), depth: bucket.depth, summary: "+ permission set", title: `add a permission set to ${bucket.path}` });
  }
  if (writable) rows.push({ kind: "add", id: BUCKET_TAB, summary: "+ bucket", title: "add a bucket — a place with its own versions of the same names" });
  return rows;
}

/**
 * What saving this draft will do to the file, where that is worth saying BEFORE the save: a line the
 * followed permission set holds was taken out, which `$ref` plus siblings cannot say, so the file is written
 * whole and stops following. Names the lines, or is empty.
 */
export function detachingLines(at: PermissionSetAt, draft: PermissionSet | undefined): string[] {
  if (draft === undefined || !at.here || at.source.follows === undefined || at.lower?.decl === undefined) return [];
  return overridesOf(at.lower.decl, declOfPermissionSet(draft)).dropped;
}

/** Why a name cannot be used for a new permission set in a bucket, or `undefined` when it can. */
export function newPermissionSetProblem(ats: readonly PermissionSetAt[], bucket: string, name: string): string | undefined {
  const problem = permissionSetBucketProblem(bucket.trim()) ?? permissionSetNameProblem(name.trim());
  if (problem !== undefined) return problem;
  const taken = ats.find((at) => at.id === `${bucket.trim()}/${name.trim()}`);
  if (taken === undefined) return undefined;
  return taken.here ? `there is already a permission set called '${taken.id}'` : `'${taken.id}' is inherited here — open it, and your first change copies it here`;
}

/** The map a new permission set starts as: nothing offered, and everything else asked about. */
export const NEW_PERMISSION_SET: PermissionSetDecl = { other: "ask" };

export const LOWER_NAME: Readonly<Record<WorkflowLayer, string>> = { system: "what ships", base: "the shared one", project: "this project's" };
/** A layer a copy can be written into, as "Copy to …" and "copied to …" name it. */
export const INTO_NAME: Readonly<Record<WritableLayer, string>> = { base: "Shared", project: "this project" };
/** The personal layer, as the page's switch names it. */
export const PERSONAL = "Just you";

/** The three calls the pane makes — the host's, so the view has no channel of its own. */
export interface PermissionSetsChannel {
  read: () => Promise<PermissionSetsData>;
  write: (request: { id: string; layer: WritableLayer; permissionSet: PermissionSetDecl }) => Promise<unknown>;
  reset: (request: { id: string; layer: WritableLayer }) => Promise<unknown>;
}

/** Everything the view is drawn from, and every write it asks for — `PermissionSetsView`'s props. */
export interface PermissionSetsViewProps {
  data: PermissionSetsData;
  layer: WritableLayer;
  writesTo: WritableLayer | undefined;
  choice: PermissionSetChoiceOf | undefined;
  onChoice: (next: PermissionSetChoiceOf) => void;
  drafts: PermissionSetDrafts;
  onDraft: (id: string, next: PermissionSet | undefined) => void;
  comparing: boolean;
  onCompare: (open: boolean) => void;
  naming: { bucket?: string; name?: string };
  onNaming: (next: { bucket?: string; name?: string }) => void;
  locked: boolean;
  problem: string | null;
  onSave: (id: string, permissionSet: PermissionSet) => void;
  onReset: (id: string) => void;
  onCopy: (id: string, next: PermissionSet) => void;
  asking?: string | undefined;
  onCopyTo: (into: WritableLayer | null) => void;
  puttingBack: boolean;
  onPutBack: (open: boolean) => void;
  told: string | null;
  onAdd: (bucket: string, name: string) => void;
  folds?: ReadonlySet<string> | undefined;
  startAdding?: string | undefined;
  startMode?: { subject: string; open: "menu" | "function" } | undefined;
  mcp?: readonly McpServerStatus[] | undefined;
  openBuckets?: ReadonlySet<string> | undefined;
  onBucket?: ((bucket: string) => void) | undefined;
}

/** A change made on the personal layer, held while the person says which layer it goes to. */
interface HeldChange {
  id: string;
  /** The map as the card showed it, and as the change left it — what {@link rebasePermissionSetChange} replays. */
  from: PermissionSetDecl;
  to: PermissionSetDecl;
}

/**
 * The state the view is drawn from, and the writes it asks for (`PermissionSetsPane`'s body).
 *
 * Drafts are kept PER LAYER AND PERMISSION_SET, so that looking at another permission set loses
 * nothing. The selection is an id, not an index, which is the whole of "the selection survives a
 * save" — and a first change's copy: the records are re-read, the host does not remount, and the id
 * still resolves, now to the layer's own file. Until the first read, what the page says instead.
 */
export function usePermissionSetsHost({
  channel,
  layer,
  busy,
  focus,
  onData,
  mcp,
}: {
  channel: PermissionSetsChannel;
  layer: ConfigLayer;
  busy: boolean;
  focus?: { id: string; nonce: number } | undefined;
  onData?: ((data: PermissionSetsData) => void) | undefined;
  mcp?: readonly McpServerStatus[] | undefined;
}): { props: PermissionSetsViewProps } | { waiting: string } {
  const [data, setData] = useState<PermissionSetsData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [wanted, setWanted] = useState<PermissionSetChoiceOf | undefined>(undefined);
  const [pending, setPending] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, PermissionSetDrafts>>>({});
  const [comparing, setComparing] = useState(false);
  const [naming, setNaming] = useState<{ bucket?: string; name?: string }>({});
  const [writing, setWriting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [puttingBack, setPuttingBack] = useState(false);
  const [held, setHeld] = useState<HeldChange | null>(null);
  const [told, setTold] = useState<string | null>(null);
  /**
   * Where each set's personal-layer changes went, once asked: the next change to it goes there too
   * without asking again, for as long as the page is open.
   */
  const [sentTo, setSentTo] = useState<Readonly<Record<string, WritableLayer>>>({});
  /** The rail's open buckets — see {@link RailFolds}. */
  const [openBuckets, setOpenBuckets] = useState<ReadonlySet<string>>(new Set());
  /** The bucket the chosen set was last opened in, so choosing one opens its bucket once, not always. */
  const [opened, setOpened] = useState<string | undefined>(undefined);

  const load = useCallback(
    (): Promise<void> =>
      channel.read().then(
        (next) => {
          setData(next);
          setFailed(null);
          onData?.(next);
        },
        (e: unknown) => setFailed(e instanceof Error ? e.message : String(e)),
      ),
    [channel, onData],
  );
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (focus === undefined) return;
    setWanted({ permissionSet: focus.id });
    setComparing(false);
    setProblem(null);
  }, [focus]);
  // A question asked on one layer is not a question on another.
  useEffect(() => {
    setHeld(null);
    setTold(null);
    setPuttingBack(false);
  }, [layer]);

  if (data === null) return { waiting: failed !== null ? `Permission sets could not be read — ${failed}` : "Reading permission sets…" };

  const { reads, writesTo } = permissionSetLayersOf(layer, data.layers);
  const ats = permissionSetsAt(data.records, reads);
  const chosenId = wanted !== undefined && wanted !== "bucket" && "permissionSet" in wanted ? wanted.permissionSet : undefined;
  const resolved = resolvePermissionSetChoice(ats, chosenId, pending);
  const choice: PermissionSetChoiceOf | undefined = wanted === "bucket" || (wanted !== undefined && "newIn" in wanted) ? wanted : resolved !== undefined ? { permissionSet: resolved } : undefined;
  if (pending !== null && ats.some((at) => at.id === pending)) setPending(null);
  // The bucket of what is on screen — and every bucket above it — opens when the choice moves there.
  const holding = choice === undefined || choice === "bucket" ? undefined : "newIn" in choice ? choice.newIn : ats.find((at) => at.id === choice.permissionSet)?.bucket;
  if (holding !== undefined && holding !== opened) {
    setOpened(holding);
    const parts = holding.split("/");
    setOpenBuckets((current) => new Set([...current, ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))]));
  }

  const dropDraft = (at: WorkflowLayer, id: string): void =>
    setDrafts((current) => {
      const { [id]: _gone, ...rest } = current[at] ?? {};
      return { ...current, [at]: rest };
    });

  /** One write at a time, re-read after it, and whatever it was refused with said in the pane. */
  const run = (act: () => Promise<unknown>, after: () => void): void => {
    setWriting(true);
    setProblem(null);
    void act()
      .then(after, (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
      .then(load)
      .finally(() => setWriting(false));
  };

  /**
   * A personal-layer change, sent where the person said: replayed over the set as THAT layer sees it
   * (so none of a nearer layer's lines ride along), written there, and said — with where it landed,
   * and when a nearer copy means the layer being read will not show it.
   */
  const send = ({ id, from, to }: HeldChange, into: WritableLayer): void => {
    const there = permissionSetsAt(data.records, into).find((one) => one.id === id);
    const onto = there?.source.decl !== undefined ? declOfPermissionSet(parsePermissionSet(there.source.decl).permissionSet) : from;
    const file = there?.here === true ? there.source.file : permissionSetFileLabel(into, id);
    const nearer = ats.find((one) => one.id === id);
    const hidden = into === "base" && reads === "project" && nearer?.here === true && nearer.source.follows?.startsWith("$BASE/") !== true;
    run(
      () => channel.write({ id, layer: into, permissionSet: rebasePermissionSetChange(from, to, onto) }),
      () => {
        setHeld(null);
        setSentTo((current) => ({ ...current, [id]: into }));
        setTold(`${there?.here === true ? `Changed in ${INTO_NAME[into]}` : `Copied to ${INTO_NAME[into]}, with your change`} — ${file}.` + (hidden ? " This project has its own copy, and that is the one it reads." : ""));
      },
    );
  };

  return {
    props: {
      data,
      layer: reads,
      writesTo,
      choice,
      onChoice: (next) => {
        setWanted(next);
        setComparing(false);
        setProblem(null);
        setPuttingBack(false);
        setHeld(null);
        setTold(null);
      },
      drafts: drafts[reads] ?? {},
      onDraft: (id, next) => (next === undefined ? dropDraft(reads, id) : setDrafts((current) => ({ ...current, [reads]: { ...current[reads], [id]: next } }))),
      comparing,
      onCompare: setComparing,
      naming,
      onNaming: setNaming,
      locked: busy || writing,
      problem,
      mcp,
      openBuckets,
      onBucket: (bucket) =>
        setOpenBuckets((current) => {
          const next = new Set(current);
          if (next.has(bucket)) next.delete(bucket);
          else next.add(bucket);
          return next;
        }),
      onSave: (id, permissionSet) => {
        if (writesTo === undefined) return;
        run(
          () => channel.write({ id, layer: writesTo, permissionSet: declOfPermissionSet(permissionSet) }),
          () => dropDraft(reads, id),
        );
      },
      onReset: (id) => {
        if (writesTo === undefined) return;
        run(
          () => channel.reset({ id, layer: writesTo }),
          () => {
            dropDraft(reads, id);
            setComparing(false);
            setPuttingBack(false);
          },
        );
      },
      puttingBack,
      onPutBack: setPuttingBack,
      onCopy: (id, next) => {
        const at = ats.find((one) => one.id === id);
        if (at?.source.decl === undefined) return;
        const to = declOfPermissionSet(next);
        if (writesTo !== undefined) {
          // The map as shown, with the one change: the writer keeps what the lower layer says as a
          // `$ref` and writes only the line that differs — the copy and the change are one write.
          run(
            () => channel.write({ id, layer: writesTo, permissionSet: to }),
            () => setWanted({ permissionSet: id }),
          );
          return;
        }
        const change: HeldChange = { id, from: declOfPermissionSet(permissionSetOfAt(at)), to };
        const known = sentTo[id];
        if (known !== undefined) send(change, known);
        else {
          setTold(null);
          setHeld(change);
        }
      },
      asking: held?.id,
      onCopyTo: (into) => {
        if (held === null) return;
        if (into === null) setHeld(null);
        else send(held, into);
      },
      told,
      onAdd: (bucket, name) => {
        if (writesTo === undefined) return;
        const id = `${bucket}/${name}`;
        run(
          () => channel.write({ id, layer: writesTo, permissionSet: NEW_PERMISSION_SET }),
          () => {
            setPending(id);
            setWanted({ permissionSet: id });
            setNaming({});
          },
        );
      },
    },
  };
}
