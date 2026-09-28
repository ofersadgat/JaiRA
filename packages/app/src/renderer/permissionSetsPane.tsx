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
import type { JSX } from "react";
import {
  comparePermissionSets,
  copiedFrom,
  copyDifferences,
  declOfPermissionSet,
  isPermissionSetDirty,
  permissionSetBucketProblem,
  permissionSetFileLabel,
  permissionSetOfAt,
  permissionSetsAt,
  permissionSetStanding,
  usedByLine,
  type ConfigLayer,
  type PermissionSetAt,
  type PermissionSetDrafts,
  type PermissionSetsView as PermissionSetsData,
  type WritableLayer,
} from "@jaira/shared/browser";
import {
  INTO_NAME,
  LOWER_NAME,
  PERSONAL,
  choiceOfTab,
  detachingLines,
  newPermissionSetProblem,
  permissionSetRailRows,
  tabOfChoice,
  usePermissionSetsHost,
  type PermissionSetsChannel,
  type PermissionSetsViewProps,
  type RailFolds,
} from "./permissionSetsHost";
import { Icon } from "./icons";
import { TabRail, type RailItem } from "./llmConfigForm";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { Schema } from "./schemaForm/types";
import { SettingsSection } from "./settingsLayout";
import { PermissionSetCard } from "./permissionSetCard";
import type { McpServerStatus } from "@jaira/shared/browser";

export {
  NEW_PERMISSION_SET,
  detachingLines,
  newPermissionSetProblem,
  permissionSetLayersOf,
  type PermissionSetChoiceOf,
  type PermissionSetsChannel,
  type PermissionSetsViewProps,
  type RailFolds,
} from "./permissionSetsHost";
/**
 * The rail, as the tab rail takes it. With nowhere to write there are no `+` rows and no dots: the
 * dot means "the layer you are editing states it", and that layer states nothing. With `folds`, each
 * bucket is a fold; a closed one lists nothing under it, a bucket inside it included.
 */
export function permissionSetRailItems(
  ats: readonly PermissionSetAt[],
  writesTo: WritableLayer | undefined,
  drafts: PermissionSetDrafts,
  folds?: RailFolds,
): RailItem[] {
  return permissionSetRailRows(ats, writesTo, drafts, folds).map((row): RailItem => {
    if (row.kind === "bucket") {
      return {
        id: row.id,
        summary: null,
        indent: row.depth,
        title: row.path,
        ...(row.fold !== undefined ? { fold: row.fold } : {}),
        heading: (
          <>
            <span className="cx-chip-icon">
              <Icon name="folder" />
            </span>
            <span>{row.name}</span>
            <span className="cx-src">{row.layerLabel}</span>
          </>
        ),
      };
    }
    if (row.kind === "add") return { id: row.id, className: "set-rail-add", ...(row.depth !== undefined ? { indent: row.depth } : {}), summary: row.summary, title: row.title };
    const copy = row.copy !== undefined ? <span className="cx-src">{row.copy}</span> : null;
    return {
      id: row.id,
      mono: true,
      indent: row.depth,
      // The dot means "the layer you are EDITING states it".
      label:
        row.dot || copy !== null ? (
          <>
            {row.name}
            {row.dot ? <i className="set-here-dot" title="set in the layer you are editing" /> : null}
            {copy}
          </>
        ) : (
          row.name
        ),
      summary: row.summary,
    };
  });
}

const HEAD_HINT = (
  <>
    Which tools are offered, and what happens when each is called. A state names one as <code>$/permission-sets/&lt;bucket&gt;/&lt;name&gt;</code>; a bucket is a
    place with its own versions of the same names.
  </>
);

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
            items={permissionSetRailItems(
              ats,
              props.writesTo,
              props.drafts,
              props.openBuckets !== undefined && props.onBucket !== undefined ? { open: props.openBuckets, onFold: props.onBucket } : undefined,
            )}
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

/** The state {@link PermissionSetsView} is drawn from, and the writes it asks for — `permissionSetsHost.ts`. */
export function PermissionSetsPane({
  channel,
  layer,
  busy,
  focus,
  onData,
  mcp,
}: {
  channel: PermissionSetsChannel;
  /** The layer the page's switch is on — any of them; see `permissionSetLayersOf`. */
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
  const host = usePermissionSetsHost({ channel, layer, busy, focus, onData, mcp });
  if ("waiting" in host) return <p className="empty">{host.waiting}</p>;
  return <PermissionSetsView {...host.props} />;
}
