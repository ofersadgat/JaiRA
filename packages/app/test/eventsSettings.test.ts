/**
 * Settings → Tools → Events and Automations (decision 0010 §2, §4; mockup B.1–B.2): what each event
 * switch writes — KEY LISTS, since event names hold dots — the rows and groups the section draws for
 * one remote, several and none, the status line, and what the models hand both sections in their main
 * states (`eventsModel.ts`, `automationsModel.ts`, `automationsHost.ts` — the universal tree draws them).
 */
import { describe, expect, it } from "vitest";
import { EVENT_SPECS, parseConfig, statesPath, withPaths, type EventsStatusView, type JairaEventsConfig } from "@jaira/shared";
import { EventTally } from "@jaira/service/eventTally";
import { badgeFor } from "../src/renderer/automationsHost";
import { automationStateIdOf, eventPicksOf, flagText, lineFlagsOf, stepFormOf, writeLine, type AutomationLine, type ShownLine } from "../src/renderer/automationsModel";
import { MISSED_WHILE_CLOSED, connectionBadgeOf, eventGroupsOf, eventStatusLine, eventSwitchPath, eventSwitchWrites, eventsConfigOf } from "../src/renderer/eventsModel";

const NOW = Date.parse("2026-09-25T12:00:00Z");

const origin = {
  name: "origin",
  host: "github.com",
  repository: "owner/repo",
  provider: "github" as const,
  connection: { name: "github", account: "ofersadgat", status: "ok" as const },
  watchable: true,
  watching: true,
  checkedAt: NOW - 30_000,
  events: { "git.pushed": { lastSeenAt: NOW - 120_000, today: 3 } },
};
const mirror = { name: "mirror", host: "gitlab.com", repository: "ofer/repo", provider: "gitlab" as const, watchable: false, watching: false, events: {} };

const status = (remotes: EventsStatusView["remotes"]): EventsStatusView => ({ remotes, tasks: {}, cadenceMs: 60_000 });

describe("what an event switch writes", () => {
  it("is the event's enabled for the only remote, and for Shared's every-project group", () => {
    expect(eventSwitchPath("git.pushed", ["origin"], "origin")).toEqual(["events", "git.pushed", "enabled"]);
    expect(eventSwitchPath("git.pushed", [], undefined)).toEqual(["events", "git.pushed", "enabled"]);
    expect(eventSwitchPath("task.failed", ["origin", "mirror"], undefined)).toEqual(["events", "task.failed", "enabled"]);
  });

  it("is the remote's own switch when there are several", () => {
    expect(eventSwitchPath("git.pushed", ["origin", "mirror"], "mirror")).toEqual(["events", "git.pushed", "remotes", "mirror"]);
  });

  it("turns the only remote's override the same way when one covers enabled", () => {
    const events: JairaEventsConfig = { "git.pushed": { enabled: false, remotes: { origin: false } } };
    expect(eventSwitchWrites(events, "git.pushed", ["origin"], "origin", true)).toEqual([
      [["events", "git.pushed", "enabled"], true],
      [["events", "git.pushed", "remotes", "origin"], true],
    ]);
    expect(eventSwitchWrites({}, "git.pushed", ["origin"], "origin", true)).toEqual([[["events", "git.pushed", "enabled"], true]]);
  });

  it("writes a dotted event name as one key, which the parser takes", () => {
    const doc = withPaths({}, eventSwitchWrites({}, "merge_request.opened", ["origin", "mirror"], "origin", true));
    expect(doc).toEqual({ events: { "merge_request.opened": { remotes: { origin: true } } } });
    expect(parseConfig(doc).events["merge_request.opened"]).toEqual({ enabled: false, remotes: { origin: true } });
  });
});

describe("the rows", () => {
  it("are one group per remote, then JaiRA's own", () => {
    const groups = eventGroupsOf(status([origin, mirror]), { "git.pushed": { enabled: true } });
    expect(groups.map((g) => g.heading)).toEqual([
      "origin → github.com/owner/repo · from .git/config",
      "mirror → gitlab.com/ofer/repo · from .git/config",
      "JaiRA · tasks in this project",
    ]);
    const push = groups[0]!.rows.find((row) => row.name === "git.pushed")!;
    expect(push).toMatchObject({ on: true, unanswered: false, branches: true, path: ["events", "git.pushed", "remotes", "origin"], activity: { today: 3 } });
    // No connection for gitlab.com: off and disabled, whatever the settings say.
    expect(groups[1]!.rows.find((row) => row.name === "git.pushed")).toMatchObject({ on: false, unanswered: true });
    expect(groups[2]!.rows.map((row) => row.name)).toEqual(["task.finished", "task.failed"]);
  });

  it("are every project's remotes on Shared, which has none", () => {
    const groups = eventGroupsOf(status([]), {});
    expect(groups[0]!.heading).toBe("Remotes · every project's, from its own .git/config");
    expect(groups[0]!.rows.every((row) => !row.unanswered && row.badge === undefined)).toBe(true);
  });

  it("wear the connection as a badge", () => {
    expect(connectionBadgeOf(origin)).toMatchObject({ text: "github · ofersadgat", brand: "github", none: false });
    expect(connectionBadgeOf(mirror)).toMatchObject({ text: "no connection · sign in on Connections", none: true });
  });

  it("say how an event that is on is watched, and what arrived", () => {
    const [group] = eventGroupsOf(status([origin]), { "git.pushed": { enabled: true } });
    const push = group!.rows.find((row) => row.name === "git.pushed")!;
    expect(eventStatusLine(push, origin, 60_000, NOW)).toBe("checked every 60 s while JaiRA is open · last checked 30 s ago · last seen 2 min ago · 3 today");
    const merged = group!.rows.find((row) => row.name === "merge_request.merged")!;
    expect(eventStatusLine(merged, origin, 60_000, NOW)).toContain("none seen yet");
  });

  it("read the events in effect from the settings view", () => {
    expect(eventsConfigOf(null)).toEqual({});
    expect(eventsConfigOf({ effective: { events: { "git.pushed": { enabled: true } } } } as never)).toEqual({ "git.pushed": { enabled: true } });
  });
});

describe("the tally of what arrived", () => {
  it("counts per project, remote and event, and today only", () => {
    let now = NOW;
    const tally = new EventTally(() => now);
    const push = { name: "git.pushed", payload: { remote: "origin" } } as never;
    tally.record("p", push);
    tally.record("p", push);
    tally.record("p", { name: "task.failed", payload: { task_id: "t" } } as never);
    expect(tally.activity("p", "origin", "git.pushed")).toEqual({ lastSeenAt: NOW, today: 2 });
    expect(tally.activity("p", undefined, "task.failed")).toEqual({ lastSeenAt: NOW, today: 1 });
    expect(tally.activity("q", "origin", "git.pushed")).toBeUndefined();
    now += 2 * 86_400_000;
    expect(tally.activity("p", "origin", "git.pushed")).toEqual({ lastSeenAt: NOW, today: 0 });
  });
});

// --- what the sections are drawn from ------------------------------------------------------------

describe("the Events section", () => {
  it("has a remote's events with the badge, the switch, and — for one that is on — its branches and status", () => {
    const events: JairaEventsConfig = { "git.pushed": { enabled: true, branches: ["main", "release/*"] } };
    const layerDoc = { events: { "git.pushed": { enabled: true } } };
    const [group] = eventGroupsOf(status([origin]), events);
    expect(group!.heading).toBe("origin → github.com/owner/repo · from .git/config");
    const push = group!.rows.find((row) => row.name === "git.pushed")!;
    expect(EVENT_SPECS[push.name].label).toBe("Pushed");
    expect(push.badge!.text).toBe("github · ofersadgat");
    // The switch: on for the event the settings turn on, off for one they do not.
    expect(push.on).toBe(true);
    expect(group!.rows.find((row) => row.name === "merge_request.opened")!.on).toBe(false);
    // One that is on and takes branch globs gets its branch box, and its status line under it.
    expect(push.branches).toBe(true);
    expect(eventStatusLine(push, group!.remote, 60_000, NOW)).toBe("checked every 60 s while JaiRA is open · last checked 30 s ago · last seen 2 min ago · 3 today");
    // This layer states the push switch: its ↺ is read at the path the switch writes.
    expect(push.path).toEqual(["events", "git.pushed", "enabled"]);
    expect(statesPath(layerDoc, push.path)).toBe(true);
    expect(statesPath(layerDoc, group!.rows.find((row) => row.name === "merge_request.opened")!.path)).toBe(false);
    // The latest-state rule behind the ⓘ.
    expect(MISSED_WHILE_CLOSED).toContain("Missed while JaiRA was closed?");
  });

  it("mutes a remote with no connection, and leaves its switches off and unanswered", () => {
    const [group] = eventGroupsOf(status([mirror]), {});
    expect(group!.rows.length).toBeGreaterThan(0);
    for (const row of group!.rows) expect(row).toMatchObject({ on: false, unanswered: true, badge: { text: "no connection · sign in on Connections", none: true } });
  });
});

const line: AutomationLine = {
  name: "push_main_docs",
  event: "git.pushed",
  filter: { branch: "main" },
  steps: [
    { kind: "start", workflow: "feature/review", inputs: { issue: { event: "payload.commits[0].message" } } },
    { kind: "notify", text: "Review started" },
  ],
};

/** The settings the Automations section is read against: pushes are watched, nothing else. */
const WATCHED: JairaEventsConfig = { "git.pushed": { enabled: true } };

describe("the Automations section", () => {
  it("has a line's badge beside its When, and its steps' inputs as picks from the event", () => {
    expect(badgeFor(line, status([origin]))!.text).toBe("github · ofersadgat");
    const start = line.steps[0] as Extract<AutomationLine["steps"][number], { kind: "start" }>;
    const picked = stepFormOf(start).picked["issue"];
    expect(eventPicksOf(line.event).find((pick) => pick.id === picked)!.label).toBe("← event.commits[0].message");
  });

  it("names the state a Shared line's steps are this project's own copy of", () => {
    expect(automationStateIdOf("push_main")).toBe("system/events/push_main");
  });

  it("flags a line an earlier one catches, and an event switched off", () => {
    const any = { ...line, name: "any_push", filter: {} };
    const shown: ShownLine[] = [
      { line: any, from: "own", ignored: false },
      { line, from: "own", ignored: false },
      { line: { ...line, name: "checks", event: "pipeline.failed", filter: {} }, from: "own", ignored: false },
    ];
    const flags = lineFlagsOf(shown, WATCHED);
    expect(flags[0]).toEqual([]);
    expect(flags[1]!.map(flagText)).toEqual(["Never reached: any_push matches every event this line would, and the first line that matches wins. Drag it above any_push to run it first."]);
    expect(flags[2]!.map(flagText)).toEqual(["pipeline.failed is switched off, so nothing arrives for this line."]);
    // The page offers "Switch it on in Events" beside the second kind, by the flag's kind.
    expect(flags[2]!.map((flag) => flag.kind)).toEqual(["off"]);
  });

  it("keeps a hand-written line whole and sends it to the file", () => {
    const raw: AutomationLine = { name: "odd", event: "", filter: {}, steps: [], raw: { rule: { name: "odd", when: "on_event('git.pushed') && true", to: "x" }, children: {} } };
    // Its guard is shown as it is written, and written back as it stood.
    expect(writeLine(raw)).toEqual(raw.raw);
    expect(writeLine(raw).rule["when"]).toBe("on_event('git.pushed') && true");
    // And the written rule of an ordinary line is what the file holds.
    expect(writeLine(line).rule["when"]).toBe("on_event('git.pushed', { branch: 'main' })");
  });
});

