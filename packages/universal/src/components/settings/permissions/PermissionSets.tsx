import type { JSX, ReactNode } from "react";
import { View } from "@tamagui/core";
import {
  comparePermissionSets,
  copiedFrom,
  copyDifferences,
  declOfPermissionSet,
  isPermissionSetDirty,
  permissionSetBucketProblem,
  permissionSetFileLabel,
  permissionSetIconOf,
  permissionSetOfAt,
  permissionSetsAt,
  permissionSetStanding,
  usedByLine,
  type ConfigLayer,
  type McpServerStatus,
  type PermissionSetAt,
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
  standingBucketsOf,
  tabOfChoice,
  usePermissionSetsHost,
  type PermissionSetsChannel,
  type PermissionSetsViewProps,
  type StandingLayers,
} from "@jaira/ui/permissionSetsHost";
import { defaultBaseOf } from "@jaira/ui/stackPreviewModel";
import { setIconGlyph } from "@jaira/ui/permissionSetWords";
import type { Schema } from "@jaira/ui/schemaForm/types";
import { Press, Txt, edge } from "../../../primitives";
import { useTokens } from "../../../tokens";
import { SchemaForm } from "../../form/SchemaForm";
import { RailDetail, TabRail, type RailItem } from "../../form/LlmConfigForm";
import { Hint, PaneActions, SourceTag, Status } from "../bits";
import { Button } from "../Button";
import { SettingsSection } from "../SettingsPage";
import { ChipIcon } from "./rows";
import { PermissionSetCard } from "./PermissionSetCard";
import { StackPreview } from "./StackPreview";

/**
 * Settings → Tools → Permission sets: a rail of buckets beside one permission set, drawn as the
 * composer's Tools card is. What the host holds and every write are `permissionSetsHost.ts`'s
 * (`usePermissionSetsHost`). What it adds to the rail and detail of `LlmConfigForm.tsx`:
 *
 *   the two columns            the rail 212 | the detail; the rail's corner 7; a detail at least 330
 *                              tall; rail tabs padding 5 9
 *   a bucket's heading         row, centred, gap 6, padding 9 8 3 (the first: 3 at the top), data 600 at
 *                              11.5/12.5 on 1.3, --text; as a fold a button (hovered --text 6%), its ›
 *                              8 wide --tok-hint turned open; its folder 13 --tok-hint; its layer a
 *                              `SourceTag` at the end
 *   the detail's title         row, centred, gap 8, wraps
 *   a question, a comparison   --panel-2 cards, 1px --line, app 11.5/12.5
 *   a bucket's standing layers under its heading, 27 in: `layered on every set:` --tok-hint, each
 *                              layer's id in the data face, --accent, joined by ` · `
 *   a set's icon               13, --tok-hint, before its name in the rail and in the detail's title
 */
export function PermissionSetsSection({
  channel,
  layer,
  busy,
  focus,
  onData,
  mcp,
  standing,
}: {
  channel: PermissionSetsChannel;
  layer: ConfigLayer;
  busy: boolean;
  focus?: { id: string; nonce: number } | undefined;
  onData?: ((data: PermissionSetsData) => void) | undefined;
  mcp?: readonly McpServerStatus[] | undefined;
  /** Each bucket's standing layers, from settings (`permissions.layers`). */
  standing?: StandingLayers | undefined;
}): JSX.Element {
  const host = usePermissionSetsHost({ channel, layer, busy, focus, onData, mcp, standing });
  if ("waiting" in host) {
    return (
      <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8}>
        {host.waiting}
      </Txt>
    );
  }
  return <PermissionSetsView {...host.props} />;
}

const HEAD_HINT = (
  <>
    {"Which tools are offered, and what happens when each is called. A state names one as "}
    <Txt spec={{ voice: "data", scale: 11 / 12, lineHeight: 1.4, color: "dim" }}>{"$/permission-sets/<bucket>/<name>"}</Txt>
    {"; a bucket is a place with its own versions of the same names."}
  </>
);

function PermissionSetsView(props: PermissionSetsViewProps): JSX.Element {
  const t = useTokens();
  const ats = permissionSetsAt(props.data.records, props.layer);
  const open = props.choice !== undefined && props.choice !== "bucket" && "permissionSet" in props.choice ? ats.find((at) => at.id === (props.choice as { permissionSet: string }).permissionSet) : undefined;
  const adding = props.choice === "bucket" || (props.choice !== undefined && typeof props.choice === "object" && "newIn" in props.choice);
  const rows = permissionSetRailRows(ats, props.writesTo, props.drafts, props.openBuckets !== undefined && props.onBucket !== undefined ? { open: props.openBuckets, onFold: props.onBucket } : undefined, props.standing);
  const items: RailItem[] = rows.map((row, i): RailItem => {
    if (row.kind === "bucket")
      return { id: row.id, summary: null, heading: <BucketHeading name={row.name} layer={row.layerLabel} depth={row.depth} first={i === 0} {...(row.fold !== undefined ? { fold: row.fold } : {})} {...(row.standing !== undefined ? { standing: row.standing } : {})} /> };
    if (row.kind === "add") return { id: row.id, add: true, summary: row.summary, title: row.title, ...(row.depth !== undefined ? { indent: row.depth } : {}) };
    return {
      id: row.id,
      indent: row.depth,
      label: (
        <>
          <View display={"inline-flex" as "flex"} marginRight={6}>
            <ChipIcon name={setIconGlyph(row.icon)} />
          </View>
          {row.name}
          {row.dot ? <View display={"inline-flex" as "flex"} width={6} height={6} marginLeft={6} borderRadius={999} backgroundColor={t.v("accent") as never} /> : null}
          {row.copy !== undefined ? <SourceTag>{row.copy}</SourceTag> : null}
        </>
      ),
      summary: row.summary,
    };
  });
  return (
    <SettingsSection id="permission-sets" title="Permission sets" lead={HEAD_HINT} wide>
      {/* The rail and the detail's box: the card's padding, inside its own ring. */}
      <View flexDirection="row" alignItems="stretch" borderRadius={8} paddingVertical={13} paddingHorizontal={16} backgroundColor={t.v("panel") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
        <TabRail width={212} pad={[5, 9]} corner={7} label="Permission sets" items={items} selected={tabOfChoice(open !== undefined ? { permissionSet: open.id } : adding ? props.choice : undefined)} onSelect={(id) => props.onChoice(choiceOfTab(id))} />
        {open !== undefined ? (
          <OpenPermissionSet key={`${props.layer}:${open.id}`} at={open} {...props} />
        ) : adding && props.writesTo !== undefined ? (
          <NewPermissionSet ats={ats} {...props} />
        ) : (
          <RailDetail title="" hints={[]} minHeight={330}>
            <Hint>{ats.length === 0 ? "No permission sets here." : "Pick a permission set."}</Hint>
          </RailDetail>
        )}
      </View>
    </SettingsSection>
  );
}

/** A bucket's name over its permission sets — a heading in the rail, a fold — and the layers laid on every set in it. */
function BucketHeading({ name, layer, depth, first, fold, standing }: { name: string; layer: string; depth: number; first: boolean; fold?: { open: boolean; onFold: () => void }; standing?: readonly string[] }): JSX.Element {
  const t = useTokens();
  const words = (
    <>
      {fold !== undefined ? (
        <Txt spec={{ voice: "data", scale: (11.5 / 12.5) * (12.5 / 12), weight: 600, lineHeight: 1.3, color: "tok-hint" }} width={8} flexShrink={0} transform={[{ rotate: fold.open ? "90deg" : "0deg" }]}>
          ›
        </Txt>
      ) : null}
      <ChipIcon name="folder" />
      <Txt spec={{ voice: "data", scale: (11.5 / 12.5) * (12.5 / 12), weight: 600, lineHeight: 1.3 }} numberOfLines={1}>
        {name}
      </Txt>
      <View flexGrow={1} />
      <SourceTag first>{layer}</SourceTag>
    </>
  );
  const box = { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: first ? 3 : 9, paddingHorizontal: 8, paddingBottom: 3, marginLeft: depth * 12 } as const;
  const head =
    fold !== undefined ? (
      <Press onPress={fold.onFold} {...({ "aria-expanded": fold.open } as object)} {...box} borderRadius={6} box={({ hovered }) => ({ backgroundColor: hovered ? t.mix(t.v("text"), 6, "transparent") : "transparent" })}>
        {words}
      </Press>
    ) : (
      <View {...box}>{words}</View>
    );
  if (standing === undefined || standing.length === 0) return head;
  return (
    <View>
      {head}
      <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.35, color: "tok-hint" }} marginLeft={depth * 12 + 27} paddingRight={8} paddingBottom={4} {...({ title: "its standing layers (settings: permissions.layers) — laid over every set of it, oldest first" } as object)}>
        {"layered on every set: "}
        {standing.map((id, i) => (
          <Txt key={id} spec={{ voice: "data", scale: 10.5 / 12, lineHeight: 1.35, color: "accent" }}>
            {i > 0 ? ` · ${id}` : id}
          </Txt>
        ))}
      </Txt>
    </View>
  );
}

/** One permission set: its path and standing, the card, and what can be done with it as a whole. */
function OpenPermissionSet({ at, ...props }: PermissionSetsViewProps & { at: PermissionSetAt }): JSX.Element {
  const t = useTokens();
  const standing = permissionSetStanding(at);
  const own = at.here && props.writesTo !== undefined;
  const draft = props.drafts[at.id];
  const dirty = own && isPermissionSetDirty(at, draft);
  const shown = own ? (draft ?? permissionSetOfAt(at)) : permissionSetOfAt(at);
  const editable = own && at.source.format === "json" && at.source.decl !== undefined;
  const copyable = !own && at.source.decl !== undefined;
  const asking = props.asking === at.id;
  const from = copiedFrom(at);
  const differ = copyDifferences(at);
  const detaching = detachingLines(at, draft);
  const differences = props.comparing && at.lower?.decl !== undefined ? comparePermissionSets(at.lower.decl, declOfPermissionSet(shown)) : [];
  const into = (["base", "project"] as WritableLayer[]).filter((layer) => props.data.layers.includes(layer));
  // A path is in the hint's own face here, not the data face.
  const mono = (text: string): string => text;
  const standsIn = standingBucketsOf(props.standing, at.id);
  const title = (
    <View flexDirection="row" alignItems="center" gap={8} flexWrap="wrap">
      <ChipIcon name={setIconGlyph(permissionSetIconOf(at.id, at.source.decl))} size={14} />
      <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600 }} {...({ title: at.source.file } as object)}>
        {[...(at.bucket === "" ? [] : at.bucket.split("/")), at.name].join(" / ")}
      </Txt>
      <Status weight={600} kind={standing.here && props.writesTo !== undefined ? "here" : "unchecked"}>
        {standing.label}
      </Status>
      {standsIn.map((bucket) => (
        <Status key={bucket} weight={600} kind="unchecked" title={`settings: permissions.layers.${bucket} — laid over every ${bucket} set, oldest first`}>
          {bucket === "" ? "standing layer at the top level" : `standing layer of ${bucket}`}
        </Status>
      ))}
      {standing.shadowed !== undefined ? (
        <Status weight={600} kind="unchecked" title="a nearer layer holds a permission set of this name, and a bare $/permission-sets reference finds that one first">
          {standing.shadowed}
        </Status>
      ) : null}
    </View>
  );
  const line: ReactNode[] = [...standsIn.map((bucket) => (bucket === "" ? "layered on every top-level set · " : `layered on every ${bucket} set · `)), usedByLine(props.data.usedBy[at.id])];
  const bases = permissionSetsAt(props.data.records, props.layer)
    .filter((one) => one.id !== at.id && one.source.decl !== undefined)
    .map((one) => ({ id: one.id, name: one.name, icon: permissionSetIconOf(one.id, one.source.decl), decl: one.source.decl as Record<string, unknown> }));
  const base = props.stack.base !== undefined && bases.some((one) => one.id === props.stack.base) ? props.stack.base : defaultBaseOf(at.id, bases.map((one) => one.id), props.standing);
  if (differ !== undefined && from !== undefined) {
    line.push(" · ");
    if (differ === 0) line.push(`nothing differs from ${LOWER_NAME[from]}`);
    else
      line.push(
        <Txt key="b" spec={{ voice: "app", scale: 11 / 12.5, lineHeight: 1.4, weight: 700, color: "dim" }}>{`${differ} line${differ === 1 ? "" : "s"}`}</Txt>,
        ` ${differ === 1 ? "differs" : "differ"} from ${LOWER_NAME[from]}`,
      );
    line.push(" — ", mono(at.source.file));
  }
  if (copyable) {
    if (props.writesTo !== undefined) line.push(" · your first change copies it to ", mono(permissionSetFileLabel(props.writesTo, at.id)));
    else line.push(` · ${PERSONAL} holds no permission sets, so your first change asks where to copy it`);
  }
  return (
    <RailDetail title={title} hints={[]} line={<Hint>{line.map((part, i) => (typeof part === "string" ? part : <Txt key={i}>{part}</Txt>))}</Hint>} minHeight={330}>
      {at.source.decl === undefined ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }}>{`${at.source.file} could not be read as a permission set — ${at.source.problem ?? "it is not a map from a subject to a mode"}. Open it in Files to fix it.`}</Txt>
      ) : (
        <PermissionSetCard
          permissionSet={shown}
          tools={props.data.tools}
          readOnly={!(editable || copyable) || asking || props.locked}
          onChange={editable ? (next) => props.onDraft(at.id, next) : copyable ? (next) => props.onCopy(at.id, next) : undefined}
          mcp={props.mcp}
        />
      )}
      {at.source.decl !== undefined ? (
        <StackPreview
          layer={{ id: at.id, name: at.name, decl: declOfPermissionSet(shown) as Record<string, unknown> }}
          sets={bases}
          base={base}
          shown={props.stack.shown}
          onShown={(next) => props.onStack({ ...props.stack, shown: next })}
          onBase={(id) => props.onStack({ shown: true, base: id })}
        />
      ) : null}
      {own && at.source.format !== "json" ? <Hint>This layer holds it as a YAML file, which JaiRA reads and does not edit. Change it in Files.</Hint> : null}
      {detaching.length > 0 ? (
        <Hint color="text" maxWidth={560} paddingVertical={6} paddingHorizontal={9} borderRadius={8} backgroundColor={t.mix(t.v("warn"), 10, "transparent") as never}>
          {`Taking out ${detaching.map((subject) => `'${subject}'`).join(", ")} is something an override cannot say — a line left out means "as ${LOWER_NAME[at.lower!.layer]} says". Saving writes this permission set whole, and it stops following ${LOWER_NAME[at.lower!.layer]}.`}
        </Hint>
      ) : null}
      {props.comparing && at.lower !== undefined ? (
        <View flexDirection="column" gap={1} maxWidth={560} marginTop={4} paddingVertical={7} paddingHorizontal={9} borderRadius={10} backgroundColor={t.v("panel-2") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
          <CompareRow cells={["line", LOWER_NAME[at.lower.layer], "here"]} head />
          {differences.length === 0 ? (
            <Hint>{`Nothing differs: this says exactly what ${LOWER_NAME[at.lower.layer]} says.`}</Hint>
          ) : (
            differences.map((row) => <CompareRow key={row.subject} cells={[row.subject, row.theirs ?? "no line", row.ours ?? "taken out"]} none={[false, row.theirs === undefined, row.ours === undefined]} />)
          )}
        </View>
      ) : null}
      {props.told !== null ? <Hint>{props.told}</Hint> : null}
      {props.problem !== null ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }}>{props.problem}</Txt> : null}
      {asking ? (
        <Ask>
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5 }}>
            {`${PERSONAL} is one settings file, and a permission set is a file of its own. Copy `}
            {at.id}
            {", with your change, to:"}
          </Txt>
          <PaneActions>
            {into.map((layer, i) => (
              <Button key={layer} kind={i === 0 ? "primary" : "ghost"} disabled={props.locked} title={`write ${permissionSetFileLabel(layer, at.id)}`} onPress={() => props.onCopyTo(layer)}>
                {`Copy to ${INTO_NAME[layer]}`}
              </Button>
            ))}
            <Button kind="ghost" onPress={() => props.onCopyTo(null)}>
              Cancel
            </Button>
          </PaneActions>
        </Ask>
      ) : own && props.puttingBack && from === "system" ? (
        <Ask>
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5 }}>
            {"Put back the built-in? This deletes "}
            {`${at.source.file}.`}
          </Txt>
          <PaneActions>
            <Button kind="danger" disabled={props.locked} onPress={() => props.onReset(at.id)}>
              Put back
            </Button>
            <Button kind="ghost" onPress={() => props.onPutBack(false)}>
              Cancel
            </Button>
          </PaneActions>
        </Ask>
      ) : own ? (
        <PaneActions marginTop="auto">
          <Button kind="primary" disabled={props.locked || !dirty} onPress={() => props.onSave(at.id, shown)}>
            Save
          </Button>
          <Button kind="ghost" disabled={!dirty} onPress={() => props.onDraft(at.id, undefined)}>
            Revert
          </Button>
          <View flex={1} minWidth={0} />
          {at.lower !== undefined ? (
            <>
              <Press onPress={() => props.onCompare(!props.comparing)} {...({ "aria-expanded": props.comparing } as object)}>
                {({ hovered }) => (
                  <Txt spec={{ voice: "data", scale: 11 / 12, color: "accent" }} textDecorationLine={hovered ? "underline" : "none"}>
                    {props.comparing ? "Hide the comparison" : `Compare with ${LOWER_NAME[at.lower!.layer]}`}
                  </Txt>
                )}
              </Press>
              {from === "system" ? (
                <Button kind="danger" disabled={props.locked} title={`delete ${at.source.file}, so what ships answers again`} onPress={() => props.onPutBack(true)}>
                  Put back the built-in
                </Button>
              ) : (
                <Button kind="danger" disabled={props.locked} title={`delete ${at.source.file}, so ${LOWER_NAME[at.lower.layer]} answers again`} onPress={() => props.onReset(at.id)}>
                  Reset to shared
                </Button>
              )}
            </>
          ) : null}
        </PaneActions>
      ) : null}
    </RailDetail>
  );
}

/** A question asked in the page, in the actions' place. */
function Ask({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="column" gap={6} maxWidth={560} marginTop="auto" paddingVertical={8} paddingHorizontal={10} borderRadius={8} backgroundColor={t.v("panel-2") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
      {children}
    </View>
  );
}

/** A row of the comparison: the line, theirs, ours. */
function CompareRow({ cells, head = false, none = [false, false, false] }: { cells: readonly string[]; head?: boolean; none?: readonly boolean[] }): JSX.Element {
  return (
    <View flexDirection="row" gap={8} alignItems="baseline" paddingVertical={2}>
      {cells.map((cell, i) => (
        <Txt
          key={i}
          spec={head ? { voice: "app", scale: 10 / 12.5, ls: 0.05, upper: true, color: "tok-hint" } : { voice: "app", scale: 11.5 / 12.5, ...(none[i] === true ? { color: "tok-hint", italic: true } : {}) }}
          flexGrow={i === 0 ? 1.4 : 1}
          flexShrink={1}
          flexBasis={0}
          minWidth={0}
        >
          {cell}
        </Txt>
      ))}
    </View>
  );
}

const NAME_SCHEMA: Schema = { type: "object", required: ["name"], properties: { name: { type: "string", title: "Name", description: "The file's name — what a state writes after the bucket.", minLength: 1 } } };
const BUCKET_SCHEMA: Schema = {
  type: "object",
  required: ["bucket", "name"],
  properties: {
    bucket: { type: "string", title: "Bucket", description: "A folder under permission-sets/. It may nest: feature/implementation.", minLength: 1 },
    name: { type: "string", title: "First permission set", description: "A bucket is a folder, and exists by holding one.", minLength: 1 },
  },
};

/** `+ permission set` and `+ bucket`: a name is all a new one needs. */
function NewPermissionSet({ ats, ...props }: PermissionSetsViewProps & { ats: readonly PermissionSetAt[] }): JSX.Element {
  const inBucket = props.choice !== "bucket" && props.choice !== undefined && "newIn" in props.choice ? props.choice.newIn : undefined;
  const bucket = inBucket ?? props.naming.bucket ?? "";
  const name = props.naming.name ?? "";
  const typed = name.trim().length > 0 || (inBucket === undefined && bucket.trim().length > 0);
  const problem = newPermissionSetProblem(ats, bucket, name);
  const path = `permission sets${inBucket !== undefined && inBucket !== "" ? `/${inBucket}` : ""}`;
  return (
    <RailDetail
      minHeight={330}
      title={
        inBucket !== undefined ? (
          <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600 }}>
            {"A new permission set in "}
            {inBucket}
          </Txt>
        ) : (
          "A new bucket"
        )
      }
      hints={[
        inBucket !== undefined
          ? "It starts holding nothing, with everything else asked about. Its lines are added once it has a name."
          : "A place with its own versions of the same names — ask-first and control/ask-first are two permission sets.",
      ]}
    >
      <SchemaForm
        schema={inBucket !== undefined ? NAME_SCHEMA : BUCKET_SCHEMA}
        value={inBucket !== undefined ? { name } : { bucket, name }}
        onChange={(next) => {
          const value = (next ?? {}) as { bucket?: unknown; name?: unknown };
          props.onNaming({ ...(typeof value.bucket === "string" ? { bucket: value.bucket } : {}), ...(typeof value.name === "string" ? { name: value.name } : {}) });
        }}
        ctx={{
          path,
          disabled: props.locked,
          ...(typed && problem !== undefined ? { errors: [{ path: `${path}.${inBucket === undefined && permissionSetBucketProblem(bucket.trim()) !== undefined ? "bucket" : "name"}`, message: problem }] } : {}),
        }}
      />
      {props.problem !== null ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }}>{props.problem}</Txt> : null}
      <PaneActions marginTop="auto">
        <Button kind="primary" disabled={props.locked || problem !== undefined} onPress={() => props.onAdd(bucket.trim(), name.trim())}>
          Add it
        </Button>
      </PaneActions>
    </RailDetail>
  );
}
