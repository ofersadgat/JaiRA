import { useContext, useState, type JSX } from "react";
import { SECRET_SOURCE_LABELS, SECRET_TARGET_LABELS, isMcpStdio, mcpSecretsOf, mcpServerEnabled, type McpDetectedSource, type McpServerConfig, type McpServerStatus, type SecretTarget } from "@jaira/shared/browser";
import { layerWriter } from "@jaira/ui/configWriter";
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
} from "@jaira/ui/connectionsModel";
import type { McpServerRowsProps } from "@jaira/ui/mcpServersRows";
import { SchemaForm } from "../../form/SchemaForm";
import { Code, Hint, PaneActions } from "../bits";
import { Button } from "../Button";
import { SelectInput, TextField } from "../fields";
import { SettingsLayerContext } from "../layers";
import { ProbeHead, ProbeList, ProbeRow, RowButton, useColumn } from "./Probe";
import { AddBox, ConnRow, ConnRows, EntryBox, KeyBox, Problem, RowControls, RowHead, Say, Tag, Wide } from "./Row";

/**
 * `mcpServersRows.tsx`'s rows of Connections → MCP servers, universal (decision 0015): one row per
 * configured server — whether it answered, the secrets it is sent as boxes, its switch and chevron —
 * then "Add a server", with the servers other tools on this machine already run under it. What each
 * says and writes is `connectionsModel.ts`'s.
 */
export function McpServerRows(props: McpServerRowsProps): JSX.Element {
  const { config, layer, busy, editable, mcp, onSave } = props;
  // The Just you view's "What you changed": only the servers the layer states, and no adding.
  const onlyStated = useContext(SettingsLayerContext)?.onlyStated === true;
  if (config === null) return <Hint card>The configuration could not be read.</Hint>;
  const doc = layerDocument(config, layer);
  const servers = effectiveServers(config);
  const locked = busy || !editable;
  const { set, stated } = layerWriter(doc, layer, onSave);
  // One write for the lot: the layer's own document with the new servers in it.
  const addAll = (entries: ReadonlyArray<{ name: string; config: McpServerConfig }>): void => onSave(layer, withServersAdded(doc, servers, entries));
  const shown = Object.entries(servers).filter(([name]) => !onlyStated || stated(`mcp.servers.${name}`));
  return (
    <ConnRows>
      {shown.map(([name, server], i) => (
        <McpServerRow key={`${layer}:${name}`} {...props} first={i === 0} name={name} server={server} status={mcp.report?.servers.find((s) => s.name === name)} locked={locked} set={set} stated={stated} />
      ))}
      {onlyStated ? null : <AddServerRow first={shown.length === 0} servers={servers} detected={mcp.detected} locked={locked} set={set} onAddAll={addAll} />}
    </ConnRows>
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
  ];

  const wide = [
    storing ? (
      <Wide key="secret">
        <SecretEntry names={credentials.map((secret) => secret.credential)} busy={locked} secrets={secrets} hasProject={config !== null && config.projectFile.length > 0} onStore={(request) => void mcp.storeSecret(request)} onClose={() => setStoring(false)} />
      </Wide>
    ) : null,
    open ? (
      <Wide key="form" body>
        <SchemaForm schema={isMcpStdio(server) ? STDIO_SCHEMA : HTTP_SCHEMA} value={server} onChange={(next) => set(path, next)} ctx={{ path, disabled: locked, isSet: stated, setAt: set }} />
        <PaneActions>
          <Button kind="danger" disabled={locked || !stated(path)} title="delete this server from the layer being edited" onPress={() => set(path, undefined)}>
            Remove
          </Button>
        </PaneActions>
      </Wide>
    ) : null,
  ];

  return (
    <ConnRow
      first={first}
      state={state}
      main={
        <>
          <RowHead brand={name} state={state} title={name} mono />
          <Say state={state} word={mcpWord(enabled, status)} detail={mcpDetail(enabled, server, status)} fix={enabled && status?.fix ? status.fix : undefined} />
        </>
      }
      boxes={boxes}
      controls={
        <RowControls
          on={enabled}
          disabled={locked}
          label={enabled ? `stop handing ${name} to agents` : `hand ${name} to agents again`}
          // `undefined` REMOVES the key: on is the default, and a layer that says so says nothing.
          onToggle={(next) => set(`${path}.enabled`, next ? undefined : false)}
          open={open}
          title={name}
          onOpen={() => setOpen((v) => !v)}
        />
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

/** The last row: add a server by hand, and the servers other tools on this machine already run. */
function AddServerRow({
  first,
  servers,
  detected,
  locked,
  set,
  onAddAll,
}: {
  first: boolean;
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
    <ConnRow
      first={first}
      state="unconfigured"
      main={
        <>
          <RowHead brand="+" state="unconfigured" title="Add a server" />
          <Say state="unconfigured" word="not set up" detail="a command JaiRA starts (stdio), or a URL it calls (HTTP)" />
        </>
      }
      boxes={[open ? null : <AddBox key="add" title="Add a server" sub="a name, and a command or an address" disabled={locked} onPress={() => setOpen(true)} />]}
      controls={null}
      wide={[
        open ? (
          <Wide key="form" body>
            <SchemaForm schema={NEW_SERVER_SCHEMA} value={draft} onChange={(next) => setDraft((next ?? {}) as Record<string, unknown>)} ctx={{ path: "", disabled: locked, hidePaths: true }} />
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
        detected !== undefined ? (
          <Wide key="found">
            <DetectedServers detected={detected} servers={servers} locked={locked} onAdd={onAddAll} />
          </Wide>
        ) : null,
      ]}
    />
  );
}

/** What other tools on this machine already run: one row per place looked, and Add. */
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
  const last = useColumn();
  return (
    <ProbeList found>
      <ProbeHead left="Servers other tools on this machine already run" right="read when this page opens — none is started" />
      {detected.map((source) => {
        const fresh = newFromSource(source, servers);
        const id = `${source.source}:${source.where}`;
        return (
          <ProbeRow
            key={id}
            id={id}
            up={source.state === "found"}
            name={source.label}
            dimName={source.state !== "found"}
            at={`${source.where} · ${detectedSaid(source)}`}
            title={source.where}
            nameWidth={190}
            last={last}
            end={
              source.state !== "found" ? null : fresh.length === 0 ? (
                <Tag tone="accent">added</Tag>
              ) : (
                <RowButton disabled={locked} onPress={() => onAdd(fresh)}>
                  {fresh.length === 1 ? "Add" : `Add ${fresh.length}`}
                </RowButton>
              )
            }
          />
        );
      })}
    </ProbeList>
  );
}
