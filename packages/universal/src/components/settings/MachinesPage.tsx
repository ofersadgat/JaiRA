import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Linking } from "react-native";
import { View } from "@tamagui/core";
import type { CopyChoice, MachinesView, OutboxView, ProjectSummary } from "@jaira/shared/browser";
import { machinesMoved } from "@jaira/ui/machinesModel";
import type { AskSpec } from "@jaira/ui/menuTypes";
import {
  CODE_SCHEMA,
  COPY_CHOICES,
  COPY_WORDS,
  FORM_CHOICES,
  MACHINES_WORDS as W,
  askingWords,
  checkedWords,
  diskWords,
  errorOf,
  groupedWords,
  machineRowsOf,
  nearbyLogLines,
  pairCodeWords,
  pairWords,
  phoneJoinWords,
  removeSpecWords,
  sentence,
  tailnetWords,
  unpairSpecWords,
  useMachines,
  type MachineChipState,
  type MachineRow,
  type TailnetAction,
} from "@jaira/ui/machinesModel";
import { invoke } from "@jaira/ui/store";
import { useView } from "@jaira/ui/useView";
import { useShell } from "../../app/shell";
import { copyText } from "../../clipboard";
import { Press, Txt, edge, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { AskDialog } from "../files/AskDialog";
import { MachineChip } from "../MachineChip";
import { MachineIcon } from "../MachineIcon";
import { NeedsAttention } from "./NeedsAttention";
import { SchemaForm } from "../form/SchemaForm";
import { Button } from "./Button";
import { Segmented, Switch } from "./controls";
import { TextField } from "./fields";
import { SettingsLayerContext } from "./layers";
import { SettingsRow, SettingsSection } from "./SettingsPage";
import { Words } from "./Words";

/**
 * Settings → Machines (decisions 0013 and 0022): this machine's name, tags, what it is, and its one
 * Tailscale sign-in; every device on the tailnet, with Pair or Unpair; and copies of the machines' work.
 * What every row says, and the fleet it reads, are `machinesModel.ts`'s; its reads and writes are
 * `invoke` calls. What it adds to the page's look:
 *
 *   a machine's tags     row, wraps, centred, gap 6; the OS a dashed chip (app 10/12.5, --dim, 1px
 *                        --line, round, padding 0 6), each tag a chip with its × (padding 0 0 0 4, --dim)
 *   what it is           its icon (20: the shape, the system's mark on it) before the four it can be
 *   the box adding one   a text box 80 wide
 *   a device's name      as the conversation's machine list draws a machine: its icon (20), its name app
 *                        600 (--dim when greyed), what it is app 11/12.5 --dim, gap 11
 *   its state            app 11/12.5, --ok paired and connected, --warn connecting, --bad offline, else --dim
 *   the code field       under the row's sentence: a `SchemaForm` of the one code, and Pair
 *
 * Unpair and Remove ask first (`AskDialog`).
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
          <NeedsAttention page="machines" />
          <ThisMachine view={view} onView={setView} />
          <YourMachines view={view} onView={setView} />
          <Outbox />
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
      <TailnetRow view={view} onView={onView} />
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

const TAILNET_LABELS: Record<TailnetAction, { label: string; kind: "primary" | "ghost" | "danger" }> = {
  signIn: { label: "Sign in to Tailscale", kind: "primary" },
  signOut: { label: "Sign out", kind: "ghost" },
  remove: { label: "Remove this machine…", kind: "danger" },
  cancel: { label: "Cancel", kind: "ghost" },
  removeCancel: { label: "Stop waiting", kind: "ghost" },
  reconnect: { label: "Reconnect", kind: "primary" },
};

/** The one Tailscale sign-in (decision 0022 §3): what it is now, and Sign in, Sign out, Remove. */
function TailnetRow({ view, onView }: { view: MachinesView; onView: (v: MachinesView) => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [asking, setAsking] = useState<AskSpec | undefined>(undefined);
  // The sign-in page opens by itself once, for the Sign in that was pressed here.
  const opening = useRef(false);
  const signInUrl = view.self.tailnet.signInUrl;
  useEffect(() => {
    if (opening.current && signInUrl !== undefined) {
      opening.current = false;
      void Linking.openURL(signInUrl);
    }
  }, [signInUrl]);
  const act = (work: Promise<MachinesView>, then?: (v: MachinesView) => void): void => {
    setBusy(true);
    setError(undefined);
    work
      .then((v) => {
        onView(v);
        then?.(v);
      }, (e: unknown) => setError(errorOf(e)))
      .finally(() => setBusy(false));
  };
  const press = (action: TailnetAction): void => {
    if (action === "signIn") {
      opening.current = true;
      act(invoke("machines:signIn", undefined));
    } else if (action === "reconnect") act(invoke("machines:signIn", undefined));
    else if (action === "signOut" || action === "cancel") act(invoke("machines:signOut", undefined));
    else if (action === "removeCancel") act(invoke("machines:removeCancel", undefined));
    else {
      const words = removeSpecWords(view);
      setAsking({
        ...words,
        danger: true,
        onConfirm: () => {
          setAsking(undefined);
          const page = view.self.tailnet.consoleUrl;
          act(invoke("machines:remove", undefined), (v) => {
            const href = v.self.tailnet.consoleUrl ?? page;
            if (href !== undefined) void Linking.openURL(href);
          });
        },
      });
    }
  };
  const words = tailnetWords(view);
  return (
    <>
      <SettingsRow
        name={W.tailnet.name}
        info={W.tailnet.info}
        description={<Words parts={error !== undefined ? [...words.description, " ", { error: sentence(error) }] : words.description} />}
        control={
          words.actions.length > 0 ? (
            <>
              {words.actions.map((action) => (
                <Button key={action} kind={TAILNET_LABELS[action].kind} disabled={busy} onPress={() => press(action)}>
                  {TAILNET_LABELS[action].label}
                </Button>
              ))}
            </>
          ) : undefined
        }
      />
      {asking !== undefined ? <AskDialog spec={asking} onCancel={() => setAsking(undefined)} /> : null}
    </>
  );
}

/** Every device on the tailnet (decision 0022 §4), with Pair or Unpair; Refresh asks them all again. */
function YourMachines({ view, onView }: { view: MachinesView; onView: (v: MachinesView) => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const signedIn = view.self.tailnet.state === "on" || view.self.tailnet.state === "removing";
  const rows = machineRowsOf(view);
  const refresh = (): void => {
    setBusy(true);
    invoke("machines:refresh", undefined)
      .then(onView, () => undefined)
      .finally(() => setBusy(false));
  };
  return (
    <SettingsSection
      id="yours"
      title={W.yours.title}
      info={W.yours.info}
      action={
        signedIn ? (
          <View flexDirection="row" alignItems="center" gap={10}>
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{checkedWords(view.checkedAt)}</Txt>
            <Button kind="ghost" disabled={busy} onPress={refresh}>
              Refresh
            </Button>
          </View>
        ) : undefined
      }
    >
      {!signedIn && rows.length === 1 ? <SettingsRow {...W.notSignedIn} /> : rows.map((row) => <DeviceRow key={row.key} row={row} onView={onView} />)}
      <PairPhone view={view} onView={onView} />
    </SettingsSection>
  );
}

/**
 * Pair a phone (decision 0013, amended 2026-10-04): the code it shows, while this machine is announced to
 * phones on the local network; the phone that proved it and is joining the tailnet; what phones did.
 */
function PairPhone({ view, onView }: { view: MachinesView; onView: (v: MachinesView) => void }): JSX.Element {
  const t = useTokens();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const act = (work: Promise<MachinesView>): void => {
    setBusy(true);
    setError(undefined);
    work.then(onView, (e: unknown) => setError(errorOf(e))).finally(() => setBusy(false));
  };
  const pairing = view.pairing;
  return (
    <>
      <SettingsRow
        name={W.pair.name}
        description={error !== undefined ? <ErrorWords error={error} /> : pairWords(view)}
        control={
          pairing === undefined ? (
            <Button disabled={busy || view.self.tailnet.state !== "on"} onPress={() => act(invoke("machines:pairCode", undefined))}>
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
                <Button kind="ghost" onPress={() => act(invoke("machines:pairCodeCancel", undefined))}>
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
    </>
  );
}

const TONES: Record<NonNullable<MachineRow["state"]>["tone"], "ok" | "warn" | "bad" | "dim"> = { ok: "ok", warn: "warn", bad: "bad", dim: "dim" };

/** One device: its icon, name and what it is; its state; Pair, Unpair, or its admin console page; and the code field while asked. */
function DeviceRow({ row, onView }: { row: MachineRow; onView: (v: MachinesView) => void }): JSX.Element {
  const t = useTokens();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [value, setValue] = useState<{ code?: string }>({});
  const [asking, setAsking] = useState<AskSpec | undefined>(undefined);
  const act = (work: Promise<MachinesView>): void => {
    setBusy(true);
    setError(undefined);
    work.then(onView, (e: unknown) => setError(errorOf(e))).finally(() => setBusy(false));
  };
  const small = { voice: "app", scale: 11 / 12.5 } as const;
  const action = row.action;
  const open = row.asking !== undefined && action?.kind === "pair";
  const button =
    action === undefined || open ? null : action.kind === "pair" ? (
      <Button kind="ghost" disabled={busy} onPress={() => act(invoke("machines:pairAsk", { device: action.device }))}>
        Pair
      </Button>
    ) : action.kind === "unpair" ? (
      <Button
        kind="ghost"
        disabled={busy}
        onPress={() =>
          setAsking({
            ...unpairSpecWords(action.label),
            onConfirm: () => {
              setAsking(undefined);
              act(invoke("machines:forget", { id: action.id }));
            },
          })
        }
      >
        Unpair
      </Button>
    ) : (
      <Button kind="danger" onPress={() => void Linking.openURL(action.href)}>
        Remove in Tailscale ↗
      </Button>
    );
  const sub = open && row.asking !== undefined ? askingWords(row.name, row.asking) : row.sub;
  return (
    <>
      <SettingsRow
        name={
          <View flexDirection="row" alignItems="center" gap={11} minWidth={0} flexShrink={1}>
            <MachineIcon face={row.face} size={20} {...(row.grey ? { color: String(t.v("dim")) } : {})} />
            <Txt spec={{ voice: "app", scale: 1.1, weight: 600, lineHeight: 1.3, color: row.grey ? "dim" : "text" }} numberOfLines={1} flexShrink={0}>
              {row.name}
            </Txt>
            <Txt spec={{ ...small, color: "dim" }} ellip minWidth={0} flexShrink={1}>
              {row.kind}
            </Txt>
          </View>
        }
        {...(sub !== undefined || error !== undefined ? { description: <Words parts={[...(sub !== undefined ? [sub] : []), ...(error !== undefined ? [" ", { error: sentence(error) }] : [])]} /> } : {})}
        control={
          <>
            {row.state !== undefined && !open ? <Txt spec={{ ...small, color: TONES[row.state.tone] }}>{row.state.text}</Txt> : null}
            {button}
            {open ? (
              <Button kind="quiet" disabled={busy} onPress={() => act(invoke("machines:pairCancel", undefined))}>
                Cancel
              </Button>
            ) : null}
          </>
        }
      >
        {open && action?.kind === "pair" ? (
          <View flexDirection="row" alignItems="flex-end" gap={10} paddingTop={8}>
            <View flex={1} minWidth={0}>
              <SchemaForm schema={CODE_SCHEMA as never} value={value} onChange={(next) => setValue(next as typeof value)} ctx={{ path: "", labels: "keys", disabled: busy }} />
            </View>
            <Button kind="primary" disabled={busy || (value.code ?? "").trim() === ""} onPress={() => act(invoke("machines:pair", { device: action.device, code: (value.code ?? "").trim() }))}>
              {busy ? "Pairing…" : "Pair"}
            </Button>
          </View>
        ) : null}
      </SettingsRow>
      {asking !== undefined ? <AskDialog spec={asking} onCancel={() => setAsking(undefined)} /> : null}
    </>
  );
}

/** Answers waiting for machines that are offline, each of which can be taken back. */
function Outbox(): JSX.Element | null {
  const t = useTokens();
  const items: OutboxView[] = useView("machines:outbox", undefined).value ?? [];
  if (items.length === 0) return null;
  return (
    <SettingsSection id="outbox" title={W.outbox.title} info={W.outbox.info}>
      {items.map((item) => (
        <SettingsRow
          key={item.id}
          name={<NameChip label={item.machine} state="off" />}
          description={`${item.what.charAt(0).toUpperCase()}${item.what.slice(1)}, given ${new Date(item.at).toLocaleString()}.`}
          control={
            <Button kind="ghost" onPress={() => void invoke("machines:withdraw", { id: item.id }).then(machinesMoved, () => undefined)}>
              Take it back
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}

/** Copies of other machines' work (decision 0013 §6). */
function Copies({ view, onView }: { view: MachinesView; onView: (v: MachinesView) => void }): JSX.Element {
  const choice = view.self.copy;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const disk = useView("machines:copies", undefined).value;
  const listed = useView("project:list", undefined).value;
  const projects: ProjectSummary[] = useMemo(() => (listed ?? []).filter((p) => p.machine !== undefined && p.machine.self !== true), [listed]);
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
