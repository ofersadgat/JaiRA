/**
 * The forge rows of Settings → Connections — the connections to remote systems (decision 0004 §1).
 * What runs over them (publishing, the wait after a comment) is a default of the function that does
 * it, on Settings → Tools.
 *
 * The provider rows' shape, because a connection is the same kind of thing a provider
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
import { useContext, useState, type JSX } from "react";
import {
  SECRET_SOURCE_LABELS,
  SECRET_TARGET_LABELS,
  type ConfigLayer,
  type ConfigView,
  type ForgeCheck,
  type JairaForgeConnection,
  type SecretCapabilities,
  type SecretTarget,
} from "@jaira/shared/browser";
import { layerWriter } from "./configPane";
import { SelectInput, SettingsLayerContext, StatusDot, Switch, stateWord } from "./controls";
import { BrandIcon, Icon } from "./icons";
import { SchemaForm } from "./schemaForm/SchemaForm";
import { BUILTIN_FORGE_SCHEMA, CUSTOM_FORGE_SCHEMA, NEW_FORGE_SCHEMA, forgeRowOf, forgesOf, gitToolsSentence, newForgeOf, secretTargetsOf } from "./connectionsModel";

// What a row says and writes is `connectionsModel.ts`'s, shared with the universal copy (decision 0015).
export { forgeState, gitToolsSentence } from "./connectionsModel";

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
  /**
   * Signing in with the forge itself (OAuth device flow), beside pasting a token. Absent ⇒ tokens only.
   * `pending` holds the code the person types at the forge while a sign-in waits on the browser.
   */
  oauth?: {
    signingIn: ReadonlySet<string>;
    pending: ReadonlyMap<string, string>;
    errors: ReadonlyMap<string, string>;
    viaOAuth: ReadonlySet<string>;
    onSignIn: (connection: string) => void;
    onCancel: (connection: string) => void;
    onDisconnect: (connection: string) => void;
  };
  /** Go to Settings → Tools, where the Git tools a connection serves are governed. Absent ⇒ the name is plain text. */
  onOpenTools?: (() => void) | undefined;
}

/**
 * The first line of an OPENED forge row (decision 0010 §1, option B): what uses this connection, and
 * where those are governed. Plain — a `cfg-hint`, no border, no tint — and only when the row is open.
 */
export function ForgeToolsLine({ onOpenTools }: { onOpenTools?: (() => void) | undefined }): JSX.Element {
  const { lead } = gitToolsSentence();
  return (
    <p className="cfg-hint conn-tools-line">
      {lead}, on{" "}
      {onOpenTools !== undefined ? (
        <button type="button" className="link" onClick={onOpenTools}>
          Tools → Git
        </button>
      ) : (
        "Tools → Git"
      )}
    </p>
  );
}

/** The forges, as the card of Connections → Forges: one row per connection, then "Another host". */
export function ForgeRows(props: IntegrationsPaneProps): JSX.Element {
  const { config, layer, busy, editable, checks, onSave } = props;
  // The Just you view's "What you changed": only the connections the layer states, and no adding.
  const onlyStated = useContext(SettingsLayerContext)?.onlyStated === true;
  if (config === null) return <p className="empty">The configuration could not be read.</p>;

  const doc = config[layer] as Record<string, unknown> | null;
  const forges = forgesOf(config);
  const locked = busy || !editable;
  const { set, stated } = layerWriter(doc, layer, onSave);

  return (
    <ul className="cfg-rows">
      {Object.entries(forges).filter(([name]) => !onlyStated || stated(`integrations.forges.${name}`)).map(([name, connection]) => (
        <ForgeRow
          key={`${layer}:${name}`}
          {...props}
          name={name}
          connection={connection}
          check={checks.find((c) => c.name === name)}
          locked={locked}
          set={set}
          stated={stated}
        />
      ))}
      {onlyStated ? null : <AddHost forges={forges} locked={locked} set={set} />}
    </ul>
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
  oauth,
  onOpenTools,
}: IntegrationsPaneProps & {
  name: string;
  connection: JairaForgeConnection;
  check: ForgeCheck | undefined;
  locked: boolean;
  set: (path: string, value: unknown) => void;
  stated: (path: string) => boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const { path, builtin, enabled, state, label, title, tokenName, identity, signingIn, viaOAuth } = forgeRowOf(name, connection, check, oauth);

  return (
    <li className={`cfg-row conn-row ${state}`}>
      <div className="conn-main">
        <div className="cfg-row-head">
          <span className="cfg-mark">
            <BrandIcon name={connection.provider} className="cfg-mark-svg" />
            <StatusDot state={state} />
          </span>
          <span className="cfg-row-title">{title}</span>
        </div>
        <p className="cfg-say">
          <span className="cfg-say-state">{stateWord(state)}</span>
          {check && state !== "off" && check.detail ? <> — {check.detail}</> : null}
          {check && state !== "off" && check.fix ? <span className="cfg-fix">→ {check.fix}</span> : null}
        </p>
      </div>

      {/* Who this connection acts as — the account the token belongs to, however it was stored — and
          the + box: sign in with the forge, or paste a token. The same boxes an agent's logins use. */}
      <ul className="conn-boxes" aria-label={`${title}: who it connects as`}>
        {identity !== undefined ? (
          <li className="cfg-login-card active">
            <div className="cfg-login-top">
              <span className="cfg-login-mark">{identity.login.charAt(0).toUpperCase()}</span>
              <span className="cfg-login-tag accent">{viaOAuth ? "OAuth" : "token"}</span>
            </div>
            <div className="cfg-login-who">{identity.login}</div>
            <div className="cfg-login-facts">
              {identity.scopes !== undefined && identity.scopes.length > 0 ? <span>{identity.scopes.join(", ")}</span> : null}
              {check?.credential ? <span>{tokenName} · {SECRET_SOURCE_LABELS[check.credential.source]}</span> : null}
            </div>
            {oauth !== undefined ? (
              <div className="cfg-login-actions">
                <button type="button" className="ghost" disabled={locked} onClick={() => oauth.onDisconnect(name)}>
                  Disconnect
                </button>
              </div>
            ) : null}
          </li>
        ) : check?.credentialMissing !== undefined && connection.credential !== undefined ? (
          <li className="cfg-key-box missing">
            <span className="cfg-login-mark key" aria-hidden="true">
              <Icon name="lock" />
            </span>
            <span className="cfg-login-who">{tokenName}</span>
            <span className="cfg-login-facts">
              <span>not found anywhere</span>
            </span>
          </li>
        ) : null}
        {tokenOpen ? null : (
          <li className="cfg-login-tile">
            {signingIn ? (
              <div className="cfg-login-add waiting" role="status">
                <span className="cfg-login-spin" aria-hidden="true" />
                <span className="cfg-login-add-title">Finish in your browser</span>
                {oauth?.pending.get(name) !== undefined ? (
                  <span className="cfg-login-add-sub">
                    Enter <code>{oauth.pending.get(name)}</code>
                  </span>
                ) : null}
                <button type="button" className="ghost" onClick={() => oauth?.onCancel(name)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="cfg-login-add">
                {oauth !== undefined && connection.provider !== undefined ? (
                  <button type="button" className="cfg-login-add-main" disabled={locked} onClick={() => oauth.onSignIn(name)}>
                    <span className="cfg-login-plus" aria-hidden="true">
                      +
                    </span>
                    <span className="cfg-login-add-title">{identity !== undefined ? "Switch account" : `Sign in with ${label}`}</span>
                  </button>
                ) : (
                  <span className="cfg-login-plus" aria-hidden="true">
                    +
                  </span>
                )}
                <button type="button" className="link cfg-login-add-sub" disabled={locked} onClick={() => setTokenOpen(true)}>
                  {oauth !== undefined ? "or paste a token" : check?.credential ? "Replace the token" : "Add a token"}
                </button>
              </div>
            )}
          </li>
        )}
      </ul>

      <div className="conn-controls">
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

      {oauth?.errors.get(name) !== undefined ? <p className="sub warn-text conn-wide">{oauth.errors.get(name)}</p> : null}

      {tokenOpen ? (
        <div className="conn-wide">
          <TokenEntry
            connection={name}
            named={connection.credential}
            name={tokenName}
            layer={layer}
            busy={locked}
            secrets={secrets}
            hasProject={config !== null && config.projectFile.length > 0}
            onSave={onSaveToken}
            onClose={() => setTokenOpen(false)}
          />
        </div>
      ) : null}

      {open ? (
        <div className="cfg-row-body conn-wide">
          <ForgeToolsLine onOpenTools={onOpenTools} />
          <SchemaForm
            schema={builtin ? BUILTIN_FORGE_SCHEMA : CUSTOM_FORGE_SCHEMA}
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
    </li>
  );
}

/**
 * Store a connection's token: the value goes straight to main, into the secret chain, and is never
 * held in a form, in renderer state, or in `settings.json` — which holds its name. The box is a
 * password field cleared the moment it is sent, and nothing here can read a stored token back.
 */
function TokenEntry({
  connection,
  named,
  name,
  layer,
  busy,
  secrets,
  hasProject,
  onSave,
  onClose,
}: {
  connection: string;
  named: string | undefined;
  name: string;
  layer: ConfigLayer;
  busy: boolean;
  secrets: SecretCapabilities;
  hasProject: boolean;
  onSave: IntegrationsPaneProps["onSaveToken"];
  onClose: () => void;
}): JSX.Element {
  const targets = secretTargetsOf(secrets, hasProject);
  const [value, setValue] = useState("");
  const [target, setTarget] = useState<SecretTarget>(targets[0] ?? "base-env-local");

  return (
    <div className="cfg-key-entry">
      <span className="cfg-hint">
        Filed under <code>{name}</code>.
      </span>
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
            onClose();
          }}
        >
          Store the token
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
    // Checked as main will check it, so what is wrong is said beside the form (`newForgeOf`).
    const made = newForgeOf(draft, forges);
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
          <span className="cfg-row-title">Another host</span>
        </div>
        <p className="cfg-say">
          <span className="cfg-say-state">not set up</span> — a self-hosted GitLab or GitHub Enterprise
        </p>
      </div>
      <ul className="conn-boxes">
        {open ? null : (
          <li className="cfg-login-tile">
            <button type="button" className="cfg-login-add" disabled={locked} onClick={() => setOpen(true)}>
              <span className="cfg-login-plus" aria-hidden="true">
                +
              </span>
              <span className="cfg-login-add-title">Add a host</span>
              <span className="cfg-login-add-sub">host, kind and a token</span>
            </button>
          </li>
        )}
      </ul>
      <div className="conn-controls" />
      {open ? (
        <div className="cfg-row-body conn-wide">
          <SchemaForm schema={NEW_FORGE_SCHEMA} value={draft} onChange={(next) => setDraft((next ?? {}) as Record<string, unknown>)} ctx={{ path: "", disabled: locked, hidePaths: true }} />
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
    </li>
  );
}
