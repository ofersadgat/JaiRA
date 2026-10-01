/**
 * The Tasks board's right-click menus — a card's, a multi-selection's and a column's — and the one
 * confirmation inside them, as items and their actions. Moved unchanged out of `App.tsx` so the
 * universal shell (`packages/universal/src/app/BoardColumn.tsx`, decision 0015) offers the same verbs
 * with the same labels, notes and exemptions; each shell draws the menu and the dialog itself.
 *
 * The menu is the card's VERBS — open, run again, cancel, delete — which all existed before it
 * did, as a double-click, a button on the panel, or nothing at all. Right-click is where people
 * look for them, and it is the only place "delete" appears: destroying history is not a verb that
 * belongs one mis-click from a card's face.
 *
 * Right-clicking INSIDE a multi-selection offers the set the same verbs, each labelled with the
 * count it will actually touch — a verb a member is ineligible for skips that member and the note
 * says so, because "Re-run 3 tasks" doing something to two of them is how trust in a menu dies.
 * Right-clicking outside the selection collapses it to the clicked card first, explorer-style.
 */
import { isArchivableStatus, type BoardCard } from "@jaira/shared/browser";
import { boardCardOrderOf, type BoardPick } from "./boardModel";
import { isChatWorkflow } from "./chatWorkflow";
import type { AskSpec, MenuItem } from "./menuTypes";
import { invoke, type useApp } from "./store";

type Actions = ReturnType<typeof useApp>["actions"];
type State = ReturnType<typeof useApp>["state"];

/** Where a menu opens — the desktop's `MenuPoint`, or the universal shell's point. */
export interface MenuPlace {
  x: number;
  y: number;
}

/** A menu to draw: the point it was asked at, its items, and a caption. */
export type BoardMenu<P extends MenuPlace> = P & { items: MenuItem[]; title?: string };

/** What the menus read and what they change — the shell's state and setters. */
export interface BoardMenuHost<P extends MenuPlace> {
  actions: Pick<
    Actions,
    "rerunTasks" | "cancelTasks" | "archiveTasks" | "deleteTasks" | "select" | "openTask" | "rerunTask" | "cancelTask" | "runQueuedOn" | "drillProject" | "selectWorkflow"
  >;
  boards: State["boards"];
  queue: State["queue"];
  /** The board's selection (`pickCard`). */
  picked: BoardPick;
  setPicked: (picked: BoardPick) => void;
  /** Open a menu — also how "Run on…" replaces the menu with its workspaces. */
  setTaskMenu: (menu: BoardMenu<P>) => void;
  /** The confirmation a Delete… asks. */
  setTaskAsk: (ask: AskSpec | null) => void;
  /** Put text on the clipboard. */
  copy: (text: string) => void;
}

/** "3 tasks", "1 task" — the count a group verb is labelled with. */
export const plural = (k: number): string => `${k} task${k === 1 ? "" : "s"}`;

/**
 * One project's cards in the order the board DRAWS them — columns left to right, each split into
 * lanes, then the at-this-level tray — which is the order "everything in between" means to the
 * person shift-clicking.
 */
const boardCardsOf = (boards: State["boards"], project: string): BoardCard[] => boardCardOrderOf(boards[project]);

/**
 * The verbs a GROUP of tasks is offered — a multi-selection, or every card in a column.
 *
 * One builder for both, because they are the same menu asked for two different ways: a set
 * somebody gathered by shift-clicking, and a set the board had already drawn as a column. Two
 * copies of "re-run these, cancel these, delete these" is two copies that stop agreeing about
 * which of them a running task is exempt from.
 *
 * Each verb is labelled with the count it will ACTUALLY touch, and one a member is ineligible for
 * skips that member and says so in the note — "Re-run 3 tasks" doing something to two of them is
 * how trust in a menu dies.
 */
export function groupItems<P extends MenuPlace>(host: BoardMenuHost<P>, project: string, cards: readonly BoardCard[]): MenuItem[] {
  const { actions, setTaskAsk, setPicked } = host;
  const n = cards.length;
  const notRunning = cards.filter((c) => c.status !== "running");
  const cancelable = cards.filter((c) => c.status === "queued" || c.status === "running" || c.status === "interrupted");
  const archivable = cards.filter((c) => isArchivableStatus(c.status));
  const archived = cards.filter((c) => c.status === "archived");
  return [
    {
      label: `Re-run ${plural(notRunning.length)}`,
      disabled: notRunning.length === 0,
      ...(notRunning.length < n ? { note: "running skipped" } : {}),
      onSelect: () =>
        void actions.rerunTasks(
          notRunning.map((c) => c.taskId),
          project,
        ),
    },
    {
      label: `Cancel ${plural(cancelable.length)}`,
      disabled: cancelable.length === 0,
      ...(cancelable.length < n ? { note: "finished skipped" } : {}),
      onSelect: () =>
        void actions.cancelTasks(
          cancelable.map((c) => c.taskId),
          project,
        ),
    },
    // Archive what is finished, or bring back what is archived — whichever the selection holds.
    archived.length > archivable.length
      ? {
          label: `Unarchive ${plural(archived.length)}`,
          separator: true,
          note: "back on the board",
          onSelect: () => void actions.archiveTasks(archived.map((c) => c.taskId), project, true),
        }
      : {
          label: `Archive ${plural(archivable.length)}`,
          separator: true,
          disabled: archivable.length === 0,
          note: archivable.length < n ? "unfinished skipped" : "off the board",
          onSelect: () => void actions.archiveTasks(archivable.map((c) => c.taskId), project),
        },
    {
      label: "Copy task ids",
      separator: true,
      disabled: n === 0,
      onSelect: () => host.copy(cards.map((c) => c.taskId).join("\n")),
    },
    {
      label: `Delete ${plural(notRunning.length)}…`,
      separator: true,
      danger: true,
      disabled: notRunning.length === 0,
      ...(notRunning.length < n ? { note: "running skipped" } : {}),
      onSelect: () =>
        setTaskAsk({
          title: `Delete ${plural(notRunning.length)}?`,
          note: "This deletes each task, every run it made, and its worktree — uncommitted work included. None of it comes back.",
          confirmLabel: "Delete",
          danger: true,
          onConfirm: () => {
            setTaskAsk(null);
            setPicked(null);
            void actions.deleteTasks(
              notRunning.map((c) => c.taskId),
              project,
            );
          },
        }),
    },
  ];
}

/** A card's right-click: its own verbs, or the selection's when it is inside a multi-selection. */
export function openTaskMenu<P extends MenuPlace>(host: BoardMenuHost<P>, project: string, card: BoardCard, at: P): void {
  const { actions, picked, setPicked, setTaskMenu, setTaskAsk } = host;
  const set = picked !== null && picked.project === project && picked.ids.length > 1 && picked.ids.includes(card.taskId) ? picked.ids : null;

  if (set !== null) {
    const byId = new Map(boardCardsOf(host.boards, project).map((c) => [c.taskId, c] as const));
    const cards = set.map((id) => byId.get(id)).filter((c): c is BoardCard => c !== undefined);
    setTaskMenu({ ...at, title: plural(cards.length), items: groupItems(host, project, cards) });
    return;
  }

  // Selecting first, so the panel beside the menu describes the card the menu is about — the
  // same answer a plain click gives, and the confirmation dialog then names a task whose detail
  // is on screen.
  setPicked({ project, ids: [card.taskId], anchor: card.taskId });
  actions.select(card.taskId, project);
  const running = card.status === "running";
  const terminal = card.status === "completed" || card.status === "failed" || card.status === "canceled" || card.status === "archived";
  // Opening a card follows the same level rule as double-clicking it — see the Board's
  // `onOpenTask`.
  const level = host.boards[project]?.level ?? "";
  // Waiting for a workspace (decision 0013 §5): sent to one by hand, before it starts (ruled "4a").
  const waiting = host.queue.some((q) => q.taskId === card.taskId);
  const runOn: MenuItem[] = waiting
    ? [
        {
          label: "Run on…",
          note: "choose a workspace",
          onSelect: () =>
            void invoke("placement:view", { project }).then((view) =>
              setTaskMenu({
                ...at,
                title: "Run on",
                items: view.workspaces.map((w) => ({
                  label: `${w.label} · ${w.dir}`,
                  note: w.why ?? "has room",
                  // Offline, or missing a tag its workflow needs: it could not run there at all.
                  disabled: w.why === "offline" || (w.why ?? "").startsWith("not "),
                  onSelect: () => void actions.runQueuedOn(card.taskId, project, w.project),
                })),
              }),
            ),
        },
      ]
    : [];
  const items: MenuItem[] = [
    ...runOn,
    {
      label: "Open",
      onSelect: () => actions.openTask(card.taskId, project, level === "" ? card.workflow : level),
    },
    {
      // The same distinctions the task panel's button draws, plus the one it cannot: a FINISHED
      // task reruns as a fresh copy ("task:rerun"), and the label says so rather than letting
      // "Re-run" quietly mean "make another task".
      //
      // A CONVERSATION is the same story arrived at differently. Re-running one in place would
      // start a second conversation in the same task, and a thread is read from the latest run —
      // so everything already said would still be in the database and reachable from nowhere.
      // `task:rerun` copies it instead, and this is where that stops being a surprise.
      label: card.status === "queued" ? "Start" : terminal || isChatWorkflow(card.workflow) ? "Re-run as a new task" : "Re-run",
      disabled: running,
      ...(terminal || isChatWorkflow(card.workflow) ? { note: "fresh copy" } : {}),
      onSelect: () => void actions.rerunTask(card.taskId, project),
    },
    {
      label: "Cancel",
      // A terminal task has nothing left to cancel; the item stays, disabled, so the menu keeps
      // one shape and the reason a verb is unavailable is visible where it would have been.
      disabled: terminal,
      onSelect: () => void actions.cancelTask(card.taskId, project),
    },
    { label: "Copy task id", separator: true, onSelect: () => host.copy(card.taskId) },
    // Archive once it has finished; an archived one comes back (the person, 2026-09-27).
    ...(card.status === "archived"
      ? [{ label: "Unarchive", separator: true, note: "back on the board", onSelect: () => void actions.archiveTasks([card.taskId], project, true) }]
      : isArchivableStatus(card.status)
        ? [{ label: "Archive", separator: true, note: "off the board", onSelect: () => void actions.archiveTasks([card.taskId], project) }]
        : []),
    {
      label: "Delete…",
      separator: true,
      danger: true,
      disabled: running,
      onSelect: () =>
        setTaskAsk({
          title: `Delete "${card.title}"?`,
          note: "This deletes the task, every run it made, and its worktree — uncommitted work included. None of it comes back.",
          confirmLabel: "Delete",
          danger: true,
          onConfirm: () => {
            setTaskAsk(null);
            void actions.deleteTasks([card.taskId], project);
          },
        }),
    },
  ];
  setTaskMenu({ ...at, items });
}

/**
 * Right-clicking a COLUMN — the place, and everything standing in it.
 *
 * A column already had a left-click meaning (describe the state it stands for) and a double-click
 * one (open it), and no right-click at all — so the gesture that works on every card in a column
 * did nothing on the column those cards are in.
 *
 * The menu is the column's own two verbs, then "select", then the group's. "Select" is what joins
 * this to the multi-selection: it fills the same set a shift-click builds, so a column is a way of
 * GATHERING tasks rather than a second, parallel way of acting on them.
 */
export function openColumnMenu<P extends MenuPlace>(host: BoardMenuHost<P>, project: string, stateId: string, at: P): void {
  const { actions, setPicked, setTaskMenu } = host;
  // Every column standing for this state, in the order the board draws its cards — a menu that
  // said "select 6 tasks" and then picked a different six than the ones under it would be worse
  // than no menu. `boardCardsOf` is the same order shift-click measures its ranges in.
  const here = new Set((host.boards[project]?.columns ?? []).filter((c) => c.stateId === stateId).flatMap((c) => c.cards.map((k) => k.taskId)));
  const cards = boardCardsOf(host.boards, project).filter((c) => here.has(c.taskId));
  setTaskMenu({
    ...at,
    title: stateId,
    items: [
      { label: "Open", onSelect: () => actions.drillProject(project, stateId) },
      { label: "Describe", onSelect: () => actions.selectWorkflow(stateId, project) },
      {
        label: `Select ${plural(cards.length)}`,
        separator: true,
        disabled: cards.length === 0,
        onSelect: () => {
          // The ANCHOR is the column's FIRST card, so a shift-click afterwards extends from the
          // top of what was just selected rather than from wherever the panel is pointing.
          setPicked({ project, ids: cards.map((c) => c.taskId), anchor: cards[0]!.taskId });
          actions.select(cards[cards.length - 1]!.taskId, project);
        },
      },
      ...groupItems(host, project, cards).map((item, i) => (i === 0 ? { ...item, separator: true } : item)),
    ],
  });
}
