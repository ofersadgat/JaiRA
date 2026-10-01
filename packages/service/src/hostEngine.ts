/**
 * Hosting the engine (decision 0012 §2, §5): the claim, the dispatch and the per-connection state put
 * together, for each of the three kinds of host.
 *
 * - **The desktop** hosts its own window's engine, built before the claim.
 * - **`jaira serve`** builds one and hosts until it is stopped (`engine:stop`, or a signal).
 * - **A CLI command with no host** holds the claim for its duration (ruled 2026-09-26: "a") with NO
 *   engine built: the command runs its own. Only if a client connects meanwhile — a desktop started
 *   while the command runs — is one built, to answer it. When the command ends the host closes, and the
 *   desktop becomes the host itself (§2, "lost its host").
 */
import { IPC_CHANNELS, type PushMessage } from "@jaira/shared";
import { CONNECTION_CHANNELS, EngineConnections } from "./connections";
import type { EngineHostInfo } from "./enginePipe";
import { NotOffered, claimEngine, type EngineHost, type EngineHostOptions, type PreAuthHandler } from "./engineHost";
import { listenNetwork, type NetworkListener } from "./engineNet";
import { HOST_CHANNELS, enginePeerHandlers, serviceHandlers, type EngineControl, type Handler } from "./handlers";
import type { AppService } from "./service";

export interface HostEngineOptions {
  baseDir: string;
  kind: EngineHostInfo["kind"];
  version: string;
  /**
   * The engine: one already built, or how to build it — called at once when `eager`, otherwise the
   * first time a client asks for anything. `publish` sends a push to every client.
   */
  service: AppService | ((publish: (message: PushMessage) => void) => AppService);
  eager?: boolean;
  /** What `engine:stop` does. Absent: it is refused with `stopRefusal`. */
  stop?: () => Promise<void>;
  stopRefusal?: string;
  /** Answers over the service's, for every client: the desktop's follow-up to `config:write`. */
  handlers?: Partial<Record<string, Handler>>;
  onFailure?: (channel: string, error: unknown) => void;
  log?: EngineHostOptions["log"];
  /**
   * Listen for other machines on loopback (decision 0013 §2) and attach the engine's fleet: the desktop
   * and `jaira serve` do; a command's claim does not. `port` for tests; 0 takes any free one.
   * `clientDir`: the built One client, served from the same listener to a browser that has no other
   * place to load it from (`clientFiles.ts`); the desktop passes the one it ships.
   */
  network?: { port?: number; clientDir?: string };
  /** Tests. */
  pipe?: string;
  port?: number;
  token?: string;
}

export interface HostedEngine {
  host: EngineHost;
  /** The engine, if it has been built. */
  built(): AppService | undefined;
  /** The engine, built now if it was not. */
  engine(): AppService;
  /** One connection's own answers — the desktop's window is one (`project:current`, `limits:watch`). */
  connection(id: string): Partial<Record<string, Handler>>;
  /** Close the pipe, then the engine if one was built. */
  close(): Promise<void>;
  /** The loopback port other machines reach this engine through, when it listens for them. */
  networkPort(): number | undefined;
}

/** The `engine:*` channels (`enginePeerHandlers`), named without building an engine to ask. */
export const PEER_CHANNELS = [
  "engine:info",
  "engine:stop",
  "engine:recordApp",
  "engine:recordChromium",
  "engine:recordCrash",
  "engine:recordWarning",
  "engine:recordIpcFailure",
  "engine:healthSet",
  "engine:healthClear",
  "engine:activeWork",
  "engine:suspendForUpdate",
  "engine:probeExecutors",
  "engine:kickRemotes",
  "engine:kickRepoWatch",
  "engine:servedArtifact",
  "engine:restore",
] as const;

/**
 * The service's channels that act on THIS machine's screen — its folder dialog, its file manager — which
 * a person holding a phone is not in front of (decision 0013 §8). The host's own channels
 * (`HOST_CHANNELS`: its clipboard, updater, plugins) are answered by a window's own process, and a
 * device has none: refused in words too, where the pipe would only say it does not answer them.
 */
const SCREEN_CHANNELS = ["project:choose", "shell:reveal"] as const;

function deviceRefusals(kind: string): Record<string, Handler> {
  const refuse = (channel: string, why: string): Handler =>
    (() => {
      throw new NotOffered(`'${channel}' ${why}, and is not offered to a ${kind}`);
    }) as Handler;
  return {
    ...Object.fromEntries(SCREEN_CHANNELS.map((channel) => [channel, refuse(channel, "acts on that machine's own screen")])),
    ...Object.fromEntries(HOST_CHANNELS.map((channel) => [channel, refuse(channel, "is the desktop app's own")])),
  };
}

/** Claim the engine and answer on its pipe; `undefined` when another process holds it. */
export async function hostEngine(options: HostEngineOptions): Promise<HostedEngine | undefined> {
  let host: EngineHost | undefined;
  let service: AppService | undefined = typeof options.service === "function" ? undefined : options.service;
  let connections: EngineConnections | undefined;
  let dispatch: Record<string, Handler> | undefined;
  const publish = (message: PushMessage): void => host?.broadcast(message);
  const engine = (): AppService => {
    if (service === undefined) {
      options.log?.("info", `building the engine to answer a client of this ${options.kind}`);
      service = (options.service as (publish: (message: PushMessage) => void) => AppService)(publish);
    }
    return service;
  };
  const connectionsOf = (): EngineConnections => (connections ??= new EngineConnections(engine()));
  // `engine:info` and `engine:stop` need no engine: a limited client, or `jaira server status` asking a
  // command that holds the claim, must not build one just to be told who is there.
  const control: EngineControl = {
    info: () => ({ host: host!.info, clients: host!.connected() }),
    stop: async () => {
      if (options.stop === undefined) throw new Error(options.stopRefusal ?? "this engine cannot be stopped from here");
      // Answered first, then stopped: the asker hears "stopping" before its connection goes.
      const stop = options.stop;
      setImmediate(() => void stop());
      return { stopping: true as const };
    },
  };
  const dispatchOf = (): Record<string, Handler> => {
    dispatch ??= { ...(serviceHandlers(engine()) as Record<string, Handler>), ...enginePeerHandlers(engine(), control), ...(options.handlers as Record<string, Handler> | undefined) };
    return dispatch;
  };
  // Every channel the service or a peer answers, resolved to the engine on first use. The host's own
  // (`HOST_CHANNELS`: dialogs, the updater, plugins) are not the pipe's: a window answers those itself.
  const hostOnly = new Set<string>(HOST_CHANNELS);
  const lazy: Record<string, Handler> = {};
  for (const channel of [...IPC_CHANNELS, ...PEER_CHANNELS]) {
    if (hostOnly.has(channel)) continue;
    lazy[channel] = ((request: unknown) => (dispatchOf()[channel] as (request: unknown) => unknown)(request)) as Handler;
  }
  lazy["engine:info"] = (() => control.info()) as Handler;
  lazy["engine:stop"] = (() => control.stop()) as Handler;
  if (options.eager === true) engine();
  host = await claimEngine({
    baseDir: options.baseDir,
    kind: options.kind,
    version: options.version,
    handlers: lazy,
    connect: (client) => {
      // A device's row on Settings → Machines says whether it is connected.
      if (client.device !== undefined) service?.fleet?.clientsChanged();
      return {
        handlers: {
          ...Object.fromEntries(
            CONNECTION_CHANNELS.map((channel) => [
              channel,
              ((request: unknown) => (connectionsOf().handlersFor(client.id)[channel] as (request: unknown) => unknown)(request)) as Handler,
            ]),
          ),
          // Another machine: answered with this machine's own workspaces, and what paired machines ask of
          // each other (decision 0013 §7).
          ...(client.machine !== undefined ? { ...(serviceHandlers(engine(), { local: true }) as Record<string, Handler>), ...(engine().peerHandlers(client.machine) as Record<string, Handler>) } : {}),
          // A phone or a browser (amended 2026-09-30): a window like the desktop's own — the service's
          // answers, with this connection's current project and limits watch above — less what a window
          // can only do in front of this machine's screen.
          ...(client.device !== undefined ? deviceRefusals(client.device.kind) : {}),
        },
        closed: () => {
          connections?.drop(client.id);
          if (client.device !== undefined) service?.fleet?.clientsChanged();
        },
      };
    },
    ...(options.network !== undefined
      ? {
          authorizeNetwork: (token: string) => engine().fleet.authorize(token),
          preAuth: ((frame, transport) => (transport === "network" ? engine().fleet.preAuth(frame, transport) : Promise.resolve(undefined))) as PreAuthHandler,
        }
      : {}),
    ...(options.onFailure !== undefined ? { onFailure: options.onFailure } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
    ...(options.pipe !== undefined ? { pipe: options.pipe } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.token !== undefined ? { token: options.token } : {}),
  });
  if (host === undefined) return undefined;
  const claimed = host;
  let net: NetworkListener | undefined;
  if (options.network !== undefined) {
    const service = engine();
    try {
      net = await listenNetwork({
        host: claimed,
        identity: () => service.fleet.identity(),
        version: options.version,
        ...(options.network.port !== undefined ? { port: options.network.port } : {}),
        ...(options.network.clientDir !== undefined ? { clientDir: options.network.clientDir } : {}),
        ...(options.log !== undefined ? { log: options.log } : {}),
      });
      await service.fleet.attach(claimed, net.port);
    } catch (e) {
      options.log?.("warn", `other machines cannot reach this engine: ${(e as Error).message}`);
    }
  }
  return {
    host: claimed,
    built: () => service,
    engine,
    connection: (id) => connectionsOf().handlersFor(id),
    close: async () => {
      service?.fleet?.close();
      await net?.close();
      await claimed.close();
      await service?.close();
    },
    networkPort: () => net?.port,
  };
}
