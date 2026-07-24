import { describe, expect, it } from "vitest";
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
  it("parses the default model and defaults artifactDir", () => {
    const cfg = parseConfig({ models: { default: "anthropic/claude-sonnet-5" } });
    expect(cfg.models.default).toBe("anthropic/claude-sonnet-5");
    expect(cfg.artifactDir).toBe("jaira-artifacts");
    expect(parseConfig({})).toEqual(defaultConfig());
    expect(() => parseConfig({ models: "nope" })).toThrow(/must be an object/);
    expect(() => parseConfig([])).toThrow(/object/);
  });

  it("requires the default model to be route-prefixed (routing is explicit)", () => {
    expect(() => parseConfig({ models: { default: "claude-sonnet-5" } })).toThrow(/route-prefixed/);
    expect(() => parseConfig({ models: { default: "" } })).toThrow(/non-empty/);
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
    const paths = jairaPaths("/some/project");
    expect(paths.jairaDir.endsWith(".jaira")).toBe(true);
    expect(paths.workflowsDir).toContain(".jaira");
    expect(paths.dbFile.endsWith("jaira.db")).toBe(true);
  });
});
