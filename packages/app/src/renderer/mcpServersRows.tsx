/**
 * The MCP server rows of Settings → Connections — the servers whose tools an agent can call, one row
 * each in the shape every Connections row has: what it is and whether it answered on the left, the
 * secrets it is sent as boxes on the right, the switch and the chevron at the edge. The last row adds
 * one, and under it are the servers other tools on this machine already run, one click from being
 * ours (the units doc `mcp-servers`).
 *
 * The state is OBSERVED, as a provider's is: `ready` is a server that answered the tools probe with a
 * list, `failed` one that did not (and why), `not started` one that is off or waits for a secret. The
 * probe is main's; this page only reads it and asks for it again.
 *
 * Every typed field is the schema form — the server's own fields, and the entry that adds one. What is
 * not is a secret's VALUE, which is not configuration: it goes straight to main, into the secret chain,
 * and `settings.json` holds its name.
 *
 * Layer-generic: the page's layer is a prop, whichever it is, and every write goes into that layer's
 * own document.
 */
import { useContext, useState, type JSX } from "react";
import {
  SECRET_SOURCE_LABELS,
  SECRET_TARGET_LABELS,
  mcpSecretsOf,
  mcpServerEnabled,
  mcpWhere,
  isMcpStdio,
  parseMcp,
  type ConfigLayer,
  type ConfigView,
  type McpDetectedSource,
  type McpServerConfig,
  type McpServerStatus,
  type SecretCapabilities,
  type SecretTarget,
} from "@jaira/shared/browser";
import { layerWriter } from "./configPane";
import { SelectInput, StatusDot, Switch, type ProviderState, SettingsLayerContext } from "./controls";
import { BrandIcon, Icon } from "./icons";
import type { McpData } from "./mcpData";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { Schema } from "./schemaForm/types";

export interface McpServerRowsProps {
  config: ConfigView | null;
  /** The layer every write goes into — any of them. */
  layer: ConfigLayer;
  busy: boolean;
  /** False when this layer has no document to write. */
  editable: boolean;
  secrets: SecretCapabilities;
  mcp: McpData;
  /** Write the whole layer document; main validates it before it lands. */
  onSave: (layer: ConfigLayer, doc: unknown) => void;
}

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

const STDIO_SCHEMA: Schema = {
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

const HTTP_SCHEMA: Schema = {
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

const NEW_SCHEMA: Schema = {
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
function rowState(enabled: boolean, status: McpServerStatus | undefined): ProviderState {
  if (!enabled) return "off";
  if (status === undefined) return "unchecked";
  if (status.state === "ready") return "available";
  if (status.state === "failed") return "unavailable";
  return "unconfigured";
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

/** The rows of Connections → MCP servers: one per configured server, then "Add a server". */
export function McpServerRows(props: McpServerRowsProps): JSX.Element {
  const { config, layer, busy, editable, mcp, onSave } = props;
  // The Just you view's "What you changed": only the servers the layer states, and no adding — as the
  // forges do (`integrationsPane.tsx`).
  const onlyStated = useContext(SettingsLayerContext)?.onlyStated === true;
  if (config === null) return <p className="empty">The configuration could not be read.</p>;
  const doc = layerDocument(config, layer);
  const servers = effectiveServers(config);
  const locked = busy || !editable;
  const { set, stated } = layerWriter(doc, layer, onSave);
  const addAll = (entries: ReadonlyArray<{ name: string; config: McpServerConfig }>): void => {
    // One write for the lot: the layer's own document with the new servers in it.
    const next = structuredClone(doc ?? {}) as Record<string, unknown>;
    const block = (next["mcp"] ??= {}) as Record<string, unknown>;
    const held = (block["servers"] ??= {}) as Record<string, unknown>;
    for (const entry of entries) if (servers[entry.name] === undefined && held[entry.name] === undefined) held[entry.name] = entry.config;
    onSave(layer, next);
  };
  return (
    <ul className="cfg-rows">
      {Object.entries(servers).filter(([name]) => !onlyStated || stated(`mcp.servers.${name}`)).map(([name, server]) => (
        <McpServerRow
          key={`${layer}:${name}`}
          {...props}
          name={name}
          server={server}
          status={mcp.report?.servers.find((s) => s.name === name)}
          locked={locked}
          set={set}
          stated={stated}
        />
      ))}
      {onlyStated ? null : <AddServerRow servers={servers} detected={mcp.detected} locked={locked} set={set} onAddAll={addAll} />}
    </ul>
  );
}

function McpServerRow({
  name,
  server,
  status,
  locked,
  set,
  stated,
  secrets,
  config,
  mcp,
}: McpServerRowsProps & {
  name: string;
  server: McpServerConfig;
  status: McpServerStatus | undefined;
  locked: boolean;
  set: (path: string, value: unknown) => void;
  stated: (path: string) => boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [storing, setStoring] = useState(false);
  const path = `mcp.servers.${name}`;
  const enabled = mcpServerEnabled(server);
  const state = rowState(enabled, status);
  const credentials: McpServerStatus["credentials"] = status?.credentials ?? mcpSecretsOf(server);
  const word = !enabled ? "turned off" : status === undefined ? "not checked" : status.state;

  return (
    <li className={`cfg-row conn-row ${state}`}>
      <div className="conn-main">
        <div className="cfg-row-head">
          <span className="cfg-mark">
            <BrandIcon name={name} className="cfg-mark-svg" />
            <StatusDot state={state} />
          </span>
          <span className="cfg-row-title mono">{name}</span>
        </div>
        <p className="cfg-say">
          <span className="cfg-say-state">{word}</span>
          {enabled && status?.state !== "not started" ? <> — {mcpStatusLine(server, status)}</> : enabled && status?.reason ? <> — {status.reason}</> : null}
          {enabled && status?.fix ? <span className="cfg-fix">→ {status.fix}</span> : null}
        </p>
      </div>

      {/* The secrets it is sent — one box each, where the chain found it or that it did not — and the +
          box that stores one. The same boxes a provider's key uses. */}
      <ul className="conn-boxes" aria-label={`${name}: the secrets it is sent`}>
        {credentials.map((secret) => {
          const origin = secret.origin;
          const missing = status !== undefined && origin === undefined;
          return (
            <li key={`${secret.field}:${secret.key}`} className={`cfg-key-box${missing ? " missing" : ""}`}>
              <span className="cfg-login-mark key" aria-hidden="true">
                <Icon name="lock" />
              </span>
              <span className="cfg-login-who">{secret.credential}</span>
              <span className="cfg-login-facts">
                <span>
                  {secret.field === "env" ? "env" : "header"} {secret.key}
                </span>
                {origin !== undefined ? <span>in {SECRET_SOURCE_LABELS[origin.source]}</span> : null}
                {missing ? <span>not found anywhere</span> : null}
              </span>
            </li>
          );
        })}
        {credentials.length === 0 || storing ? null : (
          <li className="cfg-login-tile">
            <button type="button" className="cfg-login-add" disabled={locked} onClick={() => setStoring(true)}>
              <span className="cfg-login-plus" aria-hidden="true">
                +
              </span>
              <span className="cfg-login-add-title">Store a secret</span>
              <span className="cfg-login-add-sub">{credentials.map((secret) => secret.credential).join(", ")}</span>
            </button>
          </li>
        )}
      </ul>

      <div className="conn-controls">
        <Switch
          on={enabled}
          disabled={locked}
          label={enabled ? `stop handing ${name} to agents` : `hand ${name} to agents again`}
          // `undefined` REMOVES the key: on is the default, and a layer that says so says nothing.
          onChange={(next) => set(`${path}.enabled`, next ? undefined : false)}
        />
        <button
          type="button"
          className={`quiet cfg-chevron${open ? " open" : ""}`}
          aria-expanded={open}
          aria-label={open ? `hide ${name}'s settings` : `configure ${name}`}
          title={open ? "Done" : "Configure"}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="chevron" />
        </button>
      </div>

      {storing ? (
        <div className="conn-wide">
          <SecretEntry
            names={credentials.map((secret) => secret.credential)}
            busy={locked}
            secrets={secrets}
            hasProject={config !== null && config.projectFile.length > 0}
            onStore={(request) => void mcp.storeSecret(request)}
            onClose={() => setStoring(false)}
          />
        </div>
      ) : null}

      {open ? (
        <div className="cfg-row-body conn-wide">
          <SchemaForm
            schema={isMcpStdio(server) ? STDIO_SCHEMA : HTTP_SCHEMA}
            value={server}
            onChange={(next) => set(path, next)}
            ctx={{ path, disabled: locked, isSet: stated, setAt: set }}
          />
          <div className="pane-actions">
            <button
              type="button"
              className="ghost danger"
              disabled={locked || !stated(path)}
              title="delete this server from the layer being edited"
              onClick={() => set(path, undefined)}
            >
              Remove
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Store a secret a server is sent: which of its names, the value, and the store. The value goes
 * straight to main and is never held in a form, in renderer state, or in `settings.json` — which holds
 * its name. The box is a password field cleared the moment it is sent.
 */
function SecretEntry({
  names,
  busy,
  secrets,
  hasProject,
  onStore,
  onClose,
}: {
  names: string[];
  busy: boolean;
  secrets: SecretCapabilities;
  hasProject: boolean;
  onStore: (request: { name: string; value: string; target: SecretTarget }) => void;
  onClose: () => void;
}): JSX.Element {
  const targets: SecretTarget[] = [
    ...(secrets.keychain ? (["keychain"] as SecretTarget[]) : []),
    ...(hasProject ? (["project-env-local"] as SecretTarget[]) : []),
    "base-env-local",
  ];
  const [name, setName] = useState(names[0] ?? "");
  const [value, setValue] = useState("");
  const [target, setTarget] = useState<SecretTarget>(targets[0] ?? "base-env-local");
  return (
    <div className="cfg-key-entry">
      {names.length > 1 ? (
        <SelectInput value={name} options={names.map((n) => [n, n])} onChange={setName} />
      ) : (
        <span className="cfg-hint">
          Filed under <code>{name}</code>.
        </span>
      )}
      <input
        type="password"
        className="cfg-input mono"
        value={value}
        autoComplete="off"
        placeholder={`the value of ${name} — empty clears it`}
        onChange={(e) => setValue(e.target.value)}
      />
      <SelectInput value={target} options={targets.map((t) => [SECRET_TARGET_LABELS[t], t])} onChange={(v) => setTarget(v as SecretTarget)} />
      <div className="pane-actions">
        <button
          type="button"
          disabled={busy || name.length === 0}
          onClick={() => {
            onStore({ name, value, target });
            setValue("");
            onClose();
          }}
        >
          Store the secret
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setValue("");
            onClose();
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The detected servers a source lists that are not configured yet — what its Add writes. */
export function newFromSource(source: McpDetectedSource, servers: Readonly<Record<string, McpServerConfig>>): Array<{ name: string; config: McpServerConfig }> {
  return source.servers.filter((entry) => servers[entry.name] === undefined);
}

/**
 * The last row: add a server by hand — a name and a command or an address, through the schema form —
 * and, across its width, the servers other tools on this machine already run, each source one click
 * from being ours. Nothing a source lists is started to find it.
 */
function AddServerRow({
  servers,
  detected,
  locked,
  set,
  onAddAll,
}: {
  servers: Record<string, McpServerConfig>;
  detected: McpDetectedSource[] | undefined;
  locked: boolean;
  set: (path: string, value: unknown) => void;
  onAddAll: (entries: ReadonlyArray<{ name: string; config: McpServerConfig }>) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const add = (): void => {
    const { name, ...server } = draft as { name?: string } & Record<string, unknown>;
    try {
      if (typeof name !== "string" || name.length === 0) throw new Error("give the server a name");
      if (servers[name] !== undefined) throw new Error(`there is already a server called '${name}'`);
      // The parser main will run, run here first, so what is wrong is said beside the form.
      const parsed = parseMcp({ servers: { [name]: server } });
      set(`mcp.servers.${name}`, parsed.servers[name]);
      setDraft({});
      setProblem(null);
      setOpen(false);
    } catch (e) {
      setProblem((e as Error).message.replace(/^config\.mcp\.servers\.[^:.\s]+[.:]?\s*/, ""));
    }
  };

  return (
    <li className="cfg-row conn-row unconfigured">
      <div className="conn-main">
        <div className="cfg-row-head">
          <span className="cfg-mark">
            <BrandIcon name="+" className="cfg-mark-svg" />
            <StatusDot state="unconfigured" />
          </span>
          <span className="cfg-row-title">Add a server</span>
        </div>
        <p className="cfg-say">
          <span className="cfg-say-state">not set up</span> — a command JaiRA starts (stdio), or a URL it calls (HTTP)
        </p>
      </div>
      <ul className="conn-boxes">
        {open ? null : (
          <li className="cfg-login-tile">
            <button type="button" className="cfg-login-add" disabled={locked} onClick={() => setOpen(true)}>
              <span className="cfg-login-plus" aria-hidden="true">
                +
              </span>
              <span className="cfg-login-add-title">Add a server</span>
              <span className="cfg-login-add-sub">a name, and a command or an address</span>
            </button>
          </li>
        )}
      </ul>
      <div className="conn-controls" />
      {open ? (
        <div className="cfg-row-body conn-wide">
          <SchemaForm schema={NEW_SCHEMA} value={draft} onChange={(next) => setDraft((next ?? {}) as Record<string, unknown>)} ctx={{ path: "", disabled: locked, hidePaths: true }} />
          {problem ? <p className="sub warn-text">{problem}</p> : null}
          <div className="pane-actions">
            <button type="button" className="primary" disabled={locked} onClick={add}>
              Add it
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setOpen(false);
                setProblem(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {detected !== undefined ? (
        <div className="conn-wide">
          <DetectedServers detected={detected} servers={servers} locked={locked} onAdd={onAddAll} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * What other tools on this machine already run: one row per place looked, with where it was found and
 * what it lists, and Add — which writes those servers into the layer being edited. The local servers'
 * probe list, in its markup.
 */
export function DetectedServers({
  detected,
  servers,
  locked,
  onAdd,
}: {
  detected: McpDetectedSource[];
  servers: Readonly<Record<string, McpServerConfig>>;
  locked: boolean;
  onAdd: (entries: ReadonlyArray<{ name: string; config: McpServerConfig }>) => void;
}): JSX.Element {
  return (
    <div className="conn-probe mcp-found">
      <div className="conn-probe-head">
        <span>Servers other tools on this machine already run</span>
        <span>read when this page opens — none is started</span>
      </div>
      {detected.map((source) => {
        const fresh = newFromSource(source, servers);
        const names = source.servers.map((entry) => entry.name).join(", ");
        const said = source.state === "found" ? [names, source.detail].filter((part) => part !== undefined && part.length > 0).join(" · ") : (source.detail ?? source.state);
        return (
          <div key={`${source.source}:${source.where}`} className={`conn-probe-row${source.state === "found" ? " up" : ""}`}>
            <span className="conn-probe-dot" aria-hidden="true" />
            <span className="conn-probe-name">{source.label}</span>
            <span className="conn-probe-at mono" title={source.where}>
              {source.where}
              {" · "}
              {said}
            </span>
            {source.state !== "found" ? (
              <span />
            ) : fresh.length === 0 ? (
              <span className="cfg-login-tag accent">added</span>
            ) : (
              <button type="button" className="ghost" disabled={locked} onClick={() => onAdd(fresh)}>
                {fresh.length === 1 ? "Add" : `Add ${fresh.length}`}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
