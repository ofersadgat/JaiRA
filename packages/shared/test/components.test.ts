/**
 * Component contracts (SPEC §8.1, DESIGN §7.1). Two jobs under test: reading the
 * authored config with useful errors, and refusing an out-of-contract answer
 * before it can reach the engine.
 */
import { describe, expect, it } from "vitest";
import {
  COMPONENT_NAMES,
  displayText,
  isComponentName,
  parseComponentConfig,
  validateComponentResult,
  type ComponentConfig,
} from "../src/components";

const parse = (name: Parameters<typeof parseComponentConfig>[0], raw: unknown): ComponentConfig =>
  parseComponentConfig(name, raw);

describe("component names", () => {
  it("covers the SPEC §8.1 set", () => {
    expect([...COMPONENT_NAMES]).toEqual([
      "choose_option",
      "review_artifact",
      "edit_markdown",
      "fill_form",
      "confirm_action",
    ]);
    expect(isComponentName("choose_option")).toBe(true);
    expect(isComponentName("nope")).toBe(false);
  });
});

describe("parseComponentConfig", () => {
  it("reads choose_option, accepting bare strings or labelled options", () => {
    const config = parse("choose_option", {
      prompt: "Review the critique result.",
      options: ["approve", { value: "block", label: "Block it", tone: "danger" }],
      comments: true,
    });
    expect(config).toEqual({
      component: "choose_option",
      prompt: "Review the critique result.",
      options: [{ value: "approve" }, { value: "block", label: "Block it", tone: "danger" }],
      comments: true,
    });
  });

  it("defaults the prompt and takes `decisions` as an alias for review options", () => {
    const config = parse("review_artifact", { artifact: "plan_doc", decisions: ["approve", "reject"] });
    expect(config).toMatchObject({
      component: "review_artifact",
      prompt: "Review",
      artifact: "plan_doc",
      options: [{ value: "approve" }, { value: "reject" }],
    });
  });

  it("reads a fill_form field subset", () => {
    const config = parse("fill_form", {
      prompt: "Details",
      fields: [
        { name: "title" },
        { name: "count", type: "number" },
        { name: "urgent", type: "boolean", optional: true },
        { name: "severity", type: "enum", enum: ["minor", "major"], label: "Severity" },
        { name: "notes", type: "string", multiline: true, optional: true },
      ],
    });
    expect(config).toMatchObject({
      component: "fill_form",
      fields: [
        { name: "title", type: "string" },
        { name: "count", type: "number" },
        { name: "urgent", type: "boolean", optional: true },
        { name: "severity", type: "enum", enum: ["minor", "major"], label: "Severity" },
        { name: "notes", type: "string", multiline: true, optional: true },
      ],
    });
  });

  it("defaults confirm_action labels and edit_markdown source", () => {
    expect(parse("confirm_action", {})).toEqual({
      component: "confirm_action",
      prompt: "Confirm this action",
      confirmLabel: "Confirm",
      cancelLabel: "Cancel",
    });
    expect(parse("edit_markdown", { source: "plan_doc" })).toEqual({
      component: "edit_markdown",
      prompt: "Edit",
      source: "plan_doc",
    });
  });

  it("rejects malformed authored config with a path-shaped message", () => {
    expect(() => parse("choose_option", { options: [] })).toThrow(/choose_option\.options must be a non-empty array/);
    expect(() => parse("choose_option", {})).toThrow(/choose_option\.options/);
    expect(() => parse("choose_option", { options: [{ label: "no value" }] })).toThrow(/options\[0\]\.value is required/);
    expect(() => parse("choose_option", { options: ["ok"], prompt: "" })).toThrow(/prompt must be a non-empty string/);
    expect(() => parse("choose_option", ["not", "an", "object"])).toThrow(/must be an object/);
    expect(() => parse("fill_form", { fields: [{ name: "x", type: "date" }] })).toThrow(/type must be one of/);
    expect(() => parse("fill_form", { fields: [{ name: "x", type: "enum" }] })).toThrow(/enum must be a non-empty array/);
    expect(() => parse("choose_option", { options: [{ value: "a", tone: "loud" }] })).toThrow(/tone must be/);
  });
});

describe("validateComponentResult", () => {
  const choose = parse("choose_option", { options: ["approve", "block"], comments: true });

  it("accepts a declared decision, with or without comments", () => {
    expect(validateComponentResult(choose, { decision: "approve" })).toEqual({ ok: true });
    expect(validateComponentResult(choose, { decision: "block", comments: "why" })).toEqual({ ok: true });
  });

  it("refuses an undeclared decision — the whole point of re-validating in main", () => {
    const check = validateComponentResult(choose, { decision: "ship-it-anyway" });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.errors).toMatch(/not one of: approve, block/);
  });

  it("refuses wrong shapes", () => {
    expect(validateComponentResult(choose, "approve").ok).toBe(false);
    expect(validateComponentResult(choose, null).ok).toBe(false);
    expect(validateComponentResult(choose, {}).ok).toBe(false);
    expect(validateComponentResult(choose, { decision: "approve", comments: 7 }).ok).toBe(false);
  });

  it("checks edit_markdown and confirm_action results", () => {
    const edit = parse("edit_markdown", {});
    expect(validateComponentResult(edit, { content: "# hi" })).toEqual({ ok: true });
    expect(validateComponentResult(edit, { content: 5 }).ok).toBe(false);

    const confirm = parse("confirm_action", {});
    expect(validateComponentResult(confirm, { confirmed: false })).toEqual({ ok: true });
    expect(validateComponentResult(confirm, { confirmed: "yes" }).ok).toBe(false);
  });

  it("checks fill_form fields by type, honouring optional", () => {
    const form = parse("fill_form", {
      fields: [
        { name: "title" },
        { name: "count", type: "number" },
        { name: "urgent", type: "boolean", optional: true },
        { name: "severity", type: "enum", enum: ["minor", "major"] },
      ],
    });
    expect(validateComponentResult(form, { title: "t", count: 2, severity: "minor" })).toEqual({ ok: true });

    const missing = validateComponentResult(form, { count: 2, severity: "minor" });
    expect(missing.ok === false && missing.errors).toMatch(/result\.title is required/);

    const wrong = validateComponentResult(form, { title: "t", count: "two", severity: "nope" });
    expect(wrong.ok === false && wrong.errors).toMatch(/count must be a number/);
    expect(wrong.ok === false && wrong.errors).toMatch(/severity must be one of: minor, major/);

    // An empty string counts as absent, so a required field cannot be skipped.
    const blank = validateComponentResult(form, { title: "", count: 1, severity: "major" });
    expect(blank.ok).toBe(false);
  });
});

describe("displayText", () => {
  it("renders whichever artifact shape arrives", () => {
    expect(displayText("plain")).toBe("plain");
    expect(displayText({ artifact: true, content: "# Plan" })).toBe("# Plan");
    expect(displayText({ artifact: true, path: "docs/plan.md" })).toBe("docs/plan.md");
    expect(displayText(undefined)).toBe("");
    expect(displayText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
