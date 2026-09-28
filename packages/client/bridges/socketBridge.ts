import type { IpcChannel, IpcRequest, IpcResponse, JairaBridge, PushMessage } from "@jaira/shared/browser";

/**
 * THROWAWAY (decision 0015, S2): `JairaBridge` over the desktop's spike socket
 * (`packages/app/src/main/spikeSocket.ts`, whose header has the frames). Replaced, with that file, by
 * the real remote transport when it lands; nothing above the bridge notices.
 *
 * No reconnection: a dropped socket rejects what is in flight and says so, and the page is reloaded.
 */
export interface SocketBridge extends JairaBridge {
  /** Settles once the desktop has accepted the token. */
  readonly ready: Promise<void>;
  /** Called once, when the socket closes after `ready`. */
  onClose(listener: (reason: string) => void): void;
}

export function socketBridge(url: string, token: string, readOnly: (channel: IpcChannel) => boolean = () => true): SocketBridge {
  const socket = new WebSocket(url);
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Set<(message: PushMessage) => void>();
  const closers = new Set<(reason: string) => void>();
  let next = 0;
  let open = false;

  const ready = new Promise<void>((resolve, reject) => {
    socket.onopen = () => socket.send(JSON.stringify({ hello: { token } }));
    socket.onmessage = (e: MessageEvent) => {
      const frame = JSON.parse(String(e.data)) as { hello?: unknown; id?: number; result?: unknown; error?: string; push?: PushMessage };
      if (frame.hello !== undefined) {
        open = true;
        resolve();
        return;
      }
      if (frame.push !== undefined) {
        for (const listener of listeners) listener(frame.push);
        return;
      }
      const waiting = frame.id === undefined ? undefined : pending.get(frame.id);
      if (waiting === undefined) return;
      pending.delete(frame.id as number);
      if (frame.error !== undefined) waiting.reject(new Error(frame.error));
      else waiting.resolve(frame.result);
    };
    socket.onclose = (e: CloseEvent) => {
      const reason = e.reason || `the connection closed (${e.code})`;
      for (const { reject: fail } of pending.values()) fail(new Error(reason));
      pending.clear();
      if (!open) reject(new Error(reason));
      else for (const closer of closers) closer(reason);
    };
  });

  return {
    ready,
    onClose(listener) {
      closers.add(listener);
    },
    invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> {
      if (!readOnly(channel)) {
        return Promise.reject(new Error(`'${channel}' changes something, and this client is read-only for now`));
      }
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected to the desktop"));
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        socket.send(JSON.stringify({ id, channel, request }));
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
