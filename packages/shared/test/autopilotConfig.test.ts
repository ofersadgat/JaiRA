/**
 * `autopilot.askBelow` (decision 0005 §6) — the one platform setting a fast-forward reads.
 *
 * Very low by default, layered like every other block, strict about what it accepts, and offered in
 * Settings through the same declared form as the rest of `settings.json`. It is NOT any workflow's
 * threshold: nothing here names a workflow input (§0).
 */
import { describe, expect, it } from "vitest";
import { CONFIG_SECTIONS, DEFAULT_ASK_BELOW, defaultConfig, mergeConfigDocuments, parseConfig } from "../src/index";

describe("autopilot.askBelow", () => {
  it("defaults very low — the conversation answering for you is the exception, not the rule", () => {
    expect(DEFAULT_ASK_BELOW).toBe(0.2);
    expect(defaultConfig().autopilot).toEqual({ askBelow: 0.2 });
    expect(parseConfig({}).autopilot).toEqual({ askBelow: 0.2 });
    expect(parseConfig({ autopilot: {} }).autopilot).toEqual({ askBelow: 0.2 });
  });

  it("takes a project's value over the shared root's, key by key", () => {
    const merged = mergeConfigDocuments({ autopilot: { askBelow: 0.1 } }, { autopilot: { askBelow: 0.6 } });
    expect(parseConfig(merged).autopilot).toEqual({ askBelow: 0.6 });
  });

  it("refuses what is not a confidence, rather than answering more than somebody meant it to", () => {
    expect(() => parseConfig({ autopilot: { askBelow: 1.5 } })).toThrow("config.autopilot.askBelow must be a number between 0 and 1");
    expect(() => parseConfig({ autopilot: { askBelow: -0.1 } })).toThrow("config.autopilot.askBelow must be a number between 0 and 1");
    expect(() => parseConfig({ autopilot: { askBelow: "low" } })).toThrow("config.autopilot.askBelow must be a number between 0 and 1");
    expect(() => parseConfig({ autopilot: [] })).toThrow("config.autopilot must be an object");
    // The two ends are real answers: never answer for me, and always.
    expect(parseConfig({ autopilot: { askBelow: 1 } }).autopilot.askBelow).toBe(1);
    expect(parseConfig({ autopilot: { askBelow: 0 } }).autopilot.askBelow).toBe(0);
  });

  it("is offered in Settings as a declared section, drawn by the same form as every other", () => {
    const section = CONFIG_SECTIONS.find((s) => s.key === "autopilot");
    expect(section).toMatchObject({ key: "autopilot", title: "Fast-forward", schema: { type: "object", properties: { askBelow: { type: "number" } } } });
  });
});
