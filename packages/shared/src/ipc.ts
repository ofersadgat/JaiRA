/**
 * The typed IPC contract (DESIGN §11.2).
 *
 * One place defines every channel, its request, and its response, so main and
 * renderer are checked against the same declaration. Two directions:
 *
 *  - **invoke** (`ipcMain.handle` / `ipcRenderer.invoke`) — request/response.
 *  - **push** (`webContents.send`) — engine events and store invalidations,
 *    so the board is a subscription rather than a poll.
 *
 * This channel is also the security boundary that makes SPEC §11.4 true by
 * construction: a UI state's answer can only enter a run through the renderer,
 * and no agent process can reach this surface.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { ComponentConfig } from "./components";
import type { BoardView, TaskDetail, TaskSummary } from "./view";

// --- invoke channels ---------------------------------------------------------

export interface CreateTaskRequest {
  title: string;
  workflow: string;
  description?: string;
  labels?: string[];
  inputs?: Record<string, JsonValue>;
  branch?: string;
}

export interface StartTaskRequest {
  taskId: string;
  /** Scripted interactive answers, keyed by function name — the headless/demo
   *  path. Absent ⇒ the renderer answers interactive states live. */
  interactions?: Record<string, JsonValue[]>;
  /** Scripted prompt rules (the `--fake` surface), for demos and tests. */
  fake?: JsonValue;
}

/** Answer to a pending interactive request (DESIGN §7.1). */
export interface SubmitInteractionRequest {
  requestId: string;
  value: JsonValue;
}

/** A pending interactive request the renderer must render. */
export interface PendingInteraction {
  requestId: string;
  taskId: string;
  /** The registered function name — `choose_option`, `review_artifact`, … */
  component: string;
  /** Resolved inputs, including the state's authored `config` surface. */
  inputs: Record<string, JsonValue>;
  /** The parsed component contract, normalized in main so the renderer does not
   *  re-derive it. Absent for a function that is not a built-in component. */
  config?: ComponentConfig;
  /** Set instead of `config` when the state's authored config is malformed, so the
   *  UI can show the authoring error rather than an empty dialog. */
  configError?: string;
}

/**
 * Request/response map for invoke channels. Keys are channel names; each entry
 * declares its argument and result.
 */
export interface IpcContract {
  "project:open": { request: { dir: string }; response: { dir: string; recovered: string[] } };
  "project:current": { request: void; response: { dir: string } | null };
  "task:list": { request: void; response: TaskSummary[] };
  "task:detail": { request: { taskId: string }; response: TaskDetail };
  "task:create": { request: CreateTaskRequest; response: TaskSummary };
  "task:start": { request: StartTaskRequest; response: { taskId: string; runId: number } };
  "task:cancel": { request: { taskId: string }; response: { taskId: string } };
  "board:view": { request: { level?: string }; response: BoardView };
  "interaction:pending": { request: void; response: PendingInteraction[] };
  "interaction:submit": { request: SubmitInteractionRequest; response: { requestId: string } };
}

export type IpcChannel = keyof IpcContract;
export type IpcRequest<C extends IpcChannel> = IpcContract[C]["request"];
export type IpcResponse<C extends IpcChannel> = IpcContract[C]["response"];

export const IPC_CHANNELS: readonly IpcChannel[] = [
  "project:open",
  "project:current",
  "task:list",
  "task:detail",
  "task:create",
  "task:start",
  "task:cancel",
  "board:view",
  "interaction:pending",
  "interaction:submit",
];

// --- push channels -----------------------------------------------------------

/**
 * Main → renderer pushes. `engine:event` streams the run record live;
 * `store:invalidate` tells the renderer which views to refetch, which keeps the
 * board consistent without the renderer re-deriving engine semantics.
 */
export type PushMessage =
  | { type: "engine:event"; taskId: string; runId: number; seq: number; at: number; event: JsonValue }
  | { type: "store:invalidate"; scope: "tasks" | "board" | "task"; taskId?: string }
  | { type: "interaction:requested"; pending: PendingInteraction }
  | { type: "interaction:resolved"; requestId: string }
  | { type: "run:finished"; taskId: string; runId: number; status: "completed" | "failed" | "canceled" };

export const PUSH_CHANNEL = "jaira:push";

/** The API the preload script exposes on `window.jaira`. */
export interface JairaBridge {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
  /** Subscribe to pushes; returns an unsubscribe function. */
  subscribe(listener: (message: PushMessage) => void): () => void;
}
