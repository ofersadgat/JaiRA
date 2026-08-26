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
    try {
      return ipcRenderer.invoke(channel, request);
    } catch (e) {
      // `invoke` structure-clones the request and throws SYNCHRONOUSLY when it cannot — a request
      // carrying something unrepresentable never reaches the promise. Every caller signs up for a
      // promise, so a synchronous throw arrives where nothing is waiting to catch it: outside the
      // `await`, past the component's own error handling. Reshaped into the rejection it should
      // always have been, so one failure mode reaches callers by one path.
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  },
  subscribe: (listener: (message: PushMessage) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, message: PushMessage): void => {
      // GUARDED, because this runs inside Electron's own emitter. A listener that throws would take
      // the exception into `ipcRenderer`'s dispatch, where the renderer's error boundaries are not —
      // and since every push shares one channel, one bad subscriber would break delivery for all of
      // them. Reported and dropped: a push is news, and the renderer refetches on invalidation.
      try {
        listener(message);
      } catch (e) {
        console.error("[jaira] a push listener threw", message.type, e);
      }
    };
    ipcRenderer.on(PUSH_CHANNEL, handler);
    return () => ipcRenderer.removeListener(PUSH_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld("jaira", bridge);
