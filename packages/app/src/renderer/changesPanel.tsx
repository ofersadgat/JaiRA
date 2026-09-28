/**
 * The side panel's Changes tab: what a task changed, as the tool menu groups tools — Files, Execution,
 * Web, Git, Tasks & workflows, MCP, Other — each a white card on the panel's ground that folds from its
 * head (the rulings of 2026-09-26, round 5's design 2 inverted).
 *
 * Files is a tree: one-child folders merged into one row (`src/renderer`), every folder folding, each
 * file in the colour of what happened to it — created green, deleted red and struck through, renamed
 * with where it came from — and its hunks a click away. Git leads with a banner per merge request
 * (the link opens it in the browser), then the steps as a ladder, then what changed since the last
 * commit. Everything else is one line per change.
 *
 * The data is `task:changes` (`changeLog.ts`): the task's own record of calls, judged by the read-only
 * permission set, with its subagents' and subtasks' changes attributed — and the header's switch
 * takes those out.
 */
import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import { changeCountOf, ownChangesOf, type ChangeAuthor, type ChangeItem, type FileChange, type MergeRequestView, type TaskChangeLog } from "@jaira/shared/browser";
import { Switch } from "./controls";
import { Icon } from "./icons";
import { ShellLine } from "./shellLine";
import { invoke } from "./store";
import { clockOf } from "./transcriptView";
import { useValuePanel } from "./valuePanel";
import { GROUPS, LETTER, STATE_WORDS, STEP_WORDS, baseOf, fromOf, groupFactsOf, hasAuthored, treeOf, type GroupId } from "./changesModel";

type IconName = Parameters<typeof Icon>[0]["name"];

// The groups, what each head says, the tree and the words live in `changesModel.ts`, shared with the
// universal copy (decision 0015); `treeOf` is re-exported here, where its callers have always found it.
export { treeOf };

export interface ChangesPanelProps {
  taskId: string;
  project?: string | undefined;
  /** Moves when the task goes on — a new turn, a new status — and the log is read again. */
  signal: unknown;
  /** "Review these changes", for a task with a worktree of its own. */
  onReview?: (() => void) | undefined;
  /** Open another task — a subtask that made some of these changes. */
  onOpenTask?: ((taskId: string) => void) | undefined;
}

export function ChangesPanel({ taskId, project, signal, onReview, onOpenTask }: ChangesPanelProps): JSX.Element {
  const [log, setLog] = useState<TaskChangeLog | "error" | undefined>(undefined);
  const [others, setOthers] = useState(true);
  const [folded, setFolded] = useState<ReadonlySet<GroupId>>(new Set());
  useEffect(() => {
    let live = true;
    void invoke("task:changes", { taskId, ...(project !== undefined ? { project } : {}) })
      .then((next) => live && setLog(next))
      .catch(() => live && setLog("error"));
    return () => {
      live = false;
    };
  }, [taskId, project, signal]);
  const shown = useMemo(() => (log === undefined || log === "error" ? undefined : others ? log : ownChangesOf(log)), [log, others]);
  if (log === undefined) return <p className="empty">Reading what this task changed…</p>;
  if (log === "error") return <p className="empty">What this task changed could not be read.</p>;
  const authored = hasAuthored(log);
  const count = changeCountOf(shown!);
  const fold = (id: GroupId): void => setFolded((was) => (was.has(id) ? new Set([...was].filter((one) => one !== id)) : new Set([...was, id])));
  const ctx: Ctx = { onOpenTask, currentTask: taskId };
  return (
    <div className="chg">
      <div className="chg-bar">
        <span>{count === 1 ? "1 change" : `${count} changes`}</span>
        {authored ? (
          <label className="chg-opt">
            Subagents &amp; subtasks
            <Switch on={others} label="Include what subagents and subtasks changed" onChange={setOthers} />
          </label>
        ) : null}
      </div>
      {onReview !== undefined && shown!.files.length > 0 ? (
        <div className="chg-actions">
          <button type="button" onClick={onReview}>
            Review these changes
          </button>
        </div>
      ) : null}
      {count === 0 ? <p className="empty chg-empty">Nothing here has changed anything yet.</p> : null}
      {GROUPS.map((group) => {
        const body = groupBody(group.id, shown!, ctx);
        if (body === null) return null;
        const open = !folded.has(group.id);
        return (
          <section key={group.id} className={`chg-card${open ? "" : " folded"}`} data-group={group.id}>
            <button type="button" className="chg-head" aria-expanded={open} onClick={() => fold(group.id)}>
              <span className="chg-fold">
                <Icon name="chevron" />
              </span>
              <span className="chg-icon">
                <Icon name={group.icon} />
              </span>
              <span className="chg-name">{group.name}</span>
              <span className="chg-sum">{body.summary}</span>
              <span className="chg-n">{body.count}</span>
            </button>
            {open ? <div className="chg-body">{body.node}</div> : null}
          </section>
        );
      })}
    </div>
  );
}

interface Ctx {
  onOpenTask?: ((taskId: string) => void) | undefined;
  currentTask: string;
}

function groupBody(id: GroupId, log: TaskChangeLog, ctx: Ctx): { summary: ReactNode; count: number; node: ReactNode } | null {
  const facts = groupFactsOf(id, log);
  if (facts === null) return null;
  const summary: ReactNode =
    facts.summary.kind === "files" ? (
      <>
        {facts.summary.added > 0 ? <span className="chg-add">+{facts.summary.added}</span> : null} {facts.summary.removed > 0 ? <span className="chg-del">−{facts.summary.removed}</span> : null}
      </>
    ) : facts.summary.kind === "branch" ? (
      <code>{facts.summary.branch}</code>
    ) : (
      facts.summary.text
    );
  const node: ReactNode =
    id === "files" ? (
      <FileTree files={log.files} ctx={ctx} />
    ) : id === "git" ? (
      <GitBody git={log.git} ctx={ctx} />
    ) : (
      log[id].map((item) => <ItemRow key={item.call} item={item} icon={GROUPS.find((g) => g.id === id)!.icon} ctx={ctx} />)
    );
  return { summary, count: facts.count, node };
}

// --- who made it ------------------------------------------------------------------------------------

function By({ by, ctx }: { by: ChangeAuthor | undefined; ctx: Ctx }): JSX.Element | null {
  if (by === undefined) return null;
  if (by.kind === "subagent") {
    return (
      <span className="chg-by" title="Made by a subagent this conversation spawned">
        ⑂ {by.name}
      </span>
    );
  }
  return ctx.onOpenTask !== undefined ? (
    <button type="button" className="chg-by link" title="Made by a task this one started — open it" onClick={() => ctx.onOpenTask!(by.taskId)}>
      ↳ {by.name}
    </button>
  ) : (
    <span className="chg-by">↳ {by.name}</span>
  );
}

/** A page outside the app — opens in the browser (the window's open handler sends it there). */
function Out({ url, children, title }: { url: string; children: ReactNode; title?: string }): JSX.Element {
  return (
    <a className="chg-out" href={url} target="_blank" rel="noreferrer noopener" title={title ?? url}>
      {children}
      <Icon name="external" />
    </a>
  );
}

// --- files -------------------------------------------------------------------------------------------

function FileTree({ files, ctx }: { files: readonly FileChange[]; ctx: Ctx }): JSX.Element {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => treeOf(files), [files]);
  const toggle = (set: ReadonlySet<string>, key: string): Set<string> => (set.has(key) ? new Set([...set].filter((one) => one !== key)) : new Set([...set, key]));
  let hiddenUnder: string | undefined;
  return (
    <div className="chg-tree">
      {rows.map((row) => {
        const key = row.kind === "folder" ? row.key : row.file.path;
        if (hiddenUnder !== undefined && key.startsWith(hiddenUnder)) return null;
        hiddenUnder = undefined;
        if (row.kind === "folder") {
          const shut = closed.has(row.key);
          if (shut) hiddenUnder = row.key;
          return (
            <button key={row.key} type="button" className={`chg-folder${shut ? " shut" : ""}`} style={{ paddingLeft: 8 + row.depth * 14 }} aria-expanded={!shut} onClick={() => setClosed((was) => toggle(was, row.key))}>
              <span className="chg-fold">
                <Icon name="chevron" />
              </span>
              <Icon name="folder" />
              <span className="ellip">{row.name}</span>
            </button>
          );
        }
        const file = row.file;
        const open = opened.has(file.path);
        const canOpen = file.hunks.length > 0;
        const from = fromOf(file);
        return (
          <div key={file.path} className={`chg-file-wrap${open ? " open" : ""}`}>
            <button
              type="button"
              className={`chg-file k-${file.action}`}
              style={{ paddingLeft: 26 + row.depth * 14 }}
              aria-expanded={canOpen ? open : undefined}
              disabled={!canOpen}
              title={file.path}
              onClick={() => setOpened((was) => toggle(was, file.path))}
            >
              <span className="chg-file-icon">
                <Icon name={file.action === "create" ? "fileAdd" : file.action === "delete" ? "fileDel" : "fileEdit"} />
              </span>
              <span className="chg-file-main">
                <span className="chg-file-name ellip">{baseOf(file.path)}</span>
                {from !== undefined ? (
                  <span className="chg-file-from ellip">
                    from <s>{from}</s>
                  </span>
                ) : null}
              </span>
              <By by={file.by} ctx={ctx} />
              <span className="chg-counts">
                {file.added !== undefined ? (
                  <>
                    {file.added > 0 ? <span className="chg-add">+{file.added}</span> : null}
                    {(file.removed ?? 0) > 0 ? <span className="chg-del">−{file.removed}</span> : null}
                  </>
                ) : file.command !== undefined ? (
                  <span className="chg-cmd">
                    by <code>{file.command}</code>
                  </span>
                ) : null}
              </span>
              <span className="chg-letter">{LETTER[file.action]}</span>
            </button>
            {open ? (
              <pre className="chg-hunks">
                {file.hunks.map((hunk, h) => (
                  <span key={h} className="chg-hunk">
                    {hunk.header !== "" ? <span className="ln hd">{hunk.header}</span> : null}
                    {hunk.lines.slice(0, 400).map((line, i) => (
                      <span key={i} className={`ln ${line.startsWith("+") ? "a" : line.startsWith("-") ? "d" : "c"}`}>
                        {line.length > 0 ? line : " "}
                      </span>
                    ))}
                  </span>
                ))}
              </pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// --- git ----------------------------------------------------------------------------------------------

function Banner({ request, ctx }: { request: MergeRequestView; ctx: Ctx }): JSX.Element {
  const title = (
    <>
      <b>!{request.number}</b> {request.title ?? ""}
    </>
  );
  return (
    <div className="chg-banner">
      <div className="chg-banner-top">
        <Icon name="git" />
        {request.url !== undefined ? (
          <Out url={request.url} title={`Open merge request !${request.number} in the browser`}>
            {title}
          </Out>
        ) : (
          <span className="chg-banner-title">{title}</span>
        )}
      </div>
      <div className="chg-banner-line">
        {request.branch !== undefined ? (
          <span className="chg-branches">
            <code>{request.branch}</code>
            {request.target !== undefined ? (
              <>
                {" → "}
                <code>{request.target}</code>
              </>
            ) : null}
          </span>
        ) : null}
        <span className={`chg-pill ${request.state}`}>{STATE_WORDS[request.state]}</span>
        <By by={request.by} ctx={ctx} />
      </div>
    </div>
  );
}

function GitBody({ git, ctx }: { git: TaskChangeLog["git"]; ctx: Ctx }): JSX.Element {
  return (
    <>
      {git.requests.map((request) => (
        <Banner key={request.number} request={request} ctx={ctx} />
      ))}
      <ol className="chg-ladder">
        {git.steps.map((step) => (
          <li key={`${step.call}:${step.kind}:${step.command ?? ""}`} className="chg-step">
            <span className="chg-dot" />
            <div className="chg-line">
              <div className="chg-said">
                {STEP_WORDS[step.kind]}{" "}
                {step.kind === "other" && step.command !== undefined ? (
                  <code>
                    <ShellLine line={step.command} />
                  </code>
                ) : step.subject !== undefined ? (
                  step.url !== undefined ? (
                    <Out url={step.url}>
                      <code>{step.subject}</code>
                    </Out>
                  ) : (
                    <code>{step.subject}</code>
                  )
                ) : null}
              </div>
              {step.detail !== undefined || step.by !== undefined ? (
                <div className="chg-sub">
                  {step.detail !== undefined ? <span className="ellip">{step.detail}</span> : null}
                  <By by={step.by} ctx={ctx} />
                </div>
              ) : null}
            </div>
            <span className="chg-at">{clockOf(step.at)}</span>
          </li>
        ))}
        {git.uncommitted.length > 0 ? (
          <li className="chg-step todo">
            <span className="chg-dot" />
            <div className="chg-line">
              <div className="chg-said">{git.uncommitted.length === 1 ? "1 file changed since the last commit" : `${git.uncommitted.length} files changed since the last commit`}</div>
              <div className="chg-sub">
                <span className="ellip">
                  {git.uncommitted.slice(0, 3).map((path, i) => (
                    <span key={path}>
                      {i > 0 ? ", " : ""}
                      <code>{baseOf(path)}</code>
                    </span>
                  ))}
                  {git.uncommitted.length > 3 ? ` and ${git.uncommitted.length - 3} more` : ""} · not committed
                </span>
              </div>
            </div>
          </li>
        ) : null}
      </ol>
    </>
  );
}

// --- everything else ------------------------------------------------------------------------------------

function ItemRow({ item, icon, ctx }: { item: ChangeItem; icon: IconName; ctx: Ctx }): JSX.Element {
  const panel = useValuePanel();
  const subject =
    item.subject === undefined ? null : item.url !== undefined ? (
      <Out url={item.url}>
        <code>{item.subject}</code>
      </Out>
    ) : item.open?.stateId !== undefined && panel?.openState !== undefined ? (
      <button type="button" className="link chg-in" title="Open its definition" onClick={() => panel.openState!(item.open!.stateId!)}>
        <code>{item.subject}</code>
      </button>
    ) : (
      <code>{item.subject}</code>
    );
  const task = item.open?.taskId;
  return (
    <div className="chg-item">
      <span className="chg-item-icon">
        <Icon name={icon} />
      </span>
      <div className="chg-line">
        <div className="chg-said">
          {item.said} {subject}
          {item.url !== undefined && item.subject === undefined ? <Out url={item.url}>open</Out> : null}
        </div>
        {item.command !== undefined || item.detail !== undefined || item.by !== undefined || (task !== undefined && task !== ctx.currentTask) ? (
          <div className="chg-sub">
            {item.command !== undefined ? (
              <code className="ellip">
                <ShellLine line={item.command} />
              </code>
            ) : null}
            {item.detail !== undefined ? <span className="ellip">{item.detail}</span> : null}
            {task !== undefined && task !== ctx.currentTask && ctx.onOpenTask !== undefined ? (
              <button type="button" className="link chg-in" onClick={() => ctx.onOpenTask!(task)}>
                open the task
              </button>
            ) : null}
            <By by={item.by} ctx={ctx} />
          </div>
        ) : null}
      </div>
      <span className="chg-at">{clockOf(item.at)}</span>
    </div>
  );
}
