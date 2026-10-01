import { useEffect, useRef, type ComponentType, type JSX, type ReactNode } from "react";
import type { BoardCard, BoardColumn, BoardView, ConnectPlan, InstanceNode, StateChild, TaskConnectResult } from "@jaira/shared/browser";
import type { DragOffers } from "@jaira/ui/taskDrag";
import { Board, RunBoard } from "@jaira/universal";

/**
 * A drag held part-way (decision 0015): the board with a card in the air over a column, the drop not yet
 * made — and one where it was, and the move table asked first. Each is driven as the reference page was:
 * a `dragstart` on the card (found by its title) and a `dragover` on the column (found by its heading),
 * real DOM drag events the boards' own handlers take, so what is photographed is what their HTML5 drag
 * draws. `connect.ask` answers from a fixture, at once (or never, for `asking`).
 *
 *  - `board-drag-move`     over a column a move reaches: the target dashed, the fill, and the preview with
 *                          its facts and the accent line
 *  - `board-drag-adopt`    over a column that adopts: the preview's `code`
 *  - `board-drag-refused`  over a column the task cannot reach: no dash, the preview saying why
 *  - `board-drag-offer`    over a column a waiting rule offered (`dragOffers`): dashed and filled, no preview
 *  - `board-drag-asking`   the dry run not back yet: "Working out what a drop does…"
 *  - `board-drag-confirm`  dropped on a column whose move asks first: the question under its cards
 *  - `run-board-drag`      a run's board (`RunBoard`): the execution the run rests on, held over the
 *                          column a waiting rule offers — dashed and filled, no preview
 */
export interface DragSpecimen {
  width: number;
  rn: ComponentType;
}

const NOW = Date.now();
const none = (): void => undefined;

const cardOf = (over: Partial<BoardCard> & Pick<BoardCard, "taskId" | "title">): BoardCard =>
  ({
    status: "completed",
    activeStatus: "completed",
    workflow: "feature",
    activeStateId: "feature/product",
    activePath: [{ instanceId: "i-1", stateId: "feature/product" }],
    hasSubBoard: false,
    updatedAt: NOW,
    endedAt: NOW - 12 * 60_000,
    ...over,
  }) as BoardCard;

const LIFTED = cardOf({ taskId: "t-lift", title: "add dark mode" });
const OTHER = cardOf({ taskId: "t-other", title: "rework the sync lint", status: "running", activeStatus: "running", activeStateId: "feature/ux", activePath: [{ instanceId: "i-2", stateId: "feature/ux" }], endedAt: undefined });
const column = (key: string, label: string, cards: BoardCard[] = []): BoardColumn => ({ key, stateId: `feature/${key}`, label, cards }) as BoardColumn;

const BOARD: BoardView = {
  level: "feature",
  columns: [column("product", "Product", [LIFTED]), column("ux", "UX", [OTHER]), column("build", "Build")],
  atLevel: [],
  finished: [],
} as unknown as BoardView;

const plan = (patch: Partial<ConnectPlan>): ConnectPlan => ({ resolution: "move", workflow: "feature", standsAt: { path: ["ux"], stateId: "feature/ux" }, inputs: [], asks: [], ...patch });

/** What the dry run says of each column, by key. */
const MOVE: Record<string, TaskConnectResult> = {
  ux: {
    ok: true,
    dryRun: true,
    plan: plan({
      move: { direction: "forward", to: "ux", path: [], passes: ["design"] },
      inputs: [{ name: "brief", via: "wire", from: "product.brief" }],
      asks: [{ state: "feature/ux", name: "notes", reason: "no wire" }],
      branch: "feature/dark-mode",
    }),
  },
  build: { ok: false, dryRun: true, refusal: { code: "illegal", message: "Build is not reached from Product by anything the workflow defines." }, plan: plan({ standsAt: { path: ["build"], stateId: "feature/build" } }) },
};
const ADOPT: Record<string, TaskConnectResult> = {
  ux: { ok: true, dryRun: true, plan: plan({ resolution: "adopt", workflowLabel: "Exploration", adoptedAs: "explore", standsAt: { path: ["ux", "explore"], stateId: "feature/ux/explore" } }) },
};
const CONFIRM: Record<string, TaskConnectResult> = {
  ux: {
    ok: true,
    dryRun: true,
    plan: plan({
      move: { direction: "backward", to: "ux", path: [], passes: [] },
      judgement: { where: "behind", activity: "working", way: "back", confirm: "stop-and-rewind", sentence: "This task is working. Stop it and go back to UX?" } as never,
    }),
  },
};

const askFrom =
  (answers: Record<string, TaskConnectResult> | null) =>
  (_card: BoardCard, col: Pick<BoardColumn, "key">): Promise<TaskConnectResult> =>
    answers === null ? new Promise(() => undefined) : Promise.resolve(answers[col.key] ?? { ok: false, dryRun: true, refusal: { code: "unknown-target", message: "No." } });

/** A wait offering the lifted card a move to Build. */
const OFFERS: DragOffers = new Map([[LIFTED.taskId, new Map([["build", "r-1"]])]]);

/** The element whose own words are `text`, under the specimen. */
const byText = (root: HTMLElement, text: string): HTMLElement | undefined =>
  [...root.querySelectorAll<HTMLElement>("*")].find((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent === text));

const fire = (target: Element, type: string, data: DataTransfer): void => {
  target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
};

/**
 * Picks the lifted card up and holds it over `over` — and lets go there, with `drop`. The drag events
 * the browser sends a real drag, in its order, a tick apart so the board draws between them.
 */
function Drive({ lift = LIFTED.title, over, drop = false, children }: { lift?: string; over: string; drop?: boolean; children: ReactNode }): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = box.current;
    if (root === null) return;
    const data = new DataTransfer();
    const at = (ms: number, go: () => void): ReturnType<typeof setTimeout> => setTimeout(go, ms);
    const timers = [
      at(30, () => {
        const card = byText(root, lift);
        if (card !== undefined) fire(card, "dragstart", data);
      }),
      at(90, () => {
        const heading = byText(root, over);
        if (heading === undefined) return;
        fire(heading, "dragenter", data);
        fire(heading, "dragover", data);
      }),
      at(150, () => {
        const heading = byText(root, over);
        if (heading !== undefined) fire(heading, "dragover", data);
        if (!drop || heading === undefined) return;
        fire(heading, "drop", data);
        const card = byText(root, lift);
        if (card !== undefined) fire(card, "dragend", data);
      }),
    ];
    return () => timers.forEach(clearTimeout);
  }, [lift, over, drop]);
  return (
    <div ref={box} style={{ display: "contents" }}>
      {children}
    </div>
  );
}

function dragSpecimen({ answers, offers, over, drop }: { answers: Record<string, TaskConnectResult> | null; offers?: DragOffers; over: string; drop?: boolean }): DragSpecimen {
  const common = {
    board: BOARD,
    selected: null,
    onSelectTask: none,
    onDrill: none,
    dragOffers: offers ?? new Map(),
    onTaskDrop: none,
    connect: { ask: askFrom(answers), onDrop: none, onMove: none },
  };
  return {
    width: 820,
    rn: () => (
      <Drive over={over} {...(drop === true ? { drop } : {})}>
        <Board {...common} />
      </Drive>
    ),
  };
}

/** A run of three declared children: two passes of `draft`, a `review` waiting, `publish` not reached. */
const node = (over: Partial<InstanceNode> & Pick<InstanceNode, "instanceId" | "childKey" | "status">): InstanceNode =>
  ({ stateId: `feature/plan/${over.childKey}`, index: 0, superseded: false, startedAt: NOW - 20 * 60_000, children: [], ...over }) as InstanceNode;
const RUN: InstanceNode = node({
  instanceId: "i-run",
  childKey: "plan",
  status: "waiting_for_user",
  children: [
    node({ instanceId: "i-d1", childKey: "draft", status: "completed", superseded: true, endedAt: NOW - 18 * 60_000, inputs: { issue: "# add dark mode" } }),
    node({ instanceId: "i-d2", childKey: "draft", status: "completed", startedAt: NOW - 15 * 60_000, endedAt: NOW - 14 * 60_000, inputs: { issue: "# add dark mode", notes: "tighter" } }),
    node({ instanceId: "i-r", childKey: "review", status: "waiting_for_user", startedAt: NOW - 10 * 60_000 }),
  ],
});
const DECLARED: StateChild[] = [
  { key: "draft", stateId: "feature/plan/draft", label: "Draft", hasChildren: false },
  { key: "review", stateId: "feature/plan/review", label: "Review", hasChildren: false },
  { key: "publish", stateId: "feature/plan/publish", label: "Publish", hasChildren: false },
];
const RUN_OFFERS: ReadonlyMap<string, string> = new Map([["publish", "r-9"]]);

const RUN_BOX = { height: 220, display: "flex", flexDirection: "column" } as const;

function runSpecimen(): DragSpecimen {
  const common = { declared: DECLARED, parent: RUN, openInstance: null, onSelect: none, onOpen: none, offers: RUN_OFFERS, onDrop: none };
  return {
    width: 820,
    // In a box shorter than the board, as the run's column is: it scrolls, and Chromium composites a
    // scroller that scrolls (which decides how its text is smoothed), as it does in the room.
    rn: () => (
      <Drive lift="review" over="Publish">
        <div style={RUN_BOX}>
          <RunBoard {...common} />
        </div>
      </Drive>
    ),
  };
}

export const DRAG_SPECIMENS: Record<string, DragSpecimen> = {
  "run-board-drag": runSpecimen(),
  "board-drag-move": dragSpecimen({ answers: MOVE, over: "UX" }),
  "board-drag-adopt": dragSpecimen({ answers: ADOPT, over: "UX" }),
  "board-drag-refused": dragSpecimen({ answers: MOVE, over: "Build" }),
  "board-drag-offer": dragSpecimen({ answers: MOVE, offers: OFFERS, over: "Build" }),
  "board-drag-asking": dragSpecimen({ answers: null, over: "UX" }),
  "board-drag-confirm": dragSpecimen({ answers: CONFIRM, over: "UX", drop: true }),
};
