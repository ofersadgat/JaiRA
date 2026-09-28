import { useContext, useState, type JSX } from "react";
import { View } from "@tamagui/core";
import { SECRET_SOURCE_LABELS, SECRET_TARGET_LABELS, type ForgeCheck, type JairaForgeConnection, type SecretTarget } from "@jaira/shared/browser";
import { layerWriter } from "@jaira/ui/configWriter";
import { BUILTIN_FORGE_SCHEMA, CUSTOM_FORGE_SCHEMA, NEW_FORGE_SCHEMA, forgeRowOf, forgesOf, gitToolsSentence, newForgeOf, secretTargetsOf, stateWord } from "@jaira/ui/connectionsModel";
import type { IntegrationsPaneProps } from "@jaira/ui/integrationsPane";
import { Press, Txt } from "../../../primitives";
import { SchemaForm } from "../../form/SchemaForm";
import { Code, Hint, PaneActions } from "../bits";
import { Button } from "../Button";
import { SelectInput, TextField } from "../fields";
import { SettingsLayerContext } from "../layers";
import { AddBox, CardActions, ConnRow, ConnRows, EntryBox, Facts, KeyBox, LoginCardBox, LoginMark, Problem, RowControls, RowHead, Say, SmallButton, SplitAddBox, Tag, WaitingBox, Who, Wide } from "./Row";

/**
 * `integrationsPane.tsx`'s forge rows of Connections, universal (decision 0015): one row per
 * connection — who it acts as, the + box to sign in with the forge or paste a token — then "Another
 * host". What each says and writes is `connectionsModel.ts`'s; every typed field is the schema form.
 * The rule it adds:
 *
 *   .cfg-login-top       a forge's login card: row, centred, space-between, 2 below — the mark and the
 *                        tag; the name and the facts under it
 *   .conn-tools-line     an opened row's first line, a `.cfg-hint` whose link takes its font
 */

/** The forges, as the card of Connections → Forges: one row per connection, then "Another host". */
export function ForgeRows(props: IntegrationsPaneProps): JSX.Element {
  const { config, layer, busy, editable, checks, onSave } = props;
  // The Just you view's "What you changed": only the connections the layer states, and no adding.
  const onlyStated = useContext(SettingsLayerContext)?.onlyStated === true;
  if (config === null) return <Hint card>The configuration could not be read.</Hint>;
  const doc = config[layer] as Record<string, unknown> | null;
  const forges = forgesOf(config);
  const locked = busy || !editable;
  const { set, stated } = layerWriter(doc, layer, onSave);
  const shown = Object.entries(forges).filter(([name]) => !onlyStated || stated(`integrations.forges.${name}`));
  return (
    <ConnRows>
      {shown.map(([name, connection], i) => (
        <ForgeRow key={`${layer}:${name}`} {...props} first={i === 0} name={name} connection={connection} check={checks.find((c) => c.name === name)} locked={locked} set={set} stated={stated} />
      ))}
      {onlyStated ? null : <AddHost first={shown.length === 0} forges={forges} locked={locked} set={set} />}
    </ConnRows>
  );
}

/** An opened forge row's first line: what uses this connection, and where those are governed. */
export function ForgeToolsLine({ onOpenTools }: { onOpenTools?: (() => void) | undefined }): JSX.Element {
  const { lead } = gitToolsSentence();
  const hint = { voice: "app", scale: 11 / 12.5, lineHeight: 1.4 } as const;
  return (
    <View flexDirection="row" flexWrap="wrap" alignItems="baseline">
      <Hint>{`${lead}, on `}</Hint>
      {onOpenTools !== undefined ? (
        <Press onPress={onOpenTools}>
          {({ hovered }) => (
            <Txt spec={{ ...hint, color: "accent" }} {...(hovered ? { textDecorationLine: "underline" } : {})}>
              Tools → Git
            </Txt>
          )}
        </Press>
      ) : (
        <Hint>Tools → Git</Hint>
      )}
    </View>
  );
}

function ForgeRow({
  first,
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
  first: boolean;
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
  const pending = oauth?.pending.get(name);

  const boxes = [
    identity !== undefined ? (
      <LoginCardBox key="who" active>
        <View flexDirection="row" alignItems="center" justifyContent="space-between" marginBottom={2}>
          <LoginMark initial={identity.login.charAt(0).toUpperCase()} />
          <Tag tone="accent">{viaOAuth ? "OAuth" : "token"}</Tag>
        </View>
        <Who>{identity.login}</Who>
        <Facts lines={[...(identity.scopes !== undefined && identity.scopes.length > 0 ? [identity.scopes.join(", ")] : []), ...(check?.credential ? [`${tokenName} · ${SECRET_SOURCE_LABELS[check.credential.source]}`] : [])]} />
        {oauth !== undefined ? (
          <CardActions>
            <SmallButton kind="ghost" disabled={locked} onPress={() => oauth.onDisconnect(name)}>
              Disconnect
            </SmallButton>
          </CardActions>
        ) : null}
      </LoginCardBox>
    ) : check?.credentialMissing !== undefined && connection.credential !== undefined ? (
      <KeyBox key="who" name={tokenName} facts={["not found anywhere"]} missing />
    ) : null,
    tokenOpen ? null : signingIn ? (
      <WaitingBox
        key="add"
        title="Finish in your browser"
        sub={
          pending !== undefined ? (
            <>
              Enter <Code spec={{ voice: "data", scale: 11 / 12, lineHeight: 1.3, color: "dim" }}>{pending}</Code>
            </>
          ) : undefined
        }
        onCancel={() => oauth?.onCancel(name)}
      />
    ) : (
      <SplitAddBox
        key="add"
        disabled={locked}
        {...(oauth !== undefined && connection.provider !== undefined ? { main: { title: identity !== undefined ? "Switch account" : `Sign in with ${label}`, onPress: () => oauth.onSignIn(name) } } : {})}
        link={{ text: oauth !== undefined ? "or paste a token" : check?.credential ? "Replace the token" : "Add a token", onPress: () => setTokenOpen(true) }}
      />
    ),
  ];

  const error = oauth?.errors.get(name);
  const wide = [
    error !== undefined ? (
      <Wide key="error">
        <Problem>{error}</Problem>
      </Wide>
    ) : null,
    tokenOpen ? (
      <Wide key="token">
        <TokenEntry connection={name} named={connection.credential} name={tokenName} layer={layer} busy={locked} secrets={secrets} hasProject={config !== null && config.projectFile.length > 0} onSave={onSaveToken} onClose={() => setTokenOpen(false)} />
      </Wide>
    ) : null,
    open ? (
      <Wide key="form" body>
        <ForgeToolsLine onOpenTools={onOpenTools} />
        <SchemaForm schema={builtin ? BUILTIN_FORGE_SCHEMA : CUSTOM_FORGE_SCHEMA} value={connection} onChange={(next) => set(path, next)} ctx={{ path, disabled: locked, isSet: stated, setAt: set }} />
        {builtin ? null : (
          <PaneActions>
            <Button kind="danger" disabled={locked || !stated(path)} title="delete this connection from the layer being edited" onPress={() => set(path, undefined)}>
              Remove
            </Button>
          </PaneActions>
        )}
      </Wide>
    ) : null,
  ];

  return (
    <ConnRow
      first={first}
      state={state}
      main={
        <>
          <RowHead brand={connection.provider} state={state} title={title} />
          <Say state={state} word={stateWord(state)} detail={check && state !== "off" && check.detail ? check.detail : undefined} fix={check && state !== "off" && check.fix ? check.fix : undefined} />
        </>
      }
      boxes={boxes}
      controls={
        <RowControls
          on={enabled}
          disabled={locked}
          label={enabled ? `stop using ${title}` : `use ${title} again`}
          // `undefined` REMOVES the key rather than writing `true`: on is the default.
          onToggle={(next) => set(`${path}.enabled`, next ? undefined : false)}
          open={open}
          title={title}
          onOpen={() => setOpen((v) => !v)}
        />
      }
      wide={wide}
    />
  );
}

/** Store a connection's token: the value goes straight to main and is never read back. */
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
  layer: IntegrationsPaneProps["layer"];
  busy: boolean;
  secrets: IntegrationsPaneProps["secrets"];
  hasProject: boolean;
  onSave: IntegrationsPaneProps["onSaveToken"];
  onClose: () => void;
}): JSX.Element {
  const targets = secretTargetsOf(secrets, hasProject);
  const [value, setValue] = useState("");
  const [target, setTarget] = useState<SecretTarget>(targets[0] ?? "base-env-local");
  return (
    <EntryBox>
      <Hint>
        Filed under <Code spec={{ voice: "data", scale: 11 / 12, lineHeight: 1.4, color: "dim" }}>{name}</Code>.
      </Hint>
      <TextField value={value} mono secure width="100%" placeholder={`the value of ${name} — empty clears it`} onChange={setValue} />
      <SelectInput value={target} options={targets.map((one) => [SECRET_TARGET_LABELS[one], one])} onChange={(v) => setTarget(v as SecretTarget)} fill />
      <PaneActions>
        <Button
          disabled={busy}
          onPress={() => {
            onSave({ connection, ...(named !== undefined ? { named } : {}), name, value, target, layer });
            setValue("");
            onClose();
          }}
        >
          Store the token
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
    </EntryBox>
  );
}

/** A self-hosted GitLab or a GitHub Enterprise Server: a host, a kind, and the name of a token. */
function AddHost({ first, forges, locked, set }: { first: boolean; forges: Record<string, JairaForgeConnection>; locked: boolean; set: (path: string, value: unknown) => void }): JSX.Element {
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
    <ConnRow
      first={first}
      state="unconfigured"
      main={
        <>
          <RowHead brand="+" state="unconfigured" title="Another host" />
          <Say state="unconfigured" word="not set up" detail="a self-hosted GitLab or GitHub Enterprise" />
        </>
      }
      boxes={[open ? null : <AddBox key="add" title="Add a host" sub="host, kind and a token" disabled={locked} onPress={() => setOpen(true)} />]}
      controls={null}
      wide={[
        open ? (
          <Wide key="form" body>
            <SchemaForm schema={NEW_FORGE_SCHEMA} value={draft} onChange={(next) => setDraft((next ?? {}) as Record<string, unknown>)} ctx={{ path: "", disabled: locked, hidePaths: true }} />
            {problem ? <Problem>{problem}</Problem> : null}
            <PaneActions>
              <Button kind="primary" disabled={locked} onPress={add}>
                Add it
              </Button>
              <Button
                kind="ghost"
                onPress={() => {
                  setOpen(false);
                  setProblem(null);
                }}
              >
                Cancel
              </Button>
            </PaneActions>
          </Wide>
        ) : null,
      ]}
    />
  );
}
