/**
 * What Settings → Connections COMPUTES, for the rows in
 * `packages/universal/src/components/settings/connections/`. No DOM here: the words a row says, its
 * state, the schemas its forms are drawn from, and what its buttons write.
 */
import { useEffect, useMemo, useState } from "react";
import {
  BUILTIN_FORGES,
  FORGE_CLIS,
  FORGE_LABELS,
  SECRET_SOURCE_LABELS,
  FORGE_PROVIDERS,
  SCREEN_MAPPING,
  TOOL_SPECS,
  isMcpStdio,
  mcpSecretsOf,
  mcpWhere,
  placeArgsOf,
  parseIntegrations,
  parseMcp,
  toolsInCategory,
  type AgentAccount,
  type AgentInstall,
  type AgentInstallMethod,
  type InstallChoice,
  type InstallWay,
  type ConfigLayer,
  type ConfigView,
  type EmbeddedWeightsReport,
  type ExecutorInfo,
  type ForgeCheck,
  type GitCliName,
  type JairaForgeConnection,
  type LocalServerProbe,
  type McpDetectedSource,
  type McpServerConfig,
  type McpServerStatus,
  type ProbeResult,
  type SecretCapabilities,
  type SecretTarget,
} from "@jaira/shared/browser";
import { MODEL_PROVIDERS, agentProviders, allFields, fieldText, fieldValue, providerBlockPath, type FieldSpec, type ProviderSpec } from "./providerSpecs";
import { executorBlock, type ExecutorPatch, type ExecutorTarget } from "./executorConfig";
import { routeBlock, type ModelPatch } from "./modelsConfig";
import type { Schema } from "./schemaForm/types";
import { invoke } from "./store";

// --- a row's state ------------------------------------------------------------------------------

export type ProviderState = "available" | "unavailable" | "unconfigured" | "off" | "unchecked" | "needs-sign-in";

const STATE_WORDS: Record<ProviderState, string> = {
  available: "ready",
  unavailable: "not working",
  unconfigured: "not set up",
  off: "turned off",
  unchecked: "not checked",
  "needs-sign-in": "not signed in",
};

/** The state in words, for the sentence that opens a row's status line. */
export function stateWord(state: ProviderState): string {
  return STATE_WORDS[state];
}

/** What a provider's row should say, from its configuration and what the check observed. */
export function providerState(enabled: boolean, probe: ProbeResult | undefined): ProviderState {
  if (!enabled) return "off";
  if (probe === undefined) return "unchecked";
  if (probe.status === "ok") return "available";
  if (probe.status === "failed") return "unavailable";
  if (probe.status === "disabled") return "off";
  if (probe.status === "needs-sign-in") return "needs-sign-in";
  return "unconfigured";
}

/** "checked 2 min ago", or the honest absence of one. */
export function checkedAgo(at: number): string {
  if (at === 0) return "not checked yet";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "checked just now";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `checked ${minutes} min ago` : `checked ${Math.round(minutes / 60)} h ago`;
}

/** Where a key, token or secret can be stored from this window: the keychain, the project's file, the shared one. */
export function secretTargetsOf(secrets: SecretCapabilities, hasProject: boolean): SecretTarget[] {
  return [
    ...(secrets.keychain ? (["keychain"] as SecretTarget[]) : []),
    ...(hasProject ? (["project-env-local"] as SecretTarget[]) : []),
    "base-env-local",
  ];
}

// --- providers ----------------------------------------------------------------------------------

/**
 * The three groups of providers Connections draws, in the order a person sets them up: the agents
 * first (a subscription needs no key, and it is what a bare model id reaches first), then the model
 * APIs that take a key, then what runs on this machine.
 */
export function providerGroups(executors: ExecutorInfo[]): { agents: ProviderSpec[]; apis: ProviderSpec[]; local: ProviderSpec[] } {
  return {
    agents: agentProviders(executors),
    apis: MODEL_PROVIDERS.filter((spec) => !LOCAL_PROVIDERS.has(spec.id)),
    local: MODEL_PROVIDERS.filter((spec) => LOCAL_PROVIDERS.has(spec.id)),
  };
}

/** The model providers that run on this machine rather than behind a key: Connections → Local models. */
const LOCAL_PROVIDERS = new Set(["local", "embedded"]);

/** The binary an agent's logins belong to, and the command that signs it in by hand. */
export function loginCommandOf(agent: string, command: string | undefined): { binary: string; login: string } {
  const binary = command ?? agent.replace(/-cli$/, "");
  const login = agent === "claude-cli" ? `${binary} auth login` : `${binary} login`;
  return { binary, login };
}

// --- installing an agent ------------------------------------------------------------------------

/** A way of installing, as the install panel's first column and the version line name it. */
const INSTALLED_WITH: Record<AgentInstallMethod, string> = {
  native: "Native installer",
  homebrew: "Homebrew",
  npm: "npm",
  bun: "Bun",
  pnpm: "pnpm",
  winget: "WinGet",
  chocolatey: "Chocolatey",
  scoop: "Scoop",
  "command-line-tools": "Command Line Tools",
};

/** One line of an agent's install panel: a way and its command, or the place it was found. */
export interface InstallPanelRow {
  key: string;
  name: string;
  /** The command it runs, or the path it would use. */
  at: string;
  button: string;
  title: string;
  /** Install this way; absent with `path` and `choice` absent is the update (here, the reinstall). */
  method?: AgentInstallMethod;
  /** Install by this path through the install menu: this row's step, then the recommended way on. */
  choice?: readonly string[];
  /** The row as the cascading menu draws it — for its arrow, where the next step has more than one way. */
  menu?: InstallMenuRow;
  /** A step on its way asks for an administrator's password in the system's own window. */
  elevated?: boolean;
  /** `at` begins with words, not a command (`by fnm — or choose`): drawn in the app's face. */
  words?: boolean;
  /** Use this path as the agent's command. */
  path?: string;
}

/**
 * The panel under an agent's row when its binary will not run here, from what the probe found: not
 * installed (the ways to install it, the vendor's recommendation first), what is left of an install (the
 * reinstall), or installed where this app's PATH does not reach (that path, to use). Nothing for an
 * agent that runs, or one the probe did not look for.
 */
export function installPanelOf(install: AgentInstall | undefined): { head: string; right: string; rows: InstallPanelRow[] } | undefined {
  if (install === undefined) return undefined;
  // The menu, where the check built one: a row a step, with what comes after it and the arrow to choose.
  const menu = install.choices !== undefined ? installMenuOf(install.choices) : undefined;
  const ways = (verb: string): InstallPanelRow[] =>
    menu !== undefined
      ? menu.map((row) => ({
          key: row.key,
          name: row.name,
          at: row.then !== undefined ? `${row.at}, ${row.then}` : row.at,
          button: verb,
          title: row.title,
          ...(row.words ? { words: true } : {}),
          ...(typeof row.way === "string" ? { method: row.way } : { choice: row.way }),
          ...(row.sub !== undefined ? { menu: row } : {}),
          ...(row.elevated ? { elevated: true } : {}),
        }))
      : (install.install ?? []).map((one) => ({ key: one.method, name: INSTALLED_WITH[one.method], at: one.display, button: verb, title: `runs ${one.display}`, method: one.method }));
  const count = menu?.length ?? install.install?.length ?? 0;
  if (install.broken === true) {
    if (install.update !== undefined) {
      const one = install.update;
      return { head: `What is left of an install — ${install.path ?? "its link"} points at nothing`, right: "", rows: [{ key: "reinstall", name: INSTALLED_WITH[one.method], at: one.display, button: "Reinstall", title: `runs ${one.display}` }] };
    }
    return { head: "What is left of an install. Install it again with:", right: count > 1 ? "the first is recommended" : "", rows: ways("Install") };
  }
  if (install.path !== undefined && install.onPath === false) {
    return {
      head: "Installed where this app's PATH does not reach",
      right: "",
      rows: [{ key: "use", name: "Found at", at: install.path, button: "Use it", title: "run it from this path — saved in Just you, since the path is this machine's", path: install.path }],
    };
  }
  if (install.path !== undefined) return undefined;
  if (count === 0) {
    return { head: "Not installed — and none of the ways it is installed is on this machine", right: "", rows: [] };
  }
  return { head: "Not installed here. Install it with:", right: count > 1 ? "the first is recommended" : "", rows: ways("Install") };
}

/**
 * One row of a cascading install menu, as drawn: one step — what it runs, then what comes after it by
 * default — with the choices for the step after behind its arrow when there are several.
 */
export interface InstallMenuRow {
  key: string;
  /** The keys from the top of the menu to this row. */
  path: readonly string[];
  /**
   * What pressing it asks for: the way itself for a row that is one of the agent's own ways and all
   * there is to it — installed as it always was — else the path to it, run step by step.
   */
  way: InstallWay;
  name: string;
  /** What this step does: its command, or — where it installs its own installer first — "installs fnm, then Node.js". */
  at: string;
  /** `at` is words, not a command: drawn in the app's face, not the data face. */
  words: boolean;
  /** What comes after it by default, where something does: "then npm install -g @google/gemini-cli". */
  then?: string;
  /** Some step on its way asks for an administrator's password, in the system's own window. */
  elevated: boolean;
  /** Every command it runs, in order, by the recommended way at each step after. */
  title: string;
  recommended: boolean;
  /** The choices for the step after, when there are more than one — drawn behind an arrow. */
  sub?: InstallMenuRow[];
}

/** The commands a choice runs, then the recommended choice's after it, to the end. */
function defaultPathOf(choice: InstallChoice): InstallChoice["steps"] {
  const steps = [...choice.steps];
  for (let next = choice.next?.[0]; next !== undefined; next = next.next?.[0]) steps.push(...next.steps);
  return steps;
}

/** What one row says it does. */
function rowAt(choice: InstallChoice): string {
  if (choice.steps.length === 1) return choice.steps[0]!.display;
  if (choice.steps.length > 1) return `installs ${choice.steps.map((step) => step.title).join(", then ")}`;
  // A row that groups the ways to get something: by the recommended one, the others behind its chevron.
  const first = choice.next?.[0];
  return first !== undefined ? `by ${first.name}` : "";
}

/**
 * The install menu as rows: each choice a row that runs its step and then the recommended way on;
 * its arrow, where the next step has more than one way, opens those.
 */
export function installMenuOf(choices: readonly InstallChoice[] | undefined, path: readonly string[] = []): InstallMenuRow[] {
  return (choices ?? []).map((choice, i) => {
    const here = [...path, choice.key];
    const steps = defaultPathOf(choice);
    const next = choice.next ?? [];
    // A grouping row's "then" is what its recommended way goes on to; a step's, the step after it.
    const after = choice.steps.length === 0 ? (next[0]?.next ?? []) : next;
    const then = after[0] !== undefined ? (after[0].steps.length === 1 ? after[0].steps[0]!.display : rowAt(after[0])) : undefined;
    const alone = path.length === 0 && next.length === 0 && choice.steps.length === 1 && choice.key in INSTALLED_WITH;
    return {
      key: choice.key,
      path: here,
      way: alone ? (choice.key as AgentInstallMethod) : here,
      name: alone ? INSTALLED_WITH[choice.key as AgentInstallMethod] : choice.name,
      at: rowAt(choice),
      words: choice.steps.length !== 1,
      ...(then !== undefined && then !== "" ? { then: `then ${then}` } : {}),
      elevated: steps.some((step) => step.elevated === true),
      title: `runs ${steps.map((step) => step.display).join(", then ")}`,
      recommended: i === 0 && (choices?.length ?? 0) > 1,
      ...(next.length > 1 ? { sub: installMenuOf(next, here) } : {}),
    };
  });
}

/** What the version line says of an agent that runs: how it was installed, and its Update — or nothing. */
export function updateOf(install: AgentInstall | undefined): { via: string; title: string } | undefined {
  if (install?.update === undefined || install.broken === true || install.onPath === false) return undefined;
  return { via: INSTALLED_WITH[install.update.method], title: `update it: runs ${install.update.display}` };
}

// --- Connections → Agents: the rows and the shelf -----------------------------------------------

/**
 * Where an agent is drawn in Connections → Agents: a row of its own once its binary is on this machine
 * (running, half removed, or found where this app's PATH does not reach), and a tile on the shelf under
 * the card while it is not — the check looked for the binary, found none, and could not start one. One
 * that cannot run without a key and has none (`keyNeeded`) is on the shelf too, until it has its key
 * (the person, 2026-11-19: grouped "with the uninstalled tools until you add an api key"). An agent the
 * check did not look for (a CLI JaiRA cannot install, one turned off) is a row.
 */
export function agentPlaceOf(probe: ProbeResult | undefined): "row" | "shelf" {
  if (probe?.status !== "failed") return "row";
  if (probe.keyNeeded !== undefined) return "shelf";
  return probe.install !== undefined && probe.install.path === undefined ? "shelf" : "row";
}

/**
 * Where a model API is drawn in Connections → Model APIs: a row once it has a key (or is turned off, or
 * not checked yet), and a tile on the shelf under the card while it has none (`keyNeeded`) — the
 * agents' rule for a key (the person, 2026-11-19: "model apis should have the same shelf").
 */
export function routePlaceOf(probe: ProbeResult | undefined): "row" | "shelf" {
  return keyTileOf(probe) !== undefined ? "shelf" : "row";
}

/** A shelf tile for an agent or a model API waiting on its key: the line under its name, and its button's title. */
export function keyTileOf(probe: ProbeResult | undefined): { sub: string; title: string } | undefined {
  if (probe?.status !== "failed" || probe.keyNeeded === undefined) return undefined;
  return { sub: "needs an API key", title: `store ${probe.keyNeeded}` };
}

/**
 * Whether the check could not reach the program: not installed, what is left of an install, or installed
 * where this app's PATH does not reach. Then who it runs as, its shell and its settings say nothing that
 * matters yet, and the row shows only what would make it work.
 */
export function unreachedOf(probe: ProbeResult | undefined): boolean {
  const install = probe?.install;
  return probe?.status === "failed" && install !== undefined && (install.path === undefined || install.broken === true || install.onPath === false);
}

/** Not installed at all — nothing of it found: what an opened row offers is Install, not a list of ways. */
export function notInstalledOf(probe: ProbeResult | undefined): boolean {
  const install = probe?.install;
  return probe?.status === "failed" && install !== undefined && install.path === undefined && install.broken !== true;
}

/**
 * The way an install that failed was asked for, to try it again the same way — undefined while it runs,
 * after it worked, after a Cancel, or for an update (no way named).
 */
export function retryWayOf(log: { running: boolean; way?: InstallWay | undefined; outcome?: { ok: true } | { ok: false; reason: string } | undefined } | undefined): InstallWay | undefined {
  if (log === undefined || log.running || log.outcome === undefined || log.outcome.ok || /cancelled$/.test(log.outcome.reason)) return undefined;
  return log.way;
}

/** A closed row's install button as the retry of the way that failed: "Install again", by that way. */
export function retryActionOf(action: AgentAction | undefined, retry: InstallWay | undefined): AgentAction | undefined {
  if (action?.kind !== "install" || action.path !== undefined || retry === undefined) return action;
  return { kind: "install", label: "Install again", title: "try the same way again", ...(typeof retry === "string" ? { method: retry } : { choice: retry }) };
}

/** A shelf tile's line under its name, and the ways to install it — the recommended one first. */
export function shelfTileOf(install: AgentInstall | undefined): { sub: string; ways: InstallPanelRow[]; menu?: InstallMenuRow[] } {
  const ways = (installPanelOf(install)?.rows ?? []).filter((row) => row.method !== undefined || row.choice !== undefined);
  if (install?.choices !== undefined) {
    const menu = installMenuOf(install.choices);
    const first = install.choices[0];
    const steps = first !== undefined ? defaultPathOf(first) : [];
    // What the recommended way takes: the things it installs before the program itself, if any.
    const before = steps.slice(0, -1).map((step) => step.title);
    const sub = first === undefined ? "nothing here installs it" : before.length > 0 ? `installs ${before.join(" and ")} first` : `installs with ${steps[0]?.via ?? first.name}`;
    return { sub, ways, menu };
  }
  const first = install?.install?.[0];
  return { sub: first !== undefined ? `installs with ${first.via}` : "nothing here installs it", ways };
}

// --- Connections → Git: git, and the forges' own CLIs ------------------------------------------

/** The git programs as their rows and tiles name them. */
export const GIT_CLI_TITLES: Readonly<Record<GitCliName, string>> = { git: "Git", gh: "GitHub CLI", glab: "GitLab CLI" };

/** What a git program's tile says it is for, under its name — the forge it calls. */
export const GIT_CLI_FOR: Readonly<Record<GitCliName, string>> = { git: "", gh: "GitHub from a shell", glab: "GitLab from a shell" };

/**
 * Where a git program is drawn in Connections → Git: git is always a row — JaiRA cannot do without it,
 * so its absence is said where it is looked for, not tucked on a shelf — and gh and glab are rows once
 * the check found them, tiles under the card while it did not (the agents' rule, {@link agentPlaceOf}).
 */
export function gitCliPlaceOf(name: GitCliName, probe: ProbeResult | undefined): "row" | "shelf" {
  return name === "git" ? "row" : agentPlaceOf(probe);
}

/**
 * A git program's install panel: the agents', less the path to use — a git program found where this
 * app's PATH does not reach has that folder added to it by the check itself, so one still reported so
 * is in WSL, where its sentence says what to do.
 */
export function gitCliPanelOf(install: AgentInstall | undefined): ReturnType<typeof installPanelOf> {
  if (install?.onPath === false && install.broken !== true) return undefined;
  return installPanelOf(install);
}

/** A git program's one button on its closed row: the install or reinstall that would make it work, or nothing. */
export function gitCliActionOf(probe: ProbeResult | undefined): AgentAction | undefined {
  if (probe === undefined || probe.status !== "failed") return undefined;
  const fix = gitCliPanelOf(probe.install)?.rows[0];
  if (fix === undefined || (fix.method === undefined && fix.choice === undefined)) return undefined;
  return { kind: "install", label: fix.button, title: fix.title, ...(fix.method !== undefined ? { method: fix.method } : {}), ...(fix.choice !== undefined ? { choice: fix.choice } : {}) };
}

/**
 * A closed agent row's one line: the state's word, then — ready — its version and how it was installed,
 * or else what the check found. Drawn on one line; the opened row says the check whole, with its fix.
 */
export function agentLineOf(probe: ProbeResult | undefined, state: ProviderState, install: AgentInstall | undefined): { word: string; rest: string | undefined } {
  const word = providerSayState(probe, state);
  if (probe === undefined || state === "off" || state === "unchecked") return { word, rest: undefined };
  if (state === "available") {
    const via = install?.method !== undefined ? INSTALLED_WITH[install.method] : undefined;
    const parts = [probe.version, via].filter((part): part is string => part !== undefined && part !== "");
    return { word, rest: parts.length > 0 ? parts.join(" · ") : undefined };
  }
  return { word, rest: probe.detail !== "" ? probe.detail : undefined };
}

/** The one button a closed agent row carries beside its switch: what would make it work. */
export type AgentAction =
  | { kind: "install"; label: string; title: string; method?: AgentInstallMethod; choice?: readonly string[]; path?: string }
  | { kind: "sign-in"; label: string; title: string }
  | { kind: "add-key"; label: string; title: string };

/**
 * What fixes an agent row, as its one button: the reinstall of what is left of an install, the path it
 * was found at to use, the sign-in it needs or that was refused, the key it cannot run without — or
 * nothing, for a row that works, is off, or has not been checked.
 */
export function agentActionOf(spec: ProviderSpec, probe: ProbeResult | undefined, state: ProviderState, install: AgentInstall | undefined, merged: Record<string, unknown>): AgentAction | undefined {
  if (probe === undefined || state === "off" || state === "unchecked") return undefined;
  const fix = installPanelOf(install)?.rows[0];
  if (fix !== undefined) {
    return { kind: "install", label: fix.button, title: fix.title, ...(fix.method !== undefined ? { method: fix.method } : {}), ...(fix.choice !== undefined ? { choice: fix.choice } : {}), ...(fix.path !== undefined ? { path: fix.path } : {}) };
  }
  if (probe.accounts?.some((account) => account.refused !== undefined) === true) return { kind: "sign-in", label: "Sign in again", title: "opens the sign-in page" };
  if (state === "needs-sign-in" && probe.accounts !== undefined) return { kind: "sign-in", label: probe.lapsed === true ? "Sign in again" : "Sign in", title: "opens the sign-in page" };
  if ((state === "unavailable" || state === "unconfigured") && spec.credential === "required" && probe.credential === undefined && probe.accounts === undefined) {
    const { plusTitle, plusSub } = keyBoxWords(spec, merged);
    return { kind: "add-key", label: plusTitle, title: `store ${plusSub}` };
  }
  return undefined;
}

/**
 * Whether an agent row offers Check again beside its button: it is signed out, its sign-in was refused,
 * or the check found it not working — what a sign-in from a terminal, or an install done elsewhere,
 * fixes without this app seeing it (the person, 2026-11-18: "the settings / connections pane should
 * also have check again / sign in (if not signed in or an error)"). The conversation's error and the
 * composer's line offer the same pair (`RouteFixes`).
 */
export function agentChecksAgain(probe: ProbeResult | undefined, state: ProviderState): boolean {
  return probe !== undefined && (state === "needs-sign-in" || state === "unavailable");
}

/** Who a closed agent row runs as, in a chip: the login in use, or the key it names and where that was found. */
export type AgentChip = { kind: "login"; who: string; fact: string | undefined; more: number } | { kind: "key"; name: string; where: string | undefined; missing: boolean };

export function agentChipOf(probe: ProbeResult | undefined, state: ProviderState, merged: Record<string, unknown>): AgentChip | undefined {
  if (probe === undefined || state === "off") return undefined;
  const accounts = probe.accounts ?? [];
  const account = accounts.find((one) => one.active) ?? accounts[0];
  if (account !== undefined) return { kind: "login", who: account.label, fact: loginFacts(account)[0], more: accounts.length - 1 };
  const named = typeof merged["credential"] === "string" ? merged["credential"] : undefined;
  if (named === undefined) return undefined;
  const missing = probe.credentialMissing !== undefined;
  return { kind: "key", name: named, where: probe.credential !== undefined ? `in ${SECRET_SOURCE_LABELS[probe.credential.source]}` : missing ? "not found anywhere" : undefined, missing };
}

/** What an agent's folded settings hold, for the line that opens them: its first fields, by label. */
export function settingsGistOf(spec: ProviderSpec): string | undefined {
  return gistOf(allFields(spec).map((field) => field.label));
}

/** What a schema form's fold holds, for the line that opens it: its fields' titles, the first three. */
export function schemaGistOf(schema: Schema): string | undefined {
  const titles = Object.entries(schema.properties ?? {}).map(([key, property]) => (typeof property === "object" && property !== null && typeof (property as { title?: unknown }).title === "string" ? (property as { title: string }).title : key));
  return gistOf(titles);
}

function gistOf(labels: string[]): string | undefined {
  if (labels.length === 0) return undefined;
  return labels.length <= 3 ? labels.join(", ") : `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more`;
}

// --- Connections → Model APIs and Local models: the closed rows ---------------------------------

/**
 * A model route's closed line: the state's word, then — ready — what it serves (an API's prefix, where
 * its key is in the chip beside it) or what the check found (a local server's address, the weights), or
 * else what the check found. A route's check never asks the provider, so a ready API says only that.
 */
export function routeLineOf(spec: ProviderSpec, probe: ProbeResult | undefined, state: ProviderState): { word: string; rest: string | undefined } {
  const word = providerSayState(probe, state);
  if (probe === undefined || state === "off" || state === "unchecked") return { word, rest: undefined };
  if (state === "available" && spec.credential === "required") return { word, rest: `serves ${spec.id}/…` };
  return { word, rest: probe.detail !== "" ? probe.detail : undefined };
}

/** The one button a closed route row carries: the key it cannot run without, the local server that answers, the weights it has none of. */
export type RouteAction = { kind: "key"; label: string; title: string } | { kind: "use"; label: string; title: string; baseURL: string } | { kind: "open"; label: string; title: string };

export function routeActionOf(spec: ProviderSpec, probe: ProbeResult | undefined, state: ProviderState, merged: Record<string, unknown>, localServers: readonly LocalServerProbe[] | undefined): RouteAction | undefined {
  if (probe === undefined || state === "off" || state === "unchecked" || state === "available") return undefined;
  if (spec.id === "local") {
    // A server answers on its usual port and the route does not point at it: pointing it there is the fix.
    const up = localServers?.find((server) => server.up && !server.inUse);
    return up !== undefined ? { kind: "use", label: `Use ${up.name}`, title: `send local models to ${up.baseURL}`, baseURL: up.baseURL } : undefined;
  }
  if (spec.id === "embedded") return state === "unconfigured" ? { kind: "open", label: "Add weights", title: "name a model id and the .gguf it loads" } : undefined;
  if (spec.credential === "required" && probe.credential === undefined) {
    const { plusTitle, plusSub } = keyBoxWords(spec, merged);
    return { kind: "key", label: plusTitle, title: `store ${plusSub}` };
  }
  return undefined;
}

/** The key a ready route calls with, as its closed row's chip: its name, and where it was found. */
export function routeChipOf(spec: ProviderSpec, probe: ProbeResult | undefined, state: ProviderState, merged: Record<string, unknown>): AgentChip | undefined {
  if (probe === undefined || state !== "available" || spec.credential === "none") return undefined;
  const named = typeof merged["credential"] === "string" ? merged["credential"] : spec.credential === "required" ? spec.suggestedCredential : undefined;
  if (named === undefined) return undefined;
  return { kind: "key", name: named, where: probe.credential !== undefined ? `in ${SECRET_SOURCE_LABELS[probe.credential.source]}` : undefined, missing: false };
}

/**
 * The words of an agent's + box: "Sign in" when there is nobody, "Sign in again" when the sign-in on file
 * stopped working (`lapsed`), "Switch account" when there is somebody.
 */
export function loginAddWords(accounts: readonly AgentAccount[], lapsed = false): { title: string; sub: string } {
  return {
    title: accounts.length === 0 ? (lapsed ? "Sign in again" : "Sign in") : "Switch account",
    sub: accounts.length === 0 ? "opens the sign-in page" : "signs in as someone else",
  };
}

/**
 * The login's plan, in the agent's own word. Only the plan: how it signed in ("via claude.ai") and a
 * personal organization named after its owner say nothing a person needs on the card (the person's
 * ruling, 2026-09-23), and the card is a fixed width.
 */
export function loginFacts(account: AgentAccount): string[] {
  return account.plan !== undefined ? [`${account.plan.charAt(0).toUpperCase()}${account.plan.slice(1)} plan`] : [];
}

/** This layer's own block for a provider, and the merged one — values and placeholders respectively. */
export function blocksFor(spec: ProviderSpec, layerDoc: unknown, effective: unknown): {
  here: Record<string, unknown>;
  merged: Record<string, unknown>;
} {
  if (spec.location.kind === "route") {
    return {
      here: routeBlock(layerDoc, spec.location.key) ?? {},
      merged: routeBlock(effective, spec.location.key) ?? {},
    };
  }
  return {
    here: executorBlock(layerDoc, spec.location.name) ?? {},
    merged: executorBlock(effective, spec.location.name) ?? {},
  };
}

/** The config path this field writes, for the tag beside its label. */
export function paramOf(spec: ProviderSpec, field: FieldSpec): string {
  const path = providerBlockPath(spec);
  if (path !== null) return `${path.join(".")}.${field.path}`;
  return `agents.genericCli[${spec.id}].${field.path}`;
}

/** Read a dotted path out of a block. */
export function readAt(block: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = block;
  for (const part of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** What the field would be if this layer said nothing — the inherited value, else the suggestion. */
export function placeholderFor(field: FieldSpec, merged: Record<string, unknown>): string {
  const inherited = fieldText(field.control, readAt(merged, field.path));
  if (inherited.length > 0 && field.control !== "select") return `${inherited} (inherited)`;
  return field.placeholder ?? "—";
}

/** Which box a field is edited in: a menu, a box of several lines (how many), or one line (mono or not). */
export function fieldControlOf(field: FieldSpec): { kind: "select" } | { kind: "area"; rows: number } | { kind: "line"; mono: boolean } {
  if (field.control === "select") return { kind: "select" };
  if (field.control === "json" || field.control === "argv" || field.control === "env" || field.control === "patterns") return { kind: "area", rows: field.control === "json" ? 5 : 3 };
  return { kind: "line", mono: field.control === "secret-name" || field.control === "url" };
}

/** The fields drawn at one level of a provider's form: the embedded route's weights are drawn as rows instead. */
export function levelFieldsOf(spec: ProviderSpec, fields: readonly FieldSpec[]): FieldSpec[] {
  return fields.filter((field) => !(spec.id === "embedded" && field.path === "weights"));
}

/** What a level with no fields left to draw says. */
export function emptyLevelWords(fields: readonly FieldSpec[]): string {
  return fields.length === 0 ? "Nothing to configure at this level." : "Edited in the rows above.";
}

export interface ProviderWrites {
  layer: ConfigLayer;
  onSaveRoute: (fields: ModelPatch, layer: ConfigLayer) => void;
  onSaveExecutor: (executor: ExecutorTarget, fields: ExecutorPatch, layer: ConfigLayer) => void;
}

/**
 * A provider row's form and what it writes (`ProviderRows.tsx`'s `ProviderRow`): its blocks, the
 * boxes' text against what is saved, and Save. The document moved under the form — usually because
 * this row just saved — and untouched boxes follow it, edited ones are kept, so a save never discards
 * typing that has not been sent yet.
 */
export function useProviderRow({
  spec,
  probe,
  layerDoc,
  effective,
  busy,
  editable,
  layer,
  onSaveRoute,
  onSaveExecutor,
}: ProviderWrites & { spec: ProviderSpec; probe: ProbeResult | undefined; layerDoc: unknown; effective: unknown; busy: boolean; editable: boolean }) {
  const { here, merged } = blocksFor(spec, layerDoc, effective);
  const fields = useMemo(() => allFields(spec), [spec]);
  const saved = useMemo(
    () => Object.fromEntries(fields.map((f) => [f.path, fieldText(f.control, readAt(here, f.path))])),
    [fields, here],
  );

  const [form, setForm] = useState<Record<string, string>>(saved);
  const [baseline, setBaseline] = useState(saved);
  const [problem, setProblem] = useState<string | null>(null);

  if (fields.some((f) => (baseline[f.path] ?? "") !== (saved[f.path] ?? ""))) {
    const next = { ...saved };
    for (const f of fields) if ((form[f.path] ?? "") !== (baseline[f.path] ?? "")) next[f.path] = form[f.path] ?? "";
    setBaseline(saved);
    setForm(next);
  }

  const locked = busy || !editable;
  const enabled = here["enabled"] !== false && merged["enabled"] !== false;
  const state = providerState(enabled, probe);
  const dirty = fields.some((f) => (form[f.path] ?? "") !== (saved[f.path] ?? ""));

  const write = (patch: Record<string, unknown>): void => {
    if (spec.location.kind === "route") {
      const key = spec.location.key;
      onSaveRoute(Object.fromEntries(Object.entries(patch).map(([p, v]) => [`routes.${key}.${p}`, v])), layer);
    } else {
      onSaveExecutor(
        {
          name: spec.location.name,
          kind: spec.location.executorKind,
          ...(typeof merged["command"] === "string" ? { command: merged["command"] } : {}),
        },
        patch,
        layer,
      );
    }
  };

  const save = (): void => {
    try {
      const patch: Record<string, unknown> = {};
      for (const f of fields) {
        if ((form[f.path] ?? "") === (saved[f.path] ?? "")) continue;
        patch[f.path] = fieldValue(f, form[f.path] ?? "");
      }
      setProblem(null);
      if (Object.keys(patch).length > 0) write(patch);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  const revert = (): void => {
    setForm(saved);
    setProblem(null);
  };

  return { here, merged, fields, saved, form, setForm, problem, locked, enabled, state, dirty, write, save, revert };
}

/**
 * The sentence's first word: "sign-in expired" over the state's own when a login's call was refused, or
 * when the sign-in on file still names its account and no longer works (`lapsed`).
 */
export function providerSayState(probe: ProbeResult | undefined, state: ProviderState): string {
  if (state === "needs-sign-in" && probe?.lapsed === true) return "sign-in expired";
  return probe?.accounts?.some((account) => account.refused !== undefined) === true ? "sign-in expired" : stateWord(state);
}

/**
 * A provider's key boxes (`KeyBoxes`): the key it names, if any, and the + box's words. Nothing for a
 * runtime that uses no key.
 */
export function keyBoxWords(spec: ProviderSpec, merged: Record<string, unknown>): { named: string | undefined; plusTitle: string; plusSub: string } {
  const named = typeof merged["credential"] === "string" ? merged["credential"] : undefined;
  const plusTitle = named !== undefined ? "Replace the key" : "Add a key";
  const plusSub = named ?? spec.suggestedCredential ?? (spec.credential === "optional" ? "usually none" : "name it, then paste it");
  return { named, plusTitle, plusSub };
}

/**
 * What a stored key would be filed under (`KeyEntry`): what config already names, else what has been
 * typed here, else the conventional variable — which is what makes a first run possible without
 * reading the documentation, and the typed one is what makes a provider with NO convention reachable.
 */
export function keyEntryName(spec: ProviderSpec, merged: Record<string, unknown>, typedName: string): { named: string | undefined; name: string; needsName: boolean } {
  const named = typeof merged["credential"] === "string" ? merged["credential"] : undefined;
  const name = named ?? (typedName.trim() || spec.suggestedCredential) ?? "";
  const needsName = named === undefined && spec.suggestedCredential === undefined;
  return { named, name, needsName };
}

/** The executor a stored key is for, as `onSaveCredential` takes it. */
export function keyEntryExecutor(spec: ProviderSpec, named: string | undefined): ExecutorTarget & { credential?: string | undefined } {
  return {
    name: spec.id,
    kind: spec.location.kind === "agent" ? spec.location.executorKind : "generic",
    ...(named !== undefined ? { credential: named } : {}),
  };
}

/** A weights file's size, for its row. */
export function weightsSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** What a local server's row says after its address. */
export function localServerSaid(server: LocalServerProbe): string {
  return `${server.baseURL.replace(/^https?:\/\//, "")} · ${server.up ? (server.models.length > 0 ? server.models.join(", ") : "no models loaded") : (server.error ?? "not running")}`;
}

/**
 * What answered on the usual local ports and whether each embedded model's weights are there, asked
 * while Connections is open — when it opens, after every availability check and configuration change,
 * and on Scan again.
 */
export function useLocalModels(active: boolean, checkedAt: number, config: unknown): {
  localServers: LocalServerProbe[] | undefined;
  weights: EmbeddedWeightsReport | undefined;
  scanning: boolean;
  scan: () => void;
} {
  const [localServers, setLocalServers] = useState<LocalServerProbe[] | undefined>(undefined);
  const [weights, setWeights] = useState<EmbeddedWeightsReport | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const [localScan, setLocalScan] = useState(0);
  useEffect(() => {
    if (!active) return;
    let live = true;
    setScanning(true);
    void invoke("model:probeLocal", undefined)
      .then(
        (found) => live && setLocalServers(found.servers),
        () => live && setLocalServers(undefined),
      )
      .finally(() => live && setScanning(false));
    void invoke("model:checkWeights", undefined).then(
      (report) => live && setWeights(report),
      () => live && setWeights(undefined),
    );
    return () => {
      live = false;
    };
  }, [active, checkedAt, config, localScan]);
  return { localServers, weights, scanning, scan: () => setLocalScan((n) => n + 1) };
}

// --- forges -------------------------------------------------------------------------------------

const SMALL_NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/**
 * "Used by 7 Git tools — list_merge_requests, git_push and five more, and 4 CI tools", DERIVED from the
 * vocabulary (decision 0010 §1): the count and the two names are the `git` category's, so a tool added
 * there is counted here without anybody remembering this line. The CI tools (decision 0016) reach the
 * forge through the same connection, so they count here too.
 */
export function gitToolsSentence(): { count: number; lead: string } {
  const tools = toolsInCategory("git").map((spec) => spec.name);
  const count = tools.length;
  if (count === 0) return { count, lead: "Used by no Git tools" };
  const named = count === 1 ? [tools[0]!] : [tools[0]!, tools[count - 1]!];
  const rest = count - named.length;
  const more = rest === 0 ? "" : ` and ${SMALL_NUMBERS[rest] ?? String(rest)} more`;
  const ci = toolsInCategory("ci").length;
  const alsoCi = ci === 0 ? "" : `, and ${ci} CI tool${ci === 1 ? "" : "s"}`;
  return { count, lead: `Used by ${count} Git tool${count === 1 ? "" : "s"} — ${named.join(rest === 0 ? " and " : ", ")}${more}${alsoCi}` };
}

/** What a connection's row should say, from its configuration and what the check observed. */
export function forgeState(enabled: boolean, check: ForgeCheck | undefined): ProviderState {
  if (!enabled) return "off";
  if (check === undefined) return "unchecked";
  if (check.status === "ok") return "available";
  if (check.status === "failed") return "unavailable";
  if (check.status === "disabled") return "off";
  // Its command line signed out: a sign-in to do again, drawn as a refused one is — a row, not the shelf.
  if (check.signedOut !== undefined) return "unavailable";
  return "unconfigured";
}

// No `pattern` on any of these. The form prints a pattern beside the field's name, and a regex is not
// a sentence; main's parser refuses a bad value on save and says why in words (`parseIntegrations`).
const CREDENTIAL: Schema = {
  type: "string",
  title: "token name",
  minLength: 1,
  description:
    "What the token is FILED UNDER — settings hold this name and never the token. The value is stored below, in the keychain or a file that is not committed.",
};

const API_URL: Schema = {
  type: "string",
  title: "API address",
  description:
    "Only for a host whose API is not where its kind puts it — behind a path prefix, or on another port. Empty is right for gitlab.com, github.com, a self-hosted GitLab and a GitHub Enterprise Server.",
};

/**
 * The OAuth app "Sign in with …" goes through — an app registered on THIS connection's host, which is
 * why it is set per connection. Only needed for a self-hosted host, or to use an app of your own.
 */
const OAUTH_CLIENT_ID: Schema = {
  type: "string",
  title: "sign-in app",
  minLength: 1,
  description:
    "The client ID of an OAuth app registered on this host, for signing in through the browser. On GitLab: a non-confidential application with the api scope. On GitHub: an OAuth app with “Enable Device Flow” ticked. Unset on gitlab.com and github.com uses JaiRA's own app; unset anywhere else, paste a token instead.",
};

/** A built-in connection's host and kind are what it IS; only how it is reached can change. */
export const BUILTIN_FORGE_SCHEMA: Schema = { type: "object", properties: { credential: CREDENTIAL, apiUrl: API_URL, oauthClientId: OAUTH_CLIENT_ID } };

const HOST: Schema = {
  type: "string",
  title: "host",
  minLength: 1,
  description: "As a git remote spells it — git.example.org, with no https:// and no path. A project's remote picks the connection by this.",
};

const PROVIDER: Schema = {
  type: "string",
  title: "kind",
  enum: [...FORGE_PROVIDERS],
  description: "Which forge answers there: gitlab for a self-hosted GitLab, github for a GitHub Enterprise Server.",
};

export const CUSTOM_FORGE_SCHEMA: Schema = {
  type: "object",
  properties: { provider: PROVIDER, host: HOST, credential: CREDENTIAL, apiUrl: API_URL, oauthClientId: OAUTH_CLIENT_ID },
  required: ["provider", "host"],
};

export const NEW_FORGE_SCHEMA: Schema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      title: "name",
      minLength: 1,
      description: "What this connection is called in settings — letters, digits, '-' and '_'. The host goes below.",
    },
    provider: PROVIDER,
    host: HOST,
    credential: CREDENTIAL,
  },
  required: ["name", "provider", "host", "credential"],
};

/** The forge connections the layers add up to. */
export function forgesOf(config: ConfigView): Record<string, JairaForgeConnection> {
  const effective = config.effective as Record<string, unknown>;
  const integrations = (effective["integrations"] ?? {}) as { forges?: Record<string, JairaForgeConnection> };
  return integrations.forges ?? {};
}

/** The forge sign-ins in flight, as a row reads them (`IntegrationsPaneProps["oauth"]`). */
export interface ForgeRowOAuth {
  signingIn: ReadonlySet<string>;
  pending: ReadonlyMap<string, string>;
  errors: ReadonlyMap<string, string>;
  viaOAuth: ReadonlySet<string>;
  onSignIn: (connection: string) => void;
  onCancel: (connection: string) => void;
  onDisconnect: (connection: string) => void;
}

/** What one forge row says: its path, state, title, the token's name and who it signs in as. */
export function forgeRowOf(name: string, connection: JairaForgeConnection, check: ForgeCheck | undefined, oauth: ForgeRowOAuth | undefined) {
  const path = `integrations.forges.${name}`;
  const builtin = BUILTIN_FORGES[name] !== undefined;
  const enabled = connection.enabled !== false;
  const state = forgeState(enabled, check);
  const label = FORGE_LABELS[connection.provider].name;
  const title = `${label} · ${connection.host}`;
  const tokenName = connection.credential ?? `${name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_TOKEN`;
  const identity = state === "available" ? check?.identity : undefined;
  const signingIn = oauth?.signingIn.has(name) === true;
  const viaOAuth = oauth?.viaOAuth.has(name) === true;
  // Signed in through the forge's command line: no token here, the account is the one gh or glab has.
  const viaCli = check?.via === "cli" ? FORGE_CLIS[connection.provider] : undefined;
  return { path, builtin, enabled, state, label, title, tokenName, identity, signingIn, viaOAuth, viaCli };
}

/** An opened forge row's "SSH keys on this machine": each key and what it does here, and whether JaiRA may make one. */
export interface ForgeSshView {
  keys: { name: string; facts: string[]; tag: string; tone: "ok" | "warn" | "accent"; jaira: boolean }[];
  /** In place of the keys, when there are none to show. */
  empty?: string;
  /** Under the keys: how they were checked, what was made, why some could not be told. */
  notes: string[];
  makeOn: boolean;
  makeLabel: string;
  makeSub: string;
}

/**
 * What the ssh section of a forge row says (decision 0027 §1, amended 2026-11-20, the person: "it should
 * also show if any of your current keys are valid for those forges"): the keys this machine holds, each
 * tagged `lets you in`, `not on the account` / `refused` or `can't tell`, and the switch that lets
 * JaiRA make a key and add it to the account when none does.
 */
export function forgeSshOf(connection: JairaForgeConnection, check: ForgeCheck | undefined): ForgeSshView {
  const host = connection.host;
  const makeOn = connection.makeSshKey !== false;
  const base = {
    makeOn,
    makeLabel: "Make a key when none lets this machine in",
    makeSub: `~/.ssh/jaira_${host.replace(/[^\w.-]/g, "_")}_ed25519, added to your ${host} account and titled "JaiRA on" this machine`,
  };
  if (check === undefined || check.status !== "ok") return { ...base, keys: [], notes: [], empty: "Checked once this connection is signed in." };
  const ssh = check.ssh;
  if (ssh === undefined) return { ...base, keys: [], notes: [], empty: "Checking this machine's keys…" };
  const keys = ssh.keys.map((key) => ({
    name: key.path,
    facts: [key.fingerprint, key.detail, ...(key.comment !== undefined ? [key.comment] : [])],
    tag: key.valid === "yes" ? "lets you in" : key.valid === "no" ? (ssh.by === "account" ? "not on the account" : "refused") : "can't tell",
    tone: key.valid === "yes" ? ("ok" as const) : key.valid === "no" ? ("accent" as const) : ("warn" as const),
    jaira: key.jaira === true,
  }));
  const none = ssh.keys.every((key) => key.valid !== "yes");
  const notes = [
    ssh.by === "account" ? `Checked against the keys on ${check.identity !== undefined ? `@${check.identity.login}'s` : "the"} ${host} account.` : ssh.by === "ssh" ? `Checked by signing in to ${host} over ssh with each key.` : undefined,
    ssh.note,
    ssh.made?.detail,
    none && ssh.made === undefined && !makeOn ? `No key here lets this machine in to ${host} over ssh, so a project from ${host} is cloned over https here.` : undefined,
  ].filter((note): note is string => note !== undefined && note !== "");
  return { ...base, keys, notes, ...(keys.length === 0 ? { empty: "No ssh keys on this machine." } : {}) };
}

/**
 * Where a forge connection is drawn (the person, 2026-11-17, "Forges B"): a row while it connects as
 * someone — or tried to and was refused, or is turned off — and a tile on the "Not connected" shelf
 * while there is no token for it at all.
 */
export function forgePlaceOf(enabled: boolean, check: ForgeCheck | undefined): "row" | "shelf" {
  return enabled && check?.status === "unconfigured" && check.signedOut === undefined ? "shelf" : "row";
}

/**
 * A forge row's closed line: the state's word, then — connected — the token's scopes, or else what the
 * check found. A connection refused at a project's repository says THAT first: it signs in, and does not
 * work where it is used (`ForgeCheck.unreachable`).
 */
export function forgeLineOf(state: ProviderState, check: ForgeCheck | undefined): { word: string; rest: string | undefined } {
  const word = stateWord(state);
  if (check === undefined || state === "off" || state === "unchecked") return { word, rest: undefined };
  const refused = state === "available" ? (check.unreachable ?? []) : [];
  if (refused.length > 0) return { word, rest: `can't reach ${refused[0]!.repository}${refused.length > 1 ? ` and ${refused.length - 1} more` : ""}` };
  if (state === "available") {
    const scopes = check.identity?.scopes;
    return { word, rest: scopes !== undefined && scopes.length > 0 ? scopes.join(", ") : undefined };
  }
  return { word, rest: check.detail !== "" ? check.detail : undefined };
}

/**
 * The repositories a connection was refused at, one line each, as its row says them: which, who uses it,
 * and what the forge said (`ForgeCheck.unreachable`).
 */
export function forgeRefusalsOf(check: ForgeCheck | undefined): string[] {
  return (check?.unreachable ?? []).map((one) => `Can't reach ${one.repository}${one.projects.length > 0 ? ` (used by ${one.projects.join(", ")})` : ""} — ${one.detail}`);
}

/** The one button a closed forge row carries: sign in through the browser, or store a token where there is no sign-in. */
export function forgeActionOf(row: ReturnType<typeof forgeRowOf>, check: ForgeCheck | undefined, host: string, canSignIn: boolean): { kind: "sign-in" | "token"; label: string; title: string } | undefined {
  // Signed in, and refused at a repository it is used for: signing in again — another account, a wider token — is the fix.
  if (check !== undefined && row.state === "available" && (check.unreachable?.length ?? 0) > 0 && canSignIn) return { kind: "sign-in", label: "Sign in again", title: `opens ${host} with a code to enter` };
  if (check === undefined || row.state === "available" || row.state === "off" || row.state === "unchecked") return undefined;
  if (canSignIn) return { kind: "sign-in", label: row.state === "unavailable" ? "Sign in again" : `Sign in with ${row.label}`, title: `opens ${host} with a code to enter` };
  return { kind: "token", label: check.credential !== undefined ? "Replace the token" : "Add a token", title: `filed under ${row.tokenName}` };
}

/** Who a connected forge acts as, as its closed row's chip: the account, and how it signed in. */
export function forgeChipOf(row: ReturnType<typeof forgeRowOf>): AgentChip | undefined {
  if (row.identity === undefined) return undefined;
  return { kind: "login", who: row.identity.login, fact: row.viaCli ?? (row.viaOAuth ? "OAuth" : "token"), more: 0 };
}

/**
 * Add a host from the new-connection form: the connection's path and value, or a problem in words. The
 * parser main will run, run here first — so "two connections on one host" is said beside the form that
 * caused it rather than as a refused save.
 */
export function newForgeOf(draft: Record<string, unknown>, forges: Record<string, JairaForgeConnection>): { path: string; value: Record<string, unknown> } | { problem: string } {
  const { name, ...connection } = draft as { name?: string } & Record<string, unknown>;
  try {
    if (typeof name !== "string" || name.length === 0) throw new Error("give the connection a name");
    if (forges[name] !== undefined) throw new Error(`there is already a connection called '${name}'`);
    parseIntegrations({ forges: { ...forges, [name]: connection } });
    return { path: `integrations.forges.${name}`, value: connection };
  } catch (e) {
    return { problem: (e as Error).message.replace(/^config\.integrations\.forges(\.[^:.]+)?[.:]?\s*/, "") };
  }
}

// --- MCP servers --------------------------------------------------------------------------------

/** A layer's own document, whichever layer — `null` when it has none. */
export function layerDocument(config: ConfigView, layer: ConfigLayer): Record<string, unknown> | null {
  const doc = (config as unknown as Record<string, unknown>)[layer];
  return doc !== null && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
}

/** The servers the layers add up to — what a run is handed. */
export function effectiveServers(config: ConfigView | null): Record<string, McpServerConfig> {
  const mcp = config === null ? undefined : (config.effective as { mcp?: { servers?: Record<string, McpServerConfig> } }).mcp;
  return mcp?.servers ?? {};
}

// No `pattern` on any of these: the form prints a pattern beside a field's name, and a regex is not a
// sentence. `parseMcp` refuses a bad value and says why in words — here, before anything is written.
const VALUE: Schema = {
  title: "value",
  anyOf: [
    { type: "string", title: "a value", description: "Written into settings as it is — for a value that is not a secret." },
    {
      type: "object",
      title: "a stored secret",
      description: "The NAME of a secret; the value is looked up when the server starts — keychain, a .env file, the environment — and never written here.",
      properties: { credential: { type: "string", title: "secret name", minLength: 1 } },
      required: ["credential"],
      additionalProperties: false,
    },
  ],
};

export const STDIO_SCHEMA: Schema = {
  type: "object",
  properties: {
    command: { type: "string", title: "command", minLength: 1, description: "The program JaiRA starts — npx, uvx, a full path. It speaks MCP on its stdin and stdout." },
    args: { type: "array", title: "arguments", items: { type: "string" }, description: "Handed to the command in this order." },
    env: {
      type: "object",
      title: "environment",
      additionalProperties: VALUE,
      description: "Variables the server is started with, beside a minimal environment of this machine's. A key or a token belongs in a stored secret.",
    },
    cwd: { type: "string", title: "working directory", description: "Where the server runs. Empty is wherever the agent runs. Claude does not take one; the tools probe and codex do." },
  },
};

export const HTTP_SCHEMA: Schema = {
  type: "object",
  properties: {
    url: { type: "string", title: "address", minLength: 1, description: "Its MCP endpoint — streamable HTTP, and SSE for an older server." },
    headers: {
      type: "object",
      title: "headers",
      additionalProperties: VALUE,
      description: "Sent with every request. An Authorization header belongs in a stored secret.",
    },
  },
};

/** What a server's tool may count as: every standard tool, then the Screen & input pair by its action. */
const COUNTS_AS: string[] = [...TOOL_SPECS.map((spec) => spec.name), SCREEN_MAPPING];

/**
 * The form of one server: its own settings, then — once the probe has listed its tools, and for every
 * tool its settings already map — what each tool COUNTS AS among JaiRA's permissions (decision 0019,
 * ruling 5): a standard tool (or the pair by its action) and, for one that acts on a place, which of
 * the tool's arguments holds it. Built from the server as it is, so the places offered follow the
 * standard tool picked.
 */
export function serverSchemaOf(server: McpServerConfig, status: McpServerStatus | undefined): Schema {
  const base = isMcpStdio(server) ? STDIO_SCHEMA : HTTP_SCHEMA;
  const listed = new Map((status?.tools ?? []).map((tool) => [tool.name, tool]));
  const names = [...new Set([...listed.keys(), ...Object.keys(server.tools ?? {})])].sort();
  if (names.length === 0) return base;
  const properties: Record<string, Schema> = {};
  for (const name of names) {
    const tool = listed.get(name);
    const as = server.tools?.[name]?.as;
    const places = as !== undefined && as !== SCREEN_MAPPING ? placeArgsOf(as) : [];
    properties[name] = {
      type: "object",
      description: tool === undefined ? "Not in the list the server last answered with." : (tool.description ?? tool.annotations.title ?? ""),
      properties: {
        as: {
          type: "string",
          title: "counts as",
          enum: COUNTS_AS,
          description: `The permission its calls answer to beside its own line, the stricter kept. ${SCREEN_MAPPING}: screenshot when its action only looks, control_input otherwise.`,
        },
        ...(places.length > 0
          ? {
              args: {
                type: "object",
                title: "where it reads a place",
                description: `Which of its arguments holds what ${as} reads — empty is its argument of the same name.`,
                properties: Object.fromEntries(places.map((place) => [place, { type: "string", title: place, ...(tool?.inputs !== undefined && tool.inputs.length > 0 ? { enum: tool.inputs } : {}) } as Schema])),
              },
            }
          : {}),
      },
      required: ["as"],
    };
  }
  return {
    ...base,
    properties: {
      ...(base.properties as Record<string, Schema>),
      tools: {
        type: "object",
        title: "what its tools count as",
        description: "A tool that does what one of JaiRA's permissions does answers to that permission's line in every permission set too — the stricter of the two — so one line holds every way to do it. Where the set uses JaiRA's own tool for it, the server's is withheld.",
        properties,
      },
    },
  };
}

/** The tools whose own description says what they count as, and the configuration does not say yet — to accept. */
export function unacceptedClaims(server: McpServerConfig, status: McpServerStatus | undefined): Array<{ tool: string; claim: NonNullable<McpServerStatus["tools"][number]["claim"]> }> {
  return (status?.tools ?? []).flatMap((tool) => (tool.claim !== undefined && server.tools?.[tool.name] === undefined ? [{ tool: tool.name, claim: tool.claim }] : []));
}

export const NEW_SERVER_SCHEMA: Schema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      title: "name",
      minLength: 1,
      description: "What its tools are called under — mcp__<name>__<tool>. Letters, digits, '-' and '_'.",
    },
    command: { type: "string", title: "command", description: "For a server JaiRA starts (stdio): the program — npx, uvx, a full path. Set this or an address, not both." },
    args: { type: "array", title: "arguments", items: { type: "string" }, description: "Handed to the command in this order." },
    url: { type: "string", title: "address", description: "For a server JaiRA calls (HTTP): its MCP endpoint. Set this or a command, not both." },
  },
  required: ["name"],
};

/** How a server's row is coloured, from what the probe found. */
export function mcpRowState(enabled: boolean, status: McpServerStatus | undefined): ProviderState {
  if (!enabled) return "off";
  if (status === undefined) return "unchecked";
  if (status.state === "ready") return "available";
  if (status.state === "failed") return "unavailable";
  return "unconfigured";
}

/** A server row's first word. */
export function mcpWord(enabled: boolean, status: McpServerStatus | undefined): string {
  return !enabled ? "turned off" : status === undefined ? "not checked" : status.state;
}

/**
 * The sentence a row says after its state: how it is reached and what it listed —
 * "HTTP · http://127.0.0.1:3845/mcp · answered with 21 tools", "stdio · npx @playwright/mcp · 21 tools".
 */
export function mcpStatusLine(config: McpServerConfig, status: McpServerStatus | undefined): string {
  if (status === undefined) return `${isMcpStdio(config) ? "stdio" : "HTTP"} · ${mcpWhere(config)} · not asked yet`;
  if (status.state !== "ready") return status.reason ?? "";
  const count = `${status.tools.length} ${status.tools.length === 1 ? "tool" : "tools"}`;
  if (status.transport === "stdio") return `stdio · ${status.where} · ${count}`;
  return `${status.transport === "sse" ? "SSE" : "HTTP"} · ${status.where} · answered with ${count}`;
}

/** What a server row says after its word: its status line, or why it did not start. */
export function mcpDetail(enabled: boolean, server: McpServerConfig, status: McpServerStatus | undefined): string | undefined {
  return enabled && status?.state !== "not started" ? mcpStatusLine(server, status) : enabled && status?.reason ? status.reason : undefined;
}

/** The layer's own document with the new servers in it — one write for the lot. */
export function withServersAdded(doc: Record<string, unknown> | null, servers: Record<string, McpServerConfig>, entries: ReadonlyArray<{ name: string; config: McpServerConfig }>): Record<string, unknown> {
  const next = structuredClone(doc ?? {}) as Record<string, unknown>;
  const block = (next["mcp"] ??= {}) as Record<string, unknown>;
  const held = (block["servers"] ??= {}) as Record<string, unknown>;
  for (const entry of entries) if (servers[entry.name] === undefined && held[entry.name] === undefined) held[entry.name] = entry.config;
  return next;
}

/** Add a server from the new-server form: its path and parsed value, or a problem in words. */
export function newServerOf(draft: Record<string, unknown>, servers: Record<string, McpServerConfig>): { path: string; value: unknown } | { problem: string } {
  const { name, ...server } = draft as { name?: string } & Record<string, unknown>;
  try {
    if (typeof name !== "string" || name.length === 0) throw new Error("give the server a name");
    if (servers[name] !== undefined) throw new Error(`there is already a server called '${name}'`);
    // The parser main will run, run here first, so what is wrong is said beside the form.
    const parsed = parseMcp({ servers: { [name]: server } });
    return { path: `mcp.servers.${name}`, value: parsed.servers[name] };
  } catch (e) {
    return { problem: (e as Error).message.replace(/^config\.mcp\.servers\.[^:.\s]+[.:]?\s*/, "") };
  }
}

/** The detected servers a source lists that are not configured yet — what its Add writes. */
export function newFromSource(source: McpDetectedSource, servers: Readonly<Record<string, McpServerConfig>>): Array<{ name: string; config: McpServerConfig }> {
  return source.servers.filter((entry) => servers[entry.name] === undefined);
}

/** The one button a closed server row carries: the claims waiting to be accepted, or the secret it is not sent. */
export function mcpActionOf(enabled: boolean, server: McpServerConfig, status: McpServerStatus | undefined): { kind: "accept" | "secret"; label: string; title: string } | undefined {
  if (!enabled || status === undefined) return undefined;
  const claims = unacceptedClaims(server, status);
  if (claims.length > 0) return { kind: "accept", label: `Accept ${claims.length}…`, title: `${claims.length} ${claims.length === 1 ? "tool says what it counts" : "tools say what they count"} as — open to accept` };
  const missing = (status.credentials ?? mcpSecretsOf(server)).filter((secret) => secret.origin === undefined);
  if (missing.length > 0) return { kind: "secret", label: "Store a secret", title: `store ${missing.map((secret) => secret.credential).join(", ")}` };
  return undefined;
}

/** The secret a server is sent, as its closed row's chip: the first that was found, and where. */
export function mcpChipOf(enabled: boolean, status: McpServerStatus | undefined): AgentChip | undefined {
  if (!enabled || status === undefined) return undefined;
  const found = status.credentials.find((secret) => secret.origin !== undefined);
  return found?.origin !== undefined ? { kind: "key", name: found.credential, where: `in ${SECRET_SOURCE_LABELS[found.origin.source]}`, missing: false } : undefined;
}

/** One server another tool runs, as a tile on the "Found on this machine" shelf. */
export interface FoundServer {
  name: string;
  config: McpServerConfig;
  /** How it is reached and where it was found: "stdio · in Cursor". */
  sub: string;
  /** What Add writes: the command or the address. */
  what: string;
}

/**
 * The servers other tools run that are not configured here, a tile each (the person, 2026-11-17, "MCP
 * A"): from every place that listed some, in the order the places were read; a name two places list is
 * the first one's, since a second would be refused as the same name.
 */
export function foundServersOf(detected: readonly McpDetectedSource[] | undefined, servers: Readonly<Record<string, McpServerConfig>>): FoundServer[] {
  const seen = new Set<string>();
  const found: FoundServer[] = [];
  for (const source of detected ?? []) {
    if (source.state !== "found") continue;
    for (const entry of newFromSource(source, servers)) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      found.push({ name: entry.name, config: entry.config, sub: `${isMcpStdio(entry.config) ? "stdio" : "HTTP"} · in ${source.label}`, what: mcpWhere(entry.config) });
    }
  }
  return found;
}

/** Where the shelf looked, in a sentence under it. */
export function lookedInOf(detected: readonly McpDetectedSource[] | undefined): string | undefined {
  if (detected === undefined || detected.length === 0) return undefined;
  // A place's own name may hold a comma ("Cursor, this project"), so the places are set apart with " · ".
  const list = detected.map((source) => source.label.replace(/^This /, "this ")).join(" · ");
  return `Looked in ${list} when this page opened. None is started until it is added.`;
}

/** What a detected source's row says after where it was found. */
export function detectedSaid(source: McpDetectedSource): string {
  const names = source.servers.map((entry) => entry.name).join(", ");
  return source.state === "found" ? [names, source.detail].filter((part) => part !== undefined && part.length > 0).join(" · ") : (source.detail ?? source.state);
}
