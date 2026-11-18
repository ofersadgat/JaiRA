/**
 * What Settings → About (`AboutPage.tsx`) works out, as hooks and pure functions: which machine it is
 * about (the one Settings' path names), the update track in effect and its ↺, what a downloading update
 * does next, which control a plugin row carries, where the engine runs, the `jaira` command's line, and
 * the licence manifest.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  channelOfVersion,
  decodeThirdPartyLicenseManifest,
  SHARED_SESSION,
  filterThirdPartyLicenseEntries,
  inheritedValue,
  statesPath,
  type CliCommandStatus,
  type ConfigView,
  type EngineStatus,
  type JairaEngineConfig,
  type MachinesView,
  type ThirdPartyLicenseEntry,
  type ThirdPartyLicenseManifest,
  type UpdateBusy,
  type UpdateChannel,
  type UpdateRestartChoice,
  type UpdateState,
} from "@jaira/shared/browser";
import { SOURCE_WORDS } from "./layerLabels";
import type { SettingsPath } from "./settingsScope";
import { invoke, subscribe as subscribePush, syncCache } from "./store";
import { useView } from "./useView";
import { waitedFor, type PluginFamily, type PluginRow } from "./updatesModel";

export const TRACK_CHOICES: ReadonlyArray<readonly [string, UpdateChannel]> = [
  ["Stable", "stable"],
  ["Nightly", "nightly"],
];

export const TRACK_PATH = "updates.channel";

/**
 * Where this machine's own settings are kept — the update track, how the engine is hosted: this
 * machine's layer (`machine-settings.json`), or Just you on an engine that predates it, where they were
 * kept before (decision 0026). A value still in Just you is read too, and its ↺ takes it out of both.
 */
export function machineLayerOf(config: ConfigView | null): "machine" | "you" {
  return config !== null && typeof config.machineFile === "string" ? "machine" : "you";
}

/** Whether this machine's layer — or Just you, where it used to be kept — states a path. */
function statesHere(config: ConfigView, path: string): boolean {
  const layer = machineLayerOf(config);
  return statesPath(config[layer], path) || (layer === "machine" && statesPath(config.you, path));
}

/**
 * Which machine About is about: this one, or the paired machine Settings' path names — its version as
 * it last said, and whether it is online. About is the machine's page, so a project or Just you in the
 * path changes nothing here; only a machine does.
 */
export type AboutMachine =
  | { remote: false }
  | { remote: true; id: string; label: string; version?: string; online: boolean; /** What hosts its engine, as it last said. */ host?: "desktop" | "server" | "cli" };

export function aboutMachineOf(path: SettingsPath, machines: MachinesView | undefined): AboutMachine {
  const named = path.machine;
  if (named === undefined || named.self === true || named.id === machines?.self.id) return { remote: false };
  const peer = machines?.machines.find((m) => m.id === named.id);
  return {
    remote: true,
    id: named.id,
    label: peer?.label ?? "a paired machine",
    ...(peer?.version !== undefined ? { version: peer.version } : {}),
    online: peer?.state === "online",
    ...(peer?.host !== undefined ? { host: peer.host } : {}),
  };
}

/**
 * What About says in place of what only the machine itself can do — check for an update, download it,
 * restart into it, install a plugin, put the `jaira` command on the PATH — when it is about another.
 */
export function remoteAboutWords(machine: Extract<AboutMachine, { remote: true }>): {
  lead: string;
  updates: string;
  plugins: string;
  command: string;
  /** Where its engine runs, as it last said: its name and a sentence. Absent until it has said. */
  runsIn?: { name: string; description: string };
  separate: (on: boolean) => string;
  keep: (on: boolean) => string;
} {
  const name = machine.label;
  const said = machine.online ? "" : ", when it last said";
  const runsIn =
    machine.host === "server"
      ? { name: "jaira serve", description: `${name}'s engine is a server of its own${said}, with no JaiRA window running it: the two switches below are for when a window starts there.` }
      : machine.host === "desktop"
        ? { name: "The app", description: `${name}'s engine runs in JaiRA's window there${said}.` }
        : machine.host === "cli"
          ? { name: "A jaira command", description: `${name}'s engine was started by a jaira command there${said}, and ends with it.` }
          : undefined;
  return {
    plugins: `Plugins are downloaded on ${name} itself, by JaiRA there: take ${name} out of Settings' path to see this machine's.`,
    command: `The jaira command is installed on ${name} itself, by JaiRA there: take ${name} out of Settings' path to see this machine's.`,
    ...(runsIn !== undefined ? { runsIn } : {}),
    separate: (on) =>
      on ? `When JaiRA's window starts on ${name}, it starts jaira serve and connects to it.` : `When JaiRA's window starts on ${name}, the engine runs in the window's own process.`,
    keep: (on) => (on ? `A server JaiRA's window on ${name} starts keeps running after the window quits.` : `A server JaiRA's window on ${name} starts stops when the window quits.`),
    lead: `About ${name}: its version, its update track and how its engine is hosted, read from ${name} and written to its machine-settings.json.${machine.online ? "" : ` ${name} is offline, so what it last said is shown and nothing can be changed there now.`}`,
    updates: `Checking for an update, downloading it and restarting into it happen on ${name} itself, in JaiRA there: this window sets only its track.`,
  };
}

/**
 * A paired machine's own view of its settings (`config:read` there, for no project), read for About
 * while the path names it, and again after a write or when settings change. Nothing while `machine` is
 * undefined.
 */
export function useMachineConfig(machine: string | undefined): { config: ConfigView | null; problem: string | null; reload: () => void } {
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    setConfig(null);
    setProblem(null);
    if (machine === undefined) return;
    let live = true;
    const read = (): void => {
      invoke("config:read", { project: SHARED_SESSION, machine }).then(
        (view) => {
          if (live) {
            setConfig(view);
            setProblem(null);
          }
        },
        (e: unknown) => {
          if (live) setProblem(e instanceof Error ? e.message : String(e));
        },
      );
    };
    read();
    const stop = subscribePush((message) => {
      if (message.type === "store:invalidate" && message.scope === "config") read();
    });
    return () => {
      live = false;
      stop();
    };
  }, [machine, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { config, problem, reload };
}

/** "A development build does not update itself." — a reason from main, as a sentence. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/**
 * The Updates section's rows: the running version and its own track, the track in effect, and its ↺.
 * `remote` is a paired machine's: its version as it last said, in place of this updater's.
 */
export function updateTrackOf(
  config: ConfigView | null,
  state: UpdateState | null,
  remote?: { version?: string | undefined },
): { version: string; own: UpdateChannel; channel: UpdateChannel; stated: boolean; back: string; words: string } {
  const version = remote !== undefined ? (remote.version ?? "") : (state?.version ?? "");
  const own = channelOfVersion(version);
  const effective = (config?.effective as { updates?: { channel?: UpdateChannel } } | undefined)?.updates?.channel;
  const channel = effective ?? (remote !== undefined ? undefined : state?.channel) ?? own;
  const stated = config !== null && statesHere(config, TRACK_PATH);
  const below = config !== null ? inheritedValue(config, TRACK_PATH, machineLayerOf(config)) : undefined;
  const back = below === undefined || below.value === undefined ? `Back to this build's own track, ${own}` : `Back to ${String(below.value)}, from ${SOURCE_WORDS[below.from]}`;
  const words = channel === "nightly" ? "Nightly: every day's build, a few a day at most." : "Stable: tested releases, a few a month.";
  return { version, own, channel, stated, back, words };
}

/** What a downloading update does once it has: restart, wait, or install when JaiRA closes. */
export function downloadingThen(queued: UpdateRestartChoice | undefined, busy: UpdateBusy | undefined): string {
  return queued === "later"
    ? " · then installs when JaiRA next closes"
    : queued === "cancel"
      ? " · then waits for you to restart"
      : queued === "pause"
        ? " · then pauses what is going and restarts"
        : busy !== undefined && busy.runs + busy.turns > 0
          ? ` · then restarts when ${waitedFor(busy)} finish`
          : " · then restarts";
}

/** What the Agent SDK's own licence (`LICENSE.md`) points its use to. */
export const ANTHROPIC_TERMS = "https://code.claude.com/docs/en/legal-and-compliance";

/** Which control a plugin family's own row carries. */
export type PluginControl = "progress" | "checkout" | "retry" | "current" | "outdated" | "pick" | "download";

export function pluginControlOf(row: PluginRow, local: boolean): PluginControl {
  if (row.busy) return "progress";
  if (row.workspace) return "checkout";
  if (row.status.error !== undefined) return "retry";
  if (row.current) return "current";
  if (row.outdated) return "outdated";
  if (local) return "pick";
  return "download";
}

/** What a plugin family's row says, before any "is installed; this build uses" line. */
export function pluginDescriptionOf(family: PluginFamily): { text: string | undefined; terms: boolean } {
  const row = family.base;
  if (family.builds.length > 0) {
    return {
      text: row.status.installed !== undefined ? "Loads GGUF weights into JaiRA itself. Add another build beside the one you have." : "Loads GGUF weights into JaiRA itself. Pick the build for your hardware; the suggested one fits this machine.",
      terms: false,
    };
  }
  if (row.id === "claude-agent-sdk") return { text: "Runs the Claude route on an API key, and reads the claude-cli route's usage.", terms: row.status.installed === undefined };
  return { text: row.note, terms: false };
}

/** Which control a Local models build carries. */
export type BuildTail = "progress" | "checkout" | "retry" | "current" | "outdated" | "offer";

export function buildTailOf(build: PluginRow): BuildTail {
  if (build.busy) return "progress";
  if (build.workspace) return "checkout";
  if (build.status.error !== undefined) return "retry";
  if (build.current) return "current";
  if (build.outdated) return "outdated";
  return "offer";
}

/** What the Command line row says for each state of the `jaira` command. */
export function commandWords(status: CliCommandStatus): string {
  switch (status.state) {
    case "installed":
      return `On your PATH (${status.path ?? "installed"}), running this JaiRA.`;
    case "missing":
      return status.canInstall ? "Not on your PATH yet." : `Not on your PATH: ${status.reason ?? "reinstall JaiRA"}.`;
    case "development":
    case "unavailable":
      return `Not here: ${status.reason ?? "this build has no command"}.`;
  }
}

/** The `jaira` command's status, and installing it. */
export function useCliCommand(): { status: CliCommandStatus | undefined; busy: boolean; error: string | undefined; install: () => void } {
  // A view of the window's cache (decision 0018, group 7); installing reads it again.
  const status = useView("cli:status", undefined).value;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const install = (): void => {
    setBusy(true);
    setError(undefined);
    invoke("cli:install", undefined)
      .then(() => syncCache().refresh("cli:status", undefined), (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return { status, busy, error, install };
}

/** Where this window's engine runs, as the row names it. */
export function engineWhere(status: EngineStatus): { name: string; description: string } {
  const host = status.host;
  if (status.mode === "starting" || host === undefined) return { name: "Starting…", description: "Finding the engine, or starting it." };
  const who = `process ${host.pid}, JaiRA ${host.version}`;
  if (status.mode === "local") {
    return { name: "This window", description: "The engine runs in this window's process. The jaira command and other JaiRA windows use it while this window is open." };
  }
  switch (host.kind) {
    case "server":
      return { name: status.startedServer ? "A separate server this window started" : "A separate server", description: `jaira serve (${who}). Runs carry on when this window closes.` };
    case "desktop":
      return { name: "Another JaiRA window", description: `It started first (${who}), so this window uses its engine. Quitting that window moves the engine here.` };
    case "cli":
      return { name: "A jaira command", description: `It is running (${who}); when it ends, this window runs the engine itself.` };
  }
}

export function useEngineStatus(): EngineStatus | undefined {
  const [status, setStatus] = useState<EngineStatus | undefined>(undefined);
  useEffect(() => {
    void invoke("engine:status", undefined).then(setStatus, () => undefined);
    return subscribePush((message) => {
      if (message.type === "engine:changed") setStatus(message.status);
    });
  }, []);
  return status;
}

/** The Engine section's two switches in effect, and each one's ↺ while this machine's layer (or Just you, before it) states it. */
export function engineSwitchesOf(config: ConfigView | null): { separate: boolean; keep: boolean; resetLabel: (path: "engine.separateServer" | "engine.keepServerRunning") => string | undefined } {
  const effective = (config?.effective as { engine?: JairaEngineConfig } | undefined)?.engine ?? {};
  return {
    separate: effective.separateServer === true,
    keep: effective.keepServerRunning === true,
    resetLabel: (path) => {
      if (config === null || !statesHere(config, path)) return undefined;
      const below = inheritedValue(config, path, machineLayerOf(config));
      return below === undefined || below.value === undefined ? "Back to the default, off" : `Back to ${below.value === true ? "on" : "off"}, from ${SOURCE_WORDS[below.from]}`;
    },
  };
}

type ManifestState = { readonly status: "loading" } | { readonly status: "error"; readonly message: string } | { readonly status: "ready"; readonly manifest: ThirdPartyLicenseManifest };

/** The build's third-party notices, read and decoded, narrowed by a query. */
export function useLicenseManifest(query: string): { state: ManifestState; entries: readonly ThirdPartyLicenseEntry[]; shown: readonly ThirdPartyLicenseEntry[]; retry: () => void } {
  const [state, setState] = useState<ManifestState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    invoke("licenses:read", undefined).then(
      (raw) => {
        if (!live) return;
        try {
          setState({ status: "ready", manifest: decodeThirdPartyLicenseManifest(raw) });
        } catch (error) {
          setState({ status: "error", message: (error as Error).message });
        }
      },
      (error: unknown) => {
        if (live) setState({ status: "error", message: error instanceof Error ? error.message : "The license manifest could not be read." });
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  const entries = state.status === "ready" ? state.manifest.entries : [];
  const shown = useMemo(() => filterThirdPartyLicenseEntries(entries, query), [entries, query]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, entries, shown, retry };
}

/** The count beside the search: "340 notices", or "12 of 340". */
export function licenseCountWords(shown: number, total: number): string {
  return shown === total ? `${String(total)} notices` : `${String(shown)} of ${String(total)}`;
}
