import { useMemo, type JSX } from "react";
import { View } from "@tamagui/core";
import { lookOf } from "@jaira/ui/appearanceLayer";
import type { FileSurfaceContext } from "@jaira/ui/fileTypes";
import { FOLD, HALVES, PANE, modeOf, paneOf } from "@jaira/ui/uiState";
import { FactsButton, FileAddressBar, FileInspector, FolderInspector } from "../components/files/FileAddressBar";
import { FilePanel } from "../components/files/FilePanel";
import { PanelColumn } from "./PanelColumn";
import { useShell } from "./shell";
import { issueReveal, runMode } from "./viewState";

/**
 * What the Files room's surfaces are handed beyond the file itself — `App.tsx`'s `surfaces`, for the
 * fields the universal surfaces read (the drafts, the renderer choices, the tree and the ways out of
 * the address bar). The rest of that object serves surfaces not copied yet (a state's board, its
 * conversation, the sync panel), and joins this one as they are.
 */
export function useFileSurfaces(): FileSurfaceContext {
  const { state, actions } = useShell();
  const mode = runMode.use();
  const reveal = issueReveal.use();
  const look = useMemo(() => lookOf(state.config), [state.config]);
  const renderers = look.renderers;
  const ui = state.settings.ui;
  const partial: Partial<FileSurfaceContext> = {
    state: state.state,
    config: state.config,
    tree: state.tree,
    executors: state.executors,
    ...(state.selectedProject !== null ? { project: state.selectedProject } : {}),
    selected: state.selected,
    detail: state.detail,
    onSelectTask: actions.select,
    onDrill: actions.selectState,
    trail: state.trail,
    trailState: state.trailState,
    onWalkTo: actions.walkTo,
    onOpenFile: actions.openPath,
    onOpenDir: actions.openDir,
    onOpenProject: () => actions.chooseProject("open"),
    runMode: mode,
    onRunMode: runMode.set,
    readFile: actions.readFile,
    builtInActions: {
      hasProject: state.at !== null,
      onOverride: (stateId, toLayer) => void actions.moveWorkflow({ stateId, layer: "system", to: stateId, toLayer, copy: true }),
      onEditCopy: (stateId, text) => void actions.moveWorkflow({ stateId, layer: "system", to: stateId, toLayer: "base", copy: true, draft: text }),
      onEditFileCopy: (path, original) => void actions.editBuiltInFile(path, original),
    },
    drafts: state.drafts,
    onDraft: actions.setDraft,
    // The state editor's (`WorkflowEdit`): its slots, reading and saving the state, which of its tabs is
    // open, and the issue the inspector asked it to show (`viewState.issueReveal`).
    stateSlots: actions.stateSlots,
    readState: actions.readState,
    saveState: actions.saveState,
    editorTab: state.editorTab,
    onEditorTab: actions.setEditorTab,
    ...(reveal !== null ? { revealIssue: reveal } : {}),
    renderers,
    // The editors' (`components/files/CodeEdit.tsx`, `SchemaEdit.tsx`): saving `settings.json`, the
    // schema a document answers to and its check, wrapping, and the field reference's remembered pane.
    onSaveConfig: (layer, doc) => actions.saveConfigFile(layer, doc),
    validateSchema: actions.validateSchema,
    schemaChoice: state.schemaChoice,
    onSchemaChoice: actions.setSchemaChoice,
    detectSchema: actions.detectSchema,
    wrapJson: look.editors.json.wrap,
    onWrapJson: actions.setWrapJson,
    ui: {
      pane: (id, fallback) => ui.panes[id] ?? fallback,
      setPane: actions.setPane,
      open: (id, fallback) => ui.open[id] ?? fallback,
      setOpen: actions.setFold,
    },
  };
  return partial as FileSurfaceContext;
}

/**
 * The Files room (`.files-view`, `App.tsx`): `FilePanel` — the viewer over the editor, or a folder's
 * listing — and the side panel beside it (`PanelColumn`, room-generic: the files room's stack, with the
 * state inspector on it for a state and nothing for a plain file).
 *
 *   .files-view   a grid: the panel (minmax(0, 1fr)), then the side panel's splitter and column
 */
export function FilesView(): JSX.Element {
  const { state, actions } = useShell();
  const ui = state.settings.ui;
  const context = useFileSurfaces();
  return (
    <View flex={1} minWidth={0} minHeight={0} flexDirection="row">
      <FilePanel
        doc={state.doc}
        dir={state.dir}
        busy={state.busy}
        context={context}
        viewerHeight={paneOf(ui, PANE.filesViewer)}
        onViewerHeight={(size) => actions.setPane(PANE.filesViewer, size)}
        half={modeOf(ui, FOLD.filesEditor, HALVES, "half")}
        onHalf={(half) => actions.setMode(FOLD.filesEditor, half)}
        onSave={actions.saveDoc}
      />
      <PanelColumn />
    </View>
  );
}

/** The file address bar in the title bar (`<FileAddressBar>` in `App.tsx`'s `.title-bar`), with its props. */
export function FilesAddress(): JSX.Element | null {
  const { state, actions } = useShell();
  const context = useFileSurfaces();
  return (
    <FileAddressBar
      doc={state.doc}
      dir={state.dir}
      context={context}
      onWalkBack={actions.walkBackTo}
      onInspect={actions.inspectState}
      facts={
        state.stateId === null && (state.doc !== null || state.dir !== null) ? (
          <FactsButton>
            {state.dir !== null ? <FolderInspector layer={state.dir.layer} path={state.dir.path} tree={state.tree} /> : <FileInspector doc={state.doc} />}
          </FactsButton>
        ) : undefined
      }
    />
  );
}
