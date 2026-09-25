/**
 * The event vocabulary and the `events` settings block (decision 0010 §2): nine events, each with a
 * label, a hint, a group and a payload schema a sample payload satisfies; `on_event`'s filters; and
 * the block that switches each event on per remote, layered like every other setting.
 */
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  EVENT_FILTER_KEYS,
  EVENT_NAMES,
  EVENT_SPECS,
  NEW_BRANCH_SHA,
  defaultConfig,
  enabledEvents,
  eventGroupOf,
  isEventEnabled,
  isEventName,
  matchesEventFilter,
  mergeConfigLayers,
  parseConfig,
  type EventPayloads,
  type JairaEvent,
} from "../src/index";

const where = { remote: "origin", connection: "github", host: "github.com", repository: "ofersadgat/JaiRA" };

const request = (over: Partial<EventPayloads["git.merge_request.opened"]["merge_request"]> = {}) => ({
  number: 12,
  title: "Events",
  state: "open" as const,
  author: "Ofer",
  source_branch: "feature/events",
  target_branch: "main",
  head_sha: "b".repeat(40),
  url: "https://github.com/ofersadgat/JaiRA/pull/12",
  ...over,
});

/** A payload for every event, as the watcher and the task store will deliver them. */
const SAMPLES: { [N in keyof EventPayloads]: EventPayloads[N] } = {
  "git.push": {
    ...where,
    branch: "release/2.0",
    before: NEW_BRANCH_SHA,
    after: "c".repeat(40),
    commits: [
      { sha: "a".repeat(40), message: "first", author: "someone" },
      { sha: "c".repeat(40), message: "second\n\nbody", author: "Ofer" },
    ],
  },
  "git.merge_request.opened": { ...where, merge_request: request() },
  "git.merge_request.updated": { ...where, merge_request: request() },
  "git.merge_request.comments": {
    ...where,
    merge_request: request(),
    comments: [
      { id: "1", author: "reviewer", body: "Why?", created_at: "2026-09-25T10:00:00Z" },
      { id: "2", author: "reviewer", body: "Here.", created_at: "2026-09-25T10:01:00Z", thread_id: "t1", anchor: { path: "src/a.ts", line: 3, side: "after" } },
    ],
  },
  "git.merge_request.merged": { ...where, merge_request: request({ state: "merged" }) },
  "git.merge_request.closed": { ...where, merge_request: request({ state: "closed" }) },
  "git.checks.failed": { ...where, ref: "main", sha: "c".repeat(40), checks: [{ name: "test", conclusion: "failure", url: "https://example.org/1" }, { name: "lint", conclusion: "failed" }] },
  "task.finished": { task_id: "t-1", title: "Ship it", workflow: "feature/plan", status: "completed" },
  "task.failed": { task_id: "t-2", title: "Break it", workflow: "feature/plan", status: "failed" },
};

const eventOf = <N extends keyof EventPayloads>(name: N, payload: EventPayloads[N] = SAMPLES[name]): JairaEvent => ({ name, payload }) as JairaEvent;

describe("the event vocabulary", () => {
  it("names nine events, each with a label, a one-sentence hint and the group its name says", () => {
    expect(EVENT_NAMES).toEqual([
      "git.push",
      "git.merge_request.opened",
      "git.merge_request.updated",
      "git.merge_request.comments",
      "git.merge_request.merged",
      "git.merge_request.closed",
      "git.checks.failed",
      "task.finished",
      "task.failed",
    ]);
    for (const name of EVENT_NAMES) {
      const spec = EVENT_SPECS[name];
      expect(spec.name).toBe(name);
      expect(spec.group).toBe(eventGroupOf(name));
      expect(spec.group).toBe(name.split(".")[0]);
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.hint).toMatch(/^[A-Z].*\.$/);
    }
    expect(isEventName("git.push")).toBe(true);
    expect(isEventName("git.pushed")).toBe(false);
    expect(isEventName(4)).toBe(false);
  });

  it("gives every payload a schema its sample satisfies, and that refuses a payload missing a field", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    for (const name of EVENT_NAMES) {
      const validate = ajv.compile(EVENT_SPECS[name].schema);
      expect(validate(SAMPLES[name]), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
      const missing = { ...(SAMPLES[name] as unknown as Record<string, unknown>) };
      delete missing[name.startsWith("git.") ? "remote" : "task_id"];
      expect(validate(missing), name).toBe(false);
    }
    // Every git event carries where it happened; the task events do not.
    for (const name of EVENT_NAMES) {
      const properties = Object.keys(EVENT_SPECS[name].schema["properties"] as object);
      const base = ["remote", "connection", "host", "repository"];
      if (EVENT_SPECS[name].group === "git") expect(properties).toEqual(expect.arrayContaining(base));
      else expect(properties).toEqual(["task_id", "title", "workflow", "status"]);
    }
    // An anchor and a thread are optional on a comment; a url on a check.
    const comments = EVENT_SPECS["git.merge_request.comments"].schema as { properties: { comments: { items: { required: string[] } } } };
    expect(comments.properties.comments.items.required).toEqual(["id", "author", "body", "created_at"]);
  });
});

describe("matchesEventFilter", () => {
  it("passes everything with no filter or an empty one", () => {
    for (const name of EVENT_NAMES) {
      expect(matchesEventFilter(eventOf(name), undefined)).toBe(true);
      expect(matchesEventFilter(eventOf(name), {})).toBe(true);
    }
  });

  it("matches branch against a push's branch, a merge request's target and the branch checks ran for — as globs", () => {
    expect(matchesEventFilter(eventOf("git.push"), { branch: "release/*" })).toBe(true);
    expect(matchesEventFilter(eventOf("git.push"), { branch: "release" })).toBe(false);
    expect(matchesEventFilter(eventOf("git.push"), { branch: ["main", "release/*"] })).toBe(true);
    // `*` stops at a slash, as in a path glob; `**` does not.
    expect(matchesEventFilter(eventOf("git.push", { ...SAMPLES["git.push"], branch: "release/2.0/hotfix" }), { branch: "release/*" })).toBe(false);
    expect(matchesEventFilter(eventOf("git.push", { ...SAMPLES["git.push"], branch: "release/2.0/hotfix" }), { branch: "release/**" })).toBe(true);
    // A merge request's branch is its TARGET — the branch a push to it would land on.
    expect(matchesEventFilter(eventOf("git.merge_request.opened"), { branch: "main" })).toBe(true);
    expect(matchesEventFilter(eventOf("git.merge_request.opened"), { branch: "feature/*" })).toBe(false);
    expect(matchesEventFilter(eventOf("git.checks.failed"), { branch: "main" })).toBe(true);
    // Branches are git refs: case counts.
    expect(matchesEventFilter(eventOf("git.checks.failed"), { branch: "MAIN" })).toBe(false);
  });

  it("matches remote on every git event, and a merge request's own two branches", () => {
    expect(matchesEventFilter(eventOf("git.push"), { remote: "origin" })).toBe(true);
    expect(matchesEventFilter(eventOf("git.checks.failed"), { remote: ["upstream", "mirror"] })).toBe(false);
    expect(matchesEventFilter(eventOf("git.merge_request.merged"), { source_branch: "feature/*", target_branch: "main" })).toBe(true);
    expect(matchesEventFilter(eventOf("git.merge_request.merged"), { source_branch: "feature/*", target_branch: "develop" })).toBe(false);
  });

  it("matches author on a merge request's author (comments too) and a push's head commit, without case", () => {
    expect(matchesEventFilter(eventOf("git.merge_request.opened"), { author: "ofer" })).toBe(true);
    expect(matchesEventFilter(eventOf("git.merge_request.comments"), { author: "Ofer" })).toBe(true);
    expect(matchesEventFilter(eventOf("git.merge_request.comments"), { author: "reviewer" })).toBe(false);
    expect(matchesEventFilter(eventOf("git.push"), { author: "ofer" })).toBe(true);
    expect(matchesEventFilter(eventOf("git.push"), { author: "someone" })).toBe(false);
    expect(matchesEventFilter(eventOf("git.push", { ...SAMPLES["git.push"], commits: [] }), { author: "*" })).toBe(false);
  });

  it("never matches a key that means nothing on the event, or that is not a filter", () => {
    expect(EVENT_FILTER_KEYS).toEqual(["branch", "remote", "author", "source_branch", "target_branch"]);
    expect(matchesEventFilter(eventOf("git.push"), { source_branch: "*" })).toBe(false);
    expect(matchesEventFilter(eventOf("git.checks.failed"), { author: "*" })).toBe(false);
    expect(matchesEventFilter(eventOf("task.finished"), { branch: "**" })).toBe(false);
    expect(matchesEventFilter(eventOf("git.push"), { brnach: "main" } as never)).toBe(false);
    // An absent value is no condition.
    expect(matchesEventFilter(eventOf("git.push"), { branch: undefined })).toBe(true);
  });
});

describe("the events settings block", () => {
  it("is empty by default — every event off", () => {
    expect(defaultConfig().events).toEqual({});
    expect(parseConfig({}).events).toEqual({});
    expect(parseConfig({ events: {} }).events).toEqual({});
    for (const name of EVENT_NAMES) expect(isEventEnabled(defaultConfig(), name, "origin")).toBe(false);
    expect(enabledEvents(defaultConfig(), "origin")).toEqual([]);
  });

  it("reads each event's switch, branch globs and per-remote switches, enabled defaulting to off", () => {
    const events = parseConfig({
      events: {
        "git.push": { enabled: true, branches: ["main", " release/* "], remotes: { mirror: false } },
        "git.merge_request.opened": { enabled: true },
        "git.checks.failed": { remotes: { origin: true } },
        "task.failed": { enabled: true },
      },
    }).events;
    expect(events).toEqual({
      "git.push": { enabled: true, branches: ["main", "release/*"], remotes: { mirror: false } },
      "git.merge_request.opened": { enabled: true },
      "git.checks.failed": { enabled: false, remotes: { origin: true } },
      "task.failed": { enabled: true },
    });
    const config = { events };
    // A remote's own switch wins over `enabled`, either way.
    expect(enabledEvents(config, "origin")).toEqual([
      { name: "git.push", branches: ["main", "release/*"] },
      { name: "git.merge_request.opened" },
      { name: "git.checks.failed" },
    ]);
    expect(enabledEvents(config, "mirror")).toEqual([{ name: "git.merge_request.opened" }]);
    expect(enabledEvents(config, "upstream")).toEqual([{ name: "git.push", branches: ["main", "release/*"] }, { name: "git.merge_request.opened" }]);
    // JaiRA's own events have no remote; `enabledEvents` is the remote's list and leaves them out.
    expect(isEventEnabled(config, "task.failed")).toBe(true);
    expect(isEventEnabled(config, "task.finished")).toBe(false);
  });

  it("refuses what is not an event or not a setting, by name", () => {
    expect(() => parseConfig({ events: [] })).toThrow("config.events must be an object");
    expect(() => parseConfig({ events: { "git.pushed": { enabled: true } } })).toThrow(/config\.events\["git\.pushed"\] is not an event — the events are git\.push, /);
    expect(() => parseConfig({ events: { "git.push": true } })).toThrow('config.events["git.push"] must be an object');
    expect(() => parseConfig({ events: { "git.push": { enabled: "yes" } } })).toThrow('config.events["git.push"].enabled must be true or false');
    expect(() => parseConfig({ events: { "git.push": { branch: ["main"] } } })).toThrow(/config\.events\["git\.push"\]\.branch is not a setting — it takes enabled, branches, remotes/);
    expect(() => parseConfig({ events: { "git.push": { branches: [] } } })).toThrow(/branches must be a non-empty array of branch globs/);
    expect(() => parseConfig({ events: { "git.push": { branches: "main" } } })).toThrow(/branches must be a non-empty array/);
    expect(() => parseConfig({ events: { "git.push": { branches: ["main", ""] } } })).toThrow('config.events["git.push"].branches[1] must be a non-empty string');
    expect(() => parseConfig({ events: { "git.push": { remotes: { origin: "off" } } } })).toThrow('config.events["git.push"].remotes.origin must be true or false');
    // JaiRA's own events have no branch and no remote.
    expect(() => parseConfig({ events: { "task.finished": { enabled: true, branches: ["main"] } } })).toThrow(/branches is not a setting — it takes enabled$/);
    expect(() => parseConfig({ events: { "task.finished": { remotes: {} } } })).toThrow(/remotes is not a setting/);
  });

  it("layers like every setting: switches key by key, and a stronger layer's branch list REPLACES the weaker one's", () => {
    const merged = mergeConfigLayers([
      // Shared
      { events: { "git.push": { enabled: true, branches: ["main", "release/*"], remotes: { mirror: false } }, "git.merge_request.opened": { enabled: true } } },
      // This project
      { events: { "git.push": { branches: ["develop"], remotes: { upstream: false } } } },
      // Just you
      { events: { "git.merge_request.opened": { enabled: false } } },
    ]);
    expect(parseConfig(merged).events).toEqual({
      "git.push": { enabled: true, branches: ["develop"], remotes: { mirror: false, upstream: false } },
      "git.merge_request.opened": { enabled: false },
    });
  });
});
