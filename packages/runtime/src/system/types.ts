/**
 * What the System tools (decision 0018) ask of the machine, and what it answers — one interface each
 * operating system implements (`windows.ts`, `macos.ts`), so the tools themselves (`../systemTools.ts`)
 * hold the rules that are the same everywhere: what is refused, what is JaiRA's own, how much comes
 * back.
 *
 * Field names are the tools' own output names (snake_case, as every JaiRA tool answers), so a backend's
 * rows go back to the model as they are.
 */
import type { JsonValue } from "@declarative-ai/exec";

/** The machine, by part — `read_system`'s `about`. */
export type SystemAbout = "summary" | "hardware" | "disks" | "network" | "users" | "logs";
export const SYSTEM_ABOUT: readonly SystemAbout[] = ["summary", "hardware", "disks", "network", "users", "logs"];

export type LogLevel = "critical" | "error" | "warning" | "information";
export const LOG_LEVELS: readonly LogLevel[] = ["critical", "error", "warning", "information"];

/** Which entries of the machine's log `read_system` reads. */
export interface LogQuery {
  /** The log: Windows' event log by name (`System`, `Application`); macOS' unified log by subsystem. */
  log?: string;
  /** Only entries at least this severe. */
  level?: LogLevel;
  sinceMinutes: number;
  limit: number;
}

export type PowerAction = "restart" | "shut_down" | "sleep" | "hibernate" | "sign_out" | "lock" | "cancel";
export const POWER_ACTIONS: readonly PowerAction[] = ["restart", "shut_down", "sleep", "hibernate", "sign_out", "lock", "cancel"];

/** One program running, as `list_processes` answers it. */
export interface ProcessRow {
  pid: number;
  parent_pid?: number;
  name: string;
  /** When it started, as the backend writes it — handed back to `stop_process` to make sure it is the same one. */
  started?: string;
  memory_mb?: number;
  cpu_seconds?: number;
  path?: string;
  window_title?: string;
}

export type ServiceState = "running" | "stopped" | "paused" | "start_pending" | "stop_pending" | "continue_pending" | "pause_pending" | "unknown";
export type StartType = "automatic" | "manual" | "disabled" | "boot" | "system";
export const START_TYPES: readonly StartType[] = ["automatic", "manual", "disabled"];

export interface ServiceRow {
  name: string;
  display_name?: string;
  status: ServiceState;
  start_type?: StartType;
  can_stop?: boolean;
}

export type ServiceAction = "start" | "stop" | "restart" | "pause" | "resume" | "set_start_type";
export const SERVICE_ACTIONS: readonly ServiceAction[] = ["start", "stop", "restart", "pause", "resume", "set_start_type"];

/** What `list_software` lists: installed programs, store apps, script modules, a package manager's packages. */
export type SoftwareKind = "programs" | "apps" | "modules" | "packages";
export const SOFTWARE_KINDS: readonly SoftwareKind[] = ["programs", "apps", "modules", "packages"];

export interface SoftwareRow {
  name: string;
  /** What `install_software` takes to name it, where there is such a thing. */
  id?: string;
  version?: string;
  publisher?: string;
  installed?: string;
  kind: "program" | "app" | "module" | "package";
}

export type InstallAction = "install" | "uninstall" | "upgrade";
export const INSTALL_ACTIONS: readonly InstallAction[] = ["install", "uninstall", "upgrade"];

/** Who installs: the OS's package manager (`winget`, `brew`), or PowerShell's module gallery. */
export type InstallManager = "winget" | "powershell" | "brew";

export interface InstallRequest {
  action: InstallAction;
  id: string;
  manager: InstallManager;
  version?: string;
}

export interface InstallResult {
  exit_code: number;
  /** The last of what the manager wrote. */
  output: string;
}

/** The kinds of setting: the registry, macOS' defaults, persistent environment variables, the clock and time zone. */
export type SettingsArea = "registry" | "defaults" | "environment" | "time";
export const SETTINGS_AREAS: readonly SettingsArea[] = ["registry", "defaults", "environment", "time"];

export interface ReadSettingsRequest {
  area: SettingsArea;
  /** A registry key (`HKCU\Software\…`) or a defaults domain (`com.apple.dock`). */
  key?: string;
  /** One value under it, or one environment variable. */
  name?: string;
}

/** What `write_settings` writes in: the registry, defaults, an environment variable, the time zone. */
export type WriteArea = "registry" | "defaults" | "environment" | "time_zone";
export const WRITE_AREAS: readonly WriteArea[] = ["registry", "defaults", "environment", "time_zone"];

export type ValueType = "string" | "expand_string" | "multi_string" | "dword" | "qword" | "binary" | "int" | "float" | "bool";
export const VALUE_TYPES: readonly ValueType[] = ["string", "expand_string", "multi_string", "dword", "qword", "binary", "int", "float", "bool"];

export interface WriteSettingsRequest {
  area: WriteArea;
  key?: string;
  name?: string;
  value?: string | number | boolean | string[];
  type?: ValueType;
  /** Remove the value (or the variable) instead of setting it. */
  delete?: boolean;
  /** An environment variable's: the user's own, or the whole machine's. */
  scope?: "user" | "machine";
}

export interface ClipboardContent {
  text?: string;
  files?: string[];
  /** A picture on the clipboard, as PNG. */
  image?: { png: Uint8Array; width: number; height: number };
}

export interface ClipboardWrite {
  text?: string;
  /** An image file to put on the clipboard, absolute. */
  imageFile?: string;
  /** Files, absolute, as a file drop. */
  files?: string[];
}

export interface WindowRow {
  window_id: number;
  title: string;
  app: string;
  pid: number;
  focused: boolean;
  minimized: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

export type OpenAction = "launch" | "open" | "focus" | "close";
export const OPEN_ACTIONS: readonly OpenAction[] = ["launch", "open", "focus", "close"];

export interface OpenRequest {
  action: OpenAction;
  /** An app by name or path (launch; open with it). */
  app?: string;
  /** A file (absolute) or a link (open). */
  target?: string;
  /** A window from `list_windows` (focus, close). */
  windowId?: number;
}

/** A picture of the screen as PNG, perhaps scaled down, and the part of the screen it shows. */
export interface ScreenPicture {
  png: Uint8Array;
  /** The picture's own size. */
  width: number;
  height: number;
  /** What it shows, in the screen's own pixels on the virtual desktop — what a click on the picture maps back onto. */
  region: { x: number; y: number; width: number; height: number };
}

export interface ScreenshotRequest {
  /** A window from `list_windows`; absent: a monitor. */
  windowId?: number;
  /** Which monitor, from 0; absent: the primary. */
  display?: number;
  /** The long side the picture is scaled to, at most. */
  maxSide: number;
}

/** One step of `control_input`, in the computer-use action set. Coordinates are the screen's own pixels. */
export type InputStep =
  | { action: "mouse_move"; x: number; y: number }
  | { action: "left_click" | "right_click" | "middle_click" | "double_click" | "triple_click"; x?: number; y?: number; keys?: string }
  | { action: "left_mouse_down" | "left_mouse_up" }
  | { action: "left_click_drag"; from: { x: number; y: number }; x: number; y: number }
  | { action: "scroll"; x?: number; y?: number; direction: "up" | "down" | "left" | "right"; amount: number }
  | { action: "type"; text: string }
  | { action: "key"; keys: string }
  | { action: "hold_key"; keys: string; seconds: number }
  | { action: "wait"; seconds: number }
  | { action: "cursor_position" };

/** The machine, as the System tools reach it. Every method may throw; the message reaches the model. */
export interface SystemBackend {
  readonly os: "windows" | "macos";
  readSystem(about: SystemAbout, log: LogQuery): Promise<JsonValue>;
  power(action: PowerAction, delaySeconds: number): Promise<JsonValue>;
  processes(): Promise<ProcessRow[]>;
  /** Stop one process (and, with `tree`, what it started) — the one started at `started`, if given. */
  stopProcess(pid: number, options: { started?: string; tree: boolean; force: boolean }): Promise<{ stopped: boolean; how: string }>;
  services(): Promise<ServiceRow[]>;
  controlService(name: string, action: ServiceAction, startType?: StartType): Promise<ServiceRow>;
  software(kind: SoftwareKind): Promise<SoftwareRow[]>;
  installSoftware(request: InstallRequest, timeoutMs: number): Promise<InstallResult>;
  readSettings(request: ReadSettingsRequest): Promise<JsonValue>;
  writeSettings(request: WriteSettingsRequest): Promise<JsonValue>;
  readClipboard(): Promise<ClipboardContent>;
  writeClipboard(write: ClipboardWrite): Promise<void>;
  windows(): Promise<WindowRow[]>;
  openApp(request: OpenRequest): Promise<JsonValue>;
  screenshot(request: ScreenshotRequest): Promise<ScreenPicture>;
  /** Run the steps in order; a step that would reach a window of one of `guarded` (JaiRA's own) is refused. */
  input(steps: readonly InputStep[], guarded: readonly number[], signal?: AbortSignal): Promise<{ cursor?: { x: number; y: number } }>;
}

/** A refusal a backend or a tool says out loud, rather than a failure: it reaches the model as it is. */
export class SystemToolRefusal extends Error {}
