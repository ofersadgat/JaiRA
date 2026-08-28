import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import {
  defaultConfig,
  parseJsonText,
  stripBom,
  isStartableStatus,
  isTaskId,
  isTerminalStatus,
  jairaPaths,
  newTaskId,
  parseConfig,
  parseTaskMeta,
  sessionKey,
} from "../src/index";

describe("task ids", () => {
  it("generates well-formed unique ids", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newTaskId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(isTaskId(id)).toBe(true);
  });
});

describe("statuses", () => {
  it("classifies terminal and startable statuses", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("canceled")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus("interrupted")).toBe(false);
    expect(isStartableStatus("queued")).toBe(true);
    expect(isStartableStatus("interrupted")).toBe(true);
    expect(isStartableStatus("failed")).toBe(true);
    expect(isStartableStatus("running")).toBe(false);
    expect(isStartableStatus("completed")).toBe(false);
  });
});

describe("parseTaskMeta", () => {
  it("accepts a valid meta and enforces the id/file-name match", () => {
    const meta = { id: "t-abc", title: "T", workflow: "feature/plan", createdAt: "2026-07-17T00:00:00Z" };
    expect(parseTaskMeta(meta, "t-abc").title).toBe("T");
    expect(() => parseTaskMeta(meta, "t-other")).toThrow(/does not match/);
    expect(() => parseTaskMeta({ id: "t-abc" })).toThrow(/title/);
    expect(() => parseTaskMeta(null)).toThrow(/object/);
  });
});

describe("config", () => {
  it("defaults artifactDir, and refuses the retired models.default", () => {
    expect(parseConfig({}).artifactDir).toBe("artifacts");
    expect(parseConfig({})).toEqual(defaultConfig());
    expect(() => parseConfig({ models: "nope" })).toThrow(/must be an object/);
    expect(() => parseConfig([])).toThrow(/object/);
    // A default MODEL could never route: the prompt router dispatches on `op.config.model` while a
    // leaf's defaults are applied inside its own lowering, so a default naming an agent was invisible
    // to the routing that had to happen first. Refused rather than dropped, because a config carrying
    // it was relying on it.
    expect(() => parseConfig({ models: { default: "anthropic/claude-sonnet-5" } })).toThrow(
      /executors.default.prompt.defaults.model/,
    );
  });

  it("points a config still carrying models.default at where those settings moved", () => {
    // Any value at all, well-formed or not: the field itself is gone, so validating its shape would
    // be validating a setting nothing reads.
    expect(() => parseConfig({ models: { default: "claude-sonnet-5" } })).toThrow(/has moved/);
    expect(() => parseConfig({ models: { default: "anthropic/claude-sonnet-5" } })).toThrow(/has moved/);
  });

  it("parses generic-cli agents", () => {
    const cfg = parseConfig({
      agents: { genericCli: [{ command: "opencode", args: ["run", "{prompt}"], prompt: "argument" }] },
    });
    expect(cfg.agents.genericCli).toEqual([
      { command: "opencode", args: ["run", "{prompt}"], prompt: "argument" },
    ]);
    expect(parseConfig({}).agents).toEqual({});
  });

  it("rejects a malformed agent entry rather than running the wrong binary", () => {
    // A typo here means a state either fails as "unregistered function" or runs
    // something unintended, so this is strict on purpose.
    expect(() => parseConfig({ agents: { genericCli: {} } })).toThrow(/must be an array/);
    expect(() => parseConfig({ agents: { genericCli: [{}] } })).toThrow(/\[0\]\.command/);
    expect(() => parseConfig({ agents: { genericCli: [{ command: "x", args: "run" }] } })).toThrow(/args/);
    expect(() => parseConfig({ agents: { genericCli: [{ command: "x", prompt: "pipe" }] } })).toThrow(/prompt/);
    expect(() => parseConfig({ agents: { genericCli: [{ command: "x", env: { A: 1 } }] } })).toThrow(/env/);
    expect(() => parseConfig({ agents: [] })).toThrow(/must be an object/);
  });
});

describe("json", () => {
  it("tolerates a UTF-8 BOM (PowerShell-written files)", () => {
    expect(stripBom("﻿{}")).toBe("{}");
    expect(parseJsonText('﻿{"a":1}')).toEqual({ a: 1 });
    expect(() => parseJsonText("nope", "--inputs")).toThrow(/--inputs: invalid JSON/);
  });
});

describe("paths", () => {
  it("derives the .jaira layout from the project dir", () => {
    const paths = jairaPaths("/some/project", testHome());
    expect(paths.jairaDir.endsWith(".jaira")).toBe(true);
    expect(paths.workflowsDir).toContain(".jaira");
    expect(paths.dbFile.endsWith("jaira.db")).toBe(true);
  });
});

/**
 * The identity of an open project, now that a process holds several.
 *
 * The failure this prevents is not cosmetic: two keys naming one directory would mean two
 * `better-sqlite3` handles on one file — two writers, two recovery passes, and a `jobs` claim each
 * believes it owns.
 */
describe("sessionKey", () => {
  const dir = mkdtempSync(join(tmpdir(), "jaira-key-"));

  it("collapses spellings of the same directory to one key", () => {
    expect(sessionKey(dir)).toBe(sessionKey(join(dir, "..", basename(dir))));
    expect(sessionKey(dir)).toBe(sessionKey(`${dir}${sep}`.slice(0, -1)));
  });

  it("keeps genuinely different directories apart", () => {
    expect(sessionKey(join(dir, "a"))).not.toBe(sessionKey(join(dir, "b")));
  });

  it.runIf(process.platform === "win32")("ignores case on Windows, where one path is one directory", () => {
    expect(sessionKey(dir.toUpperCase())).toBe(sessionKey(dir.toLowerCase()));
  });

  it.runIf(process.platform !== "win32")("keeps case elsewhere, where two spellings are two directories", () => {
    // Lowercasing on a case-sensitive filesystem would merge two real projects, which is the worse
    // failure of the two — so the normalization is deliberately platform-conditional.
    expect(sessionKey("/tmp/Foo")).not.toBe(sessionKey("/tmp/foo"));
  });

  it("answers for a directory that does not exist yet, which is what `init` hands it", () => {
    const missing = join(dir, "not-created-yet");
    expect(sessionKey(missing)).toBe(sessionKey(missing));
    expect(sessionKey(missing).length).toBeGreaterThan(0);
  });
});
