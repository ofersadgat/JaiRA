/**
 * A session's shell environment in words (decision 0013 §5, ruled 2026-10-02): what the bar under the
 * composer says in each stage of a conversation, what the list it opens offers, what the chip beside the
 * title and the start page's sentence repeat — and the placing and starting of a conversation told as
 * phases of actions above its first message.
 */
import { describe, expect, it } from "vitest";
import type { EnvironmentView, PlacementNote, QueuedPlacement } from "@jaira/shared/browser";
import {
  AUTO_FACE,
  barFactsOf,
  choiceOf,
  dotOf,
  facesOf,
  folderOf,
  gitFactsOf,
  listRowsOf,
  machineKindOf,
  metersOf,
  stageOf,
  startSentenceOf,
  titleChipOf,
  workTitleOf,
} from "../src/renderer/environmentModel";
import { MACHINE_ANCHORS, MACHINE_MARKS, MACHINE_SHAPES, WORK_RING, machineIconAt, machineIconSizes } from "../src/renderer/machineIcons";
import { askNameOf, placementSummaryOf } from "../src/renderer/placementSummary";
import { conversationsAt } from "../src/renderer/chatSurface";

const GB = 1024 ** 3;
const HERE = "C:/code/mist-server-3";
const VIEW: EnvironmentView = {
  identity: "gitlab.com/mist/mist-server",
  machines: [
    {
      id: "m-self",
      label: "desk",
      self: true,
      os: "windows",
      form: "desktop",
      state: "online",
      cores: 16,
      cpu: 0.12,
      memoryFree: 37 * GB,
      memoryTotal: 128 * GB,
      workspaces: [
        { project: "C:/code/mist-server", dir: "C:/code/mist-server", label: "mist-server", running: 2, queued: 0, git: { branch: "main", ahead: 0, added: 0, removed: 0 }, why: "2 of 2 running" },
        {
          project: HERE,
          dir: HERE,
          label: "mist-server-3",
          running: 0,
          queued: 0,
          git: { branch: "feature/session-cache", ahead: 2, added: 128, removed: 34, mergeRequest: { provider: "gitlab", number: 17, url: "https://gitlab.com/mist/mist-server/-/merge_requests/17", state: "open" } },
        },
      ],
    },
    {
      id: "m-mac",
      label: "mac-mini",
      self: false,
      os: "mac",
      form: "mini",
      state: "online",
      cpu: 0.93,
      memoryFree: 9 * GB,
      memoryTotal: 16 * GB,
      workspaces: [{ project: "jaira-remote:m-mac:/Users/o/code/mist-server", dir: "/Users/o/code/mist-server", label: "mist-server", running: 1, queued: 2, git: { branch: "main", added: 12, removed: 2 } }],
    },
    { id: "m-tp", label: "thinkpad", self: false, os: "linux", form: "laptop", state: "offline", workspaces: [{ project: "jaira-remote:m-tp:/home/o/src/mist-server", dir: "/home/o/src/mist-server", label: "mist-server", running: 0, queued: 0 }] },
  ],
};
const ONE: EnvironmentView = { machines: [{ id: "m-self", label: "desk", self: true, os: "linux", form: "laptop", state: "online", workspaces: [{ project: "/src/solo", dir: "/src/solo", label: "solo", running: 0, queued: 0, git: { branch: "main" } }] }] };

const queued = (over: Partial<QueuedPlacement> = {}): QueuedPlacement => ({ taskId: "t-1", project: HERE, requires: [], since: 1_000, phase: "waiting", asked: 0, refused: 0, waits: 0, asks: [], ...over });

describe("a machine's icon", () => {
  it("has a shape for everything a machine can be, a mark for everything it runs, and corners to put them on", () => {
    for (const shape of ["desktop", "laptop", "mini", "server", "phone", "auto"] as const) {
      expect(MACHINE_SHAPES[shape].paths.length).toBeGreaterThan(0);
      expect(MACHINE_ANCHORS[shape]).toHaveLength(4);
    }
    for (const mark of ["windows", "mac", "linux", "android", "ios"] as const) expect(MACHINE_MARKS[mark].paths[0]!.length).toBeGreaterThan(10);
    // Only what is not decided is dashed.
    expect(Object.entries(MACHINE_SHAPES).filter(([, s]) => s.dash !== undefined).map(([k]) => k)).toEqual(["auto"]);
  });

  it("sizes its dot and mark from its own size, and never too small to read", () => {
    expect(machineIconSizes(16)).toEqual({ dot: 5, mark: 7, ring: 1.1, room: 4 });
    expect(machineIconSizes(36)).toEqual({ dot: 11, mark: 16, ring: 2.6, room: 8 });
    expect(machineIconSizes(10)).toMatchObject({ dot: 5, mark: 7, ring: 1 });
    // The dot is centred ON the shape's corner, not beside it.
    expect(machineIconAt(24, 21, 5, 6)).toEqual({ left: 18, top: 2 });
    expect(WORK_RING).toHaveLength(2);
  });

  it("says a machine is connected, connecting, or not", () => {
    expect([dotOf("online"), dotOf("connecting"), dotOf("offline"), dotOf("mismatch")]).toEqual(["on", "slow", "off", "off"]);
    expect(facesOf(VIEW)["m-mac"]).toEqual({ shape: "mini", mark: "mac", dot: "on" });
    expect(machineKindOf({ os: "mac", form: "mini" })).toBe("Mac mini");
    expect(machineKindOf({ os: "windows", form: "desktop" })).toBe("Windows desktop");
  });
});

describe("what a checkout says", () => {
  it("writes its branch, what is unpushed, the lines changed and its request", () => {
    expect(gitFactsOf(VIEW.machines[0]!.workspaces[1]!.git)).toEqual({
      branch: "feature/session-cache",
      ahead: "↑2",
      added: "+128",
      removed: "−34",
      request: { provider: "gitlab", label: "!17", state: "open", tone: "ok", url: "https://gitlab.com/mist/mist-server/-/merge_requests/17" },
    });
  });

  it("leaves out what is nothing: no commits ahead, no lines changed", () => {
    expect(gitFactsOf({ branch: "main", ahead: 0, added: 0, removed: 0 })).toEqual({ branch: "main" });
    expect(gitFactsOf({ added: 3 })).toEqual({ added: "+3", removed: "−0" });
    expect(gitFactsOf({})).toBeUndefined();
    expect(gitFactsOf(undefined)).toBeUndefined();
  });

  it("numbers a pull request with #, and says draft, merged and closed in their tones", () => {
    const mr = (over: object) => gitFactsOf({ mergeRequest: { provider: "github", number: 4, url: "u", state: "open", ...over } as never })!.request!;
    expect(mr({})).toMatchObject({ label: "#4", state: "open", tone: "ok" });
    expect(mr({ draft: true })).toMatchObject({ state: "draft", tone: "dim" });
    expect(mr({ state: "merged" })).toMatchObject({ state: "merged", tone: "accent" });
    expect(mr({ state: "closed" })).toMatchObject({ state: "closed", tone: "bad" });
  });
});

describe("the bar under the composer", () => {
  it("before a conversation: automatic, and no checkout until a workspace is decided", () => {
    const bar = barFactsOf(VIEW, { kind: "choosing" })!;
    // Three of its four workspaces are on machines in reach.
    expect(bar).toMatchObject({ face: AUTO_FACE, machine: "automatic", workspace: { text: "the first of 3 workspaces with room", dim: true }, open: true, chip: "automatic" });
    expect(bar.git).toBeUndefined();
  });

  it("a machine chosen: its icon and name, and still no checkout", () => {
    const bar = barFactsOf(VIEW, { kind: "choosing", target: { machine: "m-self" } })!;
    expect(bar).toMatchObject({ face: { shape: "desktop", mark: "windows", dot: "on" }, machine: "this machine", workspace: { text: "the first of 2 workspaces with room", dim: true }, chip: "this machine" });
    expect(bar.git).toBeUndefined();
    // A machine with one workspace is that workspace, checkout and all.
    expect(barFactsOf(VIEW, { kind: "choosing", target: { machine: "m-mac" } })).toMatchObject({ machine: "mac-mini", workspace: { text: "mist-server" }, git: { branch: "main", added: "+12" }, chip: "mac-mini / mist-server" });
  });

  it("a workspace chosen: the machine, the folder, and what its checkout says", () => {
    const bar = barFactsOf(VIEW, { kind: "choosing", target: { project: HERE } })!;
    expect(bar).toMatchObject({ machine: "this machine", workspace: { text: "mist-server-3", icon: "folder" }, open: true, title: "this machine / mist-server-3", chip: "this machine / mist-server-3" });
    expect(bar.git).toMatchObject({ branch: "feature/session-cache", ahead: "↑2" });
  });

  it("being placed, it says so and cannot be changed; waiting, it says what for and can", () => {
    expect(barFactsOf(VIEW, { kind: "placing", queued: queued({ phase: "placing" }) })).toMatchObject({ machine: "automatic", workspace: { text: "choosing a workspace", icon: "spinner" }, open: false, chip: "automatic · choosing" });
    expect(barFactsOf(VIEW, { kind: "waiting", queued: queued() })).toMatchObject({ machine: "automatic", workspace: { text: "waiting for a workspace with room", icon: "clock" }, open: true });
    expect(barFactsOf(VIEW, { kind: "waiting", queued: queued({ target: { machine: "m-self" } }) })).toMatchObject({ machine: "this machine", workspace: { text: "waiting for room on this machine" }, chip: "this machine · waiting for room" });
    expect(barFactsOf(VIEW, { kind: "waiting", queued: queued({ target: { project: HERE } }) })).toMatchObject({ workspace: { text: "waiting for room in mist-server-3" } });
  });

  it("running, it only says: where, and the checkout", () => {
    const bar = barFactsOf(VIEW, { kind: "running", project: HERE })!;
    expect(bar).toMatchObject({ machine: "this machine", workspace: { text: "mist-server-3" }, open: false });
    expect(bar.git?.request?.label).toBe("!17");
    // On another machine, by that machine's name.
    expect(barFactsOf(VIEW, { kind: "running", project: "jaira-remote:m-mac:/Users/o/code/mist-server" })).toMatchObject({ machine: "mac-mini", face: { shape: "mini", mark: "mac" } });
  });

  it("with one workspace there is nothing to choose: the bar says it and opens nothing", () => {
    expect(barFactsOf(ONE, { kind: "choosing" })).toMatchObject({ machine: "this machine", workspace: { text: "solo" }, git: { branch: "main" }, open: false });
    expect(barFactsOf(ONE, { kind: "running", project: "/src/solo" })).toMatchObject({ machine: "this machine", workspace: { text: "solo" }, open: false });
  });

  it("is not drawn before the engine has answered, and falls back to the placement's own note for a workspace since closed", () => {
    expect(barFactsOf(undefined, { kind: "choosing" })).toBeUndefined();
    expect(barFactsOf({ machines: [] }, { kind: "choosing" })).toBeUndefined();
    const placed = { on: { project: "/gone/repo", machineId: "m-x", label: "old-box", dir: "/gone/repo" } } as PlacementNote;
    expect(barFactsOf(VIEW, { kind: "running", project: "/gone/repo", placed })).toMatchObject({ machine: "old-box", workspace: { text: "repo" }, open: false });
    expect(barFactsOf(VIEW, { kind: "running", project: "/gone/repo" })).toBeUndefined();
  });

  it("is repeated by the chip beside the title, dashed while nothing is decided", () => {
    expect(titleChipOf(barFactsOf(VIEW, { kind: "choosing" }))).toEqual({ face: AUTO_FACE, text: "automatic", dashed: true, open: true });
    expect(titleChipOf(barFactsOf(VIEW, { kind: "running", project: HERE }))).toMatchObject({ text: "this machine / mist-server-3", dashed: false, open: false });
    expect(titleChipOf(undefined)).toBeUndefined();
  });
});

describe("the start page's sentence", () => {
  it("names the choice, as the part of it that opens the list", () => {
    expect(startSentenceOf(VIEW, undefined, true)).toEqual({ before: "This conversation runs ", choice: "in the first workspace with room", after: " — it asks before it runs or changes anything." });
    expect(startSentenceOf(VIEW, { project: HERE }, true).choice).toBe("in mist-server-3 on this machine");
    expect(startSentenceOf(VIEW, { machine: "m-mac" }, true).choice).toBe("on mac-mini, in its first workspace with room");
  });

  it("offers no choice where there is none", () => {
    expect(startSentenceOf(ONE, undefined, true).choice).toBeUndefined();
    expect(startSentenceOf(undefined, undefined, true).before).toBe("This conversation works in the open project");
    expect(startSentenceOf(VIEW, undefined, false)).toEqual({ before: "No project is open, so this runs in JaiRA's own root. Open one to talk about your code.", after: "" });
  });
});

describe("the list of where a conversation can run", () => {
  it("is Automatic, then each machine and under it its workspaces", () => {
    const rows = listRowsOf(VIEW, undefined);
    expect(rows.map((r) => r.kind)).toEqual(["auto", "machine", "workspace", "workspace", "machine", "workspace", "machine", "workspace"]);
    expect(rows[0]).toEqual({ kind: "auto", on: true });
  });

  it("puts a machine's load on the machine's line, and warns from ninety percent", () => {
    const rows = listRowsOf(VIEW, undefined);
    const [desk, mac, thinkpad] = rows.filter((r) => r.kind === "machine");
    expect(desk).toMatchObject({ name: "this machine", what: "Windows desktop", usable: true, meters: [{ label: "CPU", pct: 12, text: "12%", high: false }, { label: "Memory", pct: 71, text: "71%", high: false }] });
    expect(mac).toMatchObject({ name: "mac-mini", what: "Mac mini", meters: [{ label: "CPU", pct: 93, high: true }, { label: "Memory", pct: 44 }] });
    // One that cannot be reached is listed, says why in place of its load, and cannot be chosen.
    expect(thinkpad).toMatchObject({ usable: false, meters: [], note: { text: "offline", tone: "bad" } });
    expect(metersOf({})).toEqual([]);
  });

  it("counts a workspace's tasks together — at work and waiting — and none for a machine out of reach", () => {
    const work = listRowsOf(VIEW, undefined).flatMap((r) => (r.kind === "workspace" ? [[r.workspace.label, r.work, r.usable] as const] : []));
    expect(work).toEqual([
      ["mist-server", 2, true],
      ["mist-server-3", 0, true],
      ["mist-server", 3, true],
      ["mist-server", 0, false],
    ]);
    expect(workTitleOf(1, 2)).toBe("3 tasks: 1 at work, 2 waiting");
    expect(workTitleOf(1, 0)).toBe("1 task: 1 at work, 0 waiting");
  });

  it("marks the one choice: a machine, or one workspace — never both", () => {
    const on = (target: Parameters<typeof listRowsOf>[1]) => listRowsOf(VIEW, target).flatMap((r, i) => (r.on ? [i] : []));
    expect(on(undefined)).toEqual([0]);
    expect(on({ machine: "m-self" })).toEqual([1]);
    expect(on({ project: HERE })).toEqual([3]);
    // What a row sends when it is chosen.
    const rows = listRowsOf(VIEW, undefined);
    expect(rows[1]).toMatchObject({ target: { machine: "m-self" } });
    expect(rows[3]).toMatchObject({ target: { project: HERE } });
    // Something named that is no longer there is no choice.
    expect(choiceOf(VIEW, { project: "/nowhere" })).toEqual({ kind: "auto" });
    expect(choiceOf(VIEW, { machine: "m-gone" })).toEqual({ kind: "auto" });
  });
});

describe("which stage a conversation is in", () => {
  it("is choosing with none open, placing or waiting in the queue, and running otherwise", () => {
    expect(stageOf({ taskId: null, project: HERE, runOn: { machine: "m-mac" } })).toEqual({ stage: { kind: "choosing", target: { machine: "m-mac" } }, choosable: true });
    const placing = queued({ phase: "placing" });
    expect(stageOf({ taskId: "t-1", project: HERE, queued: placing })).toEqual({ stage: { kind: "placing", queued: placing }, choosable: false });
    expect(stageOf({ taskId: "t-1", project: HERE, queued: queued() })).toMatchObject({ stage: { kind: "waiting" }, choosable: true });
    expect(stageOf({ taskId: "t-1", project: HERE, detail: { status: "running", runs: [{}] } })).toEqual({ stage: { kind: "running", project: HERE, placed: undefined }, choosable: false });
  });

  it("is not the person's to change between being made and being asked about", () => {
    expect(stageOf({ taskId: "t-1", project: HERE, detail: { status: "queued", runs: [] } })).toEqual({ stage: { kind: "choosing", target: undefined }, choosable: false });
  });
});

describe("a folder's name", () => {
  it("is the last part of its path, either slash", () => {
    expect(folderOf("C:\\code\\mist-server-3")).toBe("mist-server-3");
    expect(folderOf("/srv/mist/")).toBe("mist");
  });
});

describe("placing and starting, as phases of actions", () => {
  const ask = (dir: string, why?: string, machineId = "m-self", label = "desk") => ({ at: 5_000, project: dir, machineId, label, dir, ...(why !== undefined ? { why } : {}) });

  it("is nothing for a task that was never placed", () => {
    expect(placementSummaryOf({})).toBeUndefined();
  });

  it("while its workspaces are asked for the first time: one phase in progress, asking", () => {
    const summary = placementSummaryOf({ queued: queued({ phase: "placing" }), selfId: "m-self" })!;
    expect(summary.phases).toHaveLength(1);
    expect(summary.phases[0]).toMatchObject({ name: "Placing", state: "current", chips: [{ label: "asking", live: true }], rows: [] });
    expect(summary.until).toBeUndefined();
  });

  it("waiting: every workspace asked is an action, a refusal a failed one, and the wait an action too", () => {
    const asks = [ask("C:/code/mist-server", "low on memory"), ask(HERE, "low on memory")];
    const summary = placementSummaryOf({ queued: queued({ asked: 28, refused: 28, waits: 13, asks, askedAt: 5_000, nextAt: 15_000, target: { machine: "m-self" } }), selfId: "m-self" })!;
    const [placing] = summary.phases;
    expect(placing).toMatchObject({ name: "Placing", state: "waiting", since: 1_000 });
    expect(placing!.chips).toEqual([
      { key: "asked", icon: "folder", hue: "ask", label: "28 workspaces asked", failed: 28 },
      { key: "waits", icon: "clock", hue: "wait", label: "13 waits", failed: 0 },
    ]);
    expect(placing!.rows.map((r) => [r.said.map((s) => ("code" in s ? `\`${s.code}\`` : s.text)).join(""), r.refused])).toEqual([
      ["Asked `this machine / mist-server`", "refused · low on memory"],
      ["Asked `this machine / mist-server-3`", "refused · low on memory"],
      ["Waiting 10 s before asking this machine again", undefined],
    ]);
    expect(placing!.rows[2]).toMatchObject({ wait: true, since: 5_000 });
    expect(summary.steps).toBe(41);
    // The rounds before the latest are one line of "Every step".
    expect(summary.every[0]!.said).toEqual([{ text: "Asked 26 workspaces before that: none had room" }]);
    expect(summary.every).toHaveLength(4);
  });

  it("says what the wait is before: the workspace, the machine, or everything", () => {
    const words = (target: QueuedPlacement["target"], asks = [ask(HERE, "full"), ask("/Users/o/code/mist-server", "full", "m-mac", "mac-mini")]) =>
      placementSummaryOf({ queued: queued({ asked: 2, refused: 2, waits: 1, asks, askedAt: 5_000, nextAt: 15_000, ...(target !== undefined ? { target } : {}) }), selfId: "m-self" })!.phases[0]!.rows.at(-1)!.said[0];
    expect(words(undefined)).toEqual({ text: "Waiting 10 s before asking again" });
    expect(words({ project: HERE })).toEqual({ text: "Waiting 10 s before asking mist-server-3 again" });
    expect(words({ machine: "m-mac" })).toEqual({ text: "Waiting 10 s before asking mac-mini again" });
    expect(askNameOf({ machineId: "m-mac", label: "mac-mini", dir: "/Users/o/code/mist-server" }, "m-self")).toBe("mac-mini / mist-server");
  });

  const NOTE: PlacementNote = {
    since: 1_000,
    at: 1_800,
    asked: 3,
    refused: 2,
    waits: 0,
    asks: [ask("C:/code/mist-server", "2 of 2 running"), ask("/Users/o/code/mist-server", "CPU at 93%", "m-mac", "mac-mini"), ask(HERE)],
    on: { project: HERE, machineId: "m-self", label: "desk", dir: HERE },
    steps: [
      { at: 1_800, kind: "workspace", what: "jaira/t-1", tookMs: 400 },
      { at: 2_200, kind: "pin", what: "chat/session", tookMs: 100 },
    ],
  };

  it("placed and starting: Placing rolls up to where it went, Starting is in progress with what it did", () => {
    const summary = placementSummaryOf({ placed: NOTE, starting: true, agent: "codex-cli", selfId: "m-self" })!;
    expect(summary.phases.map((p) => [p.name, p.state])).toEqual([
      ["Placed", "done"],
      ["Starting", "current"],
    ]);
    expect(summary.phases[0]!.chips.map((c) => [c.label, c.failed, c.hue])).toEqual([
      ["3 workspaces asked", 2, "ask"],
      ["this machine / mist-server-3", 0, "found"],
    ]);
    expect(summary.phases[0]).toMatchObject({ since: 1_000, until: 1_800, rows: [] });
    expect(summary.phases[1]!.chips.map((c) => [c.label, c.live])).toEqual([
      ["1 worktree", undefined],
      ["1 snapshot", undefined],
      ["launching", true],
    ]);
    expect(summary.phases[1]!.rows.map((r) => r.said.map((s) => ("code" in s ? `\`${s.code}\`` : s.text)).join(""))).toEqual(["Made the worktree for `jaira/t-1`", "Pinned `chat/session` as it is now", "Launching `codex-cli` in `mist-server-3`"]);
    expect(summary.phases[1]!.rows.at(-1)).toMatchObject({ live: true, since: 2_300 });
    expect(summary.until).toBeUndefined();
  });

  it("started: both phases rolled up, the launch named for what answered", () => {
    const summary = placementSummaryOf({ placed: NOTE, starting: false, agent: "codex-cli", selfId: "m-self" })!;
    expect(summary.phases.map((p) => [p.name, p.state, p.rows.length])).toEqual([
      ["Placed", "done", 0],
      ["Started", "done", 0],
    ]);
    expect(summary.phases[1]!.chips.at(-1)).toMatchObject({ label: "codex-cli", hue: "launch" });
    expect(summary).toMatchObject({ steps: 7, since: 1_000, until: 2_300 });
    // Every step: the round that placed it, where it went, what starting did.
    expect(summary.every.map((r) => r.key)).toEqual(["ask:0:C:/code/mist-server", "ask:1:/Users/o/code/mist-server", `ask:2:${HERE}`, "found", "step:0", "step:1", "launch"]);
    expect(summary.every[2]!.refused).toBeUndefined();
  });

  it("says when a person sent it there by hand, and what it waited through", () => {
    const summary = placementSummaryOf({ placed: { ...NOTE, asked: 0, refused: 0, waits: 4, asks: [], byHand: true, steps: [] }, selfId: "other" })!;
    expect(summary.phases[0]!.chips.map((c) => c.label)).toEqual(["sent by hand", "4 waits", "desk / mist-server-3"]);
    expect(summary.phases[1]!.chips.map((c) => c.label)).toEqual(["agent"]);
    expect(summary.every.map((r) => r.said[0])).toEqual([{ text: "Sent by hand to " }, { text: "Launched " }]);
  });
});

describe("a project's conversations", () => {
  const task = (taskId: string, workflow: string, project?: string) => ({ taskId, title: taskId, workflow, status: "completed", updatedAt: 1, ...(project !== undefined ? { project } : {}) }) as never;
  const projects = [
    { project: "/a", kind: "user", identity: "host/repo" },
    { project: "/b", kind: "user", identity: "host/repo" },
    { project: "/c", kind: "user", identity: "host/other" },
    { project: "/solo", kind: "user" },
  ] as never;
  const all = [task("t-a", "chat/session", "/a"), task("t-b", "chat/session", "/b"), task("t-c", "chat/session", "/c")];
  const tasks = [task("t-a", "chat/session"), task("t-plan", "feature/plan")];

  it("are every workspace's when the project is one repository in several, each stamped with its own", () => {
    expect(conversationsAt({ at: "/a", allConversations: all, tasks, projects }).map((c) => [c.taskId, c.project])).toEqual([
      ["t-a", "/a"],
      ["t-b", "/b"],
    ]);
  });

  it("are the open workspace's alone when it is the only one, or when workspaces are listed apart", () => {
    expect(conversationsAt({ at: "/c", allConversations: all, tasks, projects }).map((c) => c.taskId)).toEqual(["t-a"]);
    expect(conversationsAt({ at: "/solo", allConversations: all, tasks, projects }).map((c) => c.taskId)).toEqual(["t-a"]);
    expect(conversationsAt({ at: "/a", allConversations: all, tasks, projects }, false).map((c) => [c.taskId, c.project])).toEqual([["t-a", undefined]]);
  });

  it("are everything at the root", () => {
    expect(conversationsAt({ at: null, allConversations: all, tasks, projects })).toBe(all);
  });
});
