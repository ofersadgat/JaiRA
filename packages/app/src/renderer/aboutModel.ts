/**
 * What Settings → About (`aboutPane.tsx`, `licensesPane.tsx`) works out, as hooks and pure functions in
 * a module of their own so the universal copy (decision 0015) says and does what the DOM's does: the
 * update track in effect and its ↺, what a downloading update does next, which control a plugin row
 * carries, where the engine runs, the `jaira` command's line, and the licence manifest.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  channelOfVersion,
  decodeThirdPartyLicenseManifest,
  filterThirdPartyLicenseEntries,
  inheritedValue,
  statesPath,
  type CliCommandStatus,
  type ConfigView,
  type EngineStatus,
  type JairaEngineConfig,
  type ThirdPartyLicenseEntry,
  type ThirdPartyLicenseManifest,
  type UpdateBusy,
  type UpdateChannel,
  type UpdateRestartChoice,
  type UpdateState,
} from "@jaira/shared/browser";
import { SOURCE_WORDS } from "./layerLabels";
import { invoke, subscribe as subscribePush } from "./store";
import { waitedFor, type PluginFamily, type PluginRow } from "./updatesModel";

export const TRACK_CHOICES: ReadonlyArray<readonly [string, UpdateChannel]> = [
  ["Stable", "stable"],
  ["Nightly", "nightly"],
];

export const TRACK_PATH = "updates.channel";

/** "A development build does not update itself." — a reason from main, as a sentence. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** The Updates section's rows: the running version and its own track, the track in effect, and its ↺. */
export function updateTrackOf(config: ConfigView | null, state: UpdateState | null): { version: string; own: UpdateChannel; channel: UpdateChannel; stated: boolean; back: string; words: string } {
  const version = state?.version ?? "";
  const own = channelOfVersion(version);
  const effective = (config?.effective as { updates?: { channel?: UpdateChannel } } | undefined)?.updates?.channel;
  const channel = effective ?? state?.channel ?? own;
  const stated = config !== null && statesPath(config.you, TRACK_PATH);
  const below = config !== null ? inheritedValue(config, TRACK_PATH, "you") : undefined;
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
  const [status, setStatus] = useState<CliCommandStatus | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    void invoke("cli:status", undefined).then(setStatus, () => undefined);
  }, []);
  const install = (): void => {
    setBusy(true);
    setError(undefined);
    invoke("cli:install", undefined)
      .then(setStatus, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
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

/** The Engine section's two switches in effect, and each one's ↺ while the personal layer states it. */
export function engineSwitchesOf(config: ConfigView | null): { separate: boolean; keep: boolean; resetLabel: (path: "engine.separateServer" | "engine.keepServerRunning") => string | undefined } {
  const effective = (config?.effective as { engine?: JairaEngineConfig } | undefined)?.engine ?? {};
  return {
    separate: effective.separateServer === true,
    keep: effective.keepServerRunning === true,
    resetLabel: (path) => {
      if (config === null || !statesPath(config.you, path)) return undefined;
      const below = inheritedValue(config, path, "you");
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
