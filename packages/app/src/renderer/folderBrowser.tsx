/**
 * Choosing a folder on another machine (decision 0013 §8; the approved mockup): the OS dialog can only
 * show this machine's disk, so opening or making a project on a paired machine browses its folders
 * through its engine. The machine switcher at the top lists the paired machines that are online.
 */
import { useEffect, useState, type JSX } from "react";
import type { FolderListing } from "@jaira/shared/browser";
import { Segmented } from "./settingsLayout";
import { invoke } from "./store";

export interface BrowseMachine {
  id: string;
  label: string;
}

export function FolderBrowser({
  machines,
  initial,
  mode,
  onClose,
  onChosen,
}: {
  machines: readonly BrowseMachine[];
  initial: string;
  mode: "open" | "init";
  onClose: () => void;
  /** The folder, and the machine it is on. */
  onChosen: (machine: BrowseMachine, dir: string) => void;
}): JSX.Element {
  const [machineId, setMachineId] = useState(initial);
  const [listing, setListing] = useState<FolderListing | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const machine = machines.find((m) => m.id === machineId) ?? machines[0]!;
  const go = (dir?: string): void => {
    setError(undefined);
    invoke("files:browse", { machine: machine.id, ...(dir !== undefined ? { dir } : {}) }).then(setListing, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    setListing(undefined);
    go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId]);
  const chosen = listing?.dir;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-browser" role="dialog" aria-label={mode === "init" ? "New project" : "Open a project"} onClick={(e) => e.stopPropagation()}>
        <h3 className="folder-browser-title">{mode === "init" ? "New project" : "Open a project"}</h3>
        {machines.length > 1 ? (
          <Segmented label="Machine" value={machine.id} options={machines.map((m) => [m.label, m.id] as const)} onChange={setMachineId} />
        ) : null}
        <div className="folder-crumbs">
          {listing?.roots.map((root) => (
            <button key={root} type="button" className="ghost" onClick={() => go(root)}>
              {root}
            </button>
          ))}
          {listing !== undefined ? <code className="folder-at ellip">{listing.dir}</code> : null}
        </div>
        <div className="folder-list">
          {listing?.parent !== undefined ? (
            <button type="button" className="folder-row" onClick={() => go(listing.parent)}>
              <span className="folder-glyph" aria-hidden="true">↑</span>
              <span className="grow ellip">..</span>
            </button>
          ) : null}
          {listing === undefined && error === undefined ? <p className="cfg-hint folder-empty">Reading {machine.label}…</p> : null}
          {listing?.entries.length === 0 ? <p className="cfg-hint folder-empty">No folders here.</p> : null}
          {listing?.entries.map((entry) => (
            <button key={entry.path} type="button" className={`folder-row${entry.project ? " is-project" : ""}`} onDoubleClick={() => go(entry.path)} onClick={() => go(entry.path)}>
              <span className="folder-glyph" aria-hidden="true">▸</span>
              <span className="grow ellip">{entry.name}</span>
              {entry.project ? <span className="chip">JaiRA project</span> : entry.git ? <span className="chip">git</span> : null}
            </button>
          ))}
        </div>
        <p className="cfg-hint">
          {error !== undefined ? <span className="upd-err">{error}</span> : `Folders on ${machine.label}, read by its engine.${mode === "open" ? " A folder that is not a project yet can be set up there." : ""}`}
        </p>
        <div className="folder-foot">
          <span className="grow" />
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={chosen === undefined} onClick={() => chosen !== undefined && onChosen(machine, chosen)}>
            {mode === "init" ? "Make a project" : "Open"} {chosen !== undefined ? `${chosen.split(/[\\/]/).filter(Boolean).pop() ?? chosen} on ${machine.label}` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
