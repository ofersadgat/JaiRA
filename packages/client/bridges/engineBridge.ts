import {
  ENGINE_CONTRACT,
  engineUrlOf,
  hostOfUrl,
  type ClientFrame,
  type EngineHostInfo,
  type HostFrame,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type JairaBridge,
  type PairingDevice,
  type PushMessage,
} from "@jaira/shared/browser";

/**
 * `JairaBridge` over the engine's own remote transport (decision 0013 §2–§3, amended 2026-09-30): what
 * a phone and a browser tab install where Electron's window has its preload. The frames are the ones
 * another machine's engine speaks (`@jaira/shared`'s `engineFrames.ts`) — `pair` once with the code
 * the machine shows, then `hello` with the token it issued, then `req`/`res` and every `push` — carried
 * by the platform's own `WebSocket`, one JSON frame per message. Nothing of Node is imported: this file
 * is bundled for a phone.
 *
 * The token goes in `hello` and nowhere else: never in a URL, and never to another address than the one
 * it was issued at.
 */

/** A device's pairing with one machine: where its engine is, and the token it issued. */
export interface Pairing {
  /** `wss://desk.tail4c2e.ts.net/engine`. */
  url: string;
  token: string;
  machine: { id: string; label: string };
}

const describe = hostOfUrl;

/**
 * Pair this device with the machine at `address`, by the one-time code it shows under Settings →
 * Machines → Pair a machine. One frame before any hello, and one answer: the token, or why not.
 */
export function pairDevice(address: string, code: string, device: PairingDevice, timeoutMs = 15_000): Promise<Pairing> {
  let url: string;
  try {
    url = engineUrlOf(address);
  } catch {
    return Promise.reject(new Error(`'${address}' is not an address`));
  }
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      reject(new Error(`could not reach ${describe(url)}: ${(e as Error).message}`));
      return;
    }
    let settled = false;
    const settle = (work: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      work();
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    };
    const timer = setTimeout(() => settle(() => reject(new Error(`nothing answered at ${describe(url)}`))), timeoutMs);
    socket.onopen = () => socket.send(JSON.stringify({ t: "pair", code, device } satisfies ClientFrame));
    socket.onmessage = (event) => {
      let frame: HostFrame;
      try {
        frame = JSON.parse(String(event.data)) as HostFrame;
      } catch {
        return settle(() => reject(new Error(`${describe(url)} is not a JaiRA machine`)));
      }
      if (frame.t === "paired") {
        const { machine, token } = frame;
        return settle(() => resolve({ url, token, machine: { id: machine.id, label: machine.label } }));
      }
      settle(() => reject(new Error(frame.t === "refused" ? frame.reason : "that machine did not pair")));
    };
    socket.onerror = () => settle(() => reject(new Error(`nothing answered at ${describe(url)}`)));
    socket.onclose = () => settle(() => reject(new Error(`${describe(url)} closed the connection`)));
  });
}

/** Where a bridge's connection stands. `refused` and `mismatch` are final: the bridge has stopped. */
export type BridgeState =
  | { state: "connecting" }
  | { state: "connected"; host: EngineHostInfo }
  /** Not connected — never yet, or dropped — and trying again by itself. */
  | { state: "waiting"; reason: string }
  /** The machine no longer takes this device's token: its pairing was removed there. */
  | { state: "refused"; reason: string }
  /** The machine speaks another contract than this build: one of the two needs updating. */
  | { state: "mismatch"; reason: string };

export interface EngineBridge extends JairaBridge {
  /** Settles on the first welcome; rejects when the machine refuses the token or speaks another contract. */
  readonly ready: Promise<EngineHostInfo>;
  state(): BridgeState;
  /** Hears every change of state, from the next one on. */
  onState(listener: (state: BridgeState) => void): () => void;
  /** Stop waiting and try now: the app came back to the front, or the network did. */
  retryNow(): void;
  /** Stop for good. */
  close(): void;
}

export interface EngineBridgeOptions {
  url: string;
  token: string;
  /** Who is connecting, for the machine's log: the device's name. */
  client: string;
  version: string;
  /** The first wait before trying again; it doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
  /** How long an attempt may take to be welcomed. */
  timeoutMs?: number;
  /** Tests: another contract. */
  contract?: string;
  /** How the machine is named in what the bridge says, when the URL does not say it (a loopback proxy). */
  where?: string;
}

/**
 * What the store is told after a reconnection: everything may have changed while nothing was heard.
 * The pushes it missed are gone, so each scope it listens for is invalidated once and it reads again —
 * the window stays where it was, with no reload.
 */
const RESYNC: PushMessage[] = (["tasks", "board", "task", "workflows", "config", "availability"] as const).map((scope) => ({ type: "store:invalidate", scope }));

/**
 * Connect, and stay connected: a dropped connection is retried with growing waits and a fresh `hello`,
 * until the machine refuses the token or {@link EngineBridge.close}.
 */
export function engineBridge(options: EngineBridgeOptions): EngineBridge {
  const first = options.retryMs ?? 1000;
  const longest = options.maxRetryMs ?? 30_000;
  const where = options.where ?? describe(options.url);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const listeners = new Set<(message: PushMessage) => void>();
  const stateListeners = new Set<(state: BridgeState) => void>();
  let socket: WebSocket | undefined;
  let admitted = false;
  let everConnected = false;
  let stopped = false;
  let nextId = 0;
  let wait = first;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt: ReturnType<typeof setTimeout> | undefined;
  let current: BridgeState = { state: "connecting" };
  /** Per-connection state the engine forgets with the connection (`connections.ts`), said again after a reconnection. */
  let watchingLimits = false;
  let settleReady: { resolve: (host: EngineHostInfo) => void; reject: (error: Error) => void } | undefined;
  const ready = new Promise<EngineHostInfo>((resolve, reject) => {
    settleReady = { resolve, reject };
  });
  // A page that never awaits `ready` (it listens to `onState`) must not see an unhandled rejection.
  ready.catch(() => undefined);

  const say = (state: BridgeState): void => {
    current = state;
    for (const listener of [...stateListeners]) listener(state);
  };

  const failPending = (reason: string): void => {
    for (const waiting of pending.values()) waiting.reject(new Error(reason));
    pending.clear();
  };

  /** Final: the machine will not have this device as it is, so there is nothing to retry. */
  const stop = (state: BridgeState & { state: "refused" | "mismatch" }): void => {
    stopped = true;
    admitted = false;
    if (timer !== undefined) clearTimeout(timer);
    if (attempt !== undefined) clearTimeout(attempt);
    const old = socket;
    socket = undefined;
    try {
      old?.close();
    } catch {
      // Already closing.
    }
    failPending(state.reason);
    settleReady?.reject(new Error(state.reason));
    say(state);
  };

  const later = (reason: string): void => {
    if (stopped) return;
    admitted = false;
    socket = undefined;
    if (attempt !== undefined) clearTimeout(attempt);
    failPending(reason);
    say({ state: "waiting", reason });
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(open, wait);
    wait = Math.min(wait * 2, longest);
  };

  const send = (frame: ClientFrame): void => socket?.send(JSON.stringify(frame));

  const receive = (frame: HostFrame): void => {
    if (!admitted) {
      if (frame.t === "refused") return stop({ state: "refused", reason: frame.reason });
      if (frame.t !== "welcome") return;
      if (frame.limited === true) {
        return stop({
          state: "mismatch",
          reason:
            frame.host.version === options.version
              ? `${where} runs another build of JaiRA ${frame.host.version} than this one: update both to the same build`
              : `${where} runs JaiRA ${frame.host.version}, which this JaiRA ${options.version} cannot talk to: update both to the same version`,
        });
      }
      admitted = true;
      wait = first;
      if (attempt !== undefined) clearTimeout(attempt);
      const again = everConnected;
      everConnected = true;
      settleReady?.resolve(frame.host);
      say({ state: "connected", host: frame.host });
      if (again) {
        if (watchingLimits) send({ t: "req", id: ++nextId, channel: "limits:watch", request: { watching: true } });
        for (const message of RESYNC) for (const listener of [...listeners]) listener(message);
      }
      return;
    }
    if (frame.t === "push") {
      for (const listener of [...listeners]) listener(frame.message);
      return;
    }
    if (frame.t !== "res") return;
    const waiting = pending.get(frame.id);
    if (waiting === undefined) return;
    pending.delete(frame.id);
    if (frame.ok) waiting.resolve(frame.result);
    else {
      const error = new Error(frame.error.message);
      if (frame.error.name !== undefined) error.name = frame.error.name;
      waiting.reject(error);
    }
  };

  function open(): void {
    if (stopped) return;
    timer = undefined;
    // A reconnection stays "waiting" until it is welcomed: the shell's line says why it is not there.
    if (!everConnected) say({ state: "connecting" });
    let mine: WebSocket;
    try {
      mine = new WebSocket(options.url);
    } catch (e) {
      return later(`could not reach ${where}: ${(e as Error).message}`);
    }
    socket = mine;
    let opened = false;
    attempt = setTimeout(() => {
      if (socket !== mine || admitted) return;
      try {
        mine.close();
      } catch {
        // Already closing.
      }
      later(`${where} did not answer`);
    }, options.timeoutMs ?? 10_000);
    mine.onopen = () => {
      if (socket !== mine) return;
      opened = true;
      send({ t: "hello", token: options.token, contract: options.contract ?? ENGINE_CONTRACT, version: options.version, client: options.client });
    };
    mine.onmessage = (event) => {
      if (socket !== mine) return;
      let frame: HostFrame;
      try {
        frame = JSON.parse(String(event.data)) as HostFrame;
      } catch {
        return;
      }
      receive(frame);
    };
    const gone = (): void => {
      if (socket !== mine) return;
      later(admitted ? `the connection to ${where} dropped` : opened ? `${where} closed the connection` : `nothing answers at ${where}`);
    };
    mine.onclose = gone;
    mine.onerror = gone;
  }

  open();

  return {
    ready,
    state: () => current,
    onState(listener) {
      stateListeners.add(listener);
      return () => void stateListeners.delete(listener);
    },
    retryNow() {
      // `socket` is absent exactly while waiting between attempts.
      if (stopped || socket !== undefined) return;
      if (timer !== undefined) clearTimeout(timer);
      open();
    },
    close() {
      if (stopped) return;
      stopped = true;
      admitted = false;
      if (timer !== undefined) clearTimeout(timer);
      if (attempt !== undefined) clearTimeout(attempt);
      const old = socket;
      socket = undefined;
      try {
        old?.close();
      } catch {
        // Already closing.
      }
      failPending("the connection was closed");
      settleReady?.reject(new Error("the connection was closed"));
    },
    invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> {
      if (channel === "limits:watch") watchingLimits = (request as { watching?: boolean } | undefined)?.watching === true;
      if (!admitted || socket === undefined) {
        return Promise.reject(new Error(current.state === "waiting" || current.state === "refused" || current.state === "mismatch" ? current.reason : `not connected to ${where}`));
      }
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        send({ t: "req", id, channel, request: request === undefined ? null : request });
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
