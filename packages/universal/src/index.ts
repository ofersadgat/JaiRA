import type { Slots } from "@jaira/ui/slots";
import { Pill } from "./components/Pill";
import { TaskCard } from "./components/TaskCard";

export { config } from "./tamagui.config";
export { Replayed, TokenRoot, TokenScope, useLook, useTokens, type Look, type Tokens } from "./tokens";
export { Island, type IslandProps } from "./islands";
export { Connect } from "./screens/Connect";
export { Markdown, registerFenceRenderer } from "./components/Markdown";
export { DataView } from "./components/files/DataView";
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

/** Every universal copy there is, by the slot it fills. `/universal` and native draw all of them. */
export const COPIES: Partial<Slots> = { Pill, TaskCard };

/**
 * The copies the DESKTOP draws (decision 0015, S4): each passed the fidelity gate against its DOM
 * original, and then the S1 gate with the desktop switched to it.
 */
export const SHARED: Partial<Slots> = { Pill, TaskCard };
