import { Children, type JSX, type ReactNode } from "react";
import { ScrollView, Text as RNText } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import {
  WORKFLOW_JSON,
  type ExecutorInfo,
  type FileTree,
  type LintIssue,
  type StateSlotInfo,
  type StateSlots,
  type ValidateSchemaResult,
  type WorkflowLayer,
  type WorkflowSource,
} from "@jaira/shared/browser";
import { layerActionLabel, layerBarOf, type LayerBarAction, type LayerBarModel } from "@jaira/ui/builtInModel";
import { childKeyOptions, childStateOptions } from "@jaira/ui/completions";
import type { EditorTab } from "@jaira/ui/stateEditorModel";
import type { UiSurface } from "@jaira/ui/fileTypes";
import { fieldClass, type FormIssues } from "@jaira/ui/issues";
import { LinkReaderProvider } from "@jaira/ui/linkModel";
import { REF_HINT } from "@jaira/ui/operationFieldsModel";
import { EMPTY_OPERATION_FIELDS } from "@jaira/ui/operationForm";
import { ReadOnlyContext, useRunReading } from "@jaira/ui/reading";
import {
  ENVIRONMENT_KINDS,
  MOUNT_KINDS,
  NO_STATE_SLOTS,
  OPERATION_KINDS,
  TABS,
  TAB_TITLES,
  TAB_WORDS,
  bindingTableOf,
  childRowOf,
  editedRow,
  editorPathOf,
  freeChildKeys,
  kindMarksOf,
  moved,
  outputsEmptyMeans,
  savesOf,
  transitionMarksOf,
  transitionTargetsOf,
  useWorkflowEditor,
  type LayerActions,
} from "@jaira/ui/stateEditorModel";
import { emptyBindingRow, emptyChildRow, type BindingRow, type ChildRow, type TransitionRow } from "@jaira/ui/stateForm";
import { Island } from "../../islands";
import { PLAIN_SCROLLER, Press, Txt, edge, font, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { CodeArea, IslandBand, useEditorAppearance } from "../files/CodeEdit";
import { EditorActions, Sub as ActionsSub } from "../files/EditorActions";
import { SchemaJsonEditor } from "../files/SchemaEdit";
import { Area, Box, Details, Empty, FieldName, LinkButton, ListsProvider, Pick, ROW, ReadingBody, Reason, SlotOpt, SlotOptWords, SlotsHead, SmallButton, Sub, markOf, useLists, useReadOnly, type Lists } from "./controls";
import { LinkInput, LinkPreview, ReadValue } from "./Links";
import { Field, OperationFieldsEditor } from "./OperationFields";
import { Grid, Hung, RowControls, SlotGroup, SlotTable } from "./SlotTable";
import { StateGraphView } from "./StateGraph";

/**
 * `stateEditor.tsx`'s `WorkflowEditor`, universal (decision 0015): one state file as a form, its JSON
 * and its graph, over one document. Everything it holds and decides — the drafts, copy-on-edit, the
 * merge, the completions, the children's declared slots, "Compare with what ships" — is
 * `stateEditorModel.ts`'s `useWorkflowEditor`, the hook the desktop's runs; this draws it. The JSON
 * tab's text and the comparison are islands (`schemaText`, `diff`). The rules:
 *
 *   .pane.editor           column, gap 8
 *   .edit-bar.editor-top   row, centred, gap 8; `.file-path` a `.sub` cut with … at its START (rtl)
 *   .chip                  app 10/12.5 --dim, 1px --line, round, padding 0 6; `.chip-warn` --warn
 *   .tabs.seg              the tabs joined: padding 2 11, app 11/12.5, radii 5 at the ends, the last 1
 *                          back over its neighbour; `.layer-on` --fill-accent, --on-accent 600, --sheen
 *   .pane.editor > .form   the rest, scrolling (padding 1 1 2) — in a reading the fieldset holds it
 *   .form                  column, gap 8; `.identity` gap 5, `.field.inline` 78 | 1fr, gap 8, centred,
 *                          its name right-aligned
 *   .slot-row.child-row    22 | 1fr | 1.3fr | auto ×4; `.seq` data 10/12 --dim centred, tabular
 *   .child-state           row, centred, gap 5; `.mount-id` data 10.5/12 --dim, cut with …
 *   .slot-row.binding-row  1fr | 14 | 1.4fr | auto; `.transition-row` 1.4fr | 14 | 1fr | auto auto
 *   .slots.children        each child a --panel-2 card (1px --line, radius 6, padding 6 7, 6 apart)
 *   .reorder               row, gap 2; its buttons padding 2 5 on a line of 1
 */

/**
 * The ↑/↓ pair, where the order of a table means something — nothing in a reading. `.reorder button`'s
 * padding 2 5 loses to `button.sm`'s 2 8 (equal specificity, later); its line of 1 stands.
 */
function Reorder({ index, count, onMove }: { index: number; count: number; onMove: (to: number) => void }): JSX.Element | null {
  if (useReadOnly()) return null;
  return (
    <View flexDirection="row" gap={2}>
      <SmallButton title="move up" disabled={index === 0} onPress={() => onMove(index - 1)} lineOne>
        ↑
      </SmallButton>
      <SmallButton title="move down" disabled={index === count - 1} onPress={() => onMove(index + 1)} lineOne>
        ↓
      </SmallButton>
    </View>
  );
}

/** A dim arrow in its own track (`.slot-row .arrow`), centred. */
function Arrow({ children }: { children: string }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} textAlign="center">
      {children}
    </Txt>
  );
}

/** A fixed-width grid: {@link Grid} with `px` tracks drawn at their width. */
function FixedGrid({ tracks, children, ...box }: { tracks: readonly (number | "auto" | { px: number })[]; children: ReactNode } & Record<string, unknown>): JSX.Element {
  const cells = Children.toArray(children);
  return (
    <View flexDirection="row" alignItems="center" gap={5} minWidth={0} {...box}>
      {tracks.map((track, i) => (
        <View
          key={i}
          justifyContent="center"
          {...(track === "auto" ? { flexGrow: 0, flexShrink: 0 } : typeof track === "object" ? { width: track.px, flexShrink: 0 } : { flexGrow: track, flexShrink: 1, flexBasis: 0, minWidth: 0 })}
        >
          {cells[i] ?? null}
        </View>
      ))}
    </View>
  );
}

/** One child's input wiring (`BindingTable`): a row per wire, and what the run called it with. */
function BindingTable({
  rows,
  slots,
  path,
  issues,
  onChange,
}: {
  rows: BindingRow[];
  slots: readonly StateSlotInfo[];
  path?: string | undefined;
  issues: FormIssues;
  onChange: (rows: BindingRow[]) => void;
}): JSX.Element {
  const readOnly = useReadOnly();
  const reading = useRunReading();
  const lists = useLists();
  const table = bindingTableOf(rows, slots, path, issues, REF_HINT);
  const wired = table.childKey === undefined ? undefined : reading?.children?.[table.childKey];
  // The child's declared slots, the row's own datalist (`child-inputs-<i>`).
  const slotList = slots.map((slot) => ({ value: slot.name, label: slot.optional ? "optional" : "required" }));
  const edit = (index: number, patch: Partial<BindingRow>): void => onChange(editedRow(rows, index, patch));
  return (
    <Hung inCard>
      <View flexDirection="column" gap={3}>
        <SlotsHead title="Inputs" sub="wired into the child's declared slots" strong={false}>
          {readOnly ? null : (
            <SmallButton weight={600} onPress={() => onChange([...rows, emptyBindingRow()])}>
              + Wire
            </SmallButton>
          )}
        </SlotsHead>
        {rows.length === 0 ? (
          <Sub>none — the child&apos;s inputs must all be optional or defaulted, or it cannot run</Sub>
        ) : (
          rows.map((row, i) => {
            const view = table.rows[i]!;
            return (
              <View key={i} flexDirection="column" gap={2}>
                <FixedGrid tracks={[1, { px: 14 }, 1.4, "auto"]}>
                  {[
                    <Box key="n" value={row.name} onChange={(name) => edit(i, { name })} placeholder="the child's input" size={ROW} listed={slotList} mark={view.unwired && view.nameMark === "" ? "warn" : markOf(view.nameMark)} title={view.slot?.description} />,
                    <Arrow key="a">←</Arrow>,
                    <Box
                      key="v"
                      value={row.value}
                      onChange={(value) => edit(i, { value })}
                      placeholder={view.valuePlaceholder}
                      size={ROW}
                      listed={lists.bindings}
                      disabled={row.structured === true}
                      mark={view.unwired && view.valueMark === "" ? "warn" : markOf(view.valueMark)}
                      title={view.valueTitle}
                    />,
                    ...(readOnly
                      ? []
                      : [
                          <SmallButton key="x" title="remove" onPress={() => onChange(rows.filter((_, j) => j !== i))}>
                            ✕
                          </SmallButton>,
                        ]),
                  ]}
                </FixedGrid>
                <ReadValue value={wired?.[row.name.trim()]} />
              </View>
            );
          })
        )}
      </View>
    </Hung>
  );
}

/** The children table, in run order: each child's mount, its wiring and its per-mount environment. */
function ChildrenTable({
  rows,
  functions: _functions,
  declared,
  stateIdOf,
  issues,
  onChange,
}: {
  rows: ChildRow[];
  functions: Array<{ name: string; note: string }>;
  declared: Record<string, StateSlots>;
  stateIdOf: (row: ChildRow) => string;
  issues: FormIssues;
  onChange: (rows: ChildRow[]) => void;
}): JSX.Element {
  const t = useTokens();
  const readOnly = useReadOnly();
  const lists = useLists();
  const edit = (index: number, patch: Partial<ChildRow>): void => onChange(editedRow(rows, index, patch));
  return (
    <View flexDirection="column" gap={5} paddingTop={8} {...(edge(t, { top: 1 }) as object)}>
      <SlotsHead title="Children" sub={rows.length > 1 ? "in run order" : ""}>
        {readOnly ? null : (
          <SmallButton weight={600} onPress={() => onChange([...rows, emptyChildRow()])}>
            + Add
          </SmallButton>
        )}
      </SlotsHead>
      {rows.length === 0 ? (
        <Sub marginLeft={11}>none — this state runs its own operation and nothing below it</Sub>
      ) : (
        rows.map((row, i) => {
          const view = childRowOf(row, issues, stateIdOf, readOnly);
          const env = row.environment;
          return (
            <View key={i} marginLeft={11}>
              <SlotGroup first={i === 0} box>
                <FixedGrid tracks={[{ px: 22 }, 1, 1.3, "auto", "auto", "auto", "auto"]}>
                  {[
                    <Txt key="s" spec={{ voice: "data", scale: 10 / 12, color: "dim", tabular: true }} textAlign="center">
                      {String(i + 1)}
                    </Txt>,
                    <Box key="k" value={row.key} onChange={(key) => edit(i, { key })} placeholder="key" size={ROW} listed={lists.childKeys} />,
                    <View key="st" flexDirection="row" alignItems="center" gap={5} minWidth={0}>
                      {/* The box is the flex item (`flex: 1 1 auto` on its `width: 100%`), padding and all. */}
                      <Box value={row.state} onChange={(state) => edit(i, { state })} placeholder={view.statePlaceholder} size={ROW} listed={lists.childStates} mark={markOf(view.stateMark)} flexGrow={1} flexShrink={1} />
                      {view.resolved.length > 0 ? (
                        <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "dim" }} numberOfLines={1} ellipsizeMode="tail" flexGrow={0} flexShrink={1} minWidth={0} {...({ title: `this mount runs the state '${view.resolved}'` } as object)}>
                          → {view.resolved}
                        </Txt>
                      ) : null}
                    </View>,
                    ...(readOnly
                      ? [...(row.inSpine ? [<SlotOptWords key="sp">in the sequence</SlotOptWords>] : []), ...(row.async ? [<SlotOptWords key="as">async</SlotOptWords>] : [])]
                      : [
                          <SlotOpt key="sp" checked={row.inSpine} onChange={(inSpine) => edit(i, { inSpine })} title="in the sequence: the cursor walks into it. Off means it runs only if a transition names it.">
                            spine
                          </SlotOpt>,
                          <SlotOpt key="as" checked={row.async} onChange={(async) => edit(i, { async })} title="SPEC §10.4: starting this child does not block the sequence">
                            async
                          </SlotOpt>,
                        ]),
                    ...(readOnly ? [] : [<Reorder key="r" index={i} count={rows.length} onMove={(to) => onChange(moved(rows, i, to))} />]),
                    ...(readOnly
                      ? []
                      : [
                          <SmallButton key="x" title="remove" onPress={() => onChange(rows.filter((_, j) => j !== i))}>
                            ✕
                          </SmallButton>,
                        ]),
                  ]}
                </FixedGrid>
                <BindingTable rows={row.inputs} slots={declared[stateIdOf(row)]?.inputs ?? []} path={view.inputsPath} issues={issues} onChange={(inputs) => edit(i, { inputs })} />
                {!view.environmentShown ? null : (
                  <Hung inCard>
                    <Details
                      summary={
                        <>
                          environment
                          <Text>{" · defaults for this mount only"}</Text>
                        </>
                      }
                      open={view.environmentOpen}
                    >
                      <View flexDirection="column" gap={4}>
                        <RowControls>
                          <Pick
                            value={env.kind}
                            options={MOUNT_KINDS.map((k) => ({ value: k.value, label: k.label }))}
                            mark={markOf(view.environmentMark)}
                            title="the operation kind this mount supplies to a child that leaves it to the chain"
                            onChange={(kind) => edit(i, { environment: { ...env, kind: kind as ChildRow["environment"]["kind"] } })}
                          />
                          <Box value={env.functionRef} listed={lists.functions} onChange={(functionRef) => edit(i, { environment: { ...env, functionRef } })} placeholder="function — e.g. claude-code on one mount, codex-cli on another" />
                          <Box value={env.model} onChange={(model) => edit(i, { environment: { ...env, model } })} placeholder="model" />
                        </RowControls>
                        <Sub>anything else on this mount&apos;s environment is kept as written — edit it on the JSON tab</Sub>
                      </View>
                    </Details>
                  </Hung>
                )}
              </SlotGroup>
            </View>
          );
        })
      )}
    </View>
  );
}

/** The transitions table — ordered, since the first match wins. */
function TransitionsTable({ rows, issues, onChange }: { rows: TransitionRow[]; issues: FormIssues; onChange: (rows: TransitionRow[]) => void }): JSX.Element {
  const t = useTokens();
  const readOnly = useReadOnly();
  const lists = useLists();
  const edit = (index: number, patch: Partial<TransitionRow>): void => onChange(editedRow(rows, index, patch));
  return (
    <View flexDirection="column" gap={5} paddingTop={8} {...(edge(t, { top: 1 }) as object)}>
      <SlotsHead title="Transitions" sub={rows.length > 1 ? "first match wins" : ""}>
        {readOnly ? null : (
          <SmallButton weight={600} onPress={() => onChange([...rows, { when: "", to: "" }])}>
            + Add
          </SmallButton>
        )}
      </SlotsHead>
      {rows.length === 0 ? (
        <Sub marginLeft={11}>none — the state terminates when its children are done</Sub>
      ) : (
        rows.map((row, i) => {
          const marks = transitionMarksOf(issues, i);
          return (
            <FixedGrid key={i} marginLeft={11} tracks={[1.4, { px: 14 }, 1, "auto", "auto"]}>
              {[
                <Box
                  key="w"
                  value={row.when}
                  onChange={(when) => edit(i, { when })}
                  placeholder="guard — empty is unconditional, and must infer to boolean"
                  size={ROW}
                  listed={lists.guards}
                  disabled={row.structured === true}
                  mark={markOf(marks.when)}
                  title={row.structured === true ? "a lowered guard — edit it on the JSON tab" : undefined}
                />,
                <Arrow key="a">→</Arrow>,
                <Box key="t" value={row.to} onChange={(to) => edit(i, { to })} placeholder="child key or terminate.success" size={ROW} listed={lists.transitions} mark={markOf(marks.to)} />,
                ...(readOnly ? [] : [<Reorder key="r" index={i} count={rows.length} onMove={(to) => onChange(moved(rows, i, to))} />]),
                ...(readOnly
                  ? []
                  : [
                      <SmallButton key="x" title="remove" onPress={() => onChange(rows.filter((_, j) => j !== i))}>
                        ✕
                      </SmallButton>,
                    ]),
              ]}
            </FixedGrid>
          );
        })
      )}
    </View>
  );
}

/** `.chip`: app 10/12.5, --dim, 1px --line, round, padding 0 6 — `.chip-warn` in --warn. */
export function Chip({ tone = "plain", title, children }: { tone?: "plain" | "warn" | "bad" | "ok" | "accent"; title?: string | undefined; children: ReactNode }): JSX.Element {
  const t = useTokens();
  const ink = tone === "plain" ? "dim" : tone;
  return (
    <View flexShrink={0} paddingHorizontal={6} borderRadius={999} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, tone === "plain" ? "line" : tone) as object)} {...(isWeb && title !== undefined ? { title } : {})}>
      <Txt spec={{ voice: "app", scale: 10 / 12.5, color: ink }} numberOfLines={1}>
        {children}
      </Txt>
    </View>
  );
}

/** `LayerBar`: which layer supplied the file — a chip — and the buttons that act on that. */
function LayerBar({ model, busy, comparing, onAction }: { model: LayerBarModel | null; busy: boolean; comparing: boolean; onAction: (id: LayerBarAction["id"]) => void }): JSX.Element | null {
  if (model === null) return null;
  return (
    <>
      <Chip tone={model.chip.tone} title={model.chip.title}>
        {model.chip.text}
      </Chip>
      {model.actions.map((action) => (
        <LinkButton key={action.id} title={action.title} disabled={busy || action.disabled === true} onPress={() => onAction(action.id)}>
          {layerActionLabel(action, comparing)}
        </LinkButton>
      ))}
    </>
  );
}

/** `.tabs.seg`: the readings of the file, joined — the one showing filled with the accent. */
export function SegTabs<T extends string>({ tabs, value, words, titles, onPick }: { tabs: readonly T[]; value: T; words: Record<T, string>; titles?: Record<T, string>; onPick: (tab: T) => void }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" flexShrink={0}>
      {tabs.map((one, i) => {
        const on = one === value;
        const first = i === 0;
        const last = i === tabs.length - 1 && tabs.length > 1;
        return (
          <Press
            key={one}
            onPress={() => onPick(one)}
            {...(titles !== undefined ? { title: titles[one] } : {})}
            flexDirection="row"
            alignItems="center"
            justifyContent="center"
            flexShrink={0}
            paddingVertical={2}
            paddingHorizontal={11}
            borderWidth={1}
            borderStyle="solid"
            borderTopLeftRadius={first ? 5 : 0}
            borderBottomLeftRadius={first ? 5 : 0}
            borderTopRightRadius={last ? 5 : 0}
            borderBottomRightRadius={last ? 5 : 0}
            {...(last ? { marginLeft: -1 } : {})}
            box={({ hovered }) =>
              on
                ? { backgroundColor: t.v(hovered ? "fill-accent-hover" : "fill-accent"), borderColor: t.v(hovered ? "fill-accent-hover" : "fill-accent"), boxShadow: t.v("sheen") }
                : { backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent", borderColor: t.v(hovered ? "rule" : "line") }
            }
          >
            <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: on ? 600 : 400, color: on ? "on-accent" : "text" }} numberOfLines={1} textAlign="center">
              {words[one]}
            </Txt>
          </Press>
        );
      })}
    </View>
  );
}

/**
 * `.sub.file-path`: the file, cut with … at its START (the bar's `direction: rtl`), the path itself
 * isolated so a leading `$` or `.` stays where it is written.
 */
function FilePath({ path, title }: { path: string; title: string }): JSX.Element {
  const t = useTokens();
  const style = font(t, { voice: "app", scale: 11 / 12.5, color: "dim" });
  return (
    <View flexGrow={1} flexShrink={1} flexBasis="auto" minWidth={0} {...(isWeb ? { title } : {})}>
      <RNText
        numberOfLines={1}
        ellipsizeMode="head"
        {...(isWeb ? { dir: "rtl" } : {})}
        style={{ ...(style as object), textAlign: "left" } as never}
      >
        {isWeb ? <RNText {...({ dir: "ltr" } as object)} style={{ unicodeBidi: "isolate" } as never}>{path}</RNText> : path}
      </RNText>
    </View>
  );
}

export function WorkflowEditor({
  source,
  tree,
  executors,
  busy,
  onSave,
  validateSchema,
  loadStateSlots = NO_STATE_SLOTS,
  wrapJson,
  onWrapJson,
  ui,
  issues = [],
  reveal = null,
  draft,
  onDraft,
  tab: tabProp,
  onTab,
  tabs = TABS,
  onOpenState,
  readState,
  saveState,
  readFile,
  layerActions,
  fill = true,
}: {
  source: WorkflowSource;
  tree: FileTree | null;
  executors: ExecutorInfo[];
  busy: boolean;
  onSave: (stateId: string, layer: WorkflowLayer, text: string) => void;
  validateSchema?: ((schemaId: string, text: string) => Promise<ValidateSchemaResult | null>) | undefined;
  loadStateSlots?: (stateIds: string[]) => Promise<Record<string, StateSlots> | null>;
  wrapJson?: boolean;
  onWrapJson?: ((wrap: boolean) => void) | undefined;
  ui?: UiSurface | undefined;
  issues?: readonly LintIssue[];
  reveal?: { path: string; nonce: number } | null;
  draft?: string | null;
  onDraft?: ((text: string | null) => void) | undefined;
  tab?: EditorTab;
  onTab?: ((tab: EditorTab) => void) | undefined;
  tabs?: readonly EditorTab[];
  onOpenState?: ((stateId: string) => void) | undefined;
  readState?: ((stateId: string) => Promise<WorkflowSource | null>) | undefined;
  saveState?: ((source: WorkflowSource, text: string) => void) | undefined;
  readFile?: ((layer: WorkflowLayer, path: string) => Promise<string | null>) | undefined;
  layerActions?: LayerActions;
  /**
   * Whether the editor fills its box, its form scrolling inside it (`.pane.editor > .form`): the Files
   * room's half and the state panel. False where its column scrolls it whole (a reading in the panel).
   */
  fill?: boolean;
}): JSX.Element {
  const t = useTokens();
  const appearance = useEditorAppearance();
  const e = useWorkflowEditor({
    source,
    tree,
    executors,
    loadStateSlots,
    ui,
    issues,
    reveal,
    draft,
    onDraft,
    tab: tabProp,
    onTab,
    tabs,
    readFile,
    layerActions,
    outerReadOnly: useReadOnly(),
  });
  const { tab, form, marks, targets, readOnly, editForm } = e;
  const kind = kindMarksOf(form, marks);
  // The form's datalists (`Lists`), each as the desktop's editor renders it once.
  const lists: Lists = {
    bindings: e.bindings.map((path) => ({ value: path })),
    guards: e.guards.map((path) => ({ value: path })),
    links: targets.map((ref) => ({ value: ref })),
    functions: e.functions.map((fn) => ({ value: fn.name, label: fn.note })),
    // Keys already used are not offered again: a `children` map cannot hold the same key twice.
    childKeys: freeChildKeys(childKeyOptions(tree, source.stateId), form.children).map((key) => ({ value: key })),
    childStates: childStateOptions(tree, source.stateId).map((id) => ({ value: id })),
    transitions: transitionTargetsOf(form.children.map((c) => c.key).filter((k) => k.length > 0)).map((key) => ({ value: key })),
  };

  const body = (): ReactNode => {
    if (e.comparing) {
      if (e.shippedText === null) return <Empty>{e.compareError ?? "reading what ships…"}</Empty>;
      return <IslandBand min={140}>{(height) => <Island component="diff" height={height} props={{ original: e.shippedText, modified: e.text, mime: WORKFLOW_JSON, sideBySide: true, readOnly: true }} />}</IslandBand>;
    }
    if (tab === "graph") {
      return (
        <StateGraphView
          text={e.text}
          stateId={source.stateId}
          declared={e.declared}
          {...(onOpenState !== undefined ? { onOpenState } : {})}
          {...(readState !== undefined ? { readState } : {})}
          {...(saveState !== undefined ? { saveState } : {})}
          {...(readFile !== undefined ? { readFile } : {})}
          tree={tree}
          executors={executors}
          busy={busy}
          {...(validateSchema !== undefined ? { validateSchema } : {})}
          loadStateSlots={loadStateSlots}
          {...(wrapJson !== undefined ? { wrapJson } : {})}
          onWrapJson={onWrapJson}
          ui={ui}
        />
      );
    }
    if (tab === "form") {
      if (e.parseError !== null) return <Reason flexShrink={0}>This file is not valid JSON ({e.parseError}) — fix it on the JSON tab to use the form.</Reason>;
      const content = (
        <ListsProvider value={lists}>
        <ReadingBody on={readOnly}>
          <View flexDirection="column" gap={8}>
            {/* The state's own prose, labels beside the boxes. A reading shows what the state SAYS. */}
            <View flexDirection="column" gap={5}>
              {readOnly && form.label.length === 0 ? null : (
                <InlineField name="Label">
                  <Box value={form.label} onChange={(label) => editForm({ label })} placeholder="a short name — what the board shows" />
                </InlineField>
              )}
              {readOnly && form.description.length === 0 ? null : (
                <InlineField name="Description">
                  <Area value={form.description} onChange={(description) => editForm({ description })} rows={2} placeholder="an author's note — also useful prompt context" />
                </InlineField>
              )}
            </View>
            <SlotTable title="Inputs" rows={form.inputs} optional bindingHint="default binding (optional)" targets={targets} path="inputs" issues={marks} onChange={(inputs) => editForm({ inputs })} />
            <SlotTable title="Outputs" rows={form.outputs} bindingHint=".children.critique.output.outcome" targets={targets} emptyBindingMeans={outputsEmptyMeans(form)} path="outputs" issues={marks} onChange={(outputs) => editForm({ outputs })} />
            <View flexDirection="column" gap={5} paddingTop={8} {...(edge(t, { top: 1 }) as object)}>
              <SlotsHead title="Operation" sub="what this state does when the cursor is on it" />
              {readOnly && form.operationKind === "inherit" ? null : (
                <View marginLeft={11}>
                  <Field name="Kind">
                    <Pick
                      value={form.operationKind}
                      options={OPERATION_KINDS.map((k) => ({ value: k.value, label: k.label }))}
                      mark={markOf(kind.select)}
                      onChange={(operationKind) => editForm({ operationKind: operationKind as typeof form.operationKind })}
                    />
                  </Field>
                </View>
              )}
              {form.operationKind === "ref" ? (
                <View marginLeft={11} flexDirection="column" gap={4}>
                  <LinkInput value={form.operationRef} targets={targets} placeholder="$/lib/review.operation" onChange={(operationRef) => editForm({ operationRef })} />
                  <Sub>spliced in whole; sibling keys would override it, and those stay on the JSON tab</Sub>
                  {form.operationRef.length > 0 ? <LinkPreview reference={form.operationRef} /> : null}
                </View>
              ) : form.operationKind !== "" ? (
                <View marginLeft={11} flexDirection="column" gap={5}>
                  <OperationFieldsEditor
                    form={form.operation}
                    show={{ prompt: form.operationKind !== "function", function: form.operationKind !== "prompt" }}
                    targets={targets}
                    path="operation"
                    issues={marks}
                    onChange={(operation) => editForm({ operation })}
                  />
                  {e.offFunction ? <Sub color="warn">{e.namedFunction} is turned off in this project, so it is not registered</Sub> : null}
                </View>
              ) : null}
            </View>
            <ChildrenTable
              rows={form.children}
              functions={e.functions}
              declared={e.declared}
              stateIdOf={e.childStateId}
              issues={marks}
              onChange={(children) => editForm({ children })}
            />
            <TransitionsTable rows={form.transitions} issues={marks} onChange={(transitions) => editForm({ transitions })} />
            {readOnly && form.environment === null ? null : (
              <View flexDirection="column" gap={5} paddingTop={8} {...(edge(t, { top: 1 }) as object)}>
                <SlotsHead title="Environment" sub="defaults for this state and every descendant">
                  {form.environment === null ? null : (
                    <Pick
                      value={form.environmentKind}
                      options={ENVIRONMENT_KINDS.map((k) => ({ value: k.value, label: k.label }))}
                      size={{ scale: 11 / 12.5, pad: [5, 9] }}
                      weight={600}
                      flexGrow={0}
                      flexShrink={1}
                      flexBasis="100%"
                      title="what this layer declares its descendants' operations to be"
                      onChange={(environmentKind) => editForm({ environmentKind: environmentKind as typeof form.environmentKind })}
                    />
                  )}
                  {readOnly ? null : (
                    <SmallButton weight={600} onPress={() => editForm({ environment: form.environment === null ? EMPTY_OPERATION_FIELDS : null })}>
                      {form.environment === null ? "+ Add" : "Remove"}
                    </SmallButton>
                  )}
                </SlotsHead>
                {form.environment === null ? (
                  <Sub marginLeft={11}>none — this state adds no defaults to what it inherits</Sub>
                ) : (
                  <View marginLeft={11}>
                    <OperationFieldsEditor
                      form={form.environment}
                      show={{ prompt: form.environmentKind !== "function", function: form.environmentKind !== "prompt" }}
                      targets={targets}
                      onChange={(environment) => editForm({ environment })}
                    />
                  </View>
                )}
              </View>
            )}
            {readOnly && form.limits.maxIterations.length === 0 && form.limits.timeout.length === 0 ? null : (
              <View flexDirection="column" gap={5} paddingTop={8} {...(edge(t, { top: 1 }) as object)}>
                <SlotsHead title="Limits" sub="how far this state may go before it is stopped" />
                <View marginLeft={11}>
                  <RowControls fields={[true, true]}>
                    {readOnly && form.limits.maxIterations.length === 0 ? null : (
                      <Field name="Max iterations">
                        <Box value={form.limits.maxIterations} onChange={(maxIterations) => editForm({ limits: { ...form.limits, maxIterations } })} inputMode="decimal" placeholder="guard value: limits.max_iterations" mark={markOf(fieldClass(marks, "limits.max_iterations"))} />
                      </Field>
                    )}
                    {readOnly && form.limits.timeout.length === 0 ? null : (
                      <Field name="Timeout">
                        <Box value={form.limits.timeout} onChange={(timeout) => editForm({ limits: { ...form.limits, timeout } })} inputMode="decimal" placeholder="seconds — then terminate.timeout" mark={markOf(fieldClass(marks, "limits.timeout"))} />
                      </Field>
                    )}
                  </RowControls>
                </View>
              </View>
            )}
            {readOnly ? null : (
              <Sub>
                A plain reference is editable here — 🔗 links a value to a file and unlinking gives back what was inline. Anything richer than that (a reference with sibling overrides, a computed binding) is kept exactly as written and shown read-only; edit those on the JSON tab.
              </Sub>
            )}
          </View>
        </ReadingBody>
        </ListsProvider>
      );
      if (!fill || readOnly) return content;
      return (
        <ScrollView
          style={{ flexGrow: 1, flexShrink: 1, flexBasis: "auto", minHeight: 0, ...PLAIN_SCROLLER } as never}
          contentContainerStyle={{ paddingTop: 1, paddingHorizontal: 1, paddingBottom: 2, ...PLAIN_SCROLLER } as never}
          {...(scrollbarProps(t) as object)}
        >
          {content}
        </ScrollView>
      );
    }
    // The JSON tab.
    // A reading's document: `textarea.code-editor.tall.reading-doc` — at least 340 tall, scrolling in itself.
    if (readOnly)
      return (
        <View minHeight={340} flexGrow={1} flexShrink={1} flexBasis="auto" flexDirection="column">
          <CodeArea value={e.text} readOnly onChange={() => undefined} appearance={appearance} />
        </View>
      );
    if (validateSchema !== undefined) {
      return (
        <SchemaJsonEditor
          text={e.text}
          busy={busy}
          mime={WORKFLOW_JSON}
          onChange={e.setText}
          validate={validateSchema}
          schemaId={e.schemaId}
          onSchema={e.setSchemaId}
          {...(wrapJson !== undefined ? { wrap: wrapJson } : {})}
          onWrap={onWrapJson}
          ui={ui}
        />
      );
    }
    return (
      <>
        <CodeArea value={e.text} readOnly={false} onChange={e.setText} appearance={appearance} />
        {e.parseError !== null ? <Reason>not valid JSON: {e.parseError}</Reason> : null}
      </>
    );
  };

  return (
    <ReadOnlyContext.Provider value={readOnly}>
      <LinkReaderProvider value={e.reader}>
        {/* Nothing here asks for a layer: on the Graph tab the desktop's pane is greyscale because it is
            painted after a scroller, and so is this one now that the page is painted in the same order. */}
        <View flexDirection="column" gap={8} minHeight={0} {...(fill ? { flexGrow: 1, flexShrink: 1, flexBasis: 0 } : {})}>
          <View flexDirection="row" alignItems="center" gap={8} flexShrink={0} minWidth={0}>
            <FilePath path={editorPathOf(source, e.shipped)} title={source.file} />
            <LayerBar model={layerBarOf(source, layerActions?.hasProject === true, e.copyOnEdit)} busy={busy} comparing={e.comparing} onAction={e.onLayerAction} />
            <SegTabs tabs={tabs} value={tab} words={TAB_WORDS} titles={TAB_TITLES} onPick={e.setTab} />
          </View>
          {body()}
          {!savesOf(readOnly, e.shipped) ? null : (
            <EditorActions
              dirty={e.dirty || !source.exists}
              busy={busy}
              blocked={e.parseError === null ? undefined : "fix the JSON before saving"}
              onSave={() => onSave(source.stateId, source.layer, e.text)}
              onRevert={() => {
                e.setText(e.onDisk);
                e.loadForm(e.onDisk);
              }}
            >
              {source.exists ? null : <ActionsSub>new file — saving creates it</ActionsSub>}
            </EditorActions>
          )}
        </View>
      </LinkReaderProvider>
    </ReadOnlyContext.Provider>
  );
}

/** `label.field.inline`: its name right-aligned in 78, gap 8, the control the rest, centred. */
function InlineField({ name, children }: { name: string; children: ReactNode }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" gap={8} minWidth={0}>
      <FieldName width={78} flexShrink={0} textAlign="right">
        {name}
      </FieldName>
      <View flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0}>
        {children}
      </View>
    </View>
  );
}

