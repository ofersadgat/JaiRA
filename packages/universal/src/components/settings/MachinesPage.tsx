import { useEffect, useState, type JSX } from "react";
import { View } from "@tamagui/core";
import type { CopyChoice, DeviceView, MachinesView, OutboxView, PeerView, ProjectSummary } from "@jaira/shared/browser";
import { chipStateOf, type MachineChipState } from "@jaira/ui/machinesModel";
import {
  ADD_SCHEMA,
  COPY_CHOICES,
  COPY_WORDS,
  FORM_CHOICES,
  MACHINES_WORDS as W,
  deviceWords,
  devicesOf,
  diskWords,
  errorOf,
  groupedWords,
  pairCodeWords,
  pairWords,
  peerWords,
  nearbyLogLines,
  phoneJoinWords,
  reachWords,
  sentence,
  useAddMachine,
  useMachines,
} from "@jaira/ui/machinesModel";
import { invoke, subscribe as subscribePush } from "@jaira/ui/store";
import { useShell } from "../../app/shell";
import { copyText } from "../../clipboard";
import { Press, Txt, edge, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { MachineChip } from "../MachineChip";
import { MachineIcon } from "../MachineIcon";
import { SchemaForm } from "../form/SchemaForm";
import { Button } from "./Button";
import { Segmented, Switch } from "./controls";
import { TextField } from "./fields";
import { SettingsLayerContext } from "./layers";
import { SettingsRow, SettingsSection } from "./SettingsPage";
import { Words } from "./Words";

/**
 * Settings → Machines: this machine's name, tags and reach, pairing, the machines it is paired with,
 * the phones and browsers that are windows onto it, and copies of the machines' work. What every row
 * says, and the fleet it reads, are `machinesModel.ts`'s; its reads and writes are `invoke` calls.
 * What it adds to the page's look:
 *
 *   a machine's tags     row, wraps, centred, gap 6; the OS a dashed chip (app 10/12.5, --dim, 1px
 *                        --line, round, padding 0 6), each tag a chip with its × (padding 0 0 0 4, --dim)
 *   what it is           its icon (20: the shape, the system's mark on it) before the four it can be
 *   the box adding one   a text box 80 wide
 *   the pairing code     its row on --tint-accent; the code the data face at 15/12.5, 0.08em, padding
 *                        4 10, a dashed --line, radius --control-radius
 *   Add a machine        column, gap 10, 6 above; its foot a row, centred, gap 10
 *
 * The Add a machine form is a `SchemaForm`, keyed by the schema's own names.
 */
export function MachinesPage(): JSX.Element {
  const { state, actions } = useShell();
  const grouped = state.settings.ui.groupWorkspaces !== false;
  const [view, setView] = useMachines();
  return (
    <SettingsLayerContext.Provider value={null}>
      {view === undefined ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "dim" }}>{W.reading}</Txt>
      ) : (
        <>
          <ThisMachine view={view} onView={setView} />
          <SettingsSection id="yours" title={W.yours.title} info={W.yours.info}>
            {view.machines.length === 0 ? (
              <SettingsRow {...W.none} />
            ) : (
              [...view.machines].sort((a, b) => a.label.localeCompare(b.label)).map((peer) => <PeerRow key={peer.id} peer={peer} onView={setView} />)
            )}
          </SettingsSection>
          {devicesOf(view).length > 0 ? (
            <SettingsSection id="devices" title={W.devices.title} info={W.devices.info}>
              {devicesOf(view).map((device) => (
                <DeviceRow key={device.id} device={device} onView={setView} />
              ))}
            </SettingsSection>
          ) : null}
          <Outbox />
          <AddMachine onView={setView} />
          <Copies view={view} onView={setView} />
          <SettingsSection id="projects" title={W.projects.title} info={W.projects.info}>
            <SettingsRow name={W.grouped.name} description={groupedWords(grouped)} control={<Switch on={grouped} label={W.grouped.name} onChange={actions.setGroupWorkspaces} />} />
          </SettingsSection>
        </>
      )}
    </SettingsLayerContext.Provider>
  );
}

/**
 * A machine's chip as a row's name. It takes the name's weight and line (the app voice at 550, 1.1× on
 * 1.3) and sits where an inline box does on that line — on its baseline by its dot's foot, not centred
 * in it: 3.17 px under the line's top at the default size, measured in Chromium. So the line is drawn,
 * and the chip placed in it.
 */
function NameChip({ label, state }: { label: string; state: MachineChipState }): JSX.Element {
  const t = useTokens();
  return (
    <View height={t.scaled("size-app", 1.1 * 1.3) as never}>
      <View marginTop={t.scaled("size-app", 3.17 / 12.5) as never}>
        <MachineChip label={label} state={state} voice={String(t.v("font-app"))} weight={550} line={1.3} />
      </View>
    </View>
  );
}

/** An error in a row's sentence, in --bad (`Words`). */
function ErrorWords({ error }: { error: string }): JSX.Element {
  return <Words parts={[{ error: sentence(error) }]} />;
}

function ThisMachine({ view, onView }: { view: MachinesView; onView: (v: MachinesView) => void }): JSX.Element {
  const t = useTokens();
  const [label, setLabel] = useState(view.self.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => setLabel(view.self.label), [view.self.label]);
  const act = (work: Promise<MachinesView>): void => {
    setBusy(true);
    setError(undefined);
    work.then(onView, (e: unknown) => setError(errorOf(e))).finally(() => setBusy(false));
  };
  const rename = (): void => {
    if (label.trim() !== "" && label.trim() !== view.self.label) act(invoke("machines:rename", { label: label.trim() }));
  };
  const reach = reachWords(view);
  const pairing = view.pairing;
  return (
    <SettingsSection id="this" title={W.this.title} info={W.this.info}>
      <SettingsRow
        name={W.name.name}
        description={error !== undefined ? <ErrorWords error={error} /> : W.name.description}
        control={<TextField value={label} label="Machine name" disabled={busy} onChange={setLabel} onBlur={rename} onSubmit={rename} />}
      />
      <SettingsRow name={W.tags.name} description={W.tags.description} control={<Tags os={view.self.os} tags={view.self.tags} disabled={busy} onChange={(tags) => act(invoke("machines:tags", { tags }))} />} />
      <SettingsRow
        name={W.form.name}
        description={W.form.description}
        control={
          <>
            <MachineIcon face={{ shape: view.self.form, mark: view.self.os }} size={20} />
            <Segmented value={view.self.form} options={FORM_CHOICES} label={W.form.name} disabled={busy} onChange={(form) => act(invoke("machines:form", { form }))} />
          </>
        }
      />
      <SettingsRow
        name={W.reach.name}
        description={<Words parts={reach.description} />}
        info={W.reach.info}
        control={<Switch on={reach.on} label={W.reach.name} disabled={busy} onChange={(on) => act(invoke("machines:reach", { on }))} />}
      />
      <SettingsRow
        name={W.pair.name}
        description={pairWords(view)}
        control={
          pairing === undefined ? (
            <Button disabled={busy || view.self.reach.state !== "on"} onPress={() => act(invoke("machines:pairCode", undefined))}>
              {W.pair.button}
            </Button>
          ) : undefined
        }
      />
      {pairing !== undefined ? (
        <View backgroundColor={t.v("tint-accent") as never}>
          <SettingsRow
            name={W.pairCode.name}
            description={<Words parts={pairCodeWords(view, pairing.expiresAt)} />}
            control={
              <>
                <Txt
                  spec={{ voice: "data", scale: (15 / 12.5) * (12.5 / 12), ls: 0.08 }}
                  paddingVertical={4}
                  paddingHorizontal={10}
                  borderRadius={lengthToken(t, "control-radius", 7)}
                  {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, "line", "dashed") as object)}
                  selectable
                >
                  {pairing.code}
                </Txt>
                <Button kind="ghost" onPress={() => void copyText(pairing.code)}>
                  Copy
                </Button>
                <Button kind="ghost" onPress={() => act(invoke("machines:pairCancel", undefined))}>
                  Stop
                </Button>
              </>
            }
          />
        </View>
      ) : null}
      {view.phone !== undefined ? (
        <View backgroundColor={t.v("tint-accent") as never}>
          <SettingsRow name={W.phone.name} description={<Words parts={phoneJoinWords(view.phone)} />} />
        </View>
      ) : null}
      {view.nearbyLog !== undefined ? (
        <SettingsRow
          name={W.nearbyLog.name}
          description={
            <View gap={2}>
              {nearbyLogLines(view.nearbyLog).map((line, i) => (
                <Txt key={i} spec={{ voice: "data", scale: 11 / 12.5, color: "dim" }} selectable>
                  {line}
                </Txt>
              ))}
            </View>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

/** A machine's tags: its OS (dashed, its own), the rest, and a box that adds one. */
function Tags({ os, tags, onChange, disabled = false }: { os: string; tags: string[]; onChange?: (tags: string[]) => void; disabled?: boolean }): JSX.Element {
  const t = useTokens();
  const [adding, setAdding] = useState("");
  const add = (): void => {
    const tag = adding.trim().toLowerCase();
    setAdding("");
    if (tag !== "" && !tags.includes(tag)) onChange?.([...tags, tag]);
  };
  const chip = (dashed: boolean): Record<string, unknown> => ({
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    paddingHorizontal: 6,
    borderRadius: 999,
    ...edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, "line", dashed ? "dashed" : "solid"),
  });
  const words = { voice: "app", scale: 10 / 12.5, color: "dim" } as const;
  return (
    <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={6}>
      <View {...chip(true)} {...({ title: "From the machine itself" } as object)}>
        <Txt spec={words} numberOfLines={1}>
          {os}
        </Txt>
      </View>
      {tags.map((tag) => (
        <View key={tag} {...chip(false)}>
          <Txt spec={words} numberOfLines={1}>
            {tag}
          </Txt>
          {onChange !== undefined ? (
            <Press onPress={() => onChange(tags.filter((x) => x !== tag))} disabled={disabled} label={`Remove the tag ${tag}`} paddingLeft={4}>
              <Txt spec={words}>×</Txt>
            </Press>
          ) : null}
        </View>
      ))}
      {onChange !== undefined ? <TextField value={adding} placeholder="+ tag" label="Add a tag" disabled={disabled} width={80} onChange={setAdding} onBlur={add} onSubmit={add} /> : null}
    </View>
  );
}

function PeerRow({ peer, onView }: { peer: PeerView; onView: (v: MachinesView) => void }): JSX.Element {
  const t = useTokens();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const forget = (): void => {
    setBusy(true);
    invoke("machines:forget", { id: peer.id })
      .then(onView, () => undefined)
      .finally(() => setBusy(false));
  };
  return (
    <SettingsRow
      name={<NameChip label={peer.label} state={chipStateOf(peer.state)} />}
      description={<Words parts={peerWords(peer)} />}
      control={
        <>
          <Tags os={peer.os} tags={peer.tags} />
          {confirming ? (
            <>
              <Button kind="danger" disabled={busy} onPress={forget}>
                {`Forget ${peer.label}`}
              </Button>
              <Button kind="ghost" onPress={() => setConfirming(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button kind="ghost" title="Forget this machine here and on every machine you use" onPress={() => setConfirming(true)}>
              Forget…
            </Button>
          )}
        </>
      }
    />
  );
}

/** A phone or a browser paired with this machine: what it is, whether it is there, and Forget. */
function DeviceRow({ device, onView }: { device: DeviceView; onView: (v: MachinesView) => void }): JSX.Element {
  const t = useTokens();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const forget = (): void => {
    setBusy(true);
    invoke("machines:forget", { id: device.id })
      .then(onView, () => undefined)
      .finally(() => setBusy(false));
  };
  return (
    <SettingsRow
      name={<NameChip label={device.label} state={device.connected ? "on" : "off"} />}
      description={deviceWords(device)}
      control={
        confirming ? (
          <>
            <Button kind="danger" disabled={busy} onPress={forget}>
              {`Forget ${device.label}`}
            </Button>
            <Button kind="ghost" onPress={() => setConfirming(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button kind="ghost" title={W.devices.forget} onPress={() => setConfirming(true)}>
            Forget…
          </Button>
        )
      }
    />
  );
}

/** Answers waiting for machines that are offline, each of which can be taken back. */
function Outbox(): JSX.Element | null {
  const t = useTokens();
  const [items, setItems] = useState<OutboxView[]>([]);
  useEffect(() => {
    const read = (): void => void invoke("machines:outbox", undefined).then(setItems, () => undefined);
    read();
    return subscribePush((message) => {
      if (message.type === "machines:changed" || (message.type === "store:invalidate" && message.scope === "tasks")) read();
    });
  }, []);
  if (items.length === 0) return null;
  return (
    <SettingsSection id="outbox" title={W.outbox.title} info={W.outbox.info}>
      {items.map((item) => (
        <SettingsRow
          key={item.id}
          name={<NameChip label={item.machine} state="off" />}
          description={`${item.what.charAt(0).toUpperCase()}${item.what.slice(1)}, given ${new Date(item.at).toLocaleString()}.`}
          control={
            <Button kind="ghost" onPress={() => void invoke("machines:withdraw", { id: item.id }).then(setItems, () => undefined)}>
              Take it back
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}

/** Pairing with another machine: its address and code (the schema form), and Pair. */
function AddMachine({ onView }: { onView: (v: MachinesView) => void }): JSX.Element {
  // The form's state and Pair are `machinesModel.ts`'s (`useAddMachine`).
  const { value, setValue, busy, error, done, ready, pair } = useAddMachine(onView);
  const body = { voice: "app", scale: 13 / 12.5 } as const;
  return (
    <SettingsSection id="add" title={W.add.title} info={W.add.info}>
      <SettingsRow name={W.other.name} full>
        <View gap={10} paddingTop={6}>
          <SchemaForm schema={ADD_SCHEMA as never} value={value} onChange={(next) => setValue(next as typeof value)} ctx={{ path: "", labels: "keys", disabled: busy }} />
          <View flexDirection="row" alignItems="center" gap={10}>
            <View flex={1} minWidth={0}>
              {error !== undefined ? <Txt spec={{ ...body, color: "bad" }}>{sentence(error)}</Txt> : done !== undefined ? <Txt spec={{ voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "dim" }}>{done}</Txt> : null}
            </View>
            <Button kind="primary" disabled={!ready || busy} onPress={pair}>
              {busy ? "Pairing…" : "Pair"}
            </Button>
          </View>
        </View>
      </SettingsRow>
    </SettingsSection>
  );
}

/** Copies of other machines' work (decision 0013 §6). */
function Copies({ view, onView }: { view: MachinesView; onView: (v: MachinesView) => void }): JSX.Element {
  const choice = view.self.copy;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [disk, setDisk] = useState<{ bytes: number; machines: number; dir: string } | undefined>(undefined);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  useEffect(() => {
    void invoke("machines:copies", undefined).then(setDisk, () => undefined);
    void invoke("project:list", undefined).then((all) => setProjects(all.filter((p) => p.machine !== undefined && p.machine.self !== true)), () => undefined);
  }, [choice]);
  const choose = (next: CopyChoice): void => {
    setBusy(true);
    setError(undefined);
    invoke("machines:copy", next)
      .then(onView, (e: unknown) => setError(errorOf(e)))
      .finally(() => setBusy(false));
  };
  const chosen = new Set(choice.projects ?? []);
  return (
    <SettingsSection id="copies" title={W.copies.title} info={W.copies.info}>
      <SettingsRow
        name={W.copy.name}
        description={error !== undefined ? <ErrorWords error={error} /> : COPY_WORDS[choice.mode]}
        control={
          <Segmented
            label={W.copy.name}
            value={choice.mode}
            disabled={busy}
            options={COPY_CHOICES}
            onChange={(mode) => choose(mode === "chosen" ? { mode, projects: choice.projects ?? [] } : { mode })}
          />
        }
      />
      {choice.mode === "chosen"
        ? projects.map((p) => (
            <SettingsRow
              key={p.project}
              name={p.label}
              description={`on ${p.machine?.label ?? "another machine"}`}
              control={
                <Switch
                  on={chosen.has(p.project)}
                  label={`Copy ${p.label} from ${p.machine?.label ?? "another machine"}`}
                  disabled={busy}
                  onChange={(on) => choose({ mode: "chosen", projects: on ? [...chosen, p.project] : [...chosen].filter((k) => k !== p.project) })}
                />
              }
            />
          ))
        : null}
      <SettingsRow
        name={W.disk.name}
        description={diskWords(disk)}
        control={
          disk !== undefined && disk.bytes > 0 ? (
            <Button kind="ghost" onPress={() => void invoke("shell:reveal", { file: disk.dir }).catch(() => undefined)}>
              Show
            </Button>
          ) : undefined
        }
      />
    </SettingsSection>
  );
}
