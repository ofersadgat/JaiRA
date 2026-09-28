/**
 * The provider rows of Settings → Connections — everything that can answer a prompt, and how each is
 * reached (DESIGN §8.1, §8.3). Each row is what it is and whether it works on the left, and who it
 * connects as on the right: its logins and its key, as boxes, with a + box to add one.
 *
 * One screen where there were two. "Models" listed the four serving routes and "Executors" listed
 * the agents, which is a split along how JaiRA reaches a thing rather than along anything a user is
 * doing: both tabs answered *what can run here and how do I set it up*, and neither answered it on
 * its own. A model provider and an agent provider differ in their settings, not in their purpose,
 * and `providerSpecs.ts` is where that difference is stated — as a type hierarchy, so the form can
 * show which settings come from which level instead of flattening them into one pile of boxes.
 *
 * What these rows do NOT do is choose. Which provider a state actually uses is Settings → Models'
 * question; this one is only about what is installed, reachable, and turned on.
 *
 * The state of a provider is OBSERVED, never assumed. A checkbox can say only on or off, so an
 * unavailable provider used to render as a ticked box — which is how this screen came to claim four
 * working providers on a machine configured for none. A provider therefore has four states, and the
 * pill says which: ready, not working, not set up, turned off.
 */
import { useContext, useState, type JSX } from "react";
import { accountFor, useLimits } from "./limitsStore";
import { AccountAllowance, KeyUsage } from "./usageMeters";
import {
  SECRET_SOURCE_LABELS,
  SECRET_TARGET_LABELS,
  type AgentAccount,
  type ConfigLayer,
  type ConfigView,
  type ExecutorInfo,
  type ProbeResult,
  type EmbeddedWeightsReport,
  type LocalServerProbe,
  type SecretCapabilities,
  type SecretTarget,
  type WeightsFileCheck,
} from "@jaira/shared/browser";
import { Disclosure, Field, FieldGrid, Level, SelectInput, SettingsLayerContext, StatusDot, Switch, TextArea, TextInput, useLayerRow } from "./controls";
import { BrandIcon, Icon } from "./icons";
import { providerBlockPath, type FieldSpec, type ProviderSpec } from "./providerSpecs";
import { checkCredentialName, type ExecutorPatch, type ExecutorTarget } from "./executorConfig";
import type { ModelPatch } from "./modelsConfig";
import {
  emptyLevelWords,
  fieldControlOf,
  keyBoxWords,
  keyEntryExecutor,
  keyEntryName,
  levelFieldsOf,
  localServerSaid,
  loginAddWords,
  loginCommandOf,
  loginFacts,
  paramOf,
  placeholderFor,
  providerSayState,
  readAt,
  secretTargetsOf,
  useProviderRow,
  weightsSize,
} from "./connectionsModel";

// What a row says and writes is `connectionsModel.ts`'s, shared with the universal copy (decision 0015).
export { providerGroups, providerState } from "./connectionsModel";

export interface ProvidersPaneProps {
  config: ConfigView | null;
  executors: ExecutorInfo[];
  /**
   * What the checks observed, kept as TWO maps rather than one.
   *
   * A route and an executor are different namespaces: nothing stops someone registering a generic
   * CLI called `local`, and a single merged map would then report one provider's health for the
   * other. Each row looks its result up in the map for its own family.
   */
  routeProbes: Record<string, ProbeResult>;
  executorProbes: Record<string, ProbeResult>;
  secrets: SecretCapabilities;
  busy: boolean;
  layer: ConfigLayer;
  /** False when this layer has no document to write — see the Settings shell, which hides the layer. */
  editable: boolean;
  onSaveRoute: (fields: ModelPatch, layer: ConfigLayer) => void;
  onSaveExecutor: (executor: ExecutorTarget, fields: ExecutorPatch, layer: ConfigLayer) => void;
  onAdd: (spec: { name: string; command: string }, layer: ConfigLayer) => void;
  onRemove: (name: string, layer: ConfigLayer) => void;
  onSaveCredential: (request: {
    executor: ExecutorTarget & { credential?: string | undefined };
    name: string;
    value: string;
    target: SecretTarget;
    layer: ConfigLayer;
  }) => void;
  /** Agents whose sign-in is waiting on the browser. */
  signingIn: ReadonlySet<string>;
  onSignIn: (name: string) => void;
  onCancelSignIn: (name: string) => void;
  onSignOut: (name: string) => void;
  /** What answered on the usual local ports, when the page last asked. Absent ⇒ not asked yet. */
  localServers?: LocalServerProbe[] | undefined;
  /**
   * Ask the usual ports again now, and re-check the local route — a server started after the page
   * opened is otherwise only found by the page-wide Re-check (the person, 2026-09-25).
   */
  onScanLocal?: (() => void) | undefined;
  /** A scan is in flight. */
  scanningLocal?: boolean | undefined;
  /** Whether each embedded model's weights file is there, and whether the loader is. Absent ⇒ not checked yet. */
  weights?: EmbeddedWeightsReport | undefined;
}

/** One group of provider rows, as the card of a Connections section. */
export function ProviderRows(props: ProvidersPaneProps & { specs: ProviderSpec[] }): JSX.Element {
  const { config, routeProbes, executorProbes, layer, specs } = props;
  if (config === null) return <p className="empty">The configuration could not be read.</p>;
  const layerDoc = config[layer];
  return (
    <ul className="cfg-rows">
      {specs.map((spec) => (
        <ProviderRow
          key={`${layer}:${spec.id}`}
          {...props}
          spec={spec}
          probe={spec.family === "model" ? routeProbes[spec.id] : executorProbes[spec.id]}
          layerDoc={layerDoc}
          effective={config.effective}
        />
      ))}
    </ul>
  );
}

/** Declare another agent CLI — the last row of Connections → Agents. */
export function AddAgentRow(props: Pick<ProvidersPaneProps, "layer" | "busy" | "editable" | "onAdd">): JSX.Element | null {
  // Adding is setting something, which "What you changed" is not showing — Every row is.
  if (useContext(SettingsLayerContext)?.onlyStated === true) return null;
  return <AddProvider layer={props.layer} busy={props.busy || !props.editable} onAdd={props.onAdd} />;
}

/**
 * The logins an agent holds, as one box each on the right of the row that describes the connector,
 * and the + box after them (the person's layout, 2026-09-23: "a horizontal list of boxes on the
 * right side").
 *
 * The row says what the BINARY is doing; who it calls as is the boxes' to say, with the controls that
 * change it: Log out on each, and the + box to sign in — "Sign in" when there is nobody, "Switch
 * account" when there is somebody, because every CLI today holds one login and signing in again
 * replaces it. A login a run's call was refused on is a warning box with the reason and Sign in
 * again — nothing about the connector is broken.
 *
 * The boxes are `<li>`s for the row's own box list, beside its key box if it has one. The tag and the
 * outline on the one in use appear only when there is something to tell apart.
 */
export function LoginCards({
  agent,
  command,
  accounts,
  signingIn,
  busy,
  onSignIn,
  onCancel,
  onSignOut,
  onAddKey,
}: {
  agent: string;
  command: string | undefined;
  accounts: AgentAccount[];
  signingIn: boolean;
  busy: boolean;
  onSignIn: () => void;
  onCancel: () => void;
  onSignOut: () => void;
  /** A second way in, under the + box's sign-in: store an API key. Absent for an agent that takes none. */
  onAddKey?: (() => void) | undefined;
}): JSX.Element {
  const several = accounts.length > 1;
  const { binary, login } = loginCommandOf(agent, command);
  const add = loginAddWords(accounts);
  // A refused login's own box carries the waiting state while it is signing in again.
  const renewing = accounts.some((account) => account.refused !== undefined);
  return (
    <>
      {accounts.map((account, i) => (
        <LoginCard
          key={`${account.label}:${i}`}
          agent={agent}
          account={account}
          binary={binary}
          tagged={several && account.active}
          signingIn={signingIn}
          busy={busy}
          onSignIn={onSignIn}
          onCancel={onCancel}
          onSignOut={onSignOut}
        />
      ))}
      {renewing ? null : (
        <li className="cfg-login-tile">
          {signingIn ? (
            <div className="cfg-login-add waiting" role="status">
              <span className="cfg-login-spin" aria-hidden="true" />
              <span className="cfg-login-add-title">Finish in your browser</span>
              <span className="cfg-login-add-sub">
                Nothing opened? Run <code>{login}</code>.
              </span>
              <button className="ghost" onClick={onCancel}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="cfg-login-add">
              <button className="cfg-login-add-main" onClick={onSignIn} disabled={busy}>
                <span className="cfg-login-plus" aria-hidden="true">
                  +
                </span>
                <span className="cfg-login-add-title">{add.title}</span>
              </button>
              {onAddKey !== undefined ? (
                <button type="button" className="link cfg-login-add-sub" disabled={busy} onClick={onAddKey}>
                  or an API key
                </button>
              ) : (
                <span className="cfg-login-add-sub">{add.sub}</span>
              )}
            </div>
          )}
        </li>
      )}
    </>
  );
}

function LoginCard({
  agent,
  account,
  binary,
  tagged,
  signingIn,
  busy,
  onSignIn,
  onCancel,
  onSignOut,
}: {
  /** The agent this login is for — whose account's allowance the card's ring reads. */
  agent: string;
  account: AgentAccount;
  binary: string;
  tagged: boolean;
  signingIn: boolean;
  busy: boolean;
  onSignIn: () => void;
  onCancel: () => void;
  onSignOut: () => void;
}): JSX.Element {
  // Logging out is the CLI's own, so it is machine-wide — the person's terminal loses the login too.
  // Asked once, in place, rather than in a dialog.
  const [confirming, setConfirming] = useState(false);
  const refused = account.refused !== undefined;
  // The allowance is the ACCOUNT's, and the account is whoever is signed in now — so only the login in
  // use carries the ring (usage-readings contract: design 2, the weekly window).
  const limits = useLimits();
  const allowance = account.active ? accountFor(limits, agent) : undefined;
  return (
    <li className={`cfg-login-card um-c${tagged ? " active" : ""}${refused ? " refused" : ""}`}>
      <div className="um-c-top">
        <span className="cfg-login-mark um-c-mark" aria-hidden="true">
          {account.label.charAt(0).toUpperCase()}
        </span>
        <span className="cfg-login-who" title={account.label}>
          {account.label}
        </span>
        {refused ? <span className="cfg-login-tag warn">refused</span> : tagged ? <span className="cfg-login-tag accent">in use</span> : null}
        {signingIn || confirming ? null : (
          <button
            type="button"
            className="ghost um-c-out"
            title={`Log out — signs ${binary} out on this computer`}
            aria-label="Log out"
            onClick={() => setConfirming(true)}
            disabled={busy}
          >
            <Icon name="logout" />
          </button>
        )}
      </div>
      <AccountAllowance account={allowance} plan={loginFacts(account).join(" · ")} />
      {refused ? <div className="cfg-login-note">The last run&apos;s call was refused: {account.refused}</div> : null}
      {confirming ? (
        <div className="cfg-login-confirm">
          <span>
            Sign <code>{binary}</code> out on this computer? Its terminal sessions lose this login too.
          </span>
          <div className="cfg-login-actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                onSignOut();
              }}
            >
              Log out
            </button>
            <button className="ghost" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </div>
        </div>
      ) : (
        <div className="cfg-login-actions">
          {refused && signingIn ? (
            <>
              <span className="cfg-login-waiting" role="status">
                <span className="cfg-login-spin" aria-hidden="true" />
                Finish signing in in your browser
              </span>
              <button className="ghost" onClick={onCancel}>
                Cancel
              </button>
            </>
          ) : refused ? (
            <button className="primary" onClick={onSignIn} disabled={busy}>
              Sign in again
            </button>
          ) : null}
        </div>
      )}
    </li>
  );
}

function ProviderRow({
  spec,
  probe,
  layerDoc,
  effective,
  busy,
  editable,
  layer,
  secrets,
  config,
  onSaveRoute,
  onSaveExecutor,
  onRemove,
  onSaveCredential,
  signingIn,
  onSignIn,
  onCancelSignIn,
  onSignOut,
  localServers,
  onScanLocal,
  scanningLocal,
  weights,
}: ProvidersPaneProps & {
  spec: ProviderSpec;
  probe: ProbeResult | undefined;
  layerDoc: unknown;
  effective: unknown;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  // The row's form and what it writes (`connectionsModel.ts`): the document moved under the form —
  // usually because this row just saved — and untouched boxes follow it, edited ones are kept.
  const { here, merged, form, setForm, problem, locked, enabled, state, dirty, write, save, revert } = useProviderRow({
    spec,
    probe,
    layerDoc,
    effective,
    busy,
    editable,
    layer,
    onSaveRoute,
    onSaveExecutor,
  });

  // The key's store form opens under the row, across its width, from the key box on the right.
  const [keyOpen, setKeyOpen] = useState(false);
  const agentLogins = probe?.accounts !== undefined && state !== "off";
  // The Just you view: a provider is a row the layer states when its block says anything there.
  const blockPath = providerBlockPath(spec);
  const layered = useLayerRow(blockPath !== null ? [blockPath.join(".")] : ["agents.genericCli"]);
  if (layered.hidden) return null;

  return (
    <li className={`cfg-row conn-row ${state}`}>
      {/* What it is and whether it works, on the left; who it connects as, on the right (the person's
          layout, 2026-09-23). The mark carries the dot, so identity and state are read in one
          fixation. `spec.id` and not `spec.title`: the id is the registry name (`codex-cli`,
          `anthropic`), which is what `brandOf` knows how to resolve. */}
      <div className="conn-main">
        <div className="cfg-row-head">
          <span className="cfg-mark">
            <BrandIcon name={spec.id} className="cfg-mark-svg" />
            <StatusDot state={state} />
          </span>
          <span className="cfg-row-title">{spec.title}</span>
        </div>
        {/* One SENTENCE: the state of this provider on this machine right now. `spec.hint` — the
            standing "would you want this at all" line — is inside, read once while deciding. */}
        <p className="cfg-say">
          <span className="cfg-say-state">{providerSayState(probe, state)}</span>
          {probe && state !== "off" && probe.detail ? <> — {probe.detail}</> : null}
          {probe && state !== "off" && probe.fix ? <span className="cfg-fix">→ {probe.fix}</span> : null}
        </p>
        {probe?.version ? <code className="cfg-version conn-version">{probe.version}</code> : null}
      </div>

      <ul className="conn-boxes" aria-label={`${spec.title}: who it connects as`}>
        {agentLogins ? (
          <LoginCards
            agent={spec.id}
            command={typeof merged["command"] === "string" ? merged["command"] : undefined}
            accounts={probe!.accounts!}
            signingIn={signingIn.has(spec.id)}
            busy={busy}
            onSignIn={() => onSignIn(spec.id)}
            onCancel={() => onCancelSignIn(spec.id)}
            onSignOut={() => onSignOut(spec.id)}
            {...(spec.credential !== "none" && !keyOpen ? { onAddKey: () => setKeyOpen(true) } : {})}
          />
        ) : null}
        <KeyBoxes spec={spec} probe={probe} merged={merged} busy={locked} open={keyOpen || agentLogins} onOpen={() => setKeyOpen(true)} />
      </ul>

      <div className="conn-controls">
        <Switch
          on={enabled}
          disabled={locked}
          label={enabled ? `stop using ${spec.title} in this project` : `use ${spec.title} again`}
          // `undefined` REMOVES the key rather than writing `true`: on is the default, and a layer
          // that says so explicitly is a layer overriding something for no reason.
          onChange={(next) => write({ enabled: next ? undefined : false })}
        />
        <button
          className={`quiet cfg-chevron${open ? " open" : ""}`}
          aria-expanded={open}
          aria-label={open ? `hide ${spec.title}'s settings` : `configure ${spec.title}`}
          title={open ? "Done" : "Configure"}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="chevron" />
        </button>
      </div>

      {keyOpen ? (
        <div className="conn-wide">
          <KeyEntry
            spec={spec}
            merged={merged}
            layer={layer}
            busy={locked}
            secrets={secrets}
            hasProject={config !== null && config.projectFile.length > 0}
            onSave={onSaveCredential}
            onClose={() => setKeyOpen(false)}
          />
        </div>
      ) : null}

      {/* What a provider on this machine found and holds, always in view: the servers answering on
          the usual ports, and the weights with whether each file is there. */}
      {spec.id === "local" && localServers !== undefined ? (
        <div className="conn-wide">
          <LocalServers found={localServers} locked={locked} scanning={scanningLocal === true} onScan={onScanLocal} onUse={(baseURL) => write({ baseURL })} />
        </div>
      ) : null}
      {spec.id === "embedded" ? (
        <div className="conn-wide">
          {weights !== undefined && !weights.loader.installed ? (
            <p className="cfg-hint warn-text conn-weights-note">
              <code>{weights.loader.module}</code> is not installed, so no weights can be loaded{weights.loader.error !== undefined ? ` — ${weights.loader.error}` : ""}.
            </p>
          ) : null}
          <WeightsRows
            weights={(merged["weights"] ?? {}) as Record<string, { modelPath?: string }>}
            checks={weights?.weights}
            locked={locked}
            onChange={(next) => write({ weights: Object.keys(next).length === 0 ? undefined : next })}
          />
        </div>
      ) : null}

      {open ? (
        // The row's own form: what is in it is this provider's, drawn whole once the row is.
        <SettingsLayerContext.Provider value={null}>
        <div className="cfg-row-body conn-wide">
          <p className="cfg-hint">{spec.hint}</p>
          {spec.levels.map((level, depth) => {
            // The weights are drawn as rows above, so the form does not repeat them as JSON.
            const fieldsHere = levelFieldsOf(spec, level.fields);
            return (
              // One level deeper than the page: inside a row, a type level is a band, never a section.
              <Level key={level.title} title={level.title} hint={level.hint} depth={depth + 1}>
                {fieldsHere.length === 0 ? (
                  <p className="cfg-hint">{emptyLevelWords(level.fields)}</p>
                ) : (
                  <FieldGrid>
                    {fieldsHere.map((field) => (
                      <Field
                        key={field.path}
                        label={field.label}
                        param={paramOf(spec, field)}
                        hint={field.hint}
                        set={readAt(here, field.path) !== undefined}
                      >
                        <FieldControl
                          field={field}
                          value={form[field.path] ?? ""}
                          placeholder={placeholderFor(field, merged)}
                          disabled={locked}
                          onChange={(v) => setForm((f) => ({ ...f, [field.path]: v }))}
                        />
                      </Field>
                    ))}
                  </FieldGrid>
                )}
              </Level>
            );
          })}

          <p className="cfg-hint">
            An empty box removes the setting from this layer, so it goes back to whatever the other
            layer or the built-in default says.
          </p>
          {problem ? <p className="sub warn-text">{problem}</p> : null}
          <div className="pane-actions">
            <button className="primary" onClick={save} disabled={locked || !dirty}>
              Save
            </button>
            <button
              className="ghost"
              onClick={revert}
              disabled={!dirty}
            >
              Revert
            </button>
            {spec.location.kind === "agent" && spec.location.executorKind === "generic" ? (
              <button
                className="ghost danger"
                disabled={locked}
                title="delete this CLI from the layer being edited — a built-in can only be turned off"
                onClick={() => onRemove(spec.id, layer)}
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>
        </SettingsLayerContext.Provider>
      ) : null}
    </li>
  );
}

function FieldControl({
  field,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  field: FieldSpec;
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (v: string) => void;
}): JSX.Element {
  const control = fieldControlOf(field);
  if (control.kind === "select") {
    return <SelectInput value={value} options={field.options ?? []} disabled={disabled} onChange={onChange} />;
  }
  if (control.kind === "area") {
    return <TextArea value={value} rows={control.rows} placeholder={placeholder} disabled={disabled} onChange={onChange} />;
  }
  return <TextInput value={value} placeholder={placeholder} disabled={disabled} mono={control.mono} onChange={onChange} />;
}

/**
 * A provider's key, as boxes on the right of its row: the key it names (and where it was found, or
 * that it was not), then the + box that stores one.
 *
 * Nothing for a runtime that uses no key. `claude-cli` carries the subscription its user signed
 * into: a key box there invited someone to store a secret nothing would ever read. An agent that signs
 * itself in says who it is in its login boxes instead.
 */
function KeyBoxes({
  spec,
  probe,
  merged,
  busy,
  open,
  onOpen,
}: {
  spec: ProviderSpec;
  probe: ProbeResult | undefined;
  merged: Record<string, unknown>;
  busy: boolean;
  open: boolean;
  onOpen: () => void;
}): JSX.Element | null {
  if (spec.credential === "none") return null;
  // `open` is also true for an agent that signs in: its + box offers the key under the sign-in.
  const { named, plusTitle, plusSub } = keyBoxWords(spec, merged);
  return (
    <>
      {named !== undefined ? (
        <li className={`cfg-key-box${probe?.credentialMissing ? " missing" : ""}`}>
          <span className="cfg-login-mark key" aria-hidden="true">
            <Icon name="lock" />
          </span>
          <span className="cfg-login-who">{named}</span>
          <span className="cfg-login-facts">
            {probe?.credential ? <span>in {SECRET_SOURCE_LABELS[probe.credential.source]}</span> : null}
            {probe?.credentialMissing ? <span>not found anywhere</span> : null}
          </span>
          {/* What the key has spent — a credit's dollars used, or the last seven days. Never what is left. */}
          {probe?.credentialMissing ? null : <KeyUsage route={spec.id} />}
        </li>
      ) : null}
      {open ? null : (
        <li className="cfg-login-tile">
          <button className="cfg-login-add" disabled={busy} onClick={onOpen}>
            <span className="cfg-login-plus" aria-hidden="true">
              +
            </span>
            <span className="cfg-login-add-title">{plusTitle}</span>
            <span className="cfg-login-add-sub">{plusSub}</span>
          </button>
        </li>
      )}
    </>
  );
}

/**
 * Store a provider's key: its name (when nothing names one and there is no convention), its value, and
 * which store it goes to. The value crosses to main and is never read back.
 */
function KeyEntry({
  spec,
  merged,
  layer,
  busy,
  secrets,
  hasProject,
  onSave,
  onClose,
}: {
  spec: ProviderSpec;
  merged: Record<string, unknown>;
  layer: ConfigLayer;
  busy: boolean;
  secrets: SecretCapabilities;
  hasProject: boolean;
  onSave: ProvidersPaneProps["onSaveCredential"];
  onClose: () => void;
}): JSX.Element {
  const targets = secretTargetsOf(secrets, hasProject);
  const [value, setValue] = useState("");
  const [typedName, setTypedName] = useState("");
  const [target, setTarget] = useState<SecretTarget>(targets[0] ?? "base-env-local");
  const [problem, setProblem] = useState<string | null>(null);

  // What a stored key would be filed under (`keyEntryName`).
  const { named, name, needsName } = keyEntryName(spec, merged, typedName);

  return (
    <div className="cfg-key-entry">
      <span className="cfg-hint">
        {named !== undefined ? (
          <>
            Replaces the value of <code>{named}</code>.
          </>
        ) : (
          <>
            Storing one also writes the name <code>{name || "…"}</code> into this layer, so it is actually looked up.
          </>
        )}
      </span>
      {needsName ? (
        <Field label="Secret name" param="credential" hint="What this key is filed under. Config stores this NAME; the value goes to the store you pick below.">
          <TextInput value={typedName} mono placeholder="LOCAL_API_KEY" onChange={setTypedName} />
        </Field>
      ) : null}
      <input
        type="password"
        className="cfg-input mono"
        value={value}
        autoComplete="off"
        placeholder={`the value of ${name || "the secret"} — empty clears it`}
        onChange={(e) => setValue(e.target.value)}
      />
      <SelectInput value={target} options={targets.map((t) => [SECRET_TARGET_LABELS[t], t])} onChange={(v) => setTarget(v as SecretTarget)} />
      <div className="pane-actions">
        <button
          disabled={busy || name.length === 0}
          onClick={() => {
            try {
              checkCredentialName(name);
            } catch (e) {
              setProblem((e as Error).message);
              return;
            }
            onSave({
              executor: keyEntryExecutor(spec, named),
              name,
              value,
              target,
              layer,
            });
            setValue("");
            setTypedName("");
            onClose();
          }}
        >
          Store the key
        </button>
        <button
          className="ghost"
          onClick={() => {
            setValue("");
            onClose();
          }}
        >
          Cancel
        </button>
      </div>
      {problem ? <p className="sub warn-text">{problem}</p> : null}
    </div>
  );
}

/**
 * The OpenAI-compatible servers answering on the usual local ports, asked when the page opens and on
 * Re-check. The one the route points at says so; any other that answers is one click from being it.
 */
export function LocalServers({
  found,
  locked,
  scanning = false,
  onScan,
  onUse,
}: {
  found: LocalServerProbe[];
  locked: boolean;
  scanning?: boolean;
  /** Ask again now. Absent (a still picture) draws no button. */
  onScan?: (() => void) | undefined;
  onUse: (baseURL: string) => void;
}): JSX.Element {
  return (
    <div className="conn-probe">
      <div className="conn-probe-head">
        <span>
          Asked the usual ports for a model list (<code>GET /v1/models</code>)
        </span>
        <span className="conn-probe-when">
          {scanning ? "asking now…" : "when this page opens"}
          {onScan !== undefined ? (
            <button type="button" className="ghost" disabled={scanning} title="Ask the usual ports again — for a server started since" onClick={onScan}>
              Scan again
            </button>
          ) : null}
        </span>
      </div>
      {found.map((server) => {
        const inUse = server.inUse;
        return (
          <div key={server.baseURL} className={`conn-probe-row${server.up ? " up" : ""}${inUse ? " in-use" : ""}`}>
            <span className="conn-probe-dot" aria-hidden="true" />
            <span className="conn-probe-name">{server.name}</span>
            <span className="conn-probe-at mono">{localServerSaid(server)}</span>
            {inUse ? (
              <span className="cfg-login-tag accent">in use</span>
            ) : server.up ? (
              <button className="ghost" disabled={locked} onClick={() => onUse(server.baseURL)}>
                Use
              </button>
            ) : (
              <span />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The embedded route's weights, one row per model id: the id a prompt names, the GGUF it loads, and
 * whether that file is there. Edited in place — a model id and its path — rather than as JSON.
 */
export function WeightsRows({
  weights,
  checks,
  locked,
  onChange,
}: {
  weights: Record<string, { modelPath?: string }>;
  checks: WeightsFileCheck[] | undefined;
  locked: boolean;
  onChange: (next: Record<string, { modelPath?: string }>) => void;
}): JSX.Element {
  const [id, setId] = useState("");
  const [path, setPath] = useState("");
  const entries = Object.entries(weights);
  const size = weightsSize;
  return (
    <div className="conn-weights">
      {entries.length === 0 ? <p className="cfg-hint">No weights named yet — add a model id and the .gguf it loads.</p> : null}
      {entries.map(([modelId, entry]) => {
        const check = checks?.find((c) => c.id === modelId);
        return (
          <div key={modelId} className="conn-weights-row">
            <span className="mono">{modelId}</span>
            <span className="mono dim conn-weights-path" title={entry.modelPath}>
              {entry.modelPath ?? "—"}
            </span>
            {check === undefined ? (
              <span className="sub">not checked</span>
            ) : check.exists ? (
              <span className="cfg-login-tag ok">found{check.sizeBytes !== undefined ? ` · ${size(check.sizeBytes)}` : ""}</span>
            ) : (
              <span className="cfg-login-tag bad">{check.error ?? "file missing"}</span>
            )}
            <button
              className="ghost"
              disabled={locked}
              title={`stop serving ${modelId}`}
              onClick={() => {
                const next = { ...weights };
                delete next[modelId];
                onChange(next);
              }}
            >
              Remove
            </button>
          </div>
        );
      })}
      <div className="conn-weights-row add">
        <TextInput value={id} mono placeholder="model id" disabled={locked} onChange={setId} />
        <TextInput value={path} mono placeholder="/models/name.gguf" disabled={locked} onChange={setPath} />
        <span />
        <button
          className="ghost"
          disabled={locked || id.trim().length === 0 || path.trim().length === 0 || weights[id.trim()] !== undefined}
          onClick={() => {
            onChange({ ...weights, [id.trim()]: { modelPath: path.trim() } });
            setId("");
            setPath("");
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

/** Declare a new agent CLI in the layer being edited (DESIGN §8.1's `generic-cli`). */
function AddProvider({
  layer,
  busy,
  onAdd,
}: {
  layer: ConfigLayer;
  busy: boolean;
  onAdd: (spec: { name: string; command: string }, layer: ConfigLayer) => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");

  return (
    <Disclosure summary="Add an agent CLI" desc="any other coding-agent binary">
      <div className="cfg-stack">
        <p className="cfg-hint">
          It is registered under the name you give it, which is what a state&apos;s <code>function</code> then
          names and what a model prefix routes to. It enforces no permissions of its own, so while JaiRA&apos;s built-in
          refusals are on (Settings → Tools → bash) a run will refuse to hand it a state.
        </p>
        <FieldGrid>
          <Field label="Registry name" param="agents.genericCli[].name" hint="How a workflow will name it.">
            <TextInput value={name} placeholder="opencode" disabled={busy} onChange={setName} />
          </Field>
          <Field label="Command" param="agents.genericCli[].command" hint="The executable, or a full path.">
            <TextInput value={command} placeholder="opencode" disabled={busy} onChange={setCommand} />
          </Field>
        </FieldGrid>
        <div className="pane-actions">
          <button
            disabled={busy || name.trim().length === 0 || command.trim().length === 0}
            onClick={() => {
              onAdd({ name: name.trim(), command: command.trim() }, layer);
              setName("");
              setCommand("");
            }}
          >
            Add it
          </button>
        </div>
      </div>
    </Disclosure>
  );
}
