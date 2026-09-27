/**
 * Settings → Tools → Events and Automations (decision 0010 §2, §4; mockup B.1–B.2): what each event
 * switch writes — KEY LISTS, since event names hold dots — the rows and groups the section draws for
 * one remote, several and none, the status line, and both sections rendered in their main states.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseConfig, withPaths, type EventsStatusView, type JairaEventsConfig } from "@jaira/shared";
import { EventTally } from "@jaira/service/eventTally";
import { writeLine, type AutomationLine, type ShownLine } from "../src/renderer/automationsModel";
import { AutomationsView, type AutomationsViewProps } from "../src/renderer/automationsPane";
import { connectionBadgeOf, eventGroupsOf, eventStatusLine, eventSwitchPath, eventSwitchWrites, eventsConfigOf } from "../src/renderer/eventsModel";
import { EventsSection, type EventsSectionProps } from "../src/renderer/eventsPane";

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

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
  events: { "git.push": { lastSeenAt: NOW - 120_000, today: 3 } },
};
const mirror = { name: "mirror", host: "gitlab.com", repository: "ofer/repo", provider: "gitlab" as const, watchable: false, watching: false, events: {} };

const status = (remotes: EventsStatusView["remotes"]): EventsStatusView => ({ remotes, tasks: {}, cadenceMs: 60_000 });

describe("what an event switch writes", () => {
  it("is the event's enabled for the only remote, and for Shared's every-project group", () => {
    expect(eventSwitchPath("git.push", ["origin"], "origin")).toEqual(["events", "git.push", "enabled"]);
    expect(eventSwitchPath("git.push", [], undefined)).toEqual(["events", "git.push", "enabled"]);
    expect(eventSwitchPath("task.failed", ["origin", "mirror"], undefined)).toEqual(["events", "task.failed", "enabled"]);
  });

  it("is the remote's own switch when there are several", () => {
    expect(eventSwitchPath("git.push", ["origin", "mirror"], "mirror")).toEqual(["events", "git.push", "remotes", "mirror"]);
  });

  it("turns the only remote's override the same way when one covers enabled", () => {
    const events: JairaEventsConfig = { "git.push": { enabled: false, remotes: { origin: false } } };
    expect(eventSwitchWrites(events, "git.push", ["origin"], "origin", true)).toEqual([
      [["events", "git.push", "enabled"], true],
      [["events", "git.push", "remotes", "origin"], true],
    ]);
    expect(eventSwitchWrites({}, "git.push", ["origin"], "origin", true)).toEqual([[["events", "git.push", "enabled"], true]]);
  });

  it("writes a dotted event name as one key, which the parser takes", () => {
    const doc = withPaths({}, eventSwitchWrites({}, "git.merge_request.opened", ["origin", "mirror"], "origin", true));
    expect(doc).toEqual({ events: { "git.merge_request.opened": { remotes: { origin: true } } } });
    expect(parseConfig(doc).events["git.merge_request.opened"]).toEqual({ enabled: false, remotes: { origin: true } });
  });
});

describe("the rows", () => {
  it("are one group per remote, then JaiRA's own", () => {
    const groups = eventGroupsOf(status([origin, mirror]), { "git.push": { enabled: true } });
    expect(groups.map((g) => g.heading)).toEqual([
      "origin → github.com/owner/repo · from .git/config",
      "mirror → gitlab.com/ofer/repo · from .git/config",
      "JaiRA · tasks in this project",
    ]);
    const push = groups[0]!.rows.find((row) => row.name === "git.push")!;
    expect(push).toMatchObject({ on: true, unanswered: false, branches: true, path: ["events", "git.push", "remotes", "origin"], activity: { today: 3 } });
    // No connection for gitlab.com: off and disabled, whatever the settings say.
    expect(groups[1]!.rows.find((row) => row.name === "git.push")).toMatchObject({ on: false, unanswered: true });
    expect(groups[2]!.rows.map((row) => row.name)).toEqual(["task.finished", "task.failed"]);
  });

  it("are every project's remotes on Shared, which has none", () => {
    const groups = eventGroupsOf(status([]), {});
    expect(groups[0]!.heading).toBe("Git · every project's remotes, from its own .git/config");
    expect(groups[0]!.rows.every((row) => !row.unanswered && row.badge === undefined)).toBe(true);
  });

  it("wear the connection as a badge", () => {
    expect(connectionBadgeOf(origin)).toMatchObject({ text: "github · ofersadgat", brand: "github", none: false });
    expect(connectionBadgeOf(mirror)).toMatchObject({ text: "no connection · sign in on Connections", none: true });
  });

  it("say how an event that is on is watched, and what arrived", () => {
    const [group] = eventGroupsOf(status([origin]), { "git.push": { enabled: true } });
    const push = group!.rows.find((row) => row.name === "git.push")!;
    expect(eventStatusLine(push, origin, 60_000, NOW)).toBe("checked every 60 s while JaiRA is open · last checked 30 s ago · last seen 2 min ago · 3 today");
    const merged = group!.rows.find((row) => row.name === "git.merge_request.merged")!;
    expect(eventStatusLine(merged, origin, 60_000, NOW)).toContain("none seen yet");
  });

  it("read the events in effect from the settings view", () => {
    expect(eventsConfigOf(null)).toEqual({});
    expect(eventsConfigOf({ effective: { events: { "git.push": { enabled: true } } } } as never)).toEqual({ "git.push": { enabled: true } });
  });
});

describe("the tally of what arrived", () => {
  it("counts per project, remote and event, and today only", () => {
    let now = NOW;
    const tally = new EventTally(() => now);
    const push = { name: "git.push", payload: { remote: "origin" } } as never;
    tally.record("p", push);
    tally.record("p", push);
    tally.record("p", { name: "task.failed", payload: { task_id: "t" } } as never);
    expect(tally.activity("p", "origin", "git.push")).toEqual({ lastSeenAt: NOW, today: 2 });
    expect(tally.activity("p", undefined, "task.failed")).toEqual({ lastSeenAt: NOW, today: 1 });
    expect(tally.activity("q", "origin", "git.push")).toBeUndefined();
    now += 2 * 86_400_000;
    expect(tally.activity("p", "origin", "git.push")).toEqual({ lastSeenAt: NOW, today: 0 });
  });
});

// --- rendered ----------------------------------------------------------------------------------

const eventsProps = (over: Partial<EventsSectionProps> = {}): EventsSectionProps => ({
  status: status([origin]),
  events: { "git.push": { enabled: true, branches: ["main", "release/*"] } },
  layerDoc: { events: { "git.push": { enabled: true } } },
  locked: false,
  now: NOW,
  onWrite: () => undefined,
  onOpenConnections: () => undefined,
  ...over,
});

describe("the Events section", () => {
  it("draws a remote's events with the badge, the switch, and — for one that is on — its branches and status", () => {
    const html = renderToStaticMarkup(createElement(EventsSection, eventsProps()));
    expect(html).toContain('data-part="events"');
    const words = text(html);
    expect(words).toContain("Things that happen outside JaiRA.");
    expect(words).toContain("origin → github.com/owner/repo · from .git/config");
    expect(words).toContain("github · ofersadgat");
    expect(words).toContain("Push");
    expect(words).toContain("git.push");
    expect(html).toContain('aria-label="stop watching for git.push"');
    expect(html).toContain('aria-label="watch for git.merge_request.opened"');
    expect(words).toContain("checked every 60 s while JaiRA is open · last checked 30 s ago · last seen 2 min ago · 3 today");
    expect(html).toContain('value="release/*"');
    // This layer states the push switch: its ↺.
    expect(html).toContain("set-reset");
    // The latest-state rule behind the ⓘ.
    expect(html).toContain("Missed while JaiRA was closed?");
  });

  it("mutes a remote with no connection, disables its switches, and links to Connections", () => {
    const html = renderToStaticMarkup(createElement(EventsSection, eventsProps({ status: status([mirror]), events: {} })));
    expect(text(html)).toContain("no connection · sign in on Connections");
    expect(html).toContain("src-none");
    expect(html).toMatch(/aria-label="no connection for gitlab.com — sign in on Connections"[^>]*disabled=""/);
  });

  it("says it is reading, and what went wrong reading", () => {
    expect(text(renderToStaticMarkup(createElement(EventsSection, eventsProps({ status: null }))))).toContain("Reading this project's remotes…");
    expect(text(renderToStaticMarkup(createElement(EventsSection, eventsProps({ status: { ...status([]), problem: "git failed" } }))))).toContain("could not be read — git failed");
  });
});

const line: AutomationLine = {
  name: "push_main_docs",
  event: "git.push",
  filter: { branch: "main" },
  steps: [
    { kind: "start", workflow: "feature/review", inputs: { issue: { event: "payload.commits[0].message" } } },
    { kind: "notify", text: "Review started" },
  ],
};

const automationsProps = (shown: ShownLine[], over: Partial<AutomationsViewProps> = {}): AutomationsViewProps => ({
  reads: "project",
  source: "copy",
  shown,
  events: { "git.push": { enabled: true } },
  status: status([origin]),
  workflows: [{ id: "feature/review", label: "Review" }],
  forms: { "feature/review": [{ name: "issue", schema: { type: "string" }, required: true, description: "What is asked for." } as never] },
  locked: false,
  problem: null,
  told: null,
  asking: null,
  layerName: "JaiRA",
  hasTask: true,
  onLines: () => undefined,
  onSharedLine: () => undefined,
  onUseSharedSteps: () => undefined,
  onIgnore: () => undefined,
  onAnswer: () => undefined,
  onOpenConversation: () => undefined,
  onEditFile: () => undefined,
  onOpenEvents: () => undefined,
  ...over,
});

describe("the Automations section", () => {
  it("draws a line: its grip and name, When with the badge and filter, its numbered steps with inputs from the event", () => {
    const html = renderToStaticMarkup(createElement(AutomationsView, automationsProps([{ line, from: "own", ignored: false }])));
    const words = text(html);
    expect(html).toContain('data-part="automations"');
    expect(words).toContain("What happens when an event arrives.");
    expect(html).toContain('draggable="true"');
    expect(html).toContain('value="push_main_docs"');
    expect(html).toContain('value="git.push"');
    expect(words).toContain("github · ofersadgat");
    expect(html).toContain('value="main"');
    // The filter draws the key it states, and offers the others the event takes rather than empty boxes.
    expect(words).toContain("only where + remote + author");
    expect(words).not.toContain("source_branch");
    expect(words).toContain("then");
    expect(words).toContain("from the event");
    expect(words).toContain("← event.commits[0].message");
    expect(html).toContain('value="Review started"');
    // A start is the events task's child unless it is asked to stand on its own.
    expect(words).toContain("as a child on its own");
    expect(html).toMatch(/aria-pressed="true"[^>]*>as a child</);
    expect(words).toContain("In order: each step starts when the one before it has finished.");
    expect(words).toContain("Runs as the task events in JaiRA");
    expect(words).toContain("Open its conversation");
    expect(words).toContain("Edit as a workflow file");
  });

  it("draws Shared's lines after the project's, the ignored one struck with Put back", () => {
    const shared = { ...line, name: "push_main" };
    const html = renderToStaticMarkup(
      createElement(
        AutomationsView,
        automationsProps([
          { line, from: "own", ignored: false },
          { line: shared, from: "shared", ignored: true },
          { line: { ...line, name: "mr_opened", event: "git.merge_request.opened", filter: {} }, from: "shared", ignored: false },
        ]),
      ),
    );
    const words = text(html);
    expect(words).toContain("This project");
    expect(words).toContain("From Shared · ~/.jaira");
    expect(html).toContain("au-ignored");
    expect(words).toContain("ignored here · Put back");
    expect(words).toContain("Ignore in this project");
    expect(words).toContain("from Shared");
    // A Shared line not ignored is EDITABLE here: its name, its event, its steps — and it says what an edit does.
    expect(html).toContain('value="mr_opened"');
    expect(html).toContain('value="git.merge_request.opened"');
    expect(words).toContain("A change to its steps here is this project's own copy of them; a change to its event or filter makes it a line of this project's.");
  });

  it("says when a Shared line's steps are this project's own, and offers Shared's back", () => {
    const words = text(
      renderToStaticMarkup(createElement(AutomationsView, automationsProps([{ line: { ...line, name: "push_main" }, from: "shared", ignored: false, stepsFrom: "project" }]))),
    );
    expect(words).toContain("Its steps are changed for this project only, in this project's system/events/push_main");
    expect(words).toContain("Shared's line and every other project keep Shared's.");
    expect(words).toContain("Use Shared's steps");
  });

  it("says when a project line stands in for Shared's of the same name", () => {
    const words = text(renderToStaticMarkup(createElement(AutomationsView, automationsProps([{ line, from: "own", ignored: false, replaces: true }]))));
    expect(words).toContain("This project's version of Shared's line of this name, which is ignored here.");
  });

  it("flags a line an earlier one catches, and an event switched off, with a way to Events", () => {
    const any = { ...line, name: "any_push", filter: {} };
    const html = renderToStaticMarkup(
      createElement(
        AutomationsView,
        automationsProps(
          [
            { line: any, from: "own", ignored: false },
            { line, from: "own", ignored: false },
            { line: { ...line, name: "checks", event: "git.checks.failed", filter: {} }, from: "own", ignored: false },
          ],
          {},
        ),
      ),
    );
    const words = text(html);
    expect(words).toContain("Never reached: any_push matches every event this line would");
    expect(words).toContain("git.checks.failed is switched off, so nothing arrives for this line.");
    expect(words).toContain("Switch it on in Events");
  });

  it("asks, on the personal layer, where the first change goes", () => {
    const words = text(renderToStaticMarkup(createElement(AutomationsView, automationsProps([], { asking: ["project", "base"] }))));
    expect(words).toContain("Just you is one settings file, and automations are a workflow file.");
    expect(words).toContain("This project");
    expect(words).toContain("Shared");
    expect(words).toContain("No automations yet.");
  });

  it("keeps a hand-written line whole and sends it to the file", () => {
    const raw: AutomationLine = { name: "odd", event: "", filter: {}, steps: [], raw: { rule: { name: "odd", when: "on_event('git.push') && true", to: "x" }, children: {} } };
    const words = text(renderToStaticMarkup(createElement(AutomationsView, automationsProps([{ line: raw, from: "own", ignored: false }]))));
    expect(words).toContain("on_event('git.push') && true");
    expect(words).toContain("Written by hand in the file, so it is edited there.");
    // And the written rule of an ordinary line is what the file holds.
    expect(writeLine(line).rule["when"]).toBe("on_event('git.push', { branch: 'main' })");
  });
});
