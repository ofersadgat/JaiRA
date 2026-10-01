/**
 * What Settings → Connections COMPUTES, for the rows in
 * `packages/universal/src/components/settings/connections/`. No DOM here: the words a row says, its
 * state, the schemas its forms are drawn from, and what its buttons write.
 */
import { useEffect, useMemo, useState } from "react";
import {
  BUILTIN_FORGES,
  FORGE_LABELS,
  FORGE_PROVIDERS,
  isMcpStdio,
  mcpWhere,
  parseIntegrations,
  parseMcp,
  toolsInCategory,
  type AgentAccount,
  type ConfigLayer,
  type ConfigView,
  type EmbeddedWeightsReport,
  type ExecutorInfo,
  type ForgeCheck,
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

/** The words of an agent's + box: "Sign in" when there is nobody, "Switch account" when there is somebody. */
export function loginAddWords(accounts: readonly AgentAccount[]): { title: string; sub: string } {
  return {
    title: accounts.length === 0 ? "Sign in" : "Switch account",
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

/** The sentence's first word: "sign-in expired" over the state's own when a login's call was refused. */
export function providerSayState(probe: ProbeResult | undefined, state: ProviderState): string {
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
 * "Used by 9 Git tools — list_merge_requests, git_push and seven more", DERIVED from the vocabulary
 * (decision 0010 §1): the count and the two names are the `git` category's, so a tool added there
 * is counted here without anybody remembering this line.
 */
export function gitToolsSentence(): { count: number; lead: string } {
  const tools = toolsInCategory("git").map((spec) => spec.name);
  const count = tools.length;
  if (count === 0) return { count, lead: "Used by no Git tools" };
  const named = count === 1 ? [tools[0]!] : [tools[0]!, tools[count - 1]!];
  const rest = count - named.length;
  const more = rest === 0 ? "" : ` and ${SMALL_NUMBERS[rest] ?? String(rest)} more`;
  return { count, lead: `Used by ${count} Git tool${count === 1 ? "" : "s"} — ${named.join(rest === 0 ? " and " : ", ")}${more}` };
}

/** What a connection's row should say, from its configuration and what the check observed. */
export function forgeState(enabled: boolean, check: ForgeCheck | undefined): ProviderState {
  if (!enabled) return "off";
  if (check === undefined) return "unchecked";
  if (check.status === "ok") return "available";
  if (check.status === "failed") return "unavailable";
  if (check.status === "disabled") return "off";
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
  return { path, builtin, enabled, state, label, title, tokenName, identity, signingIn, viaOAuth };
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

/** What a detected source's row says after where it was found. */
export function detectedSaid(source: McpDetectedSource): string {
  const names = source.servers.map((entry) => entry.name).join(", ");
  return source.state === "found" ? [names, source.detail].filter((part) => part !== undefined && part.length > 0).join(" · ") : (source.detail ?? source.state);
}
