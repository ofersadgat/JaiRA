/**
 * Settings → Toolsets (decision 0007 §6): a rail of buckets beside one toolset, drawn as the
 * composer's Tools card is.
 *
 * The layout is the one Settings already has for a model's call settings — `llm-config` = a rail and
 * a detail pane — and deliberately NOT tabs across the top, which was drawn and turned down. The rail
 * is the bucket hierarchy: a bucket's name with the layer that defines it, its toolsets (a dot where
 * the layer being edited states one), `+ toolset`; `+ bucket` closes it. The detail is the toolset:
 * its path, where its value comes from, which states name it, and then the card.
 *
 * Layered like the rest of Settings, with the one thing the rest does not have yet: a BUILT-IN layer
 * (decision 0006). It reads the same and changes nothing, and offers only the two overrides, which
 * write the override and move the pane to the layer they wrote into.
 *
 * Two layers of code, because the renderer has no DOM test infrastructure:
 *
 *  - what the pane SAYS is a pure function of what main read — `toolsetSettings.ts` in
 *    `@jaira/shared` (which file a layer reads, the pills, the summaries, drafts, compare) and
 *    `composerToolset.ts` (every edit to the map). That is where the tests are;
 *  - {@link ToolsetsView} is a render function over those: every piece of state arrives as a prop,
 *    so each state it can be in is one call to `renderToStaticMarkup`. {@link ToolsetsPane} is the
 *    thin host that reads, holds the drafts, and asks main for the writes.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import {
  compareToolsets,
  declOfToolset,
  isToolsetDirty,
  isWritableLayer,
  overridesOf,
  resolveToolsetChoice,
  toolsetBucketProblem,
  TOOLSET_LAYER_LABELS,
  toolsetNameProblem,
  toolsetOfAt,
  toolsetRailOf,
  toolsetRailSummary,
  toolsetsAt,
  toolsetStanding,
  usedByLine,
  type Toolset,
  type ToolsetAt,
  type ToolsetDecl,
  type ToolsetDrafts,
  type ToolsetsView as ToolsetsData,
  type WorkflowLayer,
  type WritableLayer,
} from "@jaira/shared/browser";
import { Icon } from "./icons";
import { TabRail, type RailItem } from "./llmConfigForm";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { Schema } from "./schemaForm/types";
import { SettingsSection } from "./settingsLayout";
import { ToolsetCard } from "./toolsetCard";

// --- the model ---------------------------------------------------------------------------

/** What the rail has chosen: a toolset, the `+ toolset` of one bucket, or `+ bucket`. */
export type ToolsetChoiceOf = { toolset: string } | { newIn: string } | "bucket";

const toolsetTab = (id: string): string => `toolset:${id}`;
const newTab = (bucket: string): string => `new:${bucket}`;
const BUCKET_TAB = "+bucket";

function choiceOfTab(id: string): ToolsetChoiceOf {
  if (id === BUCKET_TAB) return "bucket";
  return id.startsWith("new:") ? { newIn: id.slice("new:".length) } : { toolset: id.slice("toolset:".length) };
}

function tabOfChoice(choice: ToolsetChoiceOf | undefined): string | undefined {
  if (choice === undefined) return undefined;
  if (choice === "bucket") return BUCKET_TAB;
  return "newIn" in choice ? newTab(choice.newIn) : toolsetTab(choice.toolset);
}

/** The rail, as the tab rail takes it. A read-only layer gets no `+` rows: nothing can be added to what ships. */
export function toolsetRailItems(ats: readonly ToolsetAt[], layer: WorkflowLayer, drafts: ToolsetDrafts): RailItem[] {
  const writable = isWritableLayer(layer);
  const items: RailItem[] = [];
  for (const { bucket, toolsets } of toolsetRailOf(ats)) {
    items.push({
      id: `bucket:${bucket.path}`,
      summary: null,
      indent: bucket.depth,
      title: bucket.path,
      heading: (
        <>
          <span className="cx-chip-icon">
            <Icon name="folder" />
          </span>
          <span>{bucket.name}</span>
          <span className="cx-src">{TOOLSET_LAYER_LABELS[bucket.layer]}</span>
        </>
      ),
    });
    for (const at of toolsets) {
      items.push({
        id: toolsetTab(at.id),
        mono: true,
        indent: bucket.depth,
        // The dot means "the layer you are EDITING states it". On the built-in layer every toolset
        // is stated here and nothing is being edited, so a dot on all of them would say nothing.
        label: at.here && writable ? (
          <>
            {at.name}
            <i className="set-here-dot" title="set in the layer you are editing" />
          </>
        ) : (
          at.name
        ),
        summary: toolsetRailSummary(at, drafts[at.id]),
      });
    }
    if (writable) items.push({ id: newTab(bucket.path), className: "set-rail-add", indent: bucket.depth, summary: "+ toolset", title: `add a toolset to ${bucket.path}` });
  }
  if (writable) items.push({ id: BUCKET_TAB, className: "set-rail-add", summary: "+ bucket", title: "add a bucket — a place with its own versions of the same names" });
  return items;
}

/**
 * What saving this draft will do to the file, where that is worth saying BEFORE the save: a line the
 * followed toolset holds was taken out, which `$ref` plus siblings cannot say, so the file is written
 * whole and stops following. Names the lines, or is empty.
 */
export function detachingLines(at: ToolsetAt, draft: Toolset | undefined): string[] {
  if (draft === undefined || !at.here || at.source.follows === undefined || at.lower?.decl === undefined) return [];
  return overridesOf(at.lower.decl, declOfToolset(draft)).dropped;
}

/** Why a name cannot be used for a new toolset in a bucket, or `undefined` when it can. */
export function newToolsetProblem(ats: readonly ToolsetAt[], bucket: string, name: string): string | undefined {
  const problem = toolsetBucketProblem(bucket.trim()) ?? toolsetNameProblem(name.trim());
  if (problem !== undefined) return problem;
  const taken = ats.find((at) => at.id === `${bucket.trim()}/${name.trim()}`);
  if (taken === undefined) return undefined;
  return taken.here ? `there is already a toolset called '${taken.id}'` : `'${taken.id}' is inherited here — open it and override it`;
}

/** The map a new toolset starts as: nothing offered, and everything else asked about. */
export const NEW_TOOLSET: ToolsetDecl = { other: "ask" };

// --- the render function -----------------------------------------------------------------

const HEAD_HINT = (
  <>
    Which tools are offered, and what happens when each is called. A state names one as <code>$/toolsets/&lt;bucket&gt;/&lt;name&gt;</code>; a bucket is a
    place with its own versions of the same names.
  </>
);

const LOWER_NAME: Readonly<Record<WorkflowLayer, string>> = { system: "what ships", base: "the shared one", project: "this project's" };
const RESET_LABEL: Readonly<Record<WorkflowLayer, string>> = { system: "Reset to built in", base: "Reset to shared", project: "Reset" };
const OVERRIDE_LABEL: Readonly<Record<WritableLayer, string>> = { base: "Override for all projects", project: "Override here" };

export interface ToolsetsViewProps {
  data: ToolsetsData;
  /** The layer the picker is on. */
  layer: WorkflowLayer;
  choice: ToolsetChoiceOf | undefined;
  onChoice: (next: ToolsetChoiceOf) => void;
  drafts: ToolsetDrafts;
  onDraft: (id: string, next: Toolset | undefined) => void;
  /** "Compare with what ships" is open. */
  comparing: boolean;
  onCompare: (open: boolean) => void;
  /** What is being typed under `+ toolset` / `+ bucket`. */
  naming: { bucket?: string; name?: string };
  onNaming: (next: { bucket?: string; name?: string }) => void;
  /** A write is in flight, so nothing else may start. */
  locked: boolean;
  /** What the last write was refused with. */
  problem: string | null;
  onSave: (id: string, toolset: Toolset) => void;
  onReset: (id: string) => void;
  /** Write an override of `id` into `into`, and move there. */
  onOverride: (id: string, into: WritableLayer) => void;
  onAdd: (bucket: string, name: string) => void;
  /** For a still picture: the card's folds, and an add-menu drawn open. */
  folds?: ReadonlySet<string> | undefined;
  startAdding?: string | undefined;
  /** For a still picture: a tool line's mode menu drawn open. */
  startMode?: { subject: string; open: "menu" | "function" } | undefined;
}

export function ToolsetsView(props: ToolsetsViewProps): JSX.Element {
  const ats = toolsetsAt(props.data.records, props.layer);
  const open = props.choice !== undefined && props.choice !== "bucket" && "toolset" in props.choice ? ats.find((at) => at.id === (props.choice as { toolset: string }).toolset) : undefined;
  const adding = props.choice === "bucket" || (props.choice !== undefined && typeof props.choice === "object" && "newIn" in props.choice);
  return (
    <div className="cfg-pane">
      {/* A workspace — a rail of toolsets beside the one open — so it takes the page's width, and its
          sentence stays in view because it names the reference a state writes. */}
      <SettingsSection id="toolsets" title="Toolsets" lead={HEAD_HINT} wide>
        <div className="llm-config set-config">
          <TabRail
            label="Toolsets"
            items={toolsetRailItems(ats, props.layer, props.drafts)}
            selected={tabOfChoice(open !== undefined ? { toolset: open.id } : adding ? props.choice : undefined)}
            onSelect={(id) => props.onChoice(choiceOfTab(id))}
          />
          {open !== undefined ? (
            <OpenToolset key={`${props.layer}:${open.id}:${open.here}`} at={open} {...props} />
          ) : adding && isWritableLayer(props.layer) ? (
            <NewToolset ats={ats} {...props} />
          ) : (
            <div className="llm-detail" role="tabpanel">
              <p className="cfg-hint">{ats.length === 0 ? "No toolsets here." : "Pick a toolset."}</p>
            </div>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}

/** One toolset: its path and standing, the card, and what can be done with it as a whole. */
function OpenToolset({ at, ...props }: ToolsetsViewProps & { at: ToolsetAt }): JSX.Element {
  const standing = toolsetStanding(at);
  const system = props.layer === "system";
  const draft = props.drafts[at.id];
  const dirty = at.here && !system && isToolsetDirty(at, draft);
  const shown = at.here && !system ? (draft ?? toolsetOfAt(at)) : toolsetOfAt(at);
  // Only a layer's OWN JSON file is edited in place. What it merely inherits is read, until it is
  // overridden — the same rule Presets has, and the same one the built-in layer follows.
  const editable = at.here && !system && at.source.format === "json" && at.source.decl !== undefined;
  const detaching = detachingLines(at, draft);
  const differences = props.comparing && at.lower?.decl !== undefined ? compareToolsets(at.lower.decl, declOfToolset(shown)) : [];
  const overrideInto = (["base", "project"] as WritableLayer[]).filter((into) => props.data.layers.includes(into));

  return (
    <div className="llm-detail" role="tabpanel" aria-label={at.id}>
      <div className="llm-detail-head">
        <span className="llm-detail-title">
          <span className="mono" title={at.source.file}>
            {at.bucket.split("/").join(" / ")} / {at.name}
          </span>{" "}
          <span className={`cfg-status ${standing.here && !system ? "here" : "unchecked"}`}>
            <span className="cfg-dot" aria-hidden="true" />
            {standing.label}
          </span>
          {standing.shadowed !== undefined ? (
            <span className="cfg-status unchecked" title="a nearer layer holds a toolset of this name, and a bare $/toolsets reference finds that one first">
              <span className="cfg-dot" aria-hidden="true" />
              {standing.shadowed}
            </span>
          ) : null}
        </span>
        <span className="cfg-hint">{usedByLine(props.data.usedBy[at.id])}</span>
      </div>

      {at.source.decl === undefined ? (
        <p className="sub warn-text">
          {at.source.file} could not be read as a toolset — {at.source.problem ?? "it is not a map from a subject to a mode"}. Open it in Files to fix it.
        </p>
      ) : (
        <ToolsetCard
          toolset={shown}
          tools={props.data.tools}
          readOnly={!editable || props.locked}
          onChange={editable ? (next) => props.onDraft(at.id, next) : undefined}
          folds={props.folds}
          startAdding={props.startAdding}
          startMode={props.startMode}
        />
      )}

      {at.here && !system && at.source.format !== "json" ? (
        <p className="cfg-hint">This layer holds it as a YAML file, which JaiRA reads and does not edit. Change it in Files.</p>
      ) : null}
      {detaching.length > 0 ? (
        <p className="cfg-hint set-note">
          Taking out {detaching.map((subject) => `'${subject}'`).join(", ")} is something an override cannot say — a line left out means "as {LOWER_NAME[at.lower!.layer]} says".
          Saving writes this toolset whole, and it stops following {LOWER_NAME[at.lower!.layer]}.
        </p>
      ) : null}
      {props.comparing && at.lower !== undefined ? (
        <div className="set-compare" role="table" aria-label={`Compared with ${LOWER_NAME[at.lower.layer]}`}>
          <div className="set-compare-row set-compare-head" role="row">
            <span role="columnheader">line</span>
            <span role="columnheader">{LOWER_NAME[at.lower.layer]}</span>
            <span role="columnheader">here</span>
          </div>
          {differences.length === 0 ? (
            <p className="cfg-hint">Nothing differs: this says exactly what {LOWER_NAME[at.lower.layer]} says.</p>
          ) : (
            differences.map((row) => (
              <div key={row.subject} className="set-compare-row" role="row">
                <span className="mono" role="cell">
                  {row.subject}
                </span>
                <span role="cell" className={row.theirs === undefined ? "set-compare-none" : undefined}>
                  {row.theirs ?? "no line"}
                </span>
                <span role="cell" className={row.ours === undefined ? "set-compare-none" : undefined}>
                  {row.ours ?? "taken out"}
                </span>
              </div>
            ))
          )}
        </div>
      ) : null}
      {props.problem !== null ? <p className="sub warn-text">{props.problem}</p> : null}

      {editable || (at.here && !system) ? (
        <div className="pane-actions">
          <button type="button" className="primary" disabled={props.locked || !dirty} onClick={() => props.onSave(at.id, shown)}>
            Save
          </button>
          <button type="button" className="ghost" disabled={!dirty} onClick={() => props.onDraft(at.id, undefined)}>
            Revert
          </button>
          <span className="grow" />
          {at.lower !== undefined ? (
            <>
              <button type="button" className="link" aria-expanded={props.comparing} onClick={() => props.onCompare(!props.comparing)}>
                {props.comparing ? "Hide the comparison" : `Compare with ${LOWER_NAME[at.lower.layer]}`}
              </button>
              <button
                type="button"
                className="ghost danger"
                disabled={props.locked}
                title={`delete ${at.source.file}, so ${LOWER_NAME[at.lower.layer]} answers again`}
                onClick={() => props.onReset(at.id)}
              >
                {RESET_LABEL[at.lower.layer]}
              </button>
            </>
          ) : null}
        </div>
      ) : (
        // Read, not edited: what ships, or what this layer only inherits. The one thing to do about
        // it is to override it — into every layer nearer than the one that supplies it.
        <div className="pane-actions">
          {overrideInto
            .filter((into) => (system ? true : into === props.layer))
            .map((into) => (
              <button
                key={into}
                type="button"
                className="ghost"
                disabled={props.locked || at.source.decl === undefined}
                title={`write an override of ${at.id} that keeps following ${TOOLSET_LAYER_LABELS[at.source.layer]}, and edit it there`}
                onClick={() => props.onOverride(at.id, into)}
              >
                {OVERRIDE_LABEL[into]}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

const NAME_SCHEMA: Schema = {
  type: "object",
  required: ["name"],
  properties: { name: { type: "string", title: "Name", description: "The file's name — what a state writes after the bucket.", minLength: 1 } },
};
const BUCKET_SCHEMA: Schema = {
  type: "object",
  required: ["bucket", "name"],
  properties: {
    bucket: { type: "string", title: "Bucket", description: "A folder under toolsets/. It may nest: feature/implementation.", minLength: 1 },
    name: { type: "string", title: "First toolset", description: "A bucket is a folder, and exists by holding one.", minLength: 1 },
  },
};

/** `+ toolset` and `+ bucket`: a name is all a new one needs — its lines are added once it exists. */
function NewToolset({ ats, ...props }: ToolsetsViewProps & { ats: readonly ToolsetAt[] }): JSX.Element {
  const inBucket = props.choice !== "bucket" && props.choice !== undefined && "newIn" in props.choice ? props.choice.newIn : undefined;
  const bucket = inBucket ?? props.naming.bucket ?? "";
  const name = props.naming.name ?? "";
  const typed = name.trim().length > 0 || (inBucket === undefined && bucket.trim().length > 0);
  const problem = newToolsetProblem(ats, bucket, name);
  const path = `toolsets${inBucket !== undefined ? `/${inBucket}` : ""}`;
  return (
    <div className="llm-detail" role="tabpanel" aria-label={inBucket !== undefined ? `A new toolset in ${inBucket}` : "A new bucket"}>
      <div className="llm-detail-head">
        <span className="llm-detail-title">{inBucket !== undefined ? <>A new toolset in <span className="mono">{inBucket}</span></> : "A new bucket"}</span>
        <span className="cfg-hint">
          {inBucket !== undefined
            ? "It starts holding nothing, with everything else asked about. Its lines are added once it has a name."
            : "A place with its own versions of the same names — chat/ask-first and chat_control/ask-first are two toolsets."}
        </span>
      </div>
      <SchemaForm
        schema={inBucket !== undefined ? NAME_SCHEMA : BUCKET_SCHEMA}
        value={inBucket !== undefined ? { name } : { bucket, name }}
        onChange={(next) => {
          const value = (next ?? {}) as { bucket?: unknown; name?: unknown };
          props.onNaming({
            ...(typeof value.bucket === "string" ? { bucket: value.bucket } : {}),
            ...(typeof value.name === "string" ? { name: value.name } : {}),
          });
        }}
        ctx={{
          path,
          disabled: props.locked,
          // Said only once something is typed, and under the box it is about.
          ...(typed && problem !== undefined
            ? { errors: [{ path: `${path}.${inBucket === undefined && toolsetBucketProblem(bucket.trim()) !== undefined ? "bucket" : "name"}`, message: problem }] }
            : {}),
        }}
      />
      {props.problem !== null ? <p className="sub warn-text">{props.problem}</p> : null}
      <div className="pane-actions">
        <button type="button" className="primary" disabled={props.locked || problem !== undefined} onClick={() => props.onAdd(bucket.trim(), name.trim())}>
          Add it
        </button>
      </div>
    </div>
  );
}

// --- the host ----------------------------------------------------------------------------

/** The three calls the pane makes — the host's, so the view has no channel of its own. */
export interface ToolsetsChannel {
  read: () => Promise<ToolsetsData>;
  write: (request: { id: string; layer: WritableLayer; toolset: ToolsetDecl }) => Promise<unknown>;
  reset: (request: { id: string; layer: WritableLayer }) => Promise<unknown>;
}

/**
 * The state {@link ToolsetsView} is drawn from, and the writes it asks for.
 *
 * Drafts are kept PER LAYER AND TOOLSET, so that looking at another toolset — or at what ships —
 * loses nothing. The selection is an id, not an index, which is the whole of "the selection survives
 * a save": the records are re-read, this component does not remount, and the id still resolves.
 */
export function ToolsetsPane({
  channel,
  layer,
  onLayer,
  busy,
}: {
  channel: ToolsetsChannel;
  layer: WorkflowLayer;
  /** Move the layer picker — what an override does once it has written. */
  onLayer: (layer: WorkflowLayer) => void;
  busy: boolean;
}): JSX.Element {
  const [data, setData] = useState<ToolsetsData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [wanted, setWanted] = useState<ToolsetChoiceOf | undefined>(undefined);
  const [pending, setPending] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, ToolsetDrafts>>>({});
  const [comparing, setComparing] = useState(false);
  const [naming, setNaming] = useState<{ bucket?: string; name?: string }>({});
  const [writing, setWriting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(
    (): Promise<void> =>
      channel.read().then(
        (next) => {
          setData(next);
          setFailed(null);
        },
        (e: unknown) => setFailed(e instanceof Error ? e.message : String(e)),
      ),
    [channel],
  );
  useEffect(() => void load(), [load]);

  if (data === null) return <p className="empty">{failed !== null ? `Toolsets could not be read — ${failed}` : "Reading toolsets…"}</p>;

  const ats = toolsetsAt(data.records, layer);
  const chosenId = wanted !== undefined && wanted !== "bucket" && "toolset" in wanted ? wanted.toolset : undefined;
  const resolved = resolveToolsetChoice(ats, chosenId, pending);
  const choice: ToolsetChoiceOf | undefined = wanted === "bucket" || (wanted !== undefined && "newIn" in wanted) ? wanted : resolved !== undefined ? { toolset: resolved } : undefined;
  if (pending !== null && ats.some((at) => at.id === pending)) setPending(null);

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

  return (
    <ToolsetsView
      data={data}
      layer={layer}
      choice={choice}
      onChoice={(next) => {
        setWanted(next);
        setComparing(false);
        setProblem(null);
      }}
      drafts={drafts[layer] ?? {}}
      onDraft={(id, next) => (next === undefined ? dropDraft(layer, id) : setDrafts((current) => ({ ...current, [layer]: { ...current[layer], [id]: next } })))}
      comparing={comparing}
      onCompare={setComparing}
      naming={naming}
      onNaming={setNaming}
      locked={busy || writing}
      problem={problem}
      onSave={(id, toolset) => {
        if (!isWritableLayer(layer)) return;
        run(
          () => channel.write({ id, layer, toolset: declOfToolset(toolset) }),
          () => dropDraft(layer, id),
        );
      }}
      onReset={(id) => {
        if (!isWritableLayer(layer)) return;
        run(
          () => channel.reset({ id, layer }),
          () => {
            dropDraft(layer, id);
            setComparing(false);
          },
        );
      }}
      onOverride={(id, into) => {
        const at = ats.find((one) => one.id === id);
        if (at?.source.decl === undefined) return;
        const decl = at.source.decl;
        run(
          // The map it overrides, unchanged: what is written is `{ "$ref": … }` and nothing else, so
          // the override keeps following until a line is changed in it.
          () => channel.write({ id, layer: into, toolset: decl }),
          () => {
            setWanted({ toolset: id });
            onLayer(into);
          },
        );
      }}
      onAdd={(bucket, name) => {
        if (!isWritableLayer(layer)) return;
        const id = `${bucket}/${name}`;
        run(
          () => channel.write({ id, layer, toolset: NEW_TOOLSET }),
          () => {
            setPending(id);
            setWanted({ toolset: id });
            setNaming({});
          },
        );
      }}
    />
  );
}
