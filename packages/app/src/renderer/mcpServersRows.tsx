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
  isMcpStdio,
  type ConfigLayer,
  type ConfigView,
  type McpDetectedSource,
  type McpServerConfig,
  type McpServerStatus,
  type SecretCapabilities,
  type SecretTarget,
} from "@jaira/shared/browser";
import { layerWriter } from "./configPane";
import { SelectInput, StatusDot, Switch, SettingsLayerContext } from "./controls";
import { BrandIcon, Icon } from "./icons";
import type { McpData } from "./mcpData";
import { SchemaForm } from "./schemaForm/SchemaForm";
import {
  HTTP_SCHEMA,
  NEW_SERVER_SCHEMA,
  STDIO_SCHEMA,
  detectedSaid,
  effectiveServers,
  layerDocument,
  mcpDetail,
  mcpRowState,
  mcpWord,
  newFromSource,
  newServerOf,
  secretTargetsOf,
  withServersAdded,
} from "./connectionsModel";

// What a row says and writes is `connectionsModel.ts`'s, shared with the universal copy (decision 0015).
export { effectiveServers, layerDocument, mcpStatusLine, newFromSource } from "./connectionsModel";

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
  // One write for the lot: the layer's own document with the new servers in it.
  const addAll = (entries: ReadonlyArray<{ name: string; config: McpServerConfig }>): void => onSave(layer, withServersAdded(doc, servers, entries));
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
  const state = mcpRowState(enabled, status);
  const credentials: McpServerStatus["credentials"] = status?.credentials ?? mcpSecretsOf(server);
  const word = mcpWord(enabled, status);
  const detail = mcpDetail(enabled, server, status);

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
          {detail !== undefined ? <> — {detail}</> : null}
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
  const targets = secretTargetsOf(secrets, hasProject);
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
    // The parser main will run, run here first, so what is wrong is said beside the form (`newServerOf`).
    const made = newServerOf(draft, servers);
    if ("problem" in made) {
      setProblem(made.problem);
      return;
    }
    set(made.path, made.value);
    setDraft({});
    setProblem(null);
    setOpen(false);
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
          <SchemaForm schema={NEW_SERVER_SCHEMA} value={draft} onChange={(next) => setDraft((next ?? {}) as Record<string, unknown>)} ctx={{ path: "", disabled: locked, hidePaths: true }} />
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
        const said = detectedSaid(source);
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
