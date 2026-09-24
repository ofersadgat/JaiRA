/**
 * Settings → Permission sets (decision 0007 §6): a rail of buckets beside one permission set, drawn as the
 * composer's Tools card is.
 *
 * The layout is the one Settings already has for a model's call settings — `llm-config` = a rail and
 * a detail pane — and deliberately NOT tabs across the top, which was drawn and turned down. The rail
 * is the bucket hierarchy: a bucket's name with the layer that defines it, its permission sets (a dot where
 * the layer being edited states one), `+ permission set`; `+ bucket` closes it. The detail is the permission set:
 * its path, where its value comes from, which states name it, and then the card.
 *
 * Layered like the rest of Settings, over the layer the page's switch is on. What ships (decision
 * 0006) is not a segment of that switch any more (round 5, 2026-09-23): it is shown on every layer,
 * as whatever that layer does not state itself, and it is LIVE there — the first change to a set a
 * layer only sees writes that layer's copy with the change in it, in one write, and the set then
 * reads `shared · copied from built in` until "Put back the built-in" deletes the copy. "Override
 * here", which wrote an untouched copy and moved the pane onto it, is gone with the segment.
 *
 * The personal layer ("Just you") is one settings file, and a permission set is a file of its own, so
 * that layer cannot hold one: it shows what the nearest layer says, and its first change to a set asks
 * whether the copy goes to Shared or this project.
 *
 * Two layers of code, because the renderer has no DOM test infrastructure:
 *
 *  - what the pane SAYS is a pure function of what main read — `permissionSetSettings.ts` in
 *    `@jaira/shared` (which file a layer reads, the pills, the summaries, drafts, compare) and
 *    `composerPermissionSet.ts` (every edit to the map). That is where the tests are;
 *  - {@link PermissionSetsView} is a render function over those: every piece of state arrives as a prop,
 *    so each state it can be in is one call to `renderToStaticMarkup`. {@link PermissionSetsPane} is the
 *    thin host that reads, holds the drafts, and asks main for the writes.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import {
  comparePermissionSets,
  copiedFrom,
  copyDifferences,
  declOfPermissionSet,
  isPermissionSetDirty,
  overridesOf,
  parsePermissionSet,
  rebasePermissionSetChange,
  resolvePermissionSetChoice,
  permissionSetBucketProblem,
  PERMISSION_SET_LAYER_LABELS,
  permissionSetFileLabel,
  permissionSetNameProblem,
  permissionSetOfAt,
  permissionSetRailOf,
  permissionSetRailSummary,
  permissionSetsAt,
  permissionSetStanding,
  usedByLine,
  type ConfigLayer,
  type PermissionSet,
  type PermissionSetAt,
  type PermissionSetDecl,
  type PermissionSetDrafts,
  type PermissionSetsView as PermissionSetsData,
  type WorkflowLayer,
  type WritableLayer,
} from "@jaira/shared/browser";
import { Icon } from "./icons";
import { TabRail, type RailItem } from "./llmConfigForm";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { Schema } from "./schemaForm/types";
import { SettingsSection } from "./settingsLayout";
import { PermissionSetCard } from "./permissionSetCard";
import type { McpServerStatus } from "@jaira/shared/browser";

// --- the model ---------------------------------------------------------------------------

/** What the rail has chosen: a permission set, the `+ permission set` of one bucket, or `+ bucket`. */
export type PermissionSetChoiceOf = { permissionSet: string } | { newIn: string } | "bucket";

const permissionSetTab = (id: string): string => `permissionSet:${id}`;
const newTab = (bucket: string): string => `new:${bucket}`;
const BUCKET_TAB = "+bucket";

function choiceOfTab(id: string): PermissionSetChoiceOf {
  if (id === BUCKET_TAB) return "bucket";
  return id.startsWith("new:") ? { newIn: id.slice("new:".length) } : { permissionSet: id.slice("permissionSet:".length) };
}

function tabOfChoice(choice: PermissionSetChoiceOf | undefined): string | undefined {
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
 * The rail, as the tab rail takes it. With nowhere to write there are no `+` rows and no dots: the
 * dot means "the layer you are editing states it", and that layer states nothing.
 */
export function permissionSetRailItems(ats: readonly PermissionSetAt[], writesTo: WritableLayer | undefined, drafts: PermissionSetDrafts): RailItem[] {
  const writable = writesTo !== undefined;
  const items: RailItem[] = [];
  for (const { bucket, permissionSets } of permissionSetRailOf(ats)) {
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
          <span className="cx-src">{PERMISSION_SET_LAYER_LABELS[bucket.layer]}</span>
        </>
      ),
    });
    for (const at of permissionSets) {
      // A copy says so beside its name, in the words its head's pill uses — the bucket's own pill
      // names the layer that DEFINES the bucket, which for a copy of what ships is still built in.
      const copy = copiedFrom(at) !== undefined ? <span className="cx-src">{permissionSetStanding(at).label}</span> : null;
      items.push({
        id: permissionSetTab(at.id),
        mono: true,
        indent: bucket.depth,
        // The dot means "the layer you are EDITING states it".
        label:
          (at.here && writable) || copy !== null ? (
            <>
              {at.name}
              {at.here && writable ? <i className="set-here-dot" title="set in the layer you are editing" /> : null}
              {copy}
            </>
          ) : (
            at.name
          ),
        summary: permissionSetRailSummary(at, drafts[at.id]),
      });
    }
    if (writable) items.push({ id: newTab(bucket.path), className: "set-rail-add", indent: bucket.depth, summary: "+ permission set", title: `add a permission set to ${bucket.path}` });
  }
  if (writable) items.push({ id: BUCKET_TAB, className: "set-rail-add", summary: "+ bucket", title: "add a bucket — a place with its own versions of the same names" });
  return items;
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

// --- the render function -----------------------------------------------------------------

const HEAD_HINT = (
  <>
    Which tools are offered, and what happens when each is called. A state names one as <code>$/permission-sets/&lt;bucket&gt;/&lt;name&gt;</code>; a bucket is a
    place with its own versions of the same names.
  </>
);

const LOWER_NAME: Readonly<Record<WorkflowLayer, string>> = { system: "what ships", base: "the shared one", project: "this project's" };
/** A layer a copy can be written into, as "Copy to …" and "copied to …" name it. */
const INTO_NAME: Readonly<Record<WritableLayer, string>> = { base: "Shared", project: "this project" };
/** The personal layer, as the page's switch names it. */
const PERSONAL = "Just you";

export interface PermissionSetsViewProps {
  data: PermissionSetsData;
  /** The layer whose files the pane reads: its own, and those of every layer below it. */
  layer: WritableLayer;
  /**
   * Where a change is written: the layer being read — or, on the personal layer, which holds no
   * permission sets, nowhere yet, so a change waits on {@link asking} for the person to say where.
   */
  writesTo: WritableLayer | undefined;
  choice: PermissionSetChoiceOf | undefined;
  onChoice: (next: PermissionSetChoiceOf) => void;
  drafts: PermissionSetDrafts;
  onDraft: (id: string, next: PermissionSet | undefined) => void;
  /** "Compare with what ships" is open. */
  comparing: boolean;
  onCompare: (open: boolean) => void;
  /** What is being typed under `+ permission set` / `+ bucket`. */
  naming: { bucket?: string; name?: string };
  onNaming: (next: { bucket?: string; name?: string }) => void;
  /** A write is in flight, so nothing else may start. */
  locked: boolean;
  /** What the last write was refused with. */
  problem: string | null;
  onSave: (id: string, permissionSet: PermissionSet) => void;
  /** Delete this layer's copy — "Put back the built-in" once confirmed, or "Reset to shared". */
  onReset: (id: string) => void;
  /**
   * A change to a set this layer does not hold: `next` is the whole map as shown, with the change.
   * The host writes it as this layer's copy, or — with nowhere to write — asks where it goes.
   */
  onCopy: (id: string, next: PermissionSet) => void;
  /** The set whose change is waiting on "Copy to Shared" / "Copy to this project". */
  asking?: string | undefined;
  /** The answer: the layer the copy goes into, or `null` to drop the change. */
  onCopyTo: (into: WritableLayer | null) => void;
  /** "Put back the built-in?" is being asked, in place of the actions. */
  puttingBack: boolean;
  onPutBack: (open: boolean) => void;
  /** Where the last change made on the personal layer went, said until the person moves on. */
  told: string | null;
  onAdd: (bucket: string, name: string) => void;
  /** For a still picture: the card's folds, and an add-menu drawn open. */
  folds?: ReadonlySet<string> | undefined;
  startAdding?: string | undefined;
  /** For a still picture: a tool line's mode menu drawn open. */
  startMode?: { subject: string; open: "menu" | "function" } | undefined;
  /** The configured MCP servers as the tools probe last found them — the card's MCP groups. */
  mcp?: readonly McpServerStatus[] | undefined;
}

export function PermissionSetsView(props: PermissionSetsViewProps): JSX.Element {
  const ats = permissionSetsAt(props.data.records, props.layer);
  const open = props.choice !== undefined && props.choice !== "bucket" && "permissionSet" in props.choice ? ats.find((at) => at.id === (props.choice as { permissionSet: string }).permissionSet) : undefined;
  const adding = props.choice === "bucket" || (props.choice !== undefined && typeof props.choice === "object" && "newIn" in props.choice);
  return (
    <div className="cfg-pane">
      {/* A workspace — a rail of permission sets beside the one open — so it takes the page's width, and its
          sentence stays in view because it names the reference a state writes. */}
      <SettingsSection id="permission-sets" title="Permission sets" lead={HEAD_HINT} wide>
        <div className="llm-config set-config">
          <TabRail
            label="Permission sets"
            items={permissionSetRailItems(ats, props.writesTo, props.drafts)}
            selected={tabOfChoice(open !== undefined ? { permissionSet: open.id } : adding ? props.choice : undefined)}
            onSelect={(id) => props.onChoice(choiceOfTab(id))}
          />
          {open !== undefined ? (
            <OpenPermissionSet key={`${props.layer}:${open.id}`} at={open} {...props} />
          ) : adding && props.writesTo !== undefined ? (
            <NewPermissionSet ats={ats} {...props} />
          ) : (
            <div className="llm-detail" role="tabpanel">
              <p className="cfg-hint">{ats.length === 0 ? "No permission sets here." : "Pick a permission set."}</p>
            </div>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}

/** One permission set: its path and standing, the card, and what can be done with it as a whole. */
function OpenPermissionSet({ at, ...props }: PermissionSetsViewProps & { at: PermissionSetAt }): JSX.Element {
  const standing = permissionSetStanding(at);
  // The layer's OWN file: what Save edits in place and a reset deletes. The personal layer owns none.
  const own = at.here && props.writesTo !== undefined;
  const draft = props.drafts[at.id];
  const dirty = own && isPermissionSetDirty(at, draft);
  const shown = own ? (draft ?? permissionSetOfAt(at)) : permissionSetOfAt(at);
  // Only a layer's own JSON file is edited in place, as a draft. Everything else that could be read is
  // LIVE as well: its first change is written at once, as this layer's copy with that change in it.
  const editable = own && at.source.format === "json" && at.source.decl !== undefined;
  const copyable = !own && at.source.decl !== undefined;
  const asking = props.asking === at.id;
  const from = copiedFrom(at);
  const differ = copyDifferences(at);
  const detaching = detachingLines(at, draft);
  const differences = props.comparing && at.lower?.decl !== undefined ? comparePermissionSets(at.lower.decl, declOfPermissionSet(shown)) : [];
  const into = (["base", "project"] as WritableLayer[]).filter((layer) => props.data.layers.includes(layer));

  return (
    <div className="llm-detail" role="tabpanel" aria-label={at.id}>
      <div className="llm-detail-head">
        <span className="llm-detail-title">
          <span className="mono" title={at.source.file}>
            {at.bucket.split("/").join(" / ")} / {at.name}
          </span>{" "}
          <span className={`cfg-status ${standing.here && props.writesTo !== undefined ? "here" : "unchecked"}`}>
            <span className="cfg-dot" aria-hidden="true" />
            {standing.label}
          </span>
          {standing.shadowed !== undefined ? (
            <span className="cfg-status unchecked" title="a nearer layer holds a permission set of this name, and a bare $/permission-sets reference finds that one first">
              <span className="cfg-dot" aria-hidden="true" />
              {standing.shadowed}
            </span>
          ) : null}
        </span>
        <span className="cfg-hint">
          {usedByLine(props.data.usedBy[at.id])}
          {differ !== undefined && from !== undefined ? (
            <>
              {" · "}
              {differ === 0 ? (
                `nothing differs from ${LOWER_NAME[from]}`
              ) : (
                <>
                  <b>
                    {differ} line{differ === 1 ? "" : "s"}
                  </b>{" "}
                  {differ === 1 ? "differs" : "differ"} from {LOWER_NAME[from]}
                </>
              )}
              {" — "}
              <span className="mono">{at.source.file}</span>
            </>
          ) : null}
          {copyable ? (
            props.writesTo !== undefined ? (
              <>
                {" · your first change copies it to "}
                <span className="mono">{permissionSetFileLabel(props.writesTo, at.id)}</span>
              </>
            ) : (
              ` · ${PERSONAL} holds no permission sets, so your first change asks where to copy it`
            )
          ) : null}
        </span>
      </div>

      {at.source.decl === undefined ? (
        <p className="sub warn-text">
          {at.source.file} could not be read as a permission set — {at.source.problem ?? "it is not a map from a subject to a mode"}. Open it in Files to fix it.
        </p>
      ) : (
        <PermissionSetCard
          permissionSet={shown}
          tools={props.data.tools}
          readOnly={!(editable || copyable) || asking || props.locked}
          onChange={editable ? (next) => props.onDraft(at.id, next) : copyable ? (next) => props.onCopy(at.id, next) : undefined}
          folds={props.folds}
          startAdding={props.startAdding}
          startMode={props.startMode}
          mcp={props.mcp}
        />
      )}

      {own && at.source.format !== "json" ? (
        <p className="cfg-hint">This layer holds it as a YAML file, which JaiRA reads and does not edit. Change it in Files.</p>
      ) : null}
      {detaching.length > 0 ? (
        <p className="cfg-hint set-note">
          Taking out {detaching.map((subject) => `'${subject}'`).join(", ")} is something an override cannot say — a line left out means "as {LOWER_NAME[at.lower!.layer]} says".
          Saving writes this permission set whole, and it stops following {LOWER_NAME[at.lower!.layer]}.
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
      {props.told !== null ? (
        <p className="cfg-hint" role="status">
          {props.told}
        </p>
      ) : null}
      {props.problem !== null ? <p className="sub warn-text">{props.problem}</p> : null}

      {asking ? (
        // Asked in place, not in a dialog: the change is held until it is answered, and the card
        // shows what is in effect meanwhile.
        <div className="set-ask" role="group" aria-label={`Where the change to ${at.id} goes`}>
          <span>
            {PERSONAL} is one settings file, and a permission set is a file of its own. Copy <span className="mono">{at.id}</span>, with your change, to:
          </span>
          <div className="pane-actions">
            {into.map((layer, i) => (
              <button
                key={layer}
                type="button"
                className={i === 0 ? "primary" : "ghost"}
                disabled={props.locked}
                title={`write ${permissionSetFileLabel(layer, at.id)}`}
                onClick={() => props.onCopyTo(layer)}
              >
                Copy to {INTO_NAME[layer]}
              </button>
            ))}
            <button type="button" className="ghost" onClick={() => props.onCopyTo(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : own && props.puttingBack && from === "system" ? (
        <div className="set-ask" role="alertdialog" aria-label="Put back the built-in">
          <span>
            Put back the built-in? This deletes <span className="mono">{at.source.file}</span>.
          </span>
          <div className="pane-actions">
            <button type="button" className="danger" disabled={props.locked} onClick={() => props.onReset(at.id)}>
              Put back
            </button>
            <button type="button" className="ghost" onClick={() => props.onPutBack(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : own ? (
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
              {from === "system" ? (
                // Asked first, in the page: it deletes a file, and every change made in it goes too.
                <button type="button" className="ghost danger" disabled={props.locked} title={`delete ${at.source.file}, so what ships answers again`} onClick={() => props.onPutBack(true)}>
                  Put back the built-in
                </button>
              ) : (
                <button
                  type="button"
                  className="ghost danger"
                  disabled={props.locked}
                  title={`delete ${at.source.file}, so ${LOWER_NAME[at.lower.layer]} answers again`}
                  onClick={() => props.onReset(at.id)}
                >
                  Reset to shared
                </button>
              )}
            </>
          ) : null}
        </div>
      ) : null}
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
    bucket: { type: "string", title: "Bucket", description: "A folder under permission-sets/. It may nest: feature/implementation.", minLength: 1 },
    name: { type: "string", title: "First permission set", description: "A bucket is a folder, and exists by holding one.", minLength: 1 },
  },
};

/** `+ permission set` and `+ bucket`: a name is all a new one needs — its lines are added once it exists. */
function NewPermissionSet({ ats, ...props }: PermissionSetsViewProps & { ats: readonly PermissionSetAt[] }): JSX.Element {
  const inBucket = props.choice !== "bucket" && props.choice !== undefined && "newIn" in props.choice ? props.choice.newIn : undefined;
  const bucket = inBucket ?? props.naming.bucket ?? "";
  const name = props.naming.name ?? "";
  const typed = name.trim().length > 0 || (inBucket === undefined && bucket.trim().length > 0);
  const problem = newPermissionSetProblem(ats, bucket, name);
  const path = `permission sets${inBucket !== undefined ? `/${inBucket}` : ""}`;
  return (
    <div className="llm-detail" role="tabpanel" aria-label={inBucket !== undefined ? `A new permission set in ${inBucket}` : "A new bucket"}>
      <div className="llm-detail-head">
        <span className="llm-detail-title">{inBucket !== undefined ? <>A new permission set in <span className="mono">{inBucket}</span></> : "A new bucket"}</span>
        <span className="cfg-hint">
          {inBucket !== undefined
            ? "It starts holding nothing, with everything else asked about. Its lines are added once it has a name."
            : "A place with its own versions of the same names — chat/ask-first and chat_control/ask-first are two permission sets."}
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
            ? { errors: [{ path: `${path}.${inBucket === undefined && permissionSetBucketProblem(bucket.trim()) !== undefined ? "bucket" : "name"}`, message: problem }] }
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
export interface PermissionSetsChannel {
  read: () => Promise<PermissionSetsData>;
  write: (request: { id: string; layer: WritableLayer; permissionSet: PermissionSetDecl }) => Promise<unknown>;
  reset: (request: { id: string; layer: WritableLayer }) => Promise<unknown>;
}

/** A change made on the personal layer, held while the person says which layer it goes to. */
interface HeldChange {
  id: string;
  /** The map as the card showed it, and as the change left it — what {@link rebasePermissionSetChange} replays. */
  from: PermissionSetDecl;
  to: PermissionSetDecl;
}

/**
 * The state {@link PermissionSetsView} is drawn from, and the writes it asks for.
 *
 * Drafts are kept PER LAYER AND PERMISSION_SET, so that looking at another permission set loses
 * nothing. The selection is an id, not an index, which is the whole of "the selection survives a
 * save" — and a first change's copy: the records are re-read, this component does not remount, and
 * the id still resolves, now to the layer's own file.
 */
export function PermissionSetsPane({
  channel,
  layer,
  busy,
  focus,
  onData,
  mcp,
}: {
  channel: PermissionSetsChannel;
  /** The layer the page's switch is on — any of them; see {@link permissionSetLayersOf}. */
  layer: ConfigLayer;
  busy: boolean;
  /**
   * Open this permission set — what a cell of Settings → Tools → Functions asks for. `nonce` makes asking
   * for the same one twice open it again after the person has moved on.
   */
  focus?: { id: string; nonce: number } | undefined;
  /** Every read, handed up — the Functions table below draws the same records. */
  onData?: ((data: PermissionSetsData) => void) | undefined;
  /** The configured MCP servers and the tools each listed — what the card's MCP section groups by. */
  mcp?: readonly McpServerStatus[] | undefined;
}): JSX.Element {
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

  if (data === null) return <p className="empty">{failed !== null ? `Permission sets could not be read — ${failed}` : "Reading permission sets…"}</p>;

  const { reads, writesTo } = permissionSetLayersOf(layer, data.layers);
  const ats = permissionSetsAt(data.records, reads);
  const chosenId = wanted !== undefined && wanted !== "bucket" && "permissionSet" in wanted ? wanted.permissionSet : undefined;
  const resolved = resolvePermissionSetChoice(ats, chosenId, pending);
  const choice: PermissionSetChoiceOf | undefined = wanted === "bucket" || (wanted !== undefined && "newIn" in wanted) ? wanted : resolved !== undefined ? { permissionSet: resolved } : undefined;
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
        setTold(
          `${there?.here === true ? `Changed in ${INTO_NAME[into]}` : `Copied to ${INTO_NAME[into]}, with your change`} — ${file}.` +
            (hidden ? " This project has its own copy, and that is the one it reads." : ""),
        );
      },
    );
  };

  return (
    <PermissionSetsView
      data={data}
      layer={reads}
      writesTo={writesTo}
      choice={choice}
      onChoice={(next) => {
        setWanted(next);
        setComparing(false);
        setProblem(null);
        setPuttingBack(false);
        setHeld(null);
        setTold(null);
      }}
      drafts={drafts[reads] ?? {}}
      onDraft={(id, next) => (next === undefined ? dropDraft(reads, id) : setDrafts((current) => ({ ...current, [reads]: { ...current[reads], [id]: next } })))}
      comparing={comparing}
      onCompare={setComparing}
      naming={naming}
      onNaming={setNaming}
      locked={busy || writing}
      problem={problem}
      mcp={mcp}
      onSave={(id, permissionSet) => {
        if (writesTo === undefined) return;
        run(
          () => channel.write({ id, layer: writesTo, permissionSet: declOfPermissionSet(permissionSet) }),
          () => dropDraft(reads, id),
        );
      }}
      onReset={(id) => {
        if (writesTo === undefined) return;
        run(
          () => channel.reset({ id, layer: writesTo }),
          () => {
            dropDraft(reads, id);
            setComparing(false);
            setPuttingBack(false);
          },
        );
      }}
      puttingBack={puttingBack}
      onPutBack={setPuttingBack}
      onCopy={(id, next) => {
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
      }}
      asking={held?.id}
      onCopyTo={(into) => {
        if (held === null) return;
        if (into === null) setHeld(null);
        else send(held, into);
      }}
      told={told}
      onAdd={(bucket, name) => {
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
      }}
    />
  );
}
