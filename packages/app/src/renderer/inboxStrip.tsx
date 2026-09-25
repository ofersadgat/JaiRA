/**
 * The inbox strip at the foot of the window: what is awaiting you, and — at its right end — the
 * newest event notice you have not read (decision 0010 §4; the approved mockup's option A).
 */
import type { CSSProperties, JSX } from "react";
import type { PendingApproval, PendingInteraction, PendingQuestion, ProjectSummary } from "@jaira/shared/browser";
import { SHARED_SESSION } from "@jaira/shared/browser";
import { Pill } from "./pill";
import { projectName } from "./projects";
import { awaitingCount, moreTitle, noticeMeta, noticeTitle, type ShownNotice } from "./noticesModel";

/**
 * The approvals strip.
 *
 * Command approvals come first: an agent's tool loop is blocked until one is answered, whereas a
 * workflow gate is a state politely waiting. Both live here rather than in a sidebar, because this
 * is the only surface in the app that is genuinely interrupt-driven.
 *
 * A NOTICE sits apart, after a spacer: an automation's "tell me" asks nothing of anyone, so it is
 * quiet (the dim voice, no pill colour) and is not in the "Awaiting you" count. The strip is drawn
 * for a notice alone too, with nothing awaiting — then without the label and its pill, which would
 * say "0".
 */
export function InboxStrip({
  pending,
  approvals,
  questions,
  projects,
  hues,
  onSelect,
  notice,
  now = Date.now(),
  onOpenNotice,
  onDismissNotice,
}: {
  pending: PendingInteraction[];
  approvals: PendingApproval[];
  questions: PendingQuestion[];
  projects: ProjectSummary[];
  /** Directory → the colour that project wears everywhere else. See `hueOf`. */
  hues: Readonly<Record<string, string>>;
  onSelect: (taskId: string, project: string) => void;
  /** The notice to show — `noticeToShow` — or none. */
  notice?: ShownNotice | undefined;
  /** What the notice's age is measured against. */
  now?: number;
  onOpenNotice?: ((shown: ShownNotice["notice"]) => void) | undefined;
  onDismissNotice?: ((shown: ShownNotice["notice"]) => void) | undefined;
}): JSX.Element | null {
  const total = awaitingCount({ pending, approvals, questions });
  if (total === 0 && notice === undefined) return null;
  // The strip's own list is cross-project (`pendingApprovals()` flat-maps every session), so a row
  // has to say WHOSE task it is — and hand that project back with the click. Selecting on the task
  // id alone read the id against whichever project was focused. See SHELL.md §2.4.
  // The published label and hue when the project is still listed; the basename and the grey when it
  // is not, which is what a request outliving its session by a tick looks like.
  const chipOf = (project: string): { label: string; hue: string } => {
    // Shared's events task names its session by role; the root wears whatever its own row does.
    const found = project === SHARED_SESSION ? projects.find((p) => p.kind === "shared") : projects.find((p) => p.project === project);
    if (project === SHARED_SESSION) return { label: found?.label ?? "Shared", hue: (found !== undefined ? hues[found.project] : undefined) ?? "var(--p0)" };
    return {
      label: found?.label ?? projectName(project),
      hue: hues[project] ?? "var(--p0)",
    };
  };
  const shown = [
    // Questions first: the agent addressed the person directly, and its loop is parked on the reply.
    ...questions.slice(0, 2).map((item) => ({
      key: item.requestId,
      text: item.questions[0]?.question ?? "the agent has a question",
      title: item.questions.map((q) => q.question).join(" · "),
      taskId: item.taskId,
      project: item.project,
    })),
    ...approvals.slice(0, 2).map((item) => ({
      key: item.requestId,
      text: item.command ?? item.tool,
      title: item.reason ?? "",
      taskId: item.taskId,
      project: item.project,
    })),
    ...pending.slice(0, 2).map((item) => ({
      key: item.requestId,
      text: item.config?.prompt ?? item.component,
      title: item.component,
      taskId: item.taskId as string | undefined,
      project: item.project,
    })),
  ].slice(0, 3);
  return (
    <footer className="strip">
      {total > 0 ? (
        <>
          {/* App voice, sentence case. It was an uppercase warn-coloured label, which made the strip
              shout the same thing whether one thing was waiting or nine — the COUNT beside it is what
              varies, so the count is the coloured part. */}
          <span className="strip-label app-title">Awaiting you</span>
          <Pill kind="waiting" n={total} title={`${total} waiting on you`} />
        </>
      ) : null}
      {shown.map((item) => {
        const chip = chipOf(item.project);
        return (
          <span
            key={item.key}
            className="strip-item"
            title={item.title}
            onClick={() => (item.taskId ? onSelect(item.taskId, item.project) : undefined)}
          >
            {/* The project's hue, the same one its sidebar row and its address crumb carry — which is
                how a row here is tied back to somewhere without spelling out a path. */}
            <span className="chip strip-project" style={{ "--hue": chip.hue } as CSSProperties}>
              {chip.label}
            </span>
            <span className="ellip data-text">{item.text}</span>
          </span>
        );
      })}
      {total > shown.length ? <span className="more app-secondary">+{total - shown.length} more</span> : null}
      {notice !== undefined ? <NoticeItem shown={notice} chip={chipOf(notice.notice.project)} now={now} onOpen={onOpenNotice} onDismiss={onDismissNotice} /> : null}
    </footer>
  );
}

/**
 * The notice: 🔔, the project chip, the text, then the event and its age in the faint data voice,
 * "+N" for the older unread ones, and ×. Two buttons side by side — the item and its × — rather
 * than one inside the other, which HTML does not allow.
 */
function NoticeItem({
  shown,
  chip,
  now,
  onOpen,
  onDismiss,
}: {
  shown: ShownNotice;
  chip: { label: string; hue: string };
  now: number;
  onOpen?: ((notice: ShownNotice["notice"]) => void) | undefined;
  onDismiss?: ((notice: ShownNotice["notice"]) => void) | undefined;
}): JSX.Element {
  const { notice, more } = shown;
  const title = noticeTitle(notice);
  return (
    <>
      <span className="spacer" />
      <span className="strip-notice" data-notice={notice.id}>
        <button type="button" className="strip-notice-open" title={title} aria-label={`Notice from ${chip.label}: ${title}`} onClick={() => onOpen?.(notice)}>
          <span className="strip-bell" aria-hidden="true">
            🔔
          </span>
          <span className="chip strip-project" style={{ "--hue": chip.hue } as CSSProperties}>
            {chip.label}
          </span>
          <span className="strip-notice-text">{notice.text}</span>
          <span className="strip-notice-meta data-faint">{noticeMeta(notice, now)}</span>
          {more > 0 ? (
            <span className="strip-notice-more app-secondary" title={moreTitle(more)}>
              +{more}
            </span>
          ) : null}
        </button>
        <button type="button" className="quiet strip-dismiss" title="dismiss" aria-label="Dismiss this notice" onClick={() => onDismiss?.(notice)}>
          ×
        </button>
      </span>
    </>
  );
}
