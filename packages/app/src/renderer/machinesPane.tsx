/**
 * Settings → Machines (decision 0013 §1–§3; the mockup the person approved on 2026-09-27): this
 * machine's name, tags and reach, pairing by a one-time code, and the machines it is paired with.
 * Not a layered page: everything here is this machine's own.
 */
import { useEffect, useState, type JSX } from "react";
import type { CopyChoice, MachinesView, OutboxView, PeerView, ProjectSummary } from "@jaira/shared/browser";
import {
  ADD_SCHEMA,
  COPY_CHOICES,
  COPY_WORDS,
  MACHINES_WORDS as W,
  diskWords,
  errorOf,
  groupedWords,
  pairCodeWords,
  pairWords,
  peerWords,
  reachWords,
  sentence,
  useAddMachine,
  useMachines,
  type WordPart,
} from "./machinesModel";
import { invoke, subscribe as subscribePush } from "./store";
import { SettingsLayerContext, Switch, TextInput } from "./controls";
import { MachineChip, chipStateOf } from "./machineChip";
import { Segmented, SettingsRow, SettingsSection } from "./settingsLayout";
import { SchemaForm } from "./schemaForm/SchemaForm";

export { ago, useMachines } from "./machinesModel";

/** A sentence of the model's parts, as the DOM draws each. */
function Words({ parts }: { parts: readonly WordPart[] }): JSX.Element {
  return (
    <>
      {parts.map((part, i) =>
        typeof part === "string" ? (
          part
        ) : "code" in part ? (
          <code key={i}>{part.code}</code>
        ) : "error" in part ? (
          <span key={i} className="upd-err">
            {part.error}
          </span>
        ) : "hint" in part ? (
          <span key={i} className="cfg-hint">
            {part.hint}
          </span>
        ) : (
          <a key={i} href={part.href} target="_blank" rel="noreferrer">
            {part.link}
          </a>
        ),
      )}
    </>
  );
}

/**
 * Copies of other machines' work (decision 0013 §6; the approved mockup, with archive as a choice —
 * the person, 2026-09-27: "we can do not archived with everything as a choice").
 */
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
        description={error !== undefined ? <span className="upd-err">{sentence(error)}</span> : COPY_WORDS[choice.mode]}
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
            <button type="button" className="ghost" onClick={() => void invoke("shell:reveal", { file: disk.dir }).catch(() => undefined)}>
              Show
            </button>
          ) : undefined
        }
      />
    </SettingsSection>
  );
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
    <SettingsSection id="this" title={W.this.title} info={W.this.info}>
      <SettingsRow
        name={W.name.name}
        description={error !== undefined ? <span className="upd-err">{sentence(error)}</span> : W.name.description}
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
        name={W.tags.name}
        description={W.tags.description}
        control={<Tags os={view.self.os} tags={view.self.tags} disabled={busy} onChange={(tags) => act(invoke("machines:tags", { tags }))} />}
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
            <button type="button" disabled={busy || view.self.reach.state !== "on"} onClick={() => act(invoke("machines:pairCode", undefined))}>
              {W.pair.button}
            </button>
          ) : undefined
        }
      />
      {pairing !== undefined ? (
        <div className="set-row pair-code-row">
          <div className="set-row-line">
            <div className="set-row-say">
              <div className="set-name">
                <span>{W.pairCode.name}</span>
              </div>
              <p className="set-desc">
                <Words parts={pairCodeWords(view, pairing.expiresAt)} />
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
      description={<Words parts={peerWords(peer)} />}
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

function AddMachine({ onView }: { onView: (v: MachinesView) => void }): JSX.Element {
  // The form's state and Pair are `machinesModel.ts`'s, shared with the universal copy (decision 0015).
  const { value, setValue, busy, error, done, ready, pair } = useAddMachine(onView);
  return (
    <SettingsSection id="add" title={W.add.title} info={W.add.info}>
      <SettingsRow name={W.other.name} full>
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

/** Answers waiting for machines that are offline, each of which can be taken back (decision 0013 §7). */
function Outbox(): JSX.Element | null {
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
          name={<MachineChip label={item.machine} state="off" />}
          description={`${item.what.charAt(0).toUpperCase()}${item.what.slice(1)}, given ${new Date(item.at).toLocaleString()}.`}
          control={
            <button type="button" className="ghost" onClick={() => void invoke("machines:withdraw", { id: item.id }).then(setItems, () => undefined)}>
              Take it back
            </button>
          }
        />
      ))}
    </SettingsSection>
  );
}

export function MachinesPane({ grouped, onGrouped }: { grouped: boolean; onGrouped: (on: boolean) => void }): JSX.Element {
  const [view, setView] = useMachines();
  return (
    <SettingsLayerContext.Provider value={null}>
      <div className="cfg-pane">
        {view === undefined ? (
          <p className="cfg-hint">{W.reading}</p>
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
            <Outbox />
            <AddMachine onView={setView} />
            <Copies view={view} onView={setView} />
            <SettingsSection id="projects" title={W.projects.title} info={W.projects.info}>
              <SettingsRow name={W.grouped.name} description={groupedWords(grouped)} control={<Switch on={grouped} label={W.grouped.name} onChange={onGrouped} />}
              />
            </SettingsSection>
          </>
        )}
      </div>
    </SettingsLayerContext.Provider>
  );
}
