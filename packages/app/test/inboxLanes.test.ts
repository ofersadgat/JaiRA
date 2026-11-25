/**
 * The inbox strip's lanes (the status-bar mockups of 2026-11-24, round 2, design 09). The person: "the
 * message itself belongs to a nested task, but presented at top level", "i think grouping multiple
 * things by top level task is better", "it wastes space duplicating the project", and "awaiting 4, but
 * only has 2 and there a button +2 more when there is clearly space for them to fit".
 */
import { describe, expect, it } from "vitest";
import type { PendingApproval, PendingInteraction, PendingQuestion, ProjectTask } from "@jaira/shared/browser";
import { LANE_METRICS, entryTitle, fitLanes, inboxLanesOf, type LaneInputs } from "../src/renderer/inboxLanesModel";

const task = (taskId: string, project: string, title: string, startedBy?: string): ProjectTask =>
  ({ taskId, project, title, status: "running", workflow: "session", createdAt: "", updatedAt: 1_000, ...(startedBy ? { origin: { kind: "started", taskId: startedBy } } : {}) }) as unknown as ProjectTask;
const gate = (requestId: string, taskId: string, project: string, prompt: string): PendingInteraction =>
  ({ requestId, taskId, project, component: "choose_option", inputs: {}, config: { component: "choose_option", prompt, options: [] } }) as unknown as PendingInteraction;
const question = (requestId: string, taskId: string, project: string, text: string, at: number): PendingQuestion =>
  ({ requestId, taskId, project, questions: [{ question: text, header: "", options: [], multiSelect: false }], at }) as unknown as PendingQuestion;
const approval = (requestId: string, taskId: string, project: string, command: string, at: number): PendingApproval =>
  ({ requestId, taskId, project, tool: "Bash", command, input: {}, at }) as unknown as PendingApproval;

// Today's strip, as it was found: four lesson asks under three topodiff conversations.
const TOPO = "C:/code/topodiff";
const TASKS = [
  task("chat-oauth", TOPO, "Creating GitLab OAuth app"),
  task("chat-site", TOPO, "topodiff website / landing page"),
  task("chat-vercel", TOPO, "Vercel build failure debugging"),
  task("review-1", TOPO, "Review a conversation for lessons", "chat-oauth"),
  task("review-2", TOPO, "Review a conversation for lessons", "chat-site"),
  task("lesson-3", TOPO, "Lesson: investigate first", "chat-vercel"),
  task("review-4", TOPO, "Review a conversation for lessons", "chat-vercel"),
];
const today = (): LaneInputs => ({
  pending: [
    gate("g1", "review-1", TOPO, "Apply this change to instructions?"),
    gate("g2", "review-2", TOPO, "Apply this change to instructions?"),
    gate("g3", "lesson-3", TOPO, "Apply this change to instructions?"),
    gate("g4", "review-4", TOPO, "Apply this change to instructions?"),
  ],
  approvals: [],
  questions: [],
  tasks: TASKS,
  projects: [{ live: [
    { taskId: "review-1", kind: "waiting", since: 100 },
    { taskId: "review-2", kind: "waiting", since: 200 },
    { taskId: "lesson-3", kind: "waiting", since: 300 },
    { taskId: "review-4", kind: "waiting", since: 400 },
  ] }],
  now: 10_000,
});

describe("the lanes", () => {
  it("files every ask under its top-level chat, and those under their project, named once", () => {
    const lanes = inboxLanesOf(today());
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.project).toBe(TOPO);
    expect(lanes[0]!.asks).toBe(4);
    expect(lanes[0]!.entries.map((e) => [e.title, e.asks.length])).toEqual([
      ["Creating GitLab OAuth app", 1],
      ["topodiff website / landing page", 1],
      ["Vercel build failure debugging", 2],
    ]);
  });

  it("keeps the nested task's name as the path to the ask, and the ask is opened where it is answered", () => {
    const vercel = inboxLanesOf(today())[0]!.entries[2]!;
    expect(vercel.taskId).toBe("chat-vercel");
    expect(vercel.asks.map((a) => [a.taskId, a.path])).toEqual([
      ["lesson-3", ["Lesson: investigate first"]],
      ["review-4", ["Review a conversation for lessons"]],
    ]);
    expect(entryTitle(vercel)).toBe("Vercel build failure debugging\n  Lesson: investigate first › Apply this change to instructions?\n  Review a conversation for lessons › Apply this change to instructions?");
  });

  it("puts a ring segment on an entry per ask, and one more while it works", () => {
    const input = today();
    input.projects = [{ live: [...input.projects[0]!.live!, { taskId: "chat-vercel", kind: "running", since: 50 }] }];
    const vercel = inboxLanesOf(input)[0]!.entries[2]!;
    expect(vercel.ring).toEqual([{ kind: "waiting", since: 300 }, { kind: "waiting", since: 400 }, { kind: "running", since: 50 }]);
  });

  it("orders entries and lanes by what blocks an agent first — a question, an approval, a gate — then by age", () => {
    const input = today();
    input.tasks = [...TASKS, task("chat-jaira", "C:/code/JaiRA", "Inbox strip redesign"), task("rel", "C:/code/JaiRA", "Release nightly")];
    input.questions = [question("q1", "chat-jaira", "C:/code/JaiRA", "Group by project or by top-level task?", 900)];
    input.approvals = [approval("a1", "rel", "C:/code/JaiRA", "git push origin release", 800)];
    const lanes = inboxLanesOf(input);
    expect(lanes.map((l) => l.project)).toEqual(["C:/code/JaiRA", TOPO]);
    expect(lanes[0]!.entries.map((e) => e.title)).toEqual(["Inbox strip redesign", "Release nightly"]);
  });

  it("leaves out a move's question, which is drawn where the move asked it", () => {
    const input = today();
    input.pending = [...input.pending, { ...gate("m", "chat-oauth", TOPO, "Move to Done?"), moves: true }];
    expect(inboxLanesOf(input)[0]!.asks).toBe(4);
  });

  it("files a request no task is known for as an entry of its own", () => {
    const lanes = inboxLanesOf({ ...today(), pending: [], approvals: [approval("a", "gone", "C:/x", "rm -rf build", 5)], tasks: [] });
    expect(lanes[0]!.entries[0]).toMatchObject({ key: "gone", title: "gone", project: "C:/x" });
  });
});

describe("fitting the lanes", () => {
  const measure = { title: (s: string) => s.length * 7, name: (s: string) => s.length * 7 };
  const busy = (): LaneInputs => {
    const input = today();
    const projects = ["a", "b", "c"];
    input.tasks = [...TASKS, ...projects.flatMap((p) => [task(`${p}1`, p, `${p} first chat title`), task(`${p}2`, p, `${p} second chat title`)])];
    input.questions = projects.flatMap((p, i) => [question(`${p}q1`, `${p}1`, p, "?", i), question(`${p}q2`, `${p}2`, p, "?", i)]);
    return input;
  };

  it("shows everything when it fits — no +N more beside room to spare", () => {
    const fit = fitLanes(inboxLanesOf(today()), 900, measure);
    expect(fit).toEqual({ modes: ["titles"], titleMax: LANE_METRICS.fullTitle, more: 0 });
  });

  it("gives up words a step at a time: cut titles, the last lanes' rings, folded lanes, the first lane's rings, then +N more", () => {
    const lanes = inboxLanesOf(busy());
    expect(lanes.map((l) => l.project)).toEqual(["a", "b", "c", TOPO]);
    const at = (w: number) => fitLanes(lanes, w, measure);
    // Every width from wide to narrow: the shapes it passes through, each once, in this order.
    const shapes: string[] = [];
    for (let w = 3000; w >= 100; w -= 5) {
      const fit = at(w);
      const shape = `${fit.modes.join(" ")} / ${fit.titleMax} / +${fit.more}`;
      if (shapes[shapes.length - 1] !== shape) shapes.push(shape);
    }
    // A two-entry lane folded is no narrower than its two rings, so it keeps its rings; topodiff's three fold.
    expect(shapes).toEqual([
      "titles titles titles titles / 220 / +0",
      "titles titles titles titles / 120 / +0",
      "titles titles titles rings / 120 / +0",
      "titles titles rings rings / 120 / +0",
      "titles rings rings rings / 120 / +0",
      "titles rings rings folded / 120 / +0",
      "rings rings rings folded / 120 / +0",
      "rings rings rings hidden / 120 / +4",
      "rings rings hidden hidden / 120 / +6",
      "rings hidden hidden hidden / 120 / +8",
    ]);
  });
});
