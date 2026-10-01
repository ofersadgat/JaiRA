import type { Slots } from "@jaira/ui/slots";
import { Pill } from "./components/Pill";
import { TaskCard } from "./components/TaskCard";

export { config } from "./tamagui.config";
export { Replayed, TokenRoot, TokenScope, useLook, useTokens, type Look, type Tokens } from "./tokens";
export { Island, type IslandProps } from "./islands";
export { Connect, type ConnectProps } from "./screens/Connect";
export { Markdown, registerFenceRenderer } from "./components/Markdown";
export { DataView } from "./components/files/DataView";
// The value view, for its specimens (`valueSpecimens.tsx`).
export { ValueView } from "./components/panel/ValueView";
// …and a value owning the panel's column, for its specimens (`artifactSpecimens.tsx`).
export { PreviewCard } from "./components/panel/PreviewCard";
export { FileInspector } from "./components/files/FileAddressBar";
export { UniversalApp } from "./app/UniversalApp";
export { useShell } from "./app/shell";
export { Uncopied } from "./app/Uncopied";
export { CopiesBoard } from "./screens/CopiesBoard";
export { SchemaForm, registerWidget } from "./components/form/SchemaForm";
export { Field, FieldGrid, FormRowsContext, Level } from "./components/form/Field";
export { SettingsGroup } from "./components/settings/SettingsPage";
// The two selects (`select.cfg-input` and the plain one), for the select specimen.
export { SelectInput } from "./components/settings/fields";
export { Select } from "./components/logs/Select";
// The floats and dialogs `App.tsx` owns, and the Components room's stage, for the specimens.
export { Stage as GalleryStage } from "./components/gallery/GalleryPane";
export { ApprovalDialog, ModuleApprovalDialog } from "./components/floats/Dialogs";
export { FolderBrowser } from "./components/floats/FolderBrowser";
export { UpdateRow } from "./components/floats/UpdateRow";
// The transcript, for its specimens (`transcriptSpecimens.tsx`).
export { Transcript } from "./components/panel/SessionTranscript";
export { SessionBands } from "./components/panel/SessionBands";
export { RailedRows } from "./components/panel/Rail";
// What the hosts hand the shell: the connection going away and coming back, and a phone's net for what
// escapes everything.
export { connectionLost, connectionRestored, useConnectionLost } from "./app/connection";
export { installNativeErrorReporting } from "./components/floats/CrashScreen";
// What a phone's test holds still so it can read the screen (`&still=1` on the deep link).
export { isStill, setStill } from "./motion";
// The window's own reports, a settled gate and a conversation's foot, for their specimens (`shellSpecimens.tsx`).
export { CrashScreen, LooseErrorBanner } from "./components/floats/CrashScreen";
export { DisconnectedLine } from "./components/floats/Disconnected";
export { Toast } from "./components/floats/Toast";
export { GateSurface } from "./components/panel/Gate";
export { OfflineBanner } from "./components/panel/OfflineBanner";
export { ChangesPanel } from "./components/panel/ChangesPanel";
export { NoteList } from "./components/artifact/ReviewNotes";
export { ImageDiff, type ImageLayout } from "./components/artifact/ImageDiff";
export { Range } from "./components/form/Range";

/** Every universal copy there is, by the slot it fills. `/universal` and native draw all of them. */
export const COPIES: Partial<Slots> = { Pill, TaskCard };

/**
 * The copies the DESKTOP draws (decision 0015, S4): each passed the fidelity gate against its DOM
 * original, and then the S1 gate with the desktop switched to it.
 */
export const SHARED: Partial<Slots> = { Pill, TaskCard };
// A task card, the Debug room's journal and three of the Files room's surfaces, for their specimens (`boardSpecimens.tsx`).
export { TaskCard };
export { Conversation } from "./components/debug/Conversation";
export { JsonFormView, PatchSideBySide, RenderedFileView } from "./components/files/surfaces";
export { UpdateSplit as AboutUpdateSplit } from "./components/settings/AboutPage";
// The boards, for the specimens that hold a drag part-way (`dragSpecimens.tsx`).
export { Board } from "./components/Board";
export { RunBoard } from "./components/run/RunBoard";
// A box with a `<datalist>` and its type-ahead, and the Debug room's session panel, for their specimens (`formsFilesSpecimens.tsx`).
export { FormInput } from "./components/form/inputs";
export { SessionPanel } from "./components/debug/SessionPanel";
export { DelimitedView, PatchFileSurface, SyncSurface as WorkflowSyncSurface } from "./components/files/surfaces";
