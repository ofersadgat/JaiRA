/**
 * What the desktop's main process asks of the engine, wherever the engine runs (decision 0012 §3-§5):
 * in this process (`local`), or in another one this window is a client of (`remote`) — a server, a
 * second window's desktop, a `jaira` command holding the claim.
 *
 * The window's own requests are `invoke`. The rest is what main itself needs: its launch and crashes
 * logged, the updater's and plugins' items on the health board, what a quit would cut, the artifacts
 * its frames load. In-process these are method calls; as a client they are the `engine:*` channels.
 * A record that cannot reach the engine is printed rather than thrown: the reporter must not become
 * the failure.
 */
import type { JsonValue } from "@declarative-ai/json";
import { EngineConnections, serviceHandlers, type AppService, type CrashKind, type EngineClient, type EngineHostInfo, type Handler, type HostedEngine } from "@jaira/service";
import type { HealthItem, LogLevel } from "@jaira/shared";

export interface ServedArtifact {
  body: string;
  mediaType: string;
  interactive: boolean;
}

export interface EngineLink {
  readonly mode: "local" | "remote";
  /** Who hosts the engine: this process for `local` (undefined when it could not open its pipe). */
  readonly host: EngineHostInfo | undefined;
  /** One of the window's requests. */
  invoke(channel: string, request: unknown): Promise<unknown>;
  recordApp(level: LogLevel, message: string, detail?: JsonValue, raised?: string): void;
  recordCrash(kind: CrashKind, error: Error): void;
  recordWarning(error: Error): void;
  recordIpcFailure(channel: string, error: unknown): void;
  healthSet(item: Omit<HealthItem, "since">): void;
  healthClear(id: string): void;
  activeWork(): Promise<{ runs: number; turns: number }>;
  suspendForUpdate(): Promise<void>;
  probeExecutors(): Promise<void>;
  kickRemotes(): void;
  kickRepoWatch(): void;
  servedArtifact(token: string): Promise<ServedArtifact | undefined>;
  /** Re-open the projects remembered from the last session. */
  restore(): Promise<void>;
  /** Open one project, and stand this window at it. */
  open(dir: string): Promise<void>;
  /** A local engine drains and closes; a client disconnects. */
  close(): Promise<void>;
}

/** The window as one connection of its own engine: its current project and limits watch (§3). */
const WINDOW = "window";

/** This process's own engine, hosted on the pipe when `hosted` is there. */
export function localLink(service: AppService, hosted: HostedEngine | undefined): EngineLink {
  const dispatch: Record<string, Handler> = {
    ...(serviceHandlers(service) as Record<string, Handler>),
    ...((hosted?.connection(WINDOW) ?? new EngineConnections(service).handlersFor(WINDOW)) as Record<string, Handler>),
  };
  return {
    mode: "local",
    host: hosted?.host.info,
    invoke: async (channel, request) => {
      const handler = dispatch[channel];
      if (handler === undefined) throw new Error(`the engine does not answer '${channel}'`);
      return (handler as (request: unknown) => unknown)(request);
    },
    recordApp: (level, message, detail, raised) => service.recordApp(level, message, detail, raised),
    recordCrash: (kind, error) => service.recordCrash(kind, error),
    recordWarning: (error) => service.recordWarning(error),
    recordIpcFailure: (channel, error) => service.recordIpcFailure(channel, error),
    healthSet: (item) => service.health.set(item),
    healthClear: (id) => service.health.clear(id),
    activeWork: async () => service.activeWork(),
    suspendForUpdate: async () => service.suspendForUpdate(),
    probeExecutors: async () => {
      await service.probeExecutors();
    },
    kickRemotes: () => service.kickRemotes(),
    kickRepoWatch: () => service.kickRepoWatch(),
    servedArtifact: async (token) => service.servedArtifact(token),
    restore: async () => {
      await service.restore();
    },
    open: async (dir) => {
      await dispatch["project:open"]!({ dir } as never);
    },
    close: async () => {
      if (hosted !== undefined) await hosted.close();
      else await service.close();
    },
  };
}

/** An error as the pipe carries it: its stack survives the trip. */
function wire(error: unknown): { message: string; name?: string; stack?: string } {
  const e = error instanceof Error ? error : new Error(String(error));
  return { message: e.message, name: e.name, ...(e.stack !== undefined ? { stack: e.stack } : {}) };
}

/** Another process's engine, through this window's connection to it. */
export function remoteLink(client: EngineClient): EngineLink {
  const tell = (channel: string, request?: unknown): void => {
    client.invoke(channel, request).catch((e: unknown) => {
      try {
        console.error(`[jaira] ${channel} did not reach the engine: ${(e as Error).message}`);
      } catch {
        // Nothing left to report with.
      }
    });
  };
  return {
    mode: "remote",
    host: client.host,
    invoke: (channel, request) => client.invoke(channel, request),
    recordApp: (level, message, detail, raised) =>
      tell("engine:recordApp", { level, message, ...(detail !== undefined ? { detail } : {}), ...(raised !== undefined ? { raised } : {}) }),
    recordCrash: (kind, error) => tell("engine:recordCrash", { kind, error: wire(error) }),
    recordWarning: (error) => tell("engine:recordWarning", { error: wire(error) }),
    recordIpcFailure: (channel, error) => tell("engine:recordIpcFailure", { channel, error: wire(error) }),
    healthSet: (item) => tell("engine:healthSet", item),
    healthClear: (id) => tell("engine:healthClear", { id }),
    activeWork: async () => (await client.invoke("engine:activeWork")) as { runs: number; turns: number },
    suspendForUpdate: async () => {
      await client.invoke("engine:suspendForUpdate");
    },
    probeExecutors: async () => {
      await client.invoke("engine:probeExecutors");
    },
    kickRemotes: () => tell("engine:kickRemotes"),
    kickRepoWatch: () => tell("engine:kickRepoWatch"),
    servedArtifact: async (token) => ((await client.invoke("engine:servedArtifact", { token })) as ServedArtifact | null) ?? undefined,
    restore: async () => {
      await client.invoke("engine:restore");
    },
    open: async (dir) => {
      await client.invoke("project:open", { dir });
    },
    close: async () => client.close(),
  };
}
