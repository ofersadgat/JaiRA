/**
 * Integrations — the connections to remote systems, and the defaults of what runs over them
 * (decision 0004 §1).
 *
 * The Providers screen's rows, unchanged, because a connection is the same kind of thing a provider
 * is: something configured once, reached with a named secret, and either working or not. So it gets
 * the same four states and the same rule — the state is OBSERVED, never assumed. A connection is
 * checked the way a route is, by asking the host who the token belongs to.
 *
 * Every typed field here goes through `SchemaForm`. What does not is the token's VALUE, which is not
 * configuration: it goes straight to main, into the secret chain, and is never held in a form, in
 * renderer state, or in `settings.json` — which holds its name.
 *
 * Nothing on this screen is an identity. Commits are authored by `git config`; the merge request and
 * every comment JaiRA posts belong to whoever owns the token, which is what "signed in as" reports.
 */
import { useState, type JSX } from "react";
import {
  BUILTIN_FORGES,
  DEFAULT_PUBLISH_MODE,
  DEFAULT_SETTLE_AFTER,
  FORGE_LABELS,
  FORGE_PROVIDERS,
  SECRET_SOURCE_LABELS,
  SECRET_TARGET_LABELS,
  parseIntegrations,
  publishModeOf,
  type ConfigLayer,
  type ConfigView,
  type ForgeCheck,
  type JairaForgeConnection,
  type SecretCapabilities,
  type SecretTarget,
} from "@jaira/shared/browser";
import { layerWriter } from "./configPane";
import { SelectInput, StatusDot, Switch, stateWord, type ProviderState } from "./controls";
import { BrandIcon, Icon } from "./icons";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { Schema } from "./schemaForm/types";

export interface IntegrationsPaneProps {
  config: ConfigView | null;
  layer: ConfigLayer;
  busy: boolean;
  /** False when this layer has no document to write — see the Settings shell, which hides the layer. */
  editable: boolean;
  /** What the last check found, by connection name. Absent ⇒ not checked yet. */
  checks: ForgeCheck[];
  secrets: SecretCapabilities;
  /** Write the whole layer document. The caller validates it in main before it lands. */
  onSave: (layer: ConfigLayer, doc: unknown) => void;
  /**
   * Store a token's value, and name it in the layer being edited when nothing names it yet.
   *
   * The value crosses to main in this call and is never read back; an empty one clears the secret.
   */
  onSaveToken: (request: {
    connection: string;
    /** The name config already holds, when it holds one. */
    named?: string;
    name: string;
    value: string;
    target: SecretTarget;
    layer: ConfigLayer;
  }) => void;
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

/** A built-in connection's host and kind are what it IS; only how it is reached can change. */
const BUILTIN_SCHEMA: Schema = { type: "object", properties: { credential: CREDENTIAL, apiUrl: API_URL } };

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

const CUSTOM_SCHEMA: Schema = {
  type: "object",
  properties: { provider: PROVIDER, host: HOST, credential: CREDENTIAL, apiUrl: API_URL },
  required: ["provider", "host"],
};

const NEW_SCHEMA: Schema = {
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

const REVIEW_SCHEMA: Schema = {
  type: "object",
  properties: {
    settleAfter: {
      type: "string",
      title: "wait after a comment",
      examples: ["10m", "30m", "1h", "0"],
      description: `How long a review stays open after the last comment on the forge before it goes back with everything said — a duration like 10m, 90s or 2h, and 0 settles on the first comment. A decision, a merge or a close never waits. A state's own remote block overrides this. Default ${DEFAULT_SETTLE_AFTER}.`,
    },
  },
};

const PUBLISH_SCHEMA: Schema = {
  type: "object",
  properties: {
    publish: {
      type: "string",
      title: "publishing",
      enum: ["ask", "allow", "deny"],
      description: `Whether a workflow may push a branch and open a merge request from here without asking. ask — once per task, saying exactly what will be sent and as whom; allow — without asking; deny — never. A remote in a workflow file is a request, never the authorization. Default ${DEFAULT_PUBLISH_MODE}.`,
    },
  },
};

export function IntegrationsPane(props: IntegrationsPaneProps): JSX.Element {
  const { config, layer, busy, editable, checks, onSave } = props;
  if (config === null) return <p className="empty">The configuration could not be read.</p>;

  const doc = (layer === "base" ? config.base : config.project) as Record<string, unknown> | null;
  const effective = config.effective as Record<string, unknown>;
  const integrations = (effective["integrations"] ?? {}) as { forges?: Record<string, JairaForgeConnection>; review?: Record<string, unknown> };
  const forges = integrations.forges ?? {};
  const locked = busy || !editable;
  const { set, stated } = layerWriter(doc, layer, onSave);
  const policy = (effective["policy"] ?? {}) as Record<string, unknown>;

  return (
    <div className="cfg-pane">
      <section className="cfg-group">
        <header className="cfg-group-head">
          <h4>Forges</h4>
          <p className="cfg-hint">
            Where a review can also be opened as a merge request. A project&apos;s git remote picks the
            connection by host.
          </p>
        </header>
        <ul className="cfg-rows">
          {Object.entries(forges).map(([name, connection]) => (
            <ForgeRow
              key={`${layer}:${name}`}
              name={name}
              connection={connection}
              check={checks.find((c) => c.name === name)}
              locked={locked}
              set={set}
              stated={stated}
              {...props}
            />
          ))}
          <AddHost forges={forges} locked={locked} set={set} />
        </ul>
      </section>

      <section className="cfg-group">
        <header className="cfg-group-head">
          <h4>Remote review</h4>
        </header>
        <SchemaForm
          schema={REVIEW_SCHEMA}
          value={integrations.review}
          onChange={(next) => set("integrations.review", next)}
          // `setAt` writes each field at its own path: `value` is the MERGED block, and handing a
          // rebuilt one back would pin every inherited sibling into this layer with the one edit.
          ctx={{ path: "integrations.review", disabled: locked, isSet: stated, setAt: set }}
        />
        <SchemaForm
          schema={PUBLISH_SCHEMA}
          // The policy document is sparse, so the default is filled in here for the same reason the
          // parsed config fills the others in: a field that is not set should say what it inherits.
          value={{ publish: publishModeOf(policy) }}
          onChange={(next) => set("policy.remote", next)}
          ctx={{ path: "policy.remote", disabled: locked, isSet: stated, setAt: set }}
        />
      </section>
    </div>
  );
}

function ForgeRow({
  name,
  connection,
  check,
  locked,
  set,
  stated,
  layer,
  secrets,
  config,
  onSaveToken,
}: IntegrationsPaneProps & {
  name: string;
  connection: JairaForgeConnection;
  check: ForgeCheck | undefined;
  locked: boolean;
  set: (path: string, value: unknown) => void;
  stated: (path: string) => boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const path = `integrations.forges.${name}`;
  const builtin = BUILTIN_FORGES[name] !== undefined;
  const enabled = connection.enabled !== false;
  const state = forgeState(enabled, check);
  const title = `${FORGE_LABELS[connection.provider].name} · ${connection.host}`;

  return (
    <li className={`cfg-row ${state}`}>
      <div className="cfg-row-head">
        <span className="cfg-mark">
          <BrandIcon name={connection.provider} className="cfg-mark-svg" />
          <StatusDot state={state} />
        </span>
        <span className="cfg-row-title">{title}</span>
        <span className="grow" />
        <Switch
          on={enabled}
          disabled={locked}
          label={enabled ? `stop using ${title}` : `use ${title} again`}
          // `undefined` REMOVES the key rather than writing `true`: on is the default, and a layer
          // that says so explicitly is a layer overriding something for no reason.
          onChange={(next) => set(`${path}.enabled`, next ? undefined : false)}
        />
        <button
          type="button"
          className={`quiet cfg-chevron${open ? " open" : ""}`}
          aria-expanded={open}
          aria-label={open ? `hide ${title}'s settings` : `configure ${title}`}
          title={open ? "Done" : "Configure"}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="chevron" />
        </button>
      </div>

      <p className="cfg-say">
        <span className="cfg-say-state">{stateWord(state)}</span>
        {check && state !== "off" && check.detail ? <> — {check.detail}</> : null}
        {check && state !== "off" && check.fix ? <span className="cfg-fix">→ {check.fix}</span> : null}
      </p>

      {open ? (
        <div className="cfg-row-body">
          <SchemaForm
            schema={builtin ? BUILTIN_SCHEMA : CUSTOM_SCHEMA}
            value={connection}
            onChange={(next) => set(path, next)}
            ctx={{ path, disabled: locked, isSet: stated, setAt: set }}
          />
          {builtin ? null : (
            <div className="pane-actions">
              <button
                type="button"
                className="ghost danger"
                disabled={locked || !stated(path)}
                title="delete this connection from the layer being edited"
                onClick={() => set(path, undefined)}
              >
                Remove
              </button>
            </div>
          )}
        </div>
      ) : null}

      <TokenBlock
        connection={name}
        named={connection.credential}
        check={check}
        layer={layer}
        busy={locked}
        secrets={secrets}
        hasProject={config !== null && config.projectFile.length > 0}
        onSave={onSaveToken}
      />
    </li>
  );
}

/**
 * Where a connection's token comes from, and how to store one.
 *
 * The Providers screen's key block, for the same reason it exists there: the NAME is configuration
 * and lives in the form above; the VALUE is a secret and lives in the chain. The box is a password
 * field that is cleared the moment it is sent, and nothing here can read a stored token back.
 */
function TokenBlock({
  connection,
  named,
  check,
  layer,
  busy,
  secrets,
  hasProject,
  onSave,
}: {
  connection: string;
  named: string | undefined;
  check: ForgeCheck | undefined;
  layer: ConfigLayer;
  busy: boolean;
  secrets: SecretCapabilities;
  hasProject: boolean;
  onSave: IntegrationsPaneProps["onSaveToken"];
}): JSX.Element {
  const targets: SecretTarget[] = [
    ...(secrets.keychain ? (["keychain"] as SecretTarget[]) : []),
    ...(hasProject ? (["project-env-local"] as SecretTarget[]) : []),
    "base-env-local",
  ];
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [target, setTarget] = useState<SecretTarget>(targets[0] ?? "base-env-local");
  // A connection that names nothing yet is filed under a name made from its own.
  const name = named ?? `${connection.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_TOKEN`;

  return (
    <div className="cfg-credential">
      <span className="cfg-hint">
        Token <code>{name}</code>
        {check?.credential ? ` — found in ${SECRET_SOURCE_LABELS[check.credential.source]}` : null}
        {check?.credentialMissing ? " — not found anywhere" : null}
      </span>
      {open ? (
        <div className="cfg-key-entry">
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
              disabled={busy}
              onClick={() => {
                onSave({ connection, ...(named !== undefined ? { named } : {}), name, value, target, layer });
                setValue("");
                setOpen(false);
              }}
            >
              Store the token
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setOpen(false);
                setValue("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="ghost" disabled={busy} onClick={() => setOpen(true)}>
          {check?.credential ? "Replace the token" : "Add a token"}
        </button>
      )}
    </div>
  );
}

/** A self-hosted GitLab or a GitHub Enterprise Server: a host, a kind, and the name of a token. */
function AddHost({
  forges,
  locked,
  set,
}: {
  forges: Record<string, JairaForgeConnection>;
  locked: boolean;
  set: (path: string, value: unknown) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const add = (): void => {
    const { name, ...connection } = draft as { name?: string } & Record<string, unknown>;
    try {
      if (typeof name !== "string" || name.length === 0) throw new Error("give the connection a name");
      if (forges[name] !== undefined) throw new Error(`there is already a connection called '${name}'`);
      // The parser main will run, run here first — so "two connections on one host" is said beside
      // the form that caused it rather than as a refused save.
      parseIntegrations({ forges: { ...forges, [name]: connection } });
      set(`integrations.forges.${name}`, connection);
      setDraft({});
      setProblem(null);
      setOpen(false);
    } catch (e) {
      setProblem((e as Error).message.replace(/^config\.integrations\.forges(\.[^:.]+)?[.:]?\s*/, ""));
    }
  };

  return (
    <li className="cfg-row unconfigured">
      <div className="cfg-row-head">
        <span className="cfg-mark">
          <BrandIcon name="+" className="cfg-mark-svg" />
          <StatusDot state="unconfigured" />
        </span>
        <span className="cfg-row-title">Another host</span>
        <span className="grow" />
      </div>
      <p className="cfg-say">
        <span className="cfg-say-state">not set up</span> — a self-hosted GitLab or GitHub Enterprise
      </p>
      {open ? (
        <div className="cfg-row-body">
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
      ) : (
        <div className="cfg-credential">
          <span className="cfg-hint">Host, kind and a token</span>
          <button type="button" className="ghost" disabled={locked} onClick={() => setOpen(true)}>
            Add a host
          </button>
        </div>
      )}
    </li>
  );
}
