/**
 * The specimens the snapshot harness photographs.
 *
 * Each one is a REAL component from `src/renderer`, given fixed props and framed at the same size
 * as the corresponding figure in the visual reference (`reference/the-shell.html`, SHELL.md §10), so
 * the two PNGs can be laid side by side and read as one comparison rather than two impressions.
 *
 * Nothing here may reimplement a surface. A specimen that draws its own markup answers a question
 * about the specimen; the only question worth asking is what the app draws, so the scaffolding
 * stops at the window frame and everything inside it is imported.
 */
import { useMemo, useState, type JSX, type ReactNode } from "react";
import type { BoardCard, BoardView, FileTree } from "@jaira/shared/browser";
import { defaultAppearance } from "@jaira/shared/browser";
import { GALLERY_SURFACES } from "@jaira/shared/browser";
import { AppearancePane } from "../src/renderer/appearancePane";
import { Board } from "../src/renderer/board";
import { ComponentGallery } from "../src/renderer/componentGallery";
import { Pill, Pills } from "../src/renderer/pill";
import { Sidebar, type SidebarAct } from "../src/renderer/sidebar";
import { StateGraphView } from "../src/renderer/stateGraphView";
import { StatePanel } from "../src/renderer/statePanel";
import { ValuePanelContext, type PinnedValue } from "../src/renderer/valuePanel";

/**
 * The clock the specimen's ages are measured back from.
 *
 * Read once at load rather than pinned to a date, because what has to be stable between runs is the
 * rendered STRING — "3 minutes ago" — and a card's age is computed against the real clock. A fixed
 * timestamp gives a reproducible number that grows by a day every day.
 */
export const NOW = Date.now();

const card = (c: Partial<BoardCard> & Pick<BoardCard, "taskId" | "title" | "status">): BoardCard => ({
  workflow: "feature",
  activePath: [],
  hasSubBoard: false,
  updatedAt: NOW,
  ...c,
});

/** The column of the reference's figure 06, card for card. */
const PLAN_CARDS: BoardCard[] = [
  card({
    taskId: "t1",
    title: "tighten the sync lint",
    status: "running",
    activeStatus: "running",
    activeStateId: "plan",
    hasSubBoard: true,
  }),
  card({ taskId: "t2", title: "rate limiter", status: "running", activeStatus: "running", activeStateId: "plan" }),
  card({
    taskId: "t3",
    title: "delete stale worktrees",
    status: "running",
    activeStatus: "waiting_for_user",
    activeStateId: "plan",
  }),
  card({ taskId: "t4", title: "token budget", status: "running", activeStatus: "blocked", activeStateId: "plan" }),
  card({ taskId: "t5", title: "retry policy", status: "completed", endedAt: NOW - 3 * 60_000 }),
  card({ taskId: "t6", title: "schema migration", status: "failed", endedAt: NOW - 18 * 60_000 }),
  card({ taskId: "t7", title: "worktree cleanup", status: "interrupted", endedAt: NOW - 60 * 60_000 }),
];

const BUILD_CARDS: BoardCard[] = [
  card({ taskId: "b1", title: "bump the schema", status: "running", activeStatus: "running", activeStateId: "build" }),
  card({ taskId: "b2", title: "classify changeset", status: "failed", endedAt: NOW - 6 * 60_000 }),
];

const ONE_COLUMN: BoardView = {
  level: "feature",
  breadcrumb: [],
  columns: [{ key: "plan", stateId: "feature.plan", label: "feature.plan", cards: PLAN_CARDS }],
  atLevel: [],
  finished: [],
};

const TWO_COLUMNS: BoardView = {
  level: "feature",
  breadcrumb: [],
  columns: [
    { key: "plan", stateId: "feature.plan", label: "plan", cards: PLAN_CARDS.slice(0, 5) },
    { key: "build", stateId: "feature.build", label: "build", cards: BUILD_CARDS },
  ],
  atLevel: [],
  finished: [],
};

function BoardSpecimen({ board }: { board: BoardView }): JSX.Element {
  return (
    <Board
      board={board}
      selected="t1"
      onSelectTask={() => {}}
      onDrill={() => {}}
      onOpenTask={() => {}}
    />
  );
}

/**
 * The sidebar of the reference's figure 01: four projects, the first one open on Files.
 *
 * STATEFUL, which is the difference between a photograph of a column and a photograph of a control.
 * Every row it draws is an accordion, a switch or a verb, and a specimen wired to `() => {}` looks
 * identical to one whose accordion does not open — which is exactly the fault this pass was fixing.
 * The harness clicks it (see `OPENED` in `shoot.mjs`), so what is photographed is what a click does.
 */
function SidebarSpecimen(): JSX.Element {
  const [view, setView] = useState("files");
  const [finding, setFinding] = useState<Record<string, boolean>>({});
  const [shut, setShut] = useState(false);
  const find = (id: string): SidebarAct => ({
    id: "find",
    glyph: "⌕",
    label: `find in ${id}`,
    on: finding[id] === true,
    onAct: () => setFinding((f) => ({ ...f, [id]: !(f[id] ?? false) })),
  });
  return (
    <Sidebar
      views={[
        {
          id: "files",
          glyph: "❏",
          label: "Files",
          panel: <FileTreeStub />,
          acts: [{ id: "new", glyph: "+", label: "new file", onAct: () => {} }, find("files")],
        },
        { id: "tasks", glyph: "▶", label: "Tasks", counts: { running: 2, waiting: 1, success: 3 } },
        {
          id: "chat",
          glyph: "✎",
          label: "Chat",
          counts: { waiting: 1 },
          panel: <ChatListStub />,
          acts: [{ id: "new", glyph: "+", label: "new conversation", onAct: () => {} }, find("chat")],
        },
      ]}
      roots={[{ id: "all", glyph: "◎", label: "All tasks" }]}
      footer={[
        { id: "logs", glyph: "≡", label: "Logs" },
        { id: "debug", glyph: "⌁", label: "Debug" },
      ]}
      settings={{
        id: "settings",
        glyph: "⚙",
        label: "Settings",
        panel: <SectionsStub />,
      }}
      onLeaveSettings={() => setView("files")}
      view={view}
      onView={setView}
      collapsed={shut}
      onCollapsed={setShut}
      projects={[
        {
          project: "/w/checkouts/declarative-ai",
          label: "declarative-ai",
          kind: "user",
          hue: "var(--p1)",
          counts: { running: 2, waiting: 1, success: 2, error: 1 },
        },
        { project: "/w/notes-api", label: "notes-api", kind: "user", hue: "var(--p2)", counts: { error: 1, success: 4 } },
        { project: "/w/atlas-web", label: "atlas-web", kind: "user", hue: "var(--p3)", counts: { running: 1, warning: 1 } },
        { project: "~/.jaira", label: "~/.jaira", kind: "shared", hue: "var(--p0)", counts: {} },
      ]}
      at="/w/checkouts/declarative-ai"
      onProject={() => {}}
      busy={false}
      theme="light"
      onTheme={() => {}}
      onChooseProject={() => {}}
    />
  );
}

/**
 * Standing in for the file tree, which needs a service behind it.
 *
 * The real rows, though — `.tree-item` with its `.tree-guide` rules — because the guides are the
 * thing being checked: one rule per level of nesting, continuing the two the column draws above.
 */
function FileTreeStub(): JSX.Element {
  const row = (depth: number, name: string, sel = false): JSX.Element => (
    <li className={`tree-item${sel ? " sel" : ""}`}>
      {Array.from({ length: depth }, (_, i) => (
        <i key={i} className="tree-guide" />
      ))}
      <span className="glyph">{name.endsWith("/") ? "▾" : "·"}</span>
      <span className="name">{name}</span>
    </li>
  );
  return (
    <div className="file-browser">
      <div className="scroll">
        {/* HEADERLESS: the root the drawer is standing in is the project row above it, and printing
            its name again at the top of its own branch said the same word twice. */}
        <ul className="file-tree">
          {row(0, "workflows/")}
          {row(1, "feature/")}
          {row(2, "plan/")}
          {row(3, "goals.json")}
          {row(3, "critique.json", true)}
          {row(1, "prompts/")}
          {row(2, "review.md")}
        </ul>
        {/* The shared root introduces itself HERE — the drawer is standing in a project, so this is
            somewhere else. Standing in `~/.jaira` it would be the unnamed one and this row would be
            gone, which is the case that was still printing it. */}
        <ul className="file-tree">
          <li className="tree-root">~/.jaira</li>
          {row(0, "workflows/")}
          {row(1, "review/")}
        </ul>
      </div>
    </div>
  );
}

/** The conversation list, as the drawer under the Chat row holds it. */
function ChatListStub(): JSX.Element {
  return (
    <div className="chat-list">
      <ul className="chat-rows">
        {[
          { title: "why does the lint pass here", when: "2 min", unread: true },
          { title: "worktree cleanup", when: "1 h", unread: false },
          { title: "what does §9.2 decide", when: "yesterday", unread: false },
        ].map((c) => (
          <li key={c.title} className={c.unread ? "sel" : undefined}>
            <span className={`chat-row-mark${c.unread ? " unread" : ""}`} />
            <span className="chat-row-title ellip">{c.title}</span>
            <span className="chat-row-when sub">{c.when}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The Settings sections, as the drawer under the lifted Settings row holds them. */
function SectionsStub(): JSX.Element {
  return (
    <ul className="sections">
      {["Providers", "Executors", "Configuration", "Appearance"].map((label) => (
        <li key={label} className={label === "Appearance" ? "sel" : undefined}>
          {label}
        </li>
      ))}
    </ul>
  );
}

/** Figure 05: every pill, in both fills, plus the overflow. */
function PillSpecimen(): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <Pill kind="running" word="running" />
        <Pill kind="waiting" word="waiting" />
        <Pill kind="error" word="failed" />
        <Pill kind="warning" word="stopped" />
        <Pill kind="success" word="done" />
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <Pill kind="running" n={2} />
        <Pill kind="waiting" n={1} />
        <Pill kind="error" n={1} />
        <Pill kind="warning" n={1} />
        <Pill kind="success" n={4} />
      </div>
      <Pills counts={{ running: 2, waiting: 1, error: 1, warning: 1, success: 4 }} budget={96} />
    </div>
  );
}

/** Figure 04: the ten registers, each set in itself. */
const REGISTERS: readonly { cls: string; sample: string }[] = [
  { cls: "app-title", sample: "Appearance" },
  { cls: "app-label", sample: "Files" },
  { cls: "app-text", sample: "Separate editor size" },
  { cls: "app-secondary", sample: "every project on this machine" },
  { cls: "app-absent", sample: "no project open" },
  { cls: "data-title", sample: "declarative-ai" },
  { cls: "data-text", sample: "prompts/review.md" },
  { cls: "data-secondary", sample: "40s · 3 turns" },
  { cls: "data-faint", sample: "shadows ~/.jaira/" },
  { cls: "data-num", sample: "1234567890" },
];

function RegisterSpecimen(): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7, padding: 12 }}>
      {REGISTERS.map(({ cls, sample }) => (
        <div key={cls} style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span className="data-faint" style={{ width: 110, flex: "none" }}>
            {cls}
          </span>
          <span className={cls}>{sample}</span>
        </div>
      ))}
    </div>
  );
}

/** Figure 07, live: the real pane, holding its own state so the controls can be exercised by hand. */
function AppearanceSpecimen(): JSX.Element {
  // App text UNSET, data text chosen — the two states this control has, in one picture. Unset is
  // what almost every window is in, and it is the one that used to draw an empty box under a
  // heading: the chips now say which face is rendering and that it is ours (`shownFamilies`).
  const [appearance, setAppearance] = useState({
    ...defaultAppearance(),
    appFamily: [] as string[],
    dataFamily: ["JetBrains Mono", "Consolas"],
    advanced: true,
  });
  return (
    <AppearancePane
      appearance={appearance}
      busy={false}
      onChange={(patch) => setAppearance((a) => ({ ...a, ...patch }))}
    />
  );
}

/**
 * A state with a re-plan loop, an escape hatch and a jump target — the shapes the graph exists to
 * make readable, in one document.
 */
const GRAPH_STATE = JSON.stringify(
  {
    label: "Planning",
    inputs: {
      issue: { schema: { type: "string", contentMediaType: "text/markdown" } },
      depth: { schema: { type: "integer" }, default: 2, optional: true },
    },
    outputs: {
      plan_doc: { binding: ".children.context.outputs.plan_doc" },
      outcome: { binding: ".children.critique.outputs.outcome", optional: true },
    },
    children: {
      goals: { inputs: { issue: ".inputs.issue" } },
      context: { inputs: { goals: ".children.goals.outputs.goals" }, async: true },
      critique: {
        inputs: { plan_doc: ".children.context.outputs.plan_doc", depth: ".inputs.depth" },
        transitions: [
          { to: "terminate.success", when: ".children.critique.outputs.outcome === 'clean'" },
          { to: "goals", when: ".run.iteration < .limits.max_iterations" },
          { to: "escalate" },
        ],
      },
      escalate: { state: "$/lib/escalate", inputs: { findings: ".children.critique.outputs.findings" } },
    },
    sequence: ["goals", "context", "critique"],
    transitions: [{ to: "terminate.error", when: ".run.iteration >= .limits.max_iterations" }],
    limits: { max_iterations: 3, timeout: 600 },
  },
  null,
  2,
);

/**
 * The graph tab, over that state. Real component, real layout — see `stateGraphView.tsx`.
 *
 * What the surface asks the SHELL to do is written onto the document, because those two gestures
 * have no picture of their own: clicking a box fills a side panel this page does not have, and
 * double-clicking opens a file it cannot open. The harness reads them back and reports them in
 * words — see `shoot.mjs`, and the `graph-click` step. Without that the two would be checkable only
 * by hand, which is how a double-click that had been silently retargeted went unnoticed.
 */
function GraphSpecimen(): JSX.Element {
  const asked = useMemo(
    () => ({ open: (item: PinnedValue) => (document.documentElement.dataset["pinned"] = item.title) }),
    [],
  );
  return (
    <ValuePanelContext.Provider value={asked}>
      <StateGraphView
        text={GRAPH_STATE}
        stateId="plan"
        onOpenState={(id) => (document.documentElement.dataset["opened"] = id)}
        // Enough for a click to reach the side panel's editor rather than the box's own declaration
        // — the two are different surfaces, and the harness should exercise the real one.
        readState={async (id) =>
          ({
            stateId: id,
            layer: "project",
            file: `/w/p/workflows/${id}.json`,
            text: CHILD_STATE,
            exists: true,
          }) as never
        }
      />
    </ValuePanelContext.Provider>
  );
}

/** TEMPORARY: the side panel's state editor, over a stub document. */
const CHILD_STATE = JSON.stringify(
  {
    label: "Goals",
    inputs: { issue: { schema: { type: "string" } } },
    outputs: { goals: { schema: { type: "array" }, binding: ".operation.output.goals" } },
    operation: {
      kind: "prompt",
      model: "anthropic/claude-sonnet-5",
      prompt: { $ref: "$/prompts/goals.md" },
      outputs: { goals: { schema: { type: "array" } } },
    },
  },
  null,
  2,
);

const PROMPT_FILE = [
  "# Extract the goals",
  "",
  "Read the issue and list what the change has to achieve.",
  "",
  "- one line each",
  "- no solutions, only outcomes",
].join("\n");

/** Just enough tree for a reference to resolve: the prompt the state below links to. */
const PROMPT_TREE: FileTree = {
  roots: [
    {
      layer: "project",
      project: "/w/p",
      nodes: [
        {
          path: "prompts",
          name: "prompts",
          kind: "directory",
          mime: "inode/directory",
          layer: "project",
          children: [
            {
              path: "prompts/goals.md",
              name: "goals.md",
              kind: "file",
              mime: "text/markdown",
              layer: "project",
            },
          ],
        },
      ],
    },
  ],
};

function StatePanelSpecimen(): JSX.Element {
  return (
    <StatePanel
      // A prompt held in another file, and what it says — the whole reason a link costs something.
      tree={PROMPT_TREE}
      readFile={async () => PROMPT_FILE}
      stateId="plan/goals"
      read={async () =>
        ({
          stateId: "plan/goals",
          layer: "project",
          file: "/w/p/workflows/plan/goals.json",
          text: CHILD_STATE,
          exists: true,
        }) as never
      }
      save={() => {}}
      executors={[]}
      busy={false}
      onOpenState={() => {}}
    />
  );
}

/**
 * Two cards of the Debug view's component gallery.
 *
 * Two rather than nine because a frame tall enough for all of them is a frame nobody can read at the
 * size the type actually is. These two are the pair that carries the rest: a decision component
 * whose config is a LIST — the case the schema form used to render as an empty text box — and the
 * changeset gate, which mounts itself into a host node rather than returning an element, so a
 * picture of it is the only check that the host is still holding it right.
 *
 * `validateSchema` answers nothing: the check is an IPC round trip, and there is no main process
 * behind a snapshot. A null answer is the same one the editor gets while a real check is in flight.
 */
function GallerySpecimen(): JSX.Element {
  const shown = GALLERY_SURFACES.filter((s) => s.id === "choose_option" || s.id === "review_artifacts");
  return (
    <div className="col mid debug" style={{ overflow: "auto" }}>
      <ComponentGallery validateSchema={async () => null} surfaces={shown} />
    </div>
  );
}

/**
 * The reviewer on its own, wide enough to be read (decision 0002).
 *
 * The gallery frame above shows it inside an editor split, which is the right picture of "does the
 * host still hold a self-mounting component" and the wrong one for "does the review read". This
 * frame is the second question: a chooser, a diff, and a summary that says what submitting would
 * do — the three things the card list did not have.
 *
 * Also the only check on the container query. The layout collapses to one column below 720px of
 * CONTAINER width, so a viewport-sized frame proves nothing about it either way; a frame this wide
 * is the two-pane case, and the `gallery` frame above is narrow enough to be the other one.
 */
function ReviewerSpecimen(): JSX.Element {
  const surface = GALLERY_SURFACES.find((s) => s.id === "review_artifacts")!;
  return (
    <div className="col mid debug" style={{ overflow: "auto" }}>
      <ComponentGallery validateSchema={async () => null} surfaces={[surface]} />
    </div>
  );
}

/**
 * `edit_artifact` on the app's editor stack (decision 0002).
 *
 * Its own frame because what changed is not visible in a list of components: the gallery's document
 * is markdown, so this is the frame that shows a Write/Preview pair and a Revert where there used to
 * be one textarea and a Save.
 */
function ReviewOneSpecimen(): JSX.Element {
  const surface = GALLERY_SURFACES.find((s) => s.id === "review_artifact")!;
  return (
    <div className="col mid debug" style={{ overflow: "auto" }}>
      <ComponentGallery validateSchema={async () => null} surfaces={[surface]} />
    </div>
  );
}

function EditorSpecimen(): JSX.Element {
  const surface = GALLERY_SURFACES.find((s) => s.id === "edit_artifact")!;
  return (
    <div className="col mid debug" style={{ overflow: "auto" }}>
      <ComponentGallery validateSchema={async () => null} surfaces={[surface]} />
    </div>
  );
}

export interface Specimen {
  id: string;
  /**
   * The figure in `reference/the-shell.html` this one is answerable to, or `—` for a surface the
   * reference does not draw.
   *
   * The dash is not an exemption from the comparison — it says there is nothing to compare against,
   * which is the case for a surface designed after the reference was written. Photographing it is
   * still worth the frame: a drawing whose arrows stop meeting their boxes is invisible to every
   * test that reads the model rather than the pixels.
   */
  figure: string;
  width: number;
  height: number;
  node: ReactNode;
}

export const SPECIMENS: readonly Specimen[] = [
  { id: "board-column", figure: "06 · Column", width: 276, height: 384, node: <BoardSpecimen board={ONE_COLUMN} /> },
  { id: "board-two", figure: "01 · Tasks", width: 560, height: 340, node: <BoardSpecimen board={TWO_COLUMNS} /> },
  { id: "sidebar", figure: "02 · The sidebar", width: 251, height: 470, node: <SidebarSpecimen /> },
  { id: "pills", figure: "05 · The pills", width: 320, height: 120, node: <PillSpecimen /> },
  { id: "registers", figure: "04 · Ten registers", width: 360, height: 230, node: <RegisterSpecimen /> },
  { id: "appearance", figure: "07 · Appearance", width: 430, height: 620, node: <AppearanceSpecimen /> },
  { id: "graph", figure: "— · The state graph", width: 980, height: 560, node: <GraphSpecimen /> },
  { id: "state-panel", figure: "— · A child in the panel", width: 480, height: 560, node: <StatePanelSpecimen /> },
  { id: "gallery", figure: "— · The component gallery", width: 940, height: 620, node: <GallerySpecimen /> },
  { id: "reviewer", figure: "— · review_artifacts", width: 1720, height: 900, node: <ReviewerSpecimen /> },
  { id: "editor", figure: "— · edit_artifact", width: 1180, height: 820, node: <EditorSpecimen /> },
  { id: "review-one", figure: "— · review_artifact", width: 1180, height: 900, node: <ReviewOneSpecimen /> },
];
