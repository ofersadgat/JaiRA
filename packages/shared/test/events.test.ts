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

const request = (over: Partial<EventPayloads["merge_request.opened"]["merge_request"]> = {}) => ({
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
  "git.pushed": {
    ...where,
    branch: "release/2.0",
    before: NEW_BRANCH_SHA,
    after: "c".repeat(40),
    commits: [
      { sha: "a".repeat(40), message: "first", author: "someone" },
      { sha: "c".repeat(40), message: "second\n\nbody", author: "Ofer" },
    ],
  },
  "git.merged": { ...where, merge_request: request({ state: "merged" }) },
  "merge_request.opened": { ...where, merge_request: request() },
  "merge_request.updated": { ...where, merge_request: request() },
  "merge_request.pushed": { ...where, merge_request: request(), before: "a".repeat(40), after: "c".repeat(40), commits: [{ sha: "c".repeat(40), message: "fix", author: "someone" }] },
  "merge_request.commented": {
    ...where,
    merge_request: request(),
    comments: [
      { id: "1", author: "reviewer", body: "Why?", created_at: "2026-09-25T10:00:00Z" },
      { id: "2", author: "reviewer", body: "Here.", created_at: "2026-09-25T10:01:00Z", thread_id: "t1", anchor: { path: "src/a.ts", line: 3, side: "after" } },
    ],
  },
  "merge_request.merged": { ...where, merge_request: request({ state: "merged" }) },
  "merge_request.closed": { ...where, merge_request: request({ state: "closed" }) },
  "pipeline.succeeded": { ...where, ref: "main", sha: "c".repeat(40), pipeline_id: 7, name: "CI", source: "push", url: "https://example.org/p/7" },
  "pipeline.failed": {
    ...where,
    ref: "main",
    sha: "c".repeat(40),
    pipeline_id: 8,
    source: "merge_request",
    url: "https://example.org/p/8",
    failed_jobs: [
      { job_id: 81, name: "test", stage: "test", failure_reason: "script_failure", url: "https://example.org/j/81" },
      { job_id: 82, name: "lint", url: "https://example.org/j/82" },
    ],
  },
  "pipeline.canceled": { ...where, ref: "main", sha: "c".repeat(40), pipeline_id: 9, source: "schedule", url: "https://example.org/p/9" },
  "task.finished": { task_id: "t-1", title: "Ship it", workflow: "feature/plan", status: "completed" },
  "task.failed": { task_id: "t-2", title: "Break it", workflow: "feature/plan", status: "failed" },
};

const eventOf = <N extends keyof EventPayloads>(name: N, payload: EventPayloads[N] = SAMPLES[name]): JairaEvent => ({ name, payload }) as JairaEvent;

describe("the event vocabulary", () => {
  it("names thirteen events, each with a label, a one-sentence hint and where it happens", () => {
    expect(EVENT_NAMES).toEqual([
      "git.pushed",
      "git.merged",
      "merge_request.opened",
      "merge_request.updated",
      "merge_request.pushed",
      "merge_request.commented",
      "merge_request.merged",
      "merge_request.closed",
      "pipeline.succeeded",
      "pipeline.failed",
      "pipeline.canceled",
      "task.finished",
      "task.failed",
    ]);
    for (const name of EVENT_NAMES) {
      const spec = EVENT_SPECS[name];
      expect(spec.name).toBe(name);
      expect(spec.group).toBe(eventGroupOf(name));
      expect(spec.group).toBe(name.startsWith("task.") ? "task" : "remote");
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.hint).toMatch(/^[A-Z].*\.$/);
    }
    expect(isEventName("git.pushed")).toBe(true);
    // The names before decision 0016 are gone, not aliases.
    expect(isEventName("git.push")).toBe(false);
    expect(isEventName("git.checks.failed")).toBe(false);
    expect(isEventName(4)).toBe(false);
  });

  it("gives every payload a schema its sample satisfies, and that refuses a payload missing a field", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    for (const name of EVENT_NAMES) {
      const validate = ajv.compile(EVENT_SPECS[name].schema);
      expect(validate(SAMPLES[name]), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
      const missing = { ...(SAMPLES[name] as unknown as Record<string, unknown>) };
      delete missing[name.startsWith("task.") ? "task_id" : "remote"];
      expect(validate(missing), name).toBe(false);
    }
    // Every remote event carries where it happened; the task events do not.
    for (const name of EVENT_NAMES) {
      const properties = Object.keys(EVENT_SPECS[name].schema["properties"] as object);
      const base = ["remote", "connection", "host", "repository"];
      if (EVENT_SPECS[name].group === "remote") expect(properties).toEqual(expect.arrayContaining(base));
      else expect(properties).toEqual(["task_id", "title", "workflow", "status"]);
    }
    // An anchor and a thread are optional on a comment; a url on a check.
    const comments = EVENT_SPECS["merge_request.commented"].schema as { properties: { comments: { items: { required: string[] } } } };
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
    expect(matchesEventFilter(eventOf("git.pushed"), { branch: "release/*" })).toBe(true);
    expect(matchesEventFilter(eventOf("git.pushed"), { branch: "release" })).toBe(false);
    expect(matchesEventFilter(eventOf("git.pushed"), { branch: ["main", "release/*"] })).toBe(true);
    // `*` stops at a slash, as in a path glob; `**` does not.
    expect(matchesEventFilter(eventOf("git.pushed", { ...SAMPLES["git.pushed"], branch: "release/2.0/hotfix" }), { branch: "release/*" })).toBe(false);
    expect(matchesEventFilter(eventOf("git.pushed", { ...SAMPLES["git.pushed"], branch: "release/2.0/hotfix" }), { branch: "release/**" })).toBe(true);
    // A merge request's branch is its TARGET — the branch a push to it would land on.
    expect(matchesEventFilter(eventOf("merge_request.opened"), { branch: "main" })).toBe(true);
    expect(matchesEventFilter(eventOf("merge_request.opened"), { branch: "feature/*" })).toBe(false);
    expect(matchesEventFilter(eventOf("pipeline.failed"), { branch: "main" })).toBe(true);
    // Branches are git refs: case counts.
    expect(matchesEventFilter(eventOf("pipeline.failed"), { branch: "MAIN" })).toBe(false);
  });

  it("matches remote on every git event, and a merge request's own two branches", () => {
    expect(matchesEventFilter(eventOf("git.pushed"), { remote: "origin" })).toBe(true);
    expect(matchesEventFilter(eventOf("pipeline.failed"), { remote: ["upstream", "mirror"] })).toBe(false);
    expect(matchesEventFilter(eventOf("merge_request.merged"), { source_branch: "feature/*", target_branch: "main" })).toBe(true);
    expect(matchesEventFilter(eventOf("merge_request.merged"), { source_branch: "feature/*", target_branch: "develop" })).toBe(false);
  });

  it("matches author on a merge request's author (comments too) and a push's head commit, without case", () => {
    expect(matchesEventFilter(eventOf("merge_request.opened"), { author: "ofer" })).toBe(true);
    expect(matchesEventFilter(eventOf("merge_request.commented"), { author: "Ofer" })).toBe(true);
    expect(matchesEventFilter(eventOf("merge_request.commented"), { author: "reviewer" })).toBe(false);
    expect(matchesEventFilter(eventOf("git.pushed"), { author: "ofer" })).toBe(true);
    expect(matchesEventFilter(eventOf("git.pushed"), { author: "someone" })).toBe(false);
    expect(matchesEventFilter(eventOf("git.pushed", { ...SAMPLES["git.pushed"], commits: [] }), { author: "*" })).toBe(false);
  });

  it("never matches a key that means nothing on the event, or that is not a filter", () => {
    expect(EVENT_FILTER_KEYS).toEqual(["branch", "remote", "author", "source_branch", "target_branch"]);
    expect(matchesEventFilter(eventOf("git.pushed"), { source_branch: "*" })).toBe(false);
    expect(matchesEventFilter(eventOf("pipeline.failed"), { author: "*" })).toBe(false);
    expect(matchesEventFilter(eventOf("task.finished"), { branch: "**" })).toBe(false);
    expect(matchesEventFilter(eventOf("git.pushed"), { brnach: "main" } as never)).toBe(false);
    // An absent value is no condition.
    expect(matchesEventFilter(eventOf("git.pushed"), { branch: undefined })).toBe(true);
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
        "git.pushed": { enabled: true, branches: ["main", " release/* "], remotes: { mirror: false } },
        "merge_request.opened": { enabled: true },
        "pipeline.failed": { remotes: { origin: true } },
        "task.failed": { enabled: true },
      },
    }).events;
    expect(events).toEqual({
      "git.pushed": { enabled: true, branches: ["main", "release/*"], remotes: { mirror: false } },
      "merge_request.opened": { enabled: true },
      "pipeline.failed": { enabled: false, remotes: { origin: true } },
      "task.failed": { enabled: true },
    });
    const config = { events };
    // A remote's own switch wins over `enabled`, either way.
    expect(enabledEvents(config, "origin")).toEqual([
      { name: "git.pushed", branches: ["main", "release/*"] },
      { name: "merge_request.opened" },
      { name: "pipeline.failed" },
    ]);
    expect(enabledEvents(config, "mirror")).toEqual([{ name: "merge_request.opened" }]);
    expect(enabledEvents(config, "upstream")).toEqual([{ name: "git.pushed", branches: ["main", "release/*"] }, { name: "merge_request.opened" }]);
    // JaiRA's own events have no remote; `enabledEvents` is the remote's list and leaves them out.
    expect(isEventEnabled(config, "task.failed")).toBe(true);
    expect(isEventEnabled(config, "task.finished")).toBe(false);
  });

  it("refuses what is not an event or not a setting, by name", () => {
    expect(() => parseConfig({ events: [] })).toThrow("config.events must be an object");
    // The name before decision 0016 is refused like any other: it is not an event any more.
    expect(() => parseConfig({ events: { "git.push": { enabled: true } } })).toThrow(/config\.events\["git\.push"\] is not an event — the events are git\.pushed, /);
    expect(() => parseConfig({ events: { "git.pushed": true } })).toThrow('config.events["git.pushed"] must be an object');
    expect(() => parseConfig({ events: { "git.pushed": { enabled: "yes" } } })).toThrow('config.events["git.pushed"].enabled must be true or false');
    expect(() => parseConfig({ events: { "git.pushed": { branch: ["main"] } } })).toThrow(/config\.events\["git\.pushed"\]\.branch is not a setting — it takes enabled, branches, remotes/);
    expect(() => parseConfig({ events: { "git.pushed": { branches: [] } } })).toThrow(/branches must be a non-empty array of branch globs/);
    expect(() => parseConfig({ events: { "git.pushed": { branches: "main" } } })).toThrow(/branches must be a non-empty array/);
    expect(() => parseConfig({ events: { "git.pushed": { branches: ["main", ""] } } })).toThrow('config.events["git.pushed"].branches[1] must be a non-empty string');
    expect(() => parseConfig({ events: { "git.pushed": { remotes: { origin: "off" } } } })).toThrow('config.events["git.pushed"].remotes.origin must be true or false');
    // JaiRA's own events have no branch and no remote.
    expect(() => parseConfig({ events: { "task.finished": { enabled: true, branches: ["main"] } } })).toThrow(/branches is not a setting — it takes enabled$/);
    expect(() => parseConfig({ events: { "task.finished": { remotes: {} } } })).toThrow(/remotes is not a setting/);
  });

  it("layers like every setting: switches key by key, and a stronger layer's branch list REPLACES the weaker one's", () => {
    const merged = mergeConfigLayers([
      // Shared
      { events: { "git.pushed": { enabled: true, branches: ["main", "release/*"], remotes: { mirror: false } }, "merge_request.opened": { enabled: true } } },
      // This project
      { events: { "git.pushed": { branches: ["develop"], remotes: { upstream: false } } } },
      // Just you
      { events: { "merge_request.opened": { enabled: false } } },
    ]);
    expect(parseConfig(merged).events).toEqual({
      "git.pushed": { enabled: true, branches: ["develop"], remotes: { mirror: false, upstream: false } },
      "merge_request.opened": { enabled: false },
    });
  });
});
