import { useContext, useState, type JSX } from "react";
import { View } from "@tamagui/core";
import {
  BUILTIN_GENERIC_AGENTS,
  SECRET_SOURCE_LABELS,
  SECRET_TARGET_LABELS,
  type AgentAccount,
  type EmbeddedWeightsReport,
  type LocalServerProbe,
  type ProbeResult,
  type SecretTarget,
  type WeightsFileCheck,
} from "@jaira/shared/browser";
import {
  emptyLevelWords,
  fieldControlOf,
  installPanelOf,
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
  updateOf,
  useProviderRow,
  weightsSize,
  type InstallPanelRow,
} from "@jaira/ui/connectionsModel";
import { checkCredentialName } from "@jaira/ui/executorConfig";
import { accountFor, useLimits } from "@jaira/ui/limitsStore";
import { providerBlockPath, type FieldSpec, type ProviderSpec } from "@jaira/ui/providerSpecs";
import { layerRowOf } from "@jaira/ui/settingsRows";
import type { ProvidersPaneProps } from "@jaira/ui/providersPaneTypes";
import { Txt } from "../../../primitives";
import { Field, FieldGrid, Level } from "../../form/Field";
import { FormInput, TextArea } from "../../form/inputs";
import { AccountAllowance, KeyUsage } from "../../usage/Figures";
import { Code, Hint, PaneActions, Stack } from "../bits";
import { Button } from "../Button";
import { SelectInput, TextField } from "../fields";
import { SettingsLayerContext } from "../layers";
import { CardActions, ConnRow, ConnRows, EntryBox, KeyBox, LoginCardBox, LoginMark, LogoutButton, Problem, RowControls, RowHead, Say, SmallButton, SplitAddBox, Spin, Tag, Version, WaitingBox, Who, Wide, AddBox } from "./Row";
import { ProbeHead, ProbeList, ProbeRow, RowButton, useColumn } from "./Probe";

/**
 * The provider rows of Connections: one row per model API and local model — what it is and whether
 * it works, who it connects as (its key, as boxes, with a + box to add one), its switch and its
 * chevron — and, opened, its own form. The agents' rows are `AgentRows.tsx`'s, built of the pieces
 * exported here (the login and key boxes, the install panel, the form). What each says and writes is
 * `connectionsModel.ts`'s.
 */

/** The providers drawn in the layer view being shown: on Just you, only those whose block the layer states. */
export function useShownSpecs(specs: ProviderSpec[]): ProviderSpec[] {
  const at = useContext(SettingsLayerContext);
  return specs.filter((spec) => {
    const blockPath = providerBlockPath(spec);
    return !layerRowOf(at, blockPath !== null ? [blockPath.join(".")] : ["agents.genericCli"]).hidden;
  });
}

/** One group of provider rows, as the card of a Connections section. */
export function ProviderRows(props: ProvidersPaneProps & { specs: ProviderSpec[] }): JSX.Element {
  const { config, routeProbes, executorProbes, layer, specs } = props;
  const shown = useShownSpecs(specs);
  if (config === null) return <Hint card>The configuration could not be read.</Hint>;
  const layerDoc = config[layer];
  return (
    <ConnRows>
      {shown.map((spec, i) => (
        <ProviderRow
          key={`${layer}:${spec.id}`}
          {...props}
          first={i === 0}
          spec={spec}
          probe={spec.family === "model" ? routeProbes[spec.id] : executorProbes[spec.id]}
          layerDoc={layerDoc}
          effective={config.effective}
        />
      ))}
    </ConnRows>
  );
}

/** The logins an agent holds, one box each, and the + box after them. */
export function LoginCards({
  agent,
  command,
  accounts,
  signingIn,
  busy,
  warn,
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
  /** The row is not signed in: the + box is where that is resolved. */
  warn: boolean;
  onSignIn: () => void;
  onCancel: () => void;
  onSignOut: () => void;
  onAddKey?: (() => void) | undefined;
}): JSX.Element[] {
  const several = accounts.length > 1;
  const { binary, login } = loginCommandOf(agent, command);
  const add = loginAddWords(accounts);
  const renewing = accounts.some((account) => account.refused !== undefined);
  const boxes = accounts.map((account, i) => (
    <LoginCard key={`${account.label}:${i}`} agent={agent} account={account} binary={binary} tagged={several && account.active} signingIn={signingIn} busy={busy} onSignIn={onSignIn} onCancel={onCancel} onSignOut={onSignOut} />
  ));
  if (!renewing) {
    boxes.push(
      signingIn ? (
        <WaitingBox
          key="add"
          title="Finish in your browser"
          sub={
            <>
              Nothing opened? Run <Code spec={{ voice: "data", scale: 11 / 12, lineHeight: 1.3, color: "dim" }}>{login}</Code>.
            </>
          }
          onCancel={onCancel}
        />
      ) : (
        <SplitAddBox
          key="add"
          warn={warn}
          disabled={busy}
          main={{ title: add.title, onPress: onSignIn }}
          {...(onAddKey !== undefined ? { link: { text: "or an API key", onPress: onAddKey } } : { sub: add.sub })}
        />
      ),
    );
  }
  return boxes;
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
  // Logging out is the CLI's own, so it is machine-wide — asked once, in place, rather than in a dialog.
  const [confirming, setConfirming] = useState(false);
  const refused = account.refused !== undefined;
  // The allowance is the ACCOUNT's, and the account is whoever is signed in now.
  const limits = useLimits();
  const allowance = account.active ? accountFor(limits, agent) : undefined;
  return (
    <LoginCardBox active={tagged} refused={refused}>
      <View flexDirection="row" alignItems="center" gap={8} minWidth={0}>
        <LoginMark initial={account.label.charAt(0).toUpperCase()} />
        <Who grow>{account.label}</Who>
        {refused ? <Tag tone="warn">refused</Tag> : tagged ? <Tag tone="accent">in use</Tag> : null}
        {signingIn || confirming ? null : <LogoutButton title={`Log out — signs ${binary} out on this computer`} disabled={busy} onPress={() => setConfirming(true)} />}
      </View>
      <AccountAllowance account={allowance} plan={loginFacts(account).join(" · ")} />
      {refused ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }}>{`The last run's call was refused: ${account.refused}`}</Txt> : null}
      {confirming ? (
        <View flexDirection="column" gap={2} marginTop="auto" paddingTop={8}>
          <Txt spec={{ voice: "app", scale: 11 / 12.5 }}>
            Sign <Code spec={{ voice: "data", scale: 11 / 12, color: "text" }}>{binary}</Code> out on this computer? Its terminal sessions lose this login too.
          </Txt>
          <CardActions>
            <SmallButton
              kind="primary"
              disabled={busy}
              onPress={() => {
                setConfirming(false);
                onSignOut();
              }}
            >
              Log out
            </SmallButton>
            <SmallButton kind="ghost" onPress={() => setConfirming(false)}>
              Keep
            </SmallButton>
          </CardActions>
        </View>
      ) : (
        <CardActions>
          {refused && signingIn ? (
            <>
              <View flexDirection="row" alignItems="center" gap={6} role="status">
                <Spin />
                <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>Finish signing in in your browser</Txt>
              </View>
              <SmallButton kind="ghost" onPress={onCancel}>
                Cancel
              </SmallButton>
            </>
          ) : refused ? (
            <SmallButton kind="primary" disabled={busy} onPress={onSignIn}>
              Sign in again
            </SmallButton>
          ) : null}
        </CardActions>
      )}
    </LoginCardBox>
  );
}

function ProviderRow(
  props: ProvidersPaneProps & {
    first: boolean;
    spec: ProviderSpec;
    probe: ProbeResult | undefined;
    layerDoc: unknown;
    effective: unknown;
  },
): JSX.Element {
  const { first, spec, probe, busy, layer, secrets, config, onRemove, onSaveCredential, signingIn, onSignIn, onCancelSignIn, onSignOut, installing, onInstall, onCancelInstall, onUseCommand, localServers, onScanLocal, scanningLocal, weights } = props;
  const [open, setOpen] = useState(false);
  const row = useProviderRow(props);
  const { merged, locked, enabled, state, write } = row;
  // The key's store form opens under the row, across its width, from the key box on the right.
  const [keyOpen, setKeyOpen] = useState(false);
  const agentLogins = probe?.accounts !== undefined && state !== "off";
  // How the agent got here and what installs or updates it — for claude and codex, while they are on.
  const install = state !== "off" ? probe?.install : undefined;
  const running = installing.has(spec.id);
  const installPanel = installPanelOf(install);
  const update = updateOf(install);

  const boxes = [
    ...(agentLogins
      ? LoginCards({
          agent: spec.id,
          command: typeof merged["command"] === "string" ? merged["command"] : undefined,
          accounts: probe!.accounts!,
          signingIn: signingIn.has(spec.id),
          busy,
          warn: state === "needs-sign-in",
          onSignIn: () => onSignIn(spec.id),
          onCancel: () => onCancelSignIn(spec.id),
          onSignOut: () => onSignOut(spec.id),
          ...(spec.credential !== "none" && !keyOpen ? { onAddKey: () => setKeyOpen(true) } : {}),
        })
      : []),
    ...KeyBoxes({ spec, probe, merged, busy: locked, open: keyOpen || agentLogins, warn: state === "needs-sign-in", onOpen: () => setKeyOpen(true) }),
  ];

  const wide = [
    installPanel !== undefined ? (
      <Wide key="install">
        <InstallPanel
          panel={installPanel}
          running={running}
          busy={busy}
          locked={locked}
          onInstall={(method) => onInstall(spec.id, method)}
          onCancel={() => onCancelInstall(spec.id)}
          onUse={(path) => onUseCommand(spec.id, path)}
        />
      </Wide>
    ) : null,
    keyOpen ? (
      <Wide key="key">
        <KeyEntry spec={spec} merged={merged} layer={layer} busy={locked} secrets={secrets} hasProject={config !== null && config.projectFile.length > 0} onSave={onSaveCredential} onClose={() => setKeyOpen(false)} />
      </Wide>
    ) : null,
    spec.id === "local" && localServers !== undefined ? (
      <Wide key="local">
        <LocalServers found={localServers} locked={locked} scanning={scanningLocal === true} onScan={onScanLocal} onUse={(baseURL) => write({ baseURL })} />
      </Wide>
    ) : null,
    spec.id === "embedded" ? (
      <Wide key="weights">
        <EmbeddedWeights weights={weights} merged={merged} locked={locked} write={write} />
      </Wide>
    ) : null,
    open ? (
      // The row's own form: what is in it is this provider's, drawn whole once the row is.
      <SettingsLayerContext.Provider key="form" value={null}>
        <Wide body>
          <ProviderForm spec={spec} row={row} layer={layer} onRemove={onRemove} />
        </Wide>
      </SettingsLayerContext.Provider>
    ) : null,
  ];

  return (
    <ConnRow
      first={first}
      state={state}
      main={
        <>
          <RowHead brand={spec.id} state={state} title={spec.title} />
          <Say state={state} word={providerSayState(probe, state)} detail={probe && state !== "off" && probe.detail ? probe.detail : undefined} fix={probe && state !== "off" && probe.fix ? probe.fix : undefined} />
          {probe?.version ? (
            <Version after={update !== undefined ? <UpdateAfter via={update.via} title={update.title} running={running} disabled={busy} onUpdate={() => onInstall(spec.id)} onCancel={() => onCancelInstall(spec.id)} /> : undefined}>{probe.version}</Version>
          ) : null}
        </>
      }
      boxes={boxes}
      controls={
        <RowControls
          on={enabled}
          disabled={locked}
          label={enabled ? `stop using ${spec.title} in this project` : `use ${spec.title} again`}
          // `undefined` REMOVES the key rather than writing `true`: on is the default.
          onToggle={(next) => write({ enabled: next ? undefined : false })}
          open={open}
          title={spec.title}
          onOpen={() => setOpen((v) => !v)}
        />
      }
      wide={wide}
    />
  );
}

/**
 * A provider's own form, as a row opens it: its description, a band per level of what it is with that
 * level's fields, the empty-box note, a problem, and Save, Revert and — for a CLI someone added — Remove.
 */
export function ProviderForm({ spec, row, layer, onRemove }: { spec: ProviderSpec; row: ReturnType<typeof useProviderRow>; layer: ProvidersPaneProps["layer"]; onRemove: ProvidersPaneProps["onRemove"] }): JSX.Element {
  const { here, merged, form, setForm, problem, locked, dirty, save, revert } = row;
  return (
    <>
      <Hint>{spec.hint}</Hint>
      {spec.levels.map((level, depth) => {
        const fieldsHere = levelFieldsOf(spec, level.fields);
        return (
          <Level key={level.title} title={level.title} hint={level.hint} depth={depth + 1}>
            {fieldsHere.length === 0 ? (
              <Hint>{emptyLevelWords(level.fields)}</Hint>
            ) : (
              <FieldGrid>
                {fieldsHere.map((field) => (
                  <Field key={field.path} label={field.label} param={paramOf(spec, field)} hint={field.hint} set={readAt(here, field.path) !== undefined}>
                    <FieldControl field={field} value={form[field.path] ?? ""} placeholder={placeholderFor(field, merged)} disabled={locked} onChange={(v) => setForm((f) => ({ ...f, [field.path]: v }))} />
                  </Field>
                ))}
              </FieldGrid>
            )}
          </Level>
        );
      })}
      <Hint>An empty box removes the setting from this layer, so it goes back to whatever the other layer or the built-in default says.</Hint>
      {problem ? <Problem>{problem}</Problem> : null}
      <PaneActions>
        <Button kind="primary" onPress={save} disabled={locked || !dirty}>
          Save
        </Button>
        <Button kind="ghost" onPress={revert} disabled={!dirty}>
          Revert
        </Button>
        {spec.location.kind === "agent" && spec.location.executorKind === "generic" && BUILTIN_GENERIC_AGENTS[spec.id] === undefined ? (
          <Button kind="danger" disabled={locked} title="delete this CLI from the layer being edited — a built-in can only be turned off" onPress={() => onRemove(spec.id, layer)}>
            Remove
          </Button>
        ) : null}
      </PaneActions>
    </>
  );
}

/** After an agent's version: how it was installed, and Update — or, while it runs, that it does and Cancel. */
export function UpdateAfter({ via, title, running, disabled, onUpdate, onCancel }: { via: string; title: string; running: boolean; disabled: boolean; onUpdate: () => void; onCancel: () => void }): JSX.Element {
  const words = { voice: "app", scale: 11 / 12.5, color: "dim" } as const;
  return running ? (
    <View flexDirection="row" alignItems="center" gap={6} role="status">
      <Spin />
      <Txt spec={words}>{`updating with ${via}…`}</Txt>
      <SmallButton kind="ghost" onPress={onCancel}>
        Cancel
      </SmallButton>
    </View>
  ) : (
    <View flexDirection="row" alignItems="center" gap={6}>
      <Txt spec={words}>{via}</Txt>
      <SmallButton kind="ghost" disabled={disabled} onPress={onUpdate} title={title}>
        Update
      </SmallButton>
    </View>
  );
}

/**
 * Under an agent whose binary will not run here: the ways to install it, each with the command it runs,
 * the reinstall of what is left of one, or the path it was found at to use. The command is shown before
 * it runs — it downloads and installs a program — and while one runs, the head says so with Cancel.
 */
export function InstallPanel({
  panel,
  running,
  busy,
  locked,
  onInstall,
  onCancel,
  onUse,
}: {
  panel: { head: string; right: string; rows: InstallPanelRow[] };
  running: boolean;
  busy: boolean;
  locked: boolean;
  onInstall: (method: InstallPanelRow["method"]) => void;
  onCancel: () => void;
  onUse: (path: string) => void;
}): JSX.Element {
  const last = useColumn();
  return (
    <ProbeList>
      <ProbeHead
        left={panel.head}
        right={running ? "installing — this can take a minute…" : panel.right}
        {...(running ? { action: { label: "Cancel", title: "stop the installer", disabled: false, onPress: onCancel } } : {})}
      />
      {panel.rows.map((row) => (
        <ProbeRow
          key={row.key}
          id={row.key}
          weights
          name={row.name}
          at={
            <Txt spec={{ voice: "data", scale: 11 / 12 }} numberOfLines={1} {...({ title: row.at } as object)}>
              {row.at}
            </Txt>
          }
          nameWidth={130}
          last={last}
          end={
            <RowButton
              disabled={row.path !== undefined ? locked : busy || running}
              title={row.title}
              onPress={() => (row.path !== undefined ? onUse(row.path) : onInstall(row.method))}
            >
              {row.button}
            </RowButton>
          }
        />
      ))}
    </ProbeList>
  );
}

function FieldControl({ field, value, placeholder, disabled, onChange }: { field: FieldSpec; value: string; placeholder: string; disabled: boolean; onChange: (v: string) => void }): JSX.Element {
  const control = fieldControlOf(field);
  if (control.kind === "select") return <SelectInput value={value} options={field.options ?? []} disabled={disabled} onChange={onChange} fill />;
  if (control.kind === "area") return <TextArea value={value} rows={control.rows} placeholder={placeholder} disabled={disabled} onChange={onChange} />;
  return <FormInput value={value} placeholder={placeholder} disabled={disabled} mono={control.mono} onChange={onChange} />;
}

/** A provider's key, as boxes: the key it names (and where it was found, or that it was not), then the + box. */
export function KeyBoxes({ spec, probe, merged, busy, open, warn, onOpen }: { spec: ProviderSpec; probe: ProbeResult | undefined; merged: Record<string, unknown>; busy: boolean; open: boolean; warn: boolean; onOpen: () => void }): JSX.Element[] {
  if (spec.credential === "none") return [];
  const { named, plusTitle, plusSub } = keyBoxWords(spec, merged);
  const boxes: JSX.Element[] = [];
  if (named !== undefined) {
    boxes.push(
      <KeyBox
        key="key"
        name={named}
        missing={Boolean(probe?.credentialMissing)}
        facts={[...(probe?.credential ? [`in ${SECRET_SOURCE_LABELS[probe.credential.source]}`] : []), ...(probe?.credentialMissing ? ["not found anywhere"] : [])]}
      >
        {/* What the key has spent — a credit's dollars used, or the last seven days. Never what is left. */}
        {probe?.credentialMissing ? null : <RouteKeyUsage route={spec.id} />}
      </KeyBox>,
    );
  }
  if (!open) boxes.push(<AddBox key="add" title={plusTitle} sub={plusSub} disabled={busy} warn={warn} onPress={onOpen} />);
  return boxes;
}

/** `KeyUsage` on a route's key: its account, from the limits store. */
function RouteKeyUsage({ route }: { route: string }): JSX.Element | null {
  const limits = useLimits();
  return <KeyUsage account={accountFor(limits, route)} />;
}

/** Store a provider's key: its name (when nothing names one), its value, and the store it goes to. */
export function KeyEntry({
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
  layer: ProvidersPaneProps["layer"];
  busy: boolean;
  secrets: ProvidersPaneProps["secrets"];
  hasProject: boolean;
  onSave: ProvidersPaneProps["onSaveCredential"];
  onClose: () => void;
}): JSX.Element {
  const targets = secretTargetsOf(secrets, hasProject);
  const [value, setValue] = useState("");
  const [typedName, setTypedName] = useState("");
  const [target, setTarget] = useState<SecretTarget>(targets[0] ?? "base-env-local");
  const [problem, setProblem] = useState<string | null>(null);
  const { named, name, needsName } = keyEntryName(spec, merged, typedName);
  const code = { voice: "data", scale: 11 / 12, lineHeight: 1.4, color: "dim" } as const;
  return (
    <EntryBox>
      <Hint>
        {named !== undefined ? (
          <>
            Replaces the value of <Code spec={code}>{named}</Code>.
          </>
        ) : (
          <>
            Storing one also writes the name <Code spec={code}>{name || "…"}</Code> into this layer, so it is actually looked up.
          </>
        )}
      </Hint>
      {needsName ? (
        <Field label="Secret name" param="credential" hint="What this key is filed under. Config stores this NAME; the value goes to the store you pick below.">
          <FormInput value={typedName} mono placeholder="LOCAL_API_KEY" onChange={setTypedName} />
        </Field>
      ) : null}
      <TextField value={value} mono secure width="100%" placeholder={`the value of ${name || "the secret"} — empty clears it`} onChange={setValue} />
      <SelectInput value={target} options={targets.map((one) => [SECRET_TARGET_LABELS[one], one])} onChange={(v) => setTarget(v as SecretTarget)} fill />
      <PaneActions>
        <Button
          disabled={busy || name.length === 0}
          onPress={() => {
            try {
              checkCredentialName(name);
            } catch (e) {
              setProblem((e as Error).message);
              return;
            }
            onSave({ executor: keyEntryExecutor(spec, named), name, value, target, layer });
            setValue("");
            setTypedName("");
            onClose();
          }}
        >
          Store the key
        </Button>
        <Button
          kind="ghost"
          onPress={() => {
            setValue("");
            onClose();
          }}
        >
          Cancel
        </Button>
      </PaneActions>
      {problem ? <Problem>{problem}</Problem> : null}
    </EntryBox>
  );
}

/**
 * The OpenAI-compatible servers answering on the usual local ports. The one the route points at says
 * so; any other that answers is one click from being it.
 */
export function LocalServers({ found, locked, scanning = false, onScan, onUse }: { found: LocalServerProbe[]; locked: boolean; scanning?: boolean; onScan?: (() => void) | undefined; onUse: (baseURL: string) => void }): JSX.Element {
  const last = useColumn();
  return (
    <ProbeList>
      <ProbeHead
        left={
          <>
            Asked the usual ports for a model list (<Code spec={{ voice: "data", scale: 11 / 12, color: "dim" }}>GET /v1/models</Code>)
          </>
        }
        right={scanning ? "asking now…" : "when this page opens"}
        {...(onScan !== undefined ? { action: { label: "Scan again", title: "Ask the usual ports again — for a server started since", disabled: scanning, onPress: onScan } } : {})}
      />
      {found.map((server) => (
        <ProbeRow
          key={server.baseURL}
          up={server.up}
          inUse={server.inUse}
          name={server.name}
          at={localServerSaid(server)}
          nameWidth={130}
          last={last}
          end={server.inUse ? <Tag tone="accent">in use</Tag> : server.up ? <RowButton disabled={locked} onPress={() => onUse(server.baseURL)}>Use</RowButton> : null}
        />
      ))}
    </ProbeList>
  );
}

/** The embedded route's weights, and whether the loader is installed. */
function EmbeddedWeights({ weights, merged, locked, write }: { weights: EmbeddedWeightsReport | undefined; merged: Record<string, unknown>; locked: boolean; write: (patch: Record<string, unknown>) => void }): JSX.Element {
  return (
    <>
      {weights !== undefined && !weights.loader.installed ? (
        <Hint color="warn" marginLeft={30} marginBottom={6}>
          <Code spec={{ voice: "data", scale: 11 / 12, lineHeight: 1.4, color: "warn" }}>{weights.loader.module}</Code> is not installed, so no weights can be loaded{weights.loader.error !== undefined ? ` — ${weights.loader.error}` : ""}.
        </Hint>
      ) : null}
      <WeightsRows
        weights={(merged["weights"] ?? {}) as Record<string, { modelPath?: string }>}
        checks={weights?.weights}
        locked={locked}
        onChange={(next) => write({ weights: Object.keys(next).length === 0 ? undefined : next })}
      />
    </>
  );
}

/** The embedded route's weights, one row per model id: the id, the GGUF it loads, and whether the file is there. */
export function WeightsRows({ weights, checks, locked, onChange }: { weights: Record<string, { modelPath?: string }>; checks: WeightsFileCheck[] | undefined; locked: boolean; onChange: (next: Record<string, { modelPath?: string }>) => void }): JSX.Element {
  const [id, setId] = useState("");
  const [path, setPath] = useState("");
  const entries = Object.entries(weights);
  const tag = useColumn();
  const button = useColumn();
  return (
    <ProbeList weights>
      {entries.length === 0 ? <Hint paddingVertical={6} paddingHorizontal={10}>No weights named yet — add a model id and the .gguf it loads.</Hint> : null}
      {entries.map(([modelId, entry], i) => {
        const check = checks?.find((c) => c.id === modelId);
        return (
          <ProbeRow
            key={modelId}
            id={modelId}
            weights
            first={i === 0}
            name={<Txt spec={{ voice: "data", scale: 11.5 / 12.5 * (12.5 / 12) }} numberOfLines={1}>{modelId}</Txt>}
            at={entry.modelPath ?? "—"}
            nameWidth={150}
            last={tag}
            end={
              check === undefined ? (
                <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>not checked</Txt>
              ) : check.exists ? (
                <Tag tone="ok">{`found${check.sizeBytes !== undefined ? ` · ${weightsSize(check.sizeBytes)}` : ""}`}</Tag>
              ) : (
                <Tag tone="bad">{check.error ?? "file missing"}</Tag>
              )
            }
            after={button}
            afterEnd={
              <RowButton
                disabled={locked}
                title={`stop serving ${modelId}`}
                onPress={() => {
                  const next = { ...weights };
                  delete next[modelId];
                  onChange(next);
                }}
              >
                Remove
              </RowButton>
            }
          />
        );
      })}
      <ProbeRow
        id=" add"
        weights
        first={false}
        name={<FormInput value={id} mono placeholder="model id" disabled={locked} onChange={setId} />}
        at={<FormInput value={path} mono placeholder="/models/name.gguf" disabled={locked} onChange={setPath} />}
        nameWidth={150}
        last={tag}
        end={null}
        after={button}
        afterEnd={
          <RowButton
            disabled={locked || id.trim().length === 0 || path.trim().length === 0 || weights[id.trim()] !== undefined}
            onPress={() => {
              onChange({ ...weights, [id.trim()]: { modelPath: path.trim() } });
              setId("");
              setPath("");
            }}
          >
            Add
          </RowButton>
        }
      />
    </ProbeList>
  );
}

/** Declare a new agent CLI in the layer being edited (DESIGN §8.1's `generic-cli`) — what the shelf's last tile opens. */
export function AddAgentForm({ layer, busy, onAdd, onClose }: { layer: ProvidersPaneProps["layer"]; busy: boolean; onAdd: ProvidersPaneProps["onAdd"]; onClose: () => void }): JSX.Element {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  return (
    <Stack>
      <Hint>
        It is registered under the name you give it, which is what a state&apos;s <Code>function</Code> then names and what a model prefix routes to. It enforces no permissions of its own, so while JaiRA&apos;s built-in refusals are on (Settings → Tools → bash) a run will refuse to hand it a state.
      </Hint>
      <FieldGrid>
        <Field label="Registry name" param="agents.genericCli[].name" hint="How a workflow will name it.">
          <FormInput value={name} placeholder="aider" disabled={busy} onChange={setName} />
        </Field>
        <Field label="Command" param="agents.genericCli[].command" hint="The executable, or a full path.">
          <FormInput value={command} placeholder="aider" disabled={busy} onChange={setCommand} />
        </Field>
      </FieldGrid>
      <PaneActions>
        <Button
          kind="primary"
          disabled={busy || name.trim().length === 0 || command.trim().length === 0}
          onPress={() => {
            onAdd({ name: name.trim(), command: command.trim() }, layer);
            setName("");
            setCommand("");
            onClose();
          }}
        >
          Add it
        </Button>
        <Button kind="ghost" onPress={onClose}>
          Cancel
        </Button>
      </PaneActions>
    </Stack>
  );
}
