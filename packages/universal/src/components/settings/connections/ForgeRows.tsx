import { useContext, useState, type JSX } from "react";
import { View } from "@tamagui/core";
import { SECRET_SOURCE_LABELS, SECRET_TARGET_LABELS, type ForgeCheck, type JairaForgeConnection, type SecretTarget } from "@jaira/shared/browser";
import { layerWriter } from "@jaira/ui/configWriter";
import { BUILTIN_FORGE_SCHEMA, CUSTOM_FORGE_SCHEMA, NEW_FORGE_SCHEMA, forgeActionOf, forgeChipOf, forgeLineOf, forgePlaceOf, forgeRowOf, forgesOf, gitToolsSentence, newForgeOf, schemaGistOf, secretTargetsOf, stateWord } from "@jaira/ui/connectionsModel";
import type { IntegrationsPaneProps } from "@jaira/ui/integrationsPaneTypes";
import { Txt } from "../../../primitives";
import { SchemaForm } from "../../form/SchemaForm";
import { Code, Hint, PaneActions, Stack } from "../bits";
import { Button } from "../Button";
import { Switch } from "../controls";
import { SelectInput, TextField } from "../fields";
import { SettingsLayerContext } from "../layers";
import { SettingsGroup } from "../SettingsPage";
import { ActionSlot, LabelledBoxes, RowLine, RunsAs, SettingsFold } from "./Closed";
import { CardActions, Chevron, ConnRow, ConnRows, EntryBox, Facts, KeyBox, LoginCardBox, LoginMark, Problem, RowHead, Say, SmallButton, SplitAddBox, Tag, WaitingBox, Who, Wide } from "./Row";
import { AnotherTile, Shelf, ShelfCard, Tile } from "./Shelf";

/**
 * Connections → Forges (the person, 2026-11-17, "Forges B"): the connections that act as someone — or
 * tried and were refused, or are turned off — as rows closed to a line: the token's scopes, the one
 * button that would make it work (sign in, again) or the chip of the account it acts as, its switch
 * and chevron; then the shelf "Not connected": a tile per connection with no token at all, signing in
 * from the tile, and "Another host" last. What each says and writes is `connectionsModel.ts`'s
 * (`forgePlaceOf`, `forgeLineOf`, `forgeActionOf`, `forgeChipOf`); every typed field is the schema form.
 * What it adds to the pieces (`Closed.tsx`, `Shelf.tsx`, `Row.tsx`):
 *
 *   a forge's login card   its top a row, centred, space-between, 2 below — the mark and the tag;
 *                          the name and the facts under it
 *   the tools line         an opened row's first line, a hint whose link takes its font
 *   the device code        across the shelf while a tile signs in: the code in the data face 18/12 500,
 *                          then what to do with it, and Cancel
 */

/** The forges: the card of the connected ones, and the shelf of the rest. */
export function ForgeRows(props: IntegrationsPaneProps): JSX.Element {
  const { config, layer, busy, editable, checks, onSave } = props;
  // The Just you view's "What you changed": only the connections the layer states, and no adding.
  const onlyStated = useContext(SettingsLayerContext)?.onlyStated === true;
  if (config === null) {
    return (
      <SettingsGroup>
        <Hint card>The configuration could not be read.</Hint>
      </SettingsGroup>
    );
  }
  const doc = config[layer] as Record<string, unknown> | null;
  const forges = forgesOf(config);
  const locked = busy || !editable;
  const { set, stated } = layerWriter(doc, layer, onSave);
  const shown = Object.entries(forges).filter(([name]) => !onlyStated || stated(`integrations.forges.${name}`));
  const checkOf = (name: string): ForgeCheck | undefined => checks.find((c) => c.name === name);
  const rows = shown.filter(([name, connection]) => forgePlaceOf(connection.enabled !== false, checkOf(name)) === "row");
  const tiles = shown.filter(([name, connection]) => forgePlaceOf(connection.enabled !== false, checkOf(name)) === "shelf");
  return (
    <>
      {rows.length > 0 ? (
        <SettingsGroup>
          <ConnRows>
            {rows.map(([name, connection], i) => (
              <ForgeRow key={`${layer}:${name}`} {...props} first={i === 0} name={name} connection={connection} check={checkOf(name)} locked={locked} set={set} stated={stated} />
            ))}
          </ConnRows>
        </SettingsGroup>
      ) : null}
      {onlyStated && tiles.length === 0 ? null : <ForgeShelf {...props} forges={forges} tiles={tiles} checkOf={checkOf} locked={locked} set={set} stated={stated} adding={!onlyStated} />}
    </>
  );
}

/** An opened forge row's first line: what uses this connection, and where those are governed. */
export function ForgeToolsLine({ onOpenTools }: { onOpenTools?: (() => void) | undefined }): JSX.Element {
  const { lead } = gitToolsSentence();
  return (
    <Hint>
      {`${lead}, on `}
      {onOpenTools !== undefined ? (
        // A link in the hint's own font, --accent.
        <Txt spec={{ voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "accent" }} onPress={onOpenTools} role="button">
          Tools → Git
        </Txt>
      ) : (
        "Tools → Git"
      )}
    </Hint>
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
  const row = forgeRowOf(name, connection, check, oauth);
  const { path, builtin, enabled, state, label, title, tokenName, identity, signingIn, viaOAuth } = row;
  const pending = oauth?.pending.get(name);
  const canSignIn = oauth !== undefined && connection.provider !== undefined;
  const line = forgeLineOf(state, check);
  const action = forgeActionOf(row, check, connection.host, canSignIn);
  const chip = forgeChipOf(row);

  const slot = open ? null : action !== undefined ? (
    <ActionSlot
      action={action}
      waiting={signingIn ? { words: pending !== undefined ? `enter ${pending} in your browser` : "finish in your browser", onCancel: () => oauth?.onCancel(name) } : undefined}
      disabled={locked}
      onPress={() => {
        if (action.kind === "sign-in") oauth?.onSignIn(name);
        else {
          setOpen(true);
          setTokenOpen(true);
        }
      }}
    />
  ) : chip !== undefined ? (
    <RunsAs chip={chip} />
  ) : null;

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
        {...(canSignIn ? { main: { title: identity !== undefined ? "Switch account" : `Sign in with ${label}`, onPress: () => oauth.onSignIn(name) } } : {})}
        link={{ text: oauth !== undefined ? "or paste a token" : check?.credential ? "Replace the token" : "Add a token", onPress: () => setTokenOpen(true) }}
      />
    ),
  ].filter((box) => box !== null);

  const error = oauth?.errors.get(name);
  const schema = builtin ? BUILTIN_FORGE_SCHEMA : CUSTOM_FORGE_SCHEMA;
  const wide = open
    ? [
        <Wide key="tools" body>
          <ForgeToolsLine onOpenTools={onOpenTools} />
        </Wide>,
        <Wide key="who">
          <LabelledBoxes label={identity !== undefined ? "Signed in as" : "Signs in as"}>{boxes}</LabelledBoxes>
        </Wide>,
        tokenOpen ? (
          <Wide key="token">
            <TokenEntry connection={name} named={connection.credential} name={tokenName} layer={layer} busy={locked} secrets={secrets} hasProject={config !== null && config.projectFile.length > 0} onSave={onSaveToken} onClose={() => setTokenOpen(false)} />
          </Wide>
        ) : null,
        <SettingsFold key="form" gist={schemaGistOf(schema)}>
          <Stack>
            <ForgeForm schema={schema} connection={connection} path={path} builtin={builtin} locked={locked} set={set} stated={stated} />
          </Stack>
        </SettingsFold>,
      ]
    : [];

  return (
    <ConnRow
      first={first}
      state={state}
      main={
        <>
          <RowHead brand={connection.provider} state={state} title={title} />
          {open ? (
            <Say state={state} word={stateWord(state)} detail={check && state !== "off" && check.detail ? check.detail : undefined} fix={check && state !== "off" && check.fix ? check.fix : undefined} />
          ) : (
            <RowLine state={state} word={line.word} rest={line.rest} />
          )}
        </>
      }
      // An empty slot where there is nothing, so the switch keeps one column down the card.
      boxes={[slot ?? <View key="none" />]}
      controls={
        <>
          <Switch
            on={enabled}
            label={enabled ? `stop using ${title}` : `use ${title} again`}
            disabled={locked}
            // `undefined` REMOVES the key rather than writing `true`: on is the default.
            onChange={(next) => set(`${path}.enabled`, next ? undefined : false)}
          />
          <Chevron
            open={open}
            label={open ? `close ${title}` : `open ${title}`}
            tips={["Show more", "Show less"]}
            onPress={() => {
              if (open) setTokenOpen(false);
              setOpen(!open);
            }}
          />
        </>
      }
      wide={[...(error !== undefined ? [<Wide key="error"><Problem>{error}</Problem></Wide>] : []), ...wide]}
    />
  );
}

/** A connection's own form, and — for one someone added — Remove. */
function ForgeForm({
  schema,
  connection,
  path,
  builtin,
  locked,
  set,
  stated,
}: {
  schema: typeof BUILTIN_FORGE_SCHEMA;
  connection: JairaForgeConnection;
  path: string;
  builtin: boolean;
  locked: boolean;
  set: (path: string, value: unknown) => void;
  stated: (path: string) => boolean;
}): JSX.Element {
  return (
    <>
      <SchemaForm schema={schema} value={connection} onChange={(next) => set(path, next)} ctx={{ path, disabled: locked, isSet: stated, setAt: set }} />
      {builtin ? null : (
        <PaneActions>
          <Button kind="danger" disabled={locked || !stated(path)} title="delete this connection from the layer being edited" onPress={() => set(path, undefined)}>
            Remove
          </Button>
        </PaneActions>
      )}
    </>
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

type Opened = { kind: "token" | "settings"; name: string } | { kind: "add" } | null;

/**
 * "Not connected": a tile per connection with no token — Sign in through the browser, or the other ways
 * under ▾ — and "Another host" last; across the shelf, the code a sign-in waits on, the token's entry, a
 * connection's settings, or the new host's form.
 */
function ForgeShelf({
  forges,
  tiles,
  checkOf,
  locked,
  set,
  stated,
  adding,
  layer,
  secrets,
  config,
  onSaveToken,
  oauth,
}: IntegrationsPaneProps & {
  forges: Record<string, JairaForgeConnection>;
  tiles: Array<[string, JairaForgeConnection]>;
  checkOf: (name: string) => ForgeCheck | undefined;
  locked: boolean;
  set: (path: string, value: unknown) => void;
  stated: (path: string) => boolean;
  adding: boolean;
}): JSX.Element {
  const [opened, setOpened] = useState<Opened>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const close = (): void => {
    setOpened(null);
    setProblem(null);
  };
  const add = (): void => {
    // Checked as main will check it, so what is wrong is said beside the form (`newForgeOf`).
    const made = newForgeOf(draft, forges);
    if ("problem" in made) {
      setProblem(made.problem);
      return;
    }
    set(made.path, made.value);
    setDraft({});
    close();
  };
  const openedName = opened !== null && opened.kind !== "add" ? opened.name : undefined;
  const openedConnection = openedName !== undefined ? forges[openedName] : undefined;
  const openedRow = openedName !== undefined && openedConnection !== undefined ? forgeRowOf(openedName, openedConnection, checkOf(openedName), oauth) : undefined;
  return (
    <Shelf
      title="Not connected"
      sub={tiles.length > 0 ? "a review opens as a merge request only where you are signed in" : undefined}
      across={
        <>
          {tiles.map(([name, connection]) => {
            const row = forgeRowOf(name, connection, checkOf(name), oauth);
            const error = oauth?.errors.get(name);
            const code = oauth?.pending.get(name);
            if (!row.signingIn && error === undefined) return null;
            return (
              <ShelfCard key={name} title={row.title} closeLabel="Cancel" onClose={() => oauth?.onCancel(name)}>
                {row.signingIn ? (
                  <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={14}>
                    {code !== undefined ? <Txt spec={{ voice: "data", scale: 18 / 12, weight: 500 }}>{code}</Txt> : null}
                    <Hint flexShrink={1}>{code !== undefined ? `Finish signing in in your browser — enter this code on the page that opened at ${connection.host}.` : `Finish signing in in your browser, at ${connection.host}.`}</Hint>
                  </View>
                ) : null}
                {error !== undefined ? <Problem>{error}</Problem> : null}
              </ShelfCard>
            );
          })}
          {opened?.kind === "token" && openedRow !== undefined && openedConnection !== undefined ? (
            <ShelfCard title={`${openedRow.title} — a token`} onClose={close}>
              <TokenEntry connection={opened.name} named={openedConnection.credential} name={openedRow.tokenName} layer={layer} busy={locked} secrets={secrets} hasProject={config !== null && config.projectFile.length > 0} onSave={onSaveToken} onClose={close} />
            </ShelfCard>
          ) : null}
          {opened?.kind === "settings" && openedRow !== undefined && openedConnection !== undefined ? (
            <ShelfCard title={`${openedRow.title} settings`} onClose={close}>
              <ForgeForm schema={openedRow.builtin ? BUILTIN_FORGE_SCHEMA : CUSTOM_FORGE_SCHEMA} connection={openedConnection} path={openedRow.path} builtin={openedRow.builtin} locked={locked} set={set} stated={stated} />
            </ShelfCard>
          ) : null}
          {opened?.kind === "add" ? (
            <ShelfCard title="Another host" onClose={close}>
              <Hint>A self-hosted GitLab or a GitHub Enterprise Server: its host, its kind, and the name of a token.</Hint>
              <SchemaForm schema={NEW_FORGE_SCHEMA} value={draft} onChange={(next) => setDraft((next ?? {}) as Record<string, unknown>)} ctx={{ path: "", disabled: locked, hidePaths: true }} />
              {problem ? <Problem>{problem}</Problem> : null}
              <PaneActions>
                <Button kind="primary" disabled={locked} onPress={add}>
                  Add it
                </Button>
                <Button kind="ghost" onPress={close}>
                  Cancel
                </Button>
              </PaneActions>
            </ShelfCard>
          ) : null}
        </>
      }
    >
      {tiles.map(([name, connection]) => {
        const row = forgeRowOf(name, connection, checkOf(name), oauth);
        const canSignIn = oauth !== undefined && connection.provider !== undefined;
        const signIn = { key: "sign-in", name: `Sign in with ${row.label}`, at: `opens ${connection.host} with a code to enter`, onPress: () => oauth?.onSignIn(name) };
        const paste = { key: "token", name: "Paste a token", at: `filed under ${row.tokenName}`, onPress: () => setOpened({ kind: "token", name }) };
        return (
          <Tile
            key={`${layer}:${name}`}
            brand={connection.provider}
            title={row.label}
            sub={connection.host}
            chosen={openedName === name}
            {...(row.signingIn ? { running: { words: "signing in — finish in your browser", onCancel: () => oauth?.onCancel(name) } } : {})}
            button={canSignIn ? { label: "Sign in", title: signIn.at, disabled: locked, onPress: signIn.onPress } : { label: "Add a token", title: paste.at, disabled: locked, onPress: paste.onPress }}
            ways={{
              label: `ways to connect ${row.title}`,
              title: `Connect ${row.title} with`,
              busy: locked,
              items: canSignIn ? [signIn, paste] : [paste],
              more: { label: "Its settings — host, token name, sign-in app…", onPress: () => setOpened({ kind: "settings", name }) },
            }}
          />
        );
      })}
      {adding ? <AnotherTile title="Another host" sub="self-hosted GitLab or GitHub Enterprise" open={opened?.kind === "add"} onPress={() => (opened?.kind === "add" ? close() : setOpened({ kind: "add" }))} /> : null}
    </Shelf>
  );
}
