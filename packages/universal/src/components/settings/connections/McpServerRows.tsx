import { useContext, useState, type JSX } from "react";
import { View } from "@tamagui/core";
import { SECRET_SOURCE_LABELS, SECRET_TARGET_LABELS, mcpSecretsOf, mcpServerEnabled, type McpServerConfig, type McpServerStatus, type SecretTarget } from "@jaira/shared/browser";
import { layerWriter } from "@jaira/ui/configWriter";
import {
  NEW_SERVER_SCHEMA,
  effectiveServers,
  foundServersOf,
  layerDocument,
  lookedInOf,
  mcpActionOf,
  mcpChipOf,
  mcpDetail,
  mcpRowState,
  mcpWord,
  newServerOf,
  schemaGistOf,
  secretTargetsOf,
  serverSchemaOf,
  unacceptedClaims,
  withServersAdded,
} from "@jaira/ui/connectionsModel";
import { countsAsWords } from "@jaira/ui/mcpBucketModel";
import type { McpServerRowsProps } from "@jaira/ui/mcpServersRowsTypes";
import { SchemaForm } from "../../form/SchemaForm";
import { Code, Hint, PaneActions, Stack } from "../bits";
import { Button } from "../Button";
import { Switch } from "../controls";
import { SelectInput, TextField } from "../fields";
import { SettingsLayerContext } from "../layers";
import { SettingsGroup } from "../SettingsPage";
import { ActionSlot, LabelledBoxes, RowLine, RunsAs, SettingsFold } from "./Closed";
import { AddBox, Chevron, ConnRow, ConnRows, EntryBox, KeyBox, Problem, RowHead, Say, Wide } from "./Row";
import { AnotherTile, Shelf, ShelfCard, Tile } from "./Shelf";

/**
 * Connections → MCP servers (the person, 2026-11-17, "MCP A"): the configured servers as rows closed
 * to a line — how each is reached and what it listed, the one button that would make it work (accept
 * what its tools say they count as, store the secret it is not sent) or the chip of the secret it is
 * sent, its switch and its chevron — then the shelf "Found on this machine": a tile per server another
 * tool runs that is not added here, and "Another server" last. What each says and writes is
 * `connectionsModel.ts`'s (`mcpActionOf`, `mcpChipOf`, `foundServersOf`); the pieces are `Closed.tsx`'s
 * and `Shelf.tsx`'s.
 */
export function McpServerRows(props: McpServerRowsProps): JSX.Element {
  const { config, layer, busy, editable, mcp, onSave } = props;
  // The Just you view's "What you changed": only the servers the layer states, and no adding.
  const onlyStated = useContext(SettingsLayerContext)?.onlyStated === true;
  if (config === null) {
    return (
      <SettingsGroup>
        <Hint card>The configuration could not be read.</Hint>
      </SettingsGroup>
    );
  }
  const doc = layerDocument(config, layer);
  const servers = effectiveServers(config);
  const locked = busy || !editable;
  const { set, stated } = layerWriter(doc, layer, onSave);
  // One write for the lot: the layer's own document with the new servers in it.
  const addAll = (entries: ReadonlyArray<{ name: string; config: McpServerConfig }>): void => onSave(layer, withServersAdded(doc, servers, entries));
  const shown = Object.entries(servers).filter(([name]) => !onlyStated || stated(`mcp.servers.${name}`));
  return (
    <>
      {shown.length > 0 || mcp.problem !== null ? (
        <SettingsGroup>
          <ConnRows>
            {shown.map(([name, server], i) => (
              <McpServerRow key={`${layer}:${name}`} {...props} first={i === 0} name={name} server={server} status={mcp.report?.servers.find((s) => s.name === name)} locked={locked} set={set} stated={stated} />
            ))}
          </ConnRows>
          {mcp.problem !== null ? (
            <View paddingVertical={13} paddingHorizontal={16}>
              <Problem>{mcp.problem}</Problem>
            </View>
          ) : null}
        </SettingsGroup>
      ) : null}
      {onlyStated ? null : <FoundShelf servers={servers} detected={mcp.detected} locked={locked} set={set} onAdd={addAll} />}
    </>
  );
}

function McpServerRow({
  first,
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
  first: boolean;
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
  // What the server's tools say themselves they count as, and nobody has accepted yet (decision 0019, ruling 5).
  const claims = unacceptedClaims(server, status);
  const accept = (picked: typeof claims): void => set(`${path}.tools`, { ...(server.tools ?? {}), ...Object.fromEntries(picked.map((one) => [one.tool, one.claim])) });
  const action = mcpActionOf(enabled, server, status);
  const chip = mcpChipOf(enabled, status);
  const detail = mcpDetail(enabled, server, status);
  const schema = serverSchemaOf(server, status);

  const slot = open ? null : action !== undefined ? (
    <ActionSlot
      action={action}
      waiting={undefined}
      disabled={locked}
      onPress={() => {
        setOpen(true);
        if (action.kind === "secret") setStoring(true);
      }}
    />
  ) : chip !== undefined ? (
    <RunsAs chip={chip} />
  ) : null;

  const boxes = [
    ...credentials.map((secret) => {
      const origin = secret.origin;
      const missing = status !== undefined && origin === undefined;
      return (
        <KeyBox
          key={`${secret.field}:${secret.key}`}
          name={secret.credential}
          missing={missing}
          facts={[`${secret.field === "env" ? "env" : "header"} ${secret.key}`, ...(origin !== undefined ? [`in ${SECRET_SOURCE_LABELS[origin.source]}`] : []), ...(missing ? ["not found anywhere"] : [])]}
        />
      );
    }),
    credentials.length === 0 || storing ? null : <AddBox key="add" title="Store a secret" sub={credentials.map((secret) => secret.credential).join(", ")} disabled={locked} onPress={() => setStoring(true)} />,
  ].filter((box) => box !== null);

  const wide = open
    ? [
        boxes.length > 0 ? (
          <Wide key="sends">
            <LabelledBoxes label="Sends">{boxes}</LabelledBoxes>
          </Wide>
        ) : null,
        storing ? (
          <Wide key="secret">
            <SecretEntry names={credentials.map((secret) => secret.credential)} busy={locked} secrets={secrets} hasProject={config !== null && config.projectFile.length > 0} onStore={(request) => void mcp.storeSecret(request)} onClose={() => setStoring(false)} />
          </Wide>
        ) : null,
        claims.length > 0 ? (
          <Wide key="claims" body>
            <Stack gap={6}>
              <Hint>
                {claims.length === 1 ? "One of its tools says" : "Some of its tools say"} what {claims.length === 1 ? "it counts" : "they count"} as among JaiRA's permissions. Nothing counts until you accept it: a server could say that a tool which deletes files only reads them.
              </Hint>
              {claims.map((one) => (
                <PaneActions key={one.tool}>
                  <Code>{one.tool}</Code>
                  <Hint>counts as {countsAsWords(one.claim)}</Hint>
                  <Button kind="ghost" disabled={locked} onPress={() => accept([one])}>
                    Accept
                  </Button>
                </PaneActions>
              ))}
              {claims.length > 1 ? (
                <PaneActions>
                  <Button kind="ghost" disabled={locked} onPress={() => accept(claims)}>
                    {`Accept all ${claims.length}`}
                  </Button>
                </PaneActions>
              ) : null}
            </Stack>
          </Wide>
        ) : null,
        // How it is reached, and — once it has listed them — what its tools count as.
        <SettingsFold key="form" gist={schemaGistOf(schema)}>
          <Stack>
            <SchemaForm schema={schema} value={server} onChange={(next) => set(path, next)} ctx={{ path, disabled: locked, isSet: stated, setAt: set }} />
            <PaneActions>
              <Button kind="danger" disabled={locked || !stated(path)} title="delete this server from the layer being edited" onPress={() => set(path, undefined)}>
                Remove
              </Button>
            </PaneActions>
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
          <RowHead brand={name} state={state} title={name} mono />
          {open ? <Say state={state} word={mcpWord(enabled, status)} detail={detail} fix={enabled && status?.fix ? status.fix : undefined} /> : <RowLine state={state} word={mcpWord(enabled, status)} rest={detail} />}
        </>
      }
      // An empty slot where there is nothing, so the switch keeps one column down the card.
      boxes={[slot ?? <View key="none" />]}
      controls={
        <>
          <Switch
            on={enabled}
            label={enabled ? `stop handing ${name} to agents` : `hand ${name} to agents again`}
            disabled={locked}
            // `undefined` REMOVES the key: on is the default, and a layer that says so says nothing.
            onChange={(next) => set(`${path}.enabled`, next ? undefined : false)}
          />
          <Chevron
            open={open}
            label={open ? `close ${name}` : `open ${name}`}
            tips={["Show more", "Show less"]}
            onPress={() => {
              if (open) setStoring(false);
              setOpen(!open);
            }}
          />
        </>
      }
      wide={wide}
    />
  );
}

/** Store a secret a server is sent: which of its names, the value, and the store. */
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
  secrets: McpServerRowsProps["secrets"];
  hasProject: boolean;
  onStore: (request: { name: string; value: string; target: SecretTarget }) => void;
  onClose: () => void;
}): JSX.Element {
  const targets = secretTargetsOf(secrets, hasProject);
  const [name, setName] = useState(names[0] ?? "");
  const [value, setValue] = useState("");
  const [target, setTarget] = useState<SecretTarget>(targets[0] ?? "base-env-local");
  return (
    <EntryBox>
      {names.length > 1 ? (
        <SelectInput value={name} options={names.map((n) => [n, n])} onChange={setName} fill />
      ) : (
        <Hint>
          Filed under <Code spec={{ voice: "data", scale: 11 / 12, lineHeight: 1.4, color: "dim" }}>{name}</Code>.
        </Hint>
      )}
      <TextField value={value} mono secure width="100%" placeholder={`the value of ${name} — empty clears it`} onChange={setValue} />
      <SelectInput value={target} options={targets.map((one) => [SECRET_TARGET_LABELS[one], one])} onChange={(v) => setTarget(v as SecretTarget)} fill />
      <PaneActions>
        <Button
          disabled={busy || name.length === 0}
          onPress={() => {
            onStore({ name, value, target });
            setValue("");
            onClose();
          }}
        >
          Store the secret
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

/**
 * "Found on this machine": a tile per server another tool runs and this configuration does not have —
 * none is started until it is added — then "Another server", which opens the form across the shelf; and
 * under them, where the page looked.
 */
function FoundShelf({
  servers,
  detected,
  locked,
  set,
  onAdd,
}: {
  servers: Record<string, McpServerConfig>;
  detected: McpServerRowsProps["mcp"]["detected"];
  locked: boolean;
  set: (path: string, value: unknown) => void;
  onAdd: (entries: ReadonlyArray<{ name: string; config: McpServerConfig }>) => void;
}): JSX.Element {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const found = foundServersOf(detected, servers);
  const looked = lookedInOf(detected);
  const close = (): void => {
    setAdding(false);
    setProblem(null);
  };
  const add = (): void => {
    // The parser main will run, run here first, so what is wrong is said beside the form (`newServerOf`).
    const made = newServerOf(draft, servers);
    if ("problem" in made) {
      setProblem(made.problem);
      return;
    }
    set(made.path, made.value);
    setDraft({});
    close();
  };
  return (
    <Shelf
      title="Found on this machine"
      sub={found.length > 0 ? "servers other tools already run — none is started until you add it" : undefined}
      across={
        <>
          {adding ? (
            <ShelfCard title="Another server" onClose={close}>
              <Hint>A command JaiRA starts (stdio), or a URL it calls (HTTP).</Hint>
              <SchemaForm schema={NEW_SERVER_SCHEMA} value={draft} onChange={(next) => setDraft((next ?? {}) as Record<string, unknown>)} ctx={{ path: "", disabled: locked, hidePaths: true }} />
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
          {looked !== undefined ? <Hint paddingHorizontal={4}>{looked}</Hint> : null}
        </>
      }
    >
      {found.map((one) => (
        <Tile key={one.name} title={one.name} sub={one.sub} button={{ label: "Add", title: `adds ${one.what}`, disabled: locked, onPress: () => onAdd([{ name: one.name, config: one.config }]) }} />
      ))}
      <AnotherTile title="Another server" sub="a command or an address" open={adding} onPress={() => (adding ? close() : setAdding(true))} />
    </Shelf>
  );
}
