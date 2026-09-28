import { useState, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import { parseStructured, type StructuredFormat, type WorkflowSource } from "@jaira/shared/browser";
import { ReadOnlyContext } from "@jaira/ui/reading";
import { ToolsFieldProvider, useToolsFieldRead } from "@jaira/ui/toolsFieldModel";
import { docKey, useDraftBox } from "@jaira/ui/drafts";
import { registerSurfaceTable, newSurfaceRegistry, SURFACE_KEYS, type SurfaceKey } from "@jaira/ui/fileSurfaceTable";
import { isReading, type FileSurface, type FileSurfaceProps } from "@jaira/ui/fileTypes";
import { Island } from "../../islands";
import { Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { Uncopied } from "../../app/Uncopied";
import { Markdown } from "../Markdown";
import { DataView } from "./DataView";
import { CodeSourceView, ConfigEdit, TextEdit } from "./CodeEdit";
import { JsonEdit } from "./SchemaEdit";
import { EditorActions, ReadingNote, Sub } from "./EditorActions";
import { CompositeView } from "../run/RunView";
import { useRunContext } from "../run/runContext";
import { WorkflowEditor } from "../workflow/WorkflowEditor";
import { useShell } from "../../app/shell";

/**
 * The file surfaces, universal (decision 0015): what draws each half of the Files panel, by the same
 * table the desktop registers (`fileSurfaceTable.ts`) — so a file resolves to the same renderer on both,
 * and only the drawing differs. Viewers are native; an EDITOR is an island (CodeMirror, Monaco), the
 * only WebViews the copy allows. A surface not copied yet is an {@link Uncopied} box where it stands.
 */

/** `p.empty`: --dim, 8 above and below, and the paragraph's margins (1em of the body's 13). */
function Empty({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 13 / 12.5) as number}>
      {children}
    </Txt>
  );
}

/** `fenceRender.tsx`'s `MarkdownView`: the file, rendered — `.markdown` at 13/12.5 in the upper half. */
function MarkdownView({ doc }: FileSurfaceProps): JSX.Element {
  if (doc.text.trim().length === 0) return <Empty>This file is empty.</Empty>;
  return <Markdown text={doc.text} softbreak="space" />;
}

/** `.notice.bad`: a parse failure — --tint-bad ground, --bad, app 11/12.5, radius --control-radius, padding 7 9. */
function Notice({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View backgroundColor={t.v("tint-bad") as never} borderRadius={t.v("control-radius") as never} paddingVertical={7} paddingHorizontal={9}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }}>{children}</Txt>
    </View>
  );
}

/** `StructuredView`: a JSON or YAML document parsed by the one parse (`parseStructured`), as its tree. */
function StructuredView({ text, format }: { text: string; format: StructuredFormat }): JSX.Element {
  if (text.trim().length === 0) return <Empty>This file is empty.</Empty>;
  const parsed = parseStructured(text, format);
  if (!parsed.ok) {
    return (
      <Notice>
        does not parse: {parsed.message}
        {parsed.spot !== undefined ? ` (line ${parsed.spot.line}, column ${parsed.spot.column})` : ""}
      </Notice>
    );
  }
  return <DataView value={parsed.value} />;
}
const JsonView = ({ doc }: FileSurfaceProps): JSX.Element => <StructuredView text={doc.text} format="json" />;
const YamlView = ({ doc }: FileSurfaceProps): JSX.Element => <StructuredView text={doc.text} format="yaml" />;

/** `ConfigEffectiveView`: both configuration layers merged (`.config-effective`: a column, gap 6, padding 2 2 10). */
function ConfigEffectiveView({ context }: FileSurfaceProps): JSX.Element {
  if (context.config === null) return <Empty>Open a project to see the effective configuration.</Empty>;
  return (
    <View flexDirection="column" gap={6} paddingTop={2} paddingHorizontal={2} paddingBottom={10}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>shared config with this project&apos;s laid over it</Txt>
      <DataView value={context.config.effective} />
    </View>
  );
}

// Save and Revert, the reading note and `.file-edit` are `EditorActions.tsx`'s, shared by every editor.
export { EditorActions } from "./EditorActions";

/**
 * `fileSurfaces.tsx`'s `MarkdownFileEdit`: markdown, edited in the live preview — CodeMirror, an island
 * (`.file-edit`: a column, gap 8; the editor takes the rest, at least 200 tall, and scrolls inside
 * itself), with the same draft box, Save and Revert as the desktop's.
 */
function MarkdownFileEdit({ doc, busy, onSave, context }: FileSurfaceProps): JSX.Element {
  const draft = useDraftBox(context.drafts, context.onDraft, docKey(doc.layer, doc.path), doc.text);
  const reading = isReading(context);
  const [height, setHeight] = useState(0);
  return (
    <View flexDirection="column" flexGrow={1} flexShrink={1} flexBasis="auto" gap={8} minHeight={0}>
      <View flexGrow={1} flexShrink={1} flexBasis="auto" minHeight={200} onLayout={(e) => setHeight(Math.round(e.nativeEvent.layout.height))}>
        {height > 0 ? (
          <Island
            component="markdownEditor"
            props={{ text: reading ? doc.text : draft.text, readOnly: reading }}
            height={height}
            onEvent={(name, value) => {
              if (name === "change" && !reading) draft.set(String(value));
            }}
          />
        ) : null}
      </View>
      {reading ? (
        <ReadingNote />
      ) : (
        <EditorActions dirty={draft.dirty || !doc.exists} busy={busy} onSave={() => onSave(draft.text)} onRevert={draft.revert}>
          {doc.exists ? null : <Sub>new file — saving creates it</Sub>}
        </EditorActions>
      )}
    </View>
  );
}

/**
 * `fileSurfaces.tsx`'s `WorkflowRunView`: what a state file IS DOING — its board, or its tasks and their
 * conversation (`CompositeView`, `components/run/RunView.tsx`), exactly what the Tasks room shows for
 * the same state. The run it reads comes from the store (`useRunContext`), over the room's context. A
 * leaf's own panel (`LeafPanel`) is {@link Uncopied}.
 */
function WorkflowRunView(props: FileSurfaceProps): JSX.Element {
  const context = { ...props.context, ...useRunContext() };
  const { state } = context;
  if (state === null) return <Empty>This file does not resolve to a state.</Empty>;
  if (state.board === null) return <Uncopied name="LeafPanel" flex={1} />;
  return <CompositeView {...props} context={context} state={state} />;
}

/**
 * `fileSurfaces.tsx`'s `WorkflowEdit`: the authoring form for a state file — the workflow editor
 * (`components/workflow/WorkflowEditor.tsx`) over the document, saved through the channel that lints it.
 * What the room's context does not carry yet (the children's slots, reading and writing another state,
 * the tab each file was left on) is read from the store, as `App.tsx` hands it to the desktop's.
 */
function WorkflowEdit({ doc, busy, onSave, context }: FileSurfaceProps): JSX.Element {
  const { state, actions } = useShell();
  // The Tools field's permission sets and tools (`App.tsx` reads them for the whole window).
  const toolsFieldData = useToolsFieldRead(state.at, state.tree);
  const key = docKey(doc.layer, doc.path);
  const reading = isReading(context);
  if (doc.stateId === undefined) return <Empty>This file does not name a state.</Empty>;
  const source: WorkflowSource = {
    stateId: doc.stateId,
    layer: doc.layer,
    file: doc.file,
    text: doc.text,
    exists: doc.exists,
    ...(doc.builtIn !== undefined ? { builtIn: doc.builtIn } : {}),
  };
  const editorTab = context.editorTab ?? state.editorTab;
  const onEditorTab = context.onEditorTab ?? actions.setEditorTab;
  const readState = context.readState ?? actions.readState;
  const saveState = context.saveState ?? actions.saveState;
  const form = (
    <WorkflowEditor
      source={source}
      tree={context.tree}
      executors={context.executors}
      busy={busy}
      validateSchema={context.validateSchema}
      loadStateSlots={context.stateSlots ?? actions.stateSlots}
      {...(context.wrapJson !== undefined ? { wrapJson: context.wrapJson } : {})}
      onWrapJson={context.onWrapJson}
      ui={context.ui}
      issues={context.state?.issues ?? []}
      reveal={context.revealIssue ?? null}
      draft={context.drafts?.[key] ?? null}
      {...(context.onDraft ? { onDraft: (text: string | null) => context.onDraft?.(key, text) } : {})}
      tab={editorTab?.[key] ?? "form"}
      onTab={(next) => onEditorTab(key, next)}
      onOpenState={context.onDrill}
      readState={readState}
      saveState={saveState}
      {...(context.readFile !== undefined ? { readFile: context.readFile } : {})}
      {...(context.builtInActions !== undefined
        ? {
            layerActions: {
              hasProject: context.builtInActions.hasProject,
              onOverride: (toLayer) => context.builtInActions?.onOverride(source.stateId, toLayer),
              ...(context.builtInActions.onEditCopy !== undefined ? { onEditCopy: (text: () => string) => context.builtInActions?.onEditCopy?.(source.stateId, text) } : {}),
            },
          }
        : {})}
      onSave={(_stateId, _layer, text) => onSave(text)}
    />
  );
  return <ToolsFieldProvider value={toolsFieldData}>{reading ? <ReadOnlyContext.Provider value={true}>{form}</ReadOnlyContext.Provider> : form}</ToolsFieldProvider>;
}

/** The copies there are, by the table's key. */
const COPIED: Partial<Record<SurfaceKey, FileSurface>> = { MarkdownView, MarkdownFileEdit, JsonView, YamlView, ConfigEffectiveView, WorkflowRunView, WorkflowEdit, TextEdit, CodeSourceView, ConfigEdit, JsonEdit };

/** The table, registered with the copies — and an {@link Uncopied} box for every surface without one. */
export const SURFACES = registerSurfaceTable(
  Object.fromEntries(SURFACE_KEYS.map((key) => [key, COPIED[key] ?? ((): JSX.Element => <Uncopied name={key} flex={1} />)])) as Record<SurfaceKey, FileSurface>,
  newSurfaceRegistry(),
);
