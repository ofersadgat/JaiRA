/**
 * The preload bridge (DESIGN §11.2): the renderer's only capability.
 *
 * `contextBridge` exposes exactly two functions — a typed `invoke` over the
 * contract's channels and a `subscribe` for pushes. No Node, no engine, no
 * database handle crosses this line.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC_CHANNELS, PUSH_CHANNEL, type IpcChannel, type PushMessage } from "@jaira/shared";

const allowed = new Set<string>(IPC_CHANNELS);

const bridge = {
  invoke: (channel: IpcChannel, request: unknown): Promise<unknown> => {
    // Whitelist rather than forward anything: a renderer bug (or injected script)
    // must not be able to reach an arbitrary ipcMain handler.
    if (!allowed.has(channel)) return Promise.reject(new Error(`channel '${channel}' is not part of the IPC contract`));
    return ipcRenderer.invoke(channel, request);
  },
  subscribe: (listener: (message: PushMessage) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, message: PushMessage): void => listener(message);
    ipcRenderer.on(PUSH_CHANNEL, handler);
    return () => ipcRenderer.removeListener(PUSH_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld("jaira", bridge);
