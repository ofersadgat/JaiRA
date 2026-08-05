/**
 * The viewer for a workflow description: what the description and the workflows say about each
 * other, and the two buttons that bring them back together.
 *
 * A description is the one file in the tree whose preview is not the interesting thing about it.
 * What you want to know when you open it is whether it is still TRUE — and that question has an
 * answer now (`persistence/workflowSync.ts` remembers where the two last agreed), so it goes at the
 * top, above the rendering. The preview is still one click away, and is what you get before any sync
 * has run.
 *
 * ## Nothing is written
 *
 * A sync produces a proposal, and the proposal arrives as unsaved DRAFTS — the rewritten description
 * in the editor below this panel, the proposed state files against their own rows in the tree. That
 * is the whole shape of the feature: one side of this pair is prose somebody wrote and the other is
 * code that will run, and a model rewriting either straight to disk would be a model with commit
 * rights. What lands here is a diff you read, in the editor you were already using, with Save and
 * Revert exactly where they always are.
 *
 * ## The report is the evidence
 *
 * Every proposal is shown next to the findings it came from — the same per-requirement verdicts
 * `jaira workflow check` prints. Without them the panel would be a button that rewrote your document
 * for reasons of its own; with them, each edit is traceable to the requirement that motivated it.
 */
import { useEffect, useState, type JSX } from "react";
import type { SyncDirection, WorkflowSyncEdit, WorkflowSyncResult } from "@jaira/shared/browser";
import { docKey } from "./drafts";
import type { FileSurfaceProps } from "./fileTypes";
import { MarkdownView } from "./markdown";
import { agoOf, driftOf, plural, syncSentence, SYNC_HINT, SYNC_LABEL } from "./syncState";

const DIRECTIONS: SyncDirection[] = ["document", "states"];

/** Worst first, so the reason the sync was run is at the top rather than under what already passes. */
const STATUS_ORDER = ["contradicted", "missing", "partial", "satisfied"];

const STATUS_CHIP: Record<string, string> = {
  satisfied: "chip-ok",
  partial: "chip-warn",
  missing: "chip-bad",
  contradicted: "chip-bad",
};

function Findings({ result }: { result: WorkflowSyncResult }): JSX.Element {
  const sorted = [...result.findings].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  );
  return (
    <section className="sync-section">
      <h3>
        <span>Requirements</span>
        <span className="count">{result.findings.length}</span>
      </h3>
      {sorted.length === 0 ? <p className="empty">The check returned no findings.</p> : null}
      {sorted.map((finding) => (
        <div key={finding.id} className="sync-finding">
          <div className="sync-finding-head">
            <span className={`chip ${STATUS_CHIP[finding.status] ?? ""}`}>{finding.status}</span>
            <b>{finding.id}</b>
            <span className="grow">{finding.requirement}</span>
          </div>
          {finding.detail === "" ? null : <div className="sub">{finding.detail}</div>}
          {finding.states.length > 0 ? (
            <div className="sub sync-states">{finding.states.join(" · ")}</div>
          ) : null}
        </div>
      ))}
    </section>
  );
}

/**
 * The proposed state files.
 *
 * Every row is a link to the file it would change, because "4 files have unsaved edits" is only
 * actionable if getting to them is one click rather than a hunt through the tree. A row that could
 * not be offered says why on itself — reported and not silently dropped, since a gap the sync
 * declined to close is exactly the thing a person has to go and do by hand.
 */
function Edits({ edits, onOpen }: { edits: WorkflowSyncEdit[]; onOpen?: (edit: WorkflowSyncEdit) => void }): JSX.Element {
  return (
    <section className="sync-section">
      <h3>
        <span>Proposed files</span>
        <span className="count">{edits.length}</span>
      </h3>
      {edits.length === 0 ? <p className="empty">Nothing to change.</p> : null}
      {edits.map((edit) => (
        <div key={`${edit.path}:${edit.stateId}`} className={`sync-edit${edit.applicable ? "" : " blocked"}`}>
          <div className="sync-edit-head">
            <span className={`chip${edit.action === "create" ? " chip-ok" : ""}`}>{edit.action}</span>
            {edit.applicable && onOpen ? (
              <button className="link grow ellip" onClick={() => onOpen(edit)} title={edit.path}>
                {edit.stateId}
              </button>
            ) : (
              <span className="grow ellip" title={edit.path}>
                {edit.stateId}
              </span>
            )}
            {edit.requirements.length > 0 ? <span className="sub">{edit.requirements.join(", ")}</span> : null}
          </div>
          {edit.reason === "" ? null : <div className="sub">{edit.reason}</div>}
          {edit.blocked === undefined ? null : <div className="notice warn">not applied — {edit.blocked}</div>}
        </div>
      ))}
    </section>
  );
}

function Report({
  result,
  onOpenEdit,
}: {
  result: WorkflowSyncResult;
  onOpenEdit?: (edit: WorkflowSyncEdit) => void;
}): JSX.Element {
  return (
    <div className="sync-report">
      <div className="sync-verdict">
        <span className={`chip ${result.verdict === "conforms" ? "chip-ok" : "chip-warn"}`}>{result.verdict}</span>
        <span className="sub">
          against {result.workflows.join(", ")}
          {result.costUsd !== undefined ? ` · $${result.costUsd.toFixed(3)}` : ""}
        </span>
      </div>

      {result.document !== undefined ? (
        <section className="sync-section">
          <h3>
            <span>Changes to this document</span>
            <span className="count">{result.document.changes.length}</span>
          </h3>
          {/* Said here rather than only implied by a dirty marker: the rewritten text is sitting in
              the editor below, and someone who does not know that will look for a file that changed
              and find none. */}
          <div className="notice">
            The rewritten description is in the editor below, unsaved. Read it, then Save or Revert.
          </div>
          {result.document.changes.map((change, i) => (
            <div key={i} className="sync-change">
              <span className="grow">{change.summary}</span>
              {change.requirements.length > 0 ? <span className="sub">{change.requirements.join(", ")}</span> : null}
            </div>
          ))}
        </section>
      ) : null}

      {result.edits !== undefined ? <Edits edits={result.edits} {...(onOpenEdit ? { onOpen: onOpenEdit } : {})} /> : null}

      {result.notes.length > 0 ? (
        <section className="sync-section">
          <h3>Notes</h3>
          {result.notes.map((note, i) => (
            <div key={i} className="notice warn">
              {note}
            </div>
          ))}
        </section>
      ) : null}

      <Findings result={result} />

      {result.extras.length > 0 ? (
        <section className="sync-section">
          <h3>
            <span>Not described by the document</span>
            <span className="count">{result.extras.length}</span>
          </h3>
          {result.extras.map((extra, i) => (
            <div key={i} className="sync-finding">
              <div className="grow">{extra.detail}</div>
              {extra.states.length > 0 ? <div className="sub sync-states">{extra.states.join(" · ")}</div> : null}
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

/**
 * The description's viewer: the sync bar, then either the report or the rendered markdown.
 *
 * The two are a toggle rather than a stack. Both are long — a report is one block per requirement,
 * a description is a document — and the panel is half a column; putting them one above the other
 * would mean the thing you just asked for arrives below a page of something else.
 */
export function WorkflowSyncPanel(props: FileSurfaceProps): JSX.Element {
  const { doc, busy, context } = props;
  const sync = context.sync;
  /**
   * Which half the reader has asked for, and which result they asked it ABOUT.
   *
   * Derived rather than an effect that flips a flag when a result arrives. The default follows the
   * data — a report if there is one, the preview otherwise — and a preference is remembered only
   * against the result it was expressed about, so the next sync shows its own findings instead of
   * whatever the last toggle happened to leave behind.
   */
  const [preferred, setPreferred] = useState<{ for: WorkflowSyncResult | null; view: "report" | "preview" } | null>(
    null,
  );

  const key = docKey(doc.layer, doc.path);
  const held = context.drafts?.[key];
  const dirty = held !== undefined && held !== doc.text;

  // Destructured so the effect depends on the store's stable action rather than on the context bag,
  // which is rebuilt on every render of the shell.
  const refresh = sync?.refresh;
  useEffect(() => {
    refresh?.(doc.layer, doc.path);
  }, [refresh, doc.layer, doc.path]);

  const result = sync?.result ?? null;
  const showing =
    preferred !== null && preferred.for === result ? preferred.view : result !== null ? "report" : "preview";

  const status = sync?.status ?? null;
  const drift = driftOf(status, dirty);
  const running = sync?.running === true;
  const blocked = status?.blocked;

  return (
    <div className="sync-panel">
      <div className="sync-head">
        <div className="sync-line">
          <span className="grow">{syncSentence(status, drift)}</span>
          {status?.synced && status.at !== undefined ? (
            <span className="sub" title={new Date(status.at).toLocaleString()}>
              last synced {agoOf(status.at, Date.now())}
            </span>
          ) : null}
        </div>

        <div className="sync-actions">
          {DIRECTIONS.map((direction) => (
            <button
              key={direction}
              className={drift.suggested === direction ? "" : "ghost"}
              disabled={running || busy || blocked !== undefined || sync === undefined}
              title={SYNC_HINT[direction]}
              onClick={() => sync?.run(direction)}
            >
              {SYNC_LABEL[direction]}
            </button>
          ))}
          {running ? (
            <button className="ghost" onClick={() => sync?.cancel()}>
              Cancel
            </button>
          ) : null}
          {result !== null || running ? (
            <button
              className="ghost sync-toggle"
              disabled={result === null}
              onClick={() => setPreferred({ for: result, view: showing === "report" ? "preview" : "report" })}
            >
              {showing === "report" ? "Preview" : "Report"}
            </button>
          ) : null}
        </div>

        {/* What this document is NOT answerable for. Above the buttons rather than in the report,
            because it changes what the buttons mean: a sync here will not touch these states, and
            someone who just edited one needs to know that before pressing anything — not after
            reading a proposal that does not mention the file they changed. */}
        {status?.delegated?.length ? (
          <div className="sub sync-delegated">
            Described elsewhere:{" "}
            {status.delegated.map((d, i) => (
              <span key={d.document}>
                {i > 0 ? " · " : ""}
                <b>{d.root}</b> ({plural(d.states, "state")}) by{" "}
                {sync?.openDocument ? (
                  <button className="link" onClick={() => sync.openDocument?.(doc.layer, d.document)}>
                    {d.document}
                  </button>
                ) : (
                  d.document
                )}
              </span>
            ))}
          </div>
        ) : null}

        {running ? <div className="sub">Reading the workflows and the description…</div> : null}
        {sync?.error ? <div className="notice bad">{sync.error}</div> : null}
        {status?.pending !== undefined && !running ? (
          <div className="sub">
            A proposal from this session is still unsaved — the baseline moves when you save it.
          </div>
        ) : null}
      </div>

      <div className="sync-body">
        {showing === "report" && result !== null ? (
          <Report result={result} {...(sync?.openEdit ? { onOpenEdit: sync.openEdit } : {})} />
        ) : (
          <MarkdownView {...props} />
        )}
      </div>
    </div>
  );
}
