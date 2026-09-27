/**
 * Settings → Machines (decision 0013 §1–§3; the mockup the person approved on 2026-09-27): this
 * machine's name, tags and reach, pairing by a one-time code, and the machines it is paired with.
 * Not a layered page: everything here is this machine's own.
 */
import { useEffect, useState, type JSX } from "react";
import { PAIRING_CODE_MS, type MachinesView, type PeerView } from "@jaira/shared/browser";
import { invoke, subscribe as subscribePush } from "./store";
import { SettingsLayerContext, Switch, TextInput } from "./controls";
import { MachineChip, chipStateOf } from "./machineChip";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { SchemaForm } from "./schemaForm/SchemaForm";

/** The fleet, fetched once and kept current by `machines:changed`. */
export function useMachines(): [MachinesView | undefined, (next: MachinesView) => void] {
  const [view, setView] = useState<MachinesView | undefined>(undefined);
  useEffect(() => {
    void invoke("machines:view", undefined).then(setView, () => undefined);
    return subscribePush((message) => {
      if (message.type === "machines:changed") setView(message.view);
    });
  }, []);
  return [view, setView];
}

const errorOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function ago(at: number | undefined): string {
  if (at === undefined) return "never seen";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "last seen now";
  if (minutes < 60) return `last seen ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `last seen ${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `last seen ${Math.round(hours / 24)} days ago`;
}

function Tags({ os, tags, onChange, disabled }: { os: string; tags: string[]; onChange?: (tags: string[]) => void; disabled?: boolean }): JSX.Element {
  const [adding, setAdding] = useState("");
  const add = (): void => {
    const tag = adding.trim().toLowerCase();
    setAdding("");
    if (tag !== "" && !tags.includes(tag)) onChange?.([...tags, tag]);
  };
  return (
    <span className="machine-tags">
      <span className="chip machine-tag-os" title="From the machine itself">
        {os}
      </span>
      {tags.map((tag) => (
        <span key={tag} className="chip">
          {tag}
          {onChange !== undefined ? (
            <button type="button" className="machine-tag-x" aria-label={`Remove the tag ${tag}`} disabled={disabled} onClick={() => onChange(tags.filter((t) => t !== tag))}>
              ×
            </button>
          ) : null}
        </span>
      ))}
      {onChange !== undefined ? (
        <span className="machine-tag-add">
          <TextInput
            value={adding}
            placeholder="+ tag"
            label="Add a tag"
            disabled={disabled}
            onChange={setAdding}
            onBlur={add}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
        </span>
      ) : null}
    </span>
  );
}

function reachWords(view: MachinesView): { description: JSX.Element | string; on: boolean } {
  const reach = view.self.reach;
  switch (reach.state) {
    case "off":
      return { on: false, description: "Off: your other machines cannot reach this one, and it cannot be paired with." };
    case "starting":
      return { on: true, description: "Publishing this machine through Tailscale…" };
    case "on":
      return {
        on: true,
        description: (
          <>
            On, through {reach.via === "helper" ? "JaiRA's Tailscale helper" : "Tailscale"}: <code>{reach.url}</code>. Nothing is opened to the internet, and only paired machines get in.
          </>
        ),
      };
    case "unavailable":
      return {
        on: true,
        description: (
          <>
            <span className="upd-err">{sentence(reach.reason ?? "It cannot be published.")}</span>
            {reach.signInUrl !== undefined ? (
              <>
                {" "}
                <a href={reach.signInUrl} target="_blank" rel="noreferrer">
                  Sign in to your tailnet
                </a>
              </>
            ) : null}
          </>
        ),
      };
  }
}

function sentence(text: string): string {
  const t = text.trim();
  const c = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(c) ? c : `${c}.`;
}

function ThisMachine({ view, onView }: { view: MachinesView; onView: (v: MachinesView) => void }): JSX.Element {
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
    <SettingsSection
      id="this"
      title="This machine"
      info="Every machine you use JaiRA on runs its own engine. Paired machines see each other's projects and tasks, and tasks go to whichever has room."
    >
      <SettingsRow
        name="Name"
        description={error !== undefined ? <span className="upd-err">{sentence(error)}</span> : "How other machines and the task chips call this one."}
        control={
          <TextInput
            value={label}
            label="Machine name"
            disabled={busy}
            onChange={setLabel}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === "Enter") rename();
            }}
          />
        }
      />
      <SettingsRow
        name="Tags"
        description="What a workflow can ask for. The operating system is added by itself."
        control={<Tags os={view.self.os} tags={view.self.tags} disabled={busy} onChange={(tags) => act(invoke("machines:tags", { tags }))} />}
      />
      <SettingsRow
        name="Reachable from my other machines"
        description={reach.description}
        info="JaiRA publishes its own port on your tailnet with Tailscale (tailscale serve), and turns it off again with this switch. Funnel is never used."
        control={<Switch on={reach.on} label="Reachable from my other machines" disabled={busy} onChange={(on) => act(invoke("machines:reach", { on }))} />}
      />
      <SettingsRow
        name="Pair a machine"
        description={
          view.self.reach.state === "on"
            ? `Show a code to type on the other machine. It works once, for ${PAIRING_CODE_MS / 60_000} minutes.`
            : "Turn on Reachable first: the other machine connects to this one to pair."
        }
        control={
          pairing === undefined ? (
            <button type="button" disabled={busy || view.self.reach.state !== "on"} onClick={() => act(invoke("machines:pairCode", undefined))}>
              Show a code
            </button>
          ) : undefined
        }
      />
      {pairing !== undefined ? (
        <div className="set-row pair-code-row">
          <div className="set-row-line">
            <div className="set-row-say">
              <div className="set-name">
                <span>Code for pairing</span>
              </div>
              <p className="set-desc">
                On the other machine: Settings → Machines → Add a machine, with <code>{view.self.reach.url}</code>. Works until{" "}
                {new Date(pairing.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
              </p>
            </div>
            <div className="set-ctl">
              <span className="pair-code">{pairing.code}</span>
              <button type="button" className="ghost" onClick={() => void navigator.clipboard?.writeText(pairing.code).catch(() => undefined)}>
                Copy
              </button>
              <button type="button" className="ghost" onClick={() => act(invoke("machines:pairCancel", undefined))}>
                Stop
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </SettingsSection>
  );
}

function peerWords(peer: PeerView): JSX.Element {
  const where = peer.url !== undefined ? <code>{new URL(peer.url).host}</code> : null;
  switch (peer.state) {
    case "online":
      return (
        <>
          Online · JaiRA {peer.version ?? "?"}
          {where !== null ? <> · {where}</> : null}
        </>
      );
    case "connecting":
      return <>Connecting…</>;
    case "mismatch":
      return (
        <>
          <span className="upd-err">{sentence(peer.reason ?? `It runs JaiRA ${peer.version ?? "?"}`)}</span> {ago(peer.lastSeenAt)}
        </>
      );
    case "offline":
      return (
        <>
          Offline · {ago(peer.lastSeenAt)}
          {peer.reason !== undefined ? <span className="cfg-hint"> · {peer.reason}</span> : null}
        </>
      );
  }
}

function PeerRow({ peer, onView }: { peer: PeerView; onView: (v: MachinesView) => void }): JSX.Element {
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
      name={<MachineChip label={peer.label} state={chipStateOf(peer.state)} />}
      description={peerWords(peer)}
      control={
        <>
          <Tags os={peer.os} tags={peer.tags} />
          {confirming ? (
            <>
              <button type="button" className="danger" disabled={busy} onClick={forget}>
                Forget {peer.label}
              </button>
              <button type="button" className="ghost" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" className="ghost" title="Forget this machine here and on every machine you use" onClick={() => setConfirming(true)}>
              Forget…
            </button>
          )}
        </>
      }
    />
  );
}

const ADD_SCHEMA = {
  type: "object",
  properties: {
    address: { type: "string", title: "address", minLength: 1, description: "The other machine's address, shown on its Machines page: mac-mini.tail4c2e.ts.net" },
    code: { type: "string", title: "code", minLength: 1, description: "The code the other machine shows under Pair a machine." },
  },
  required: ["address", "code"],
} as const;

function AddMachine({ onView }: { onView: (v: MachinesView) => void }): JSX.Element {
  const [value, setValue] = useState<{ address?: string; code?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  const ready = (value.address ?? "").trim() !== "" && (value.code ?? "").trim() !== "";
  const pair = (): void => {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    invoke("machines:add", { address: value.address!.trim(), code: value.code!.trim() })
      .then((view) => {
        onView(view);
        setValue({});
        setDone("Paired. It is listed under Your machines, with any machines it was already paired with.");
      }, (e: unknown) => setError(errorOf(e)))
      .finally(() => setBusy(false));
  };
  return (
    <SettingsSection id="add" title="Add a machine" info="Pairing is once per machine: after that they find each other by themselves, and a machine paired with any of yours joins all of them.">
      <SettingsRow name="The other machine" full>
        <div className="machine-add">
          <SchemaForm schema={ADD_SCHEMA as never} value={value} onChange={(next) => setValue(next as typeof value)} ctx={{ path: "", labels: "keys", disabled: busy }} />
          <div className="machine-add-foot">
            {error !== undefined ? <span className="upd-err grow">{sentence(error)}</span> : done !== undefined ? <span className="grow cfg-hint">{done}</span> : <span className="grow" />}
            <button type="button" className="primary" disabled={!ready || busy} onClick={pair}>
              {busy ? "Pairing…" : "Pair"}
            </button>
          </div>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

export function MachinesPane(): JSX.Element {
  const [view, setView] = useMachines();
  return (
    <SettingsLayerContext.Provider value={null}>
      <div className="cfg-pane">
        {view === undefined ? (
          <p className="cfg-hint">Reading this machine…</p>
        ) : (
          <>
            <ThisMachine view={view} onView={setView} />
            <SettingsSection
              id="yours"
              title="Your machines"
              info="Remembered on every machine you pair: pairing one new machine with any of these introduces it to the rest."
            >
              {view.machines.length === 0 ? (
                <SettingsRow name="None yet" description="Pair a machine below, or show a code here and type it there." />
              ) : (
                [...view.machines].sort((a, b) => a.label.localeCompare(b.label)).map((peer) => <PeerRow key={peer.id} peer={peer} onView={setView} />)
              )}
            </SettingsSection>
            <AddMachine onView={setView} />
          </>
        )}
      </div>
    </SettingsLayerContext.Provider>
  );
}
