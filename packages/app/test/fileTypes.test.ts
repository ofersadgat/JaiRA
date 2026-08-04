/**
 * The surface registry: what renders a file, and what happens when nothing does.
 *
 * The mechanism is small enough that the risky part is the fallback chain rather than the table.
 * Two properties matter and both are load-bearing for the UI: a text type that nobody registered
 * still resolves to an editor (otherwise clicking a `.ts` file in the tree shows a dead panel), and
 * `view` is allowed to resolve to nothing (that null is what makes the editor fill the column, so a
 * bug here silently halves the space every plain file gets).
 *
 * Stub surfaces rather than the real components: this is a test about lookup, and importing the
 * built-in table would drag React, a markdown parser and a DOM sanitizer into a node test to prove
 * something none of them are involved in.
 */
import { describe, expect, it } from "vitest";
import { CONFIG_JSON, WORKFLOW_JSON, WORKFLOW_YAML } from "@jaira/shared/browser";
import { registerFileSurface, registeredMimes, resolveFileSurface, type FileSurface } from "../src/renderer/fileTypes";

/** A surface identified by name — enough to assert WHICH one resolution picked. */
const stub = (name: string): FileSurface => Object.assign(() => null as never, { surfaceName: name });
const nameOf = (surface: FileSurface | null): string | null =>
  surface === null ? null : ((surface as unknown as { surfaceName: string }).surfaceName ?? "?");

const TEXT_EDIT = stub("TextEdit");
const MARKDOWN_VIEW = stub("MarkdownView");
const JSON_VIEW = stub("JsonView");
const YAML_EDIT = stub("YamlEdit");
const WORKFLOW_VIEW = stub("WorkflowRunView");
const WORKFLOW_EDIT = stub("WorkflowEdit");
const CONFIG_EDIT = stub("ConfigEdit");

registerFileSurface("text/plain", "edit", TEXT_EDIT);
registerFileSurface("text/markdown", "view", MARKDOWN_VIEW);
registerFileSurface("application/json", "view", JSON_VIEW);
registerFileSurface("application/yaml", "edit", YAML_EDIT);
registerFileSurface(WORKFLOW_JSON, "view", WORKFLOW_VIEW);
registerFileSurface(WORKFLOW_JSON, "edit", WORKFLOW_EDIT);
registerFileSurface(WORKFLOW_YAML, "view", WORKFLOW_VIEW);
registerFileSurface(CONFIG_JSON, "edit", CONFIG_EDIT);

describe("resolveFileSurface", () => {
  it("prefers an exact registration over anything it falls back to", () => {
    expect(nameOf(resolveFileSurface(WORKFLOW_JSON, "edit"))).toBe("WorkflowEdit");
    expect(nameOf(resolveFileSurface(WORKFLOW_JSON, "view"))).toBe("WorkflowRunView");
  });

  it("sends a vendor type with no editor to the syntax it is written in", () => {
    // The case that made the chain worth having: a YAML state keeps the board on top, but its
    // editor must be the YAML one — the authoring form serialises JSON and would rewrite the file.
    expect(nameOf(resolveFileSurface(WORKFLOW_YAML, "view"))).toBe("WorkflowRunView");
    expect(nameOf(resolveFileSurface(WORKFLOW_YAML, "edit"))).toBe("YamlEdit");
  });

  it("gives every unregistered text type the plain editor", () => {
    expect(nameOf(resolveFileSurface("text/x-typescript", "edit"))).toBe("TextEdit");
    expect(nameOf(resolveFileSurface("text/plain", "edit"))).toBe("TextEdit");
    expect(nameOf(resolveFileSurface("application/toml", "edit"))).toBe("TextEdit");
  });

  it("resolves no viewer for a type that has nothing to show beyond its own text", () => {
    // Not a gap: this null is what tells the panel to give the editor the whole column.
    expect(resolveFileSurface("text/plain", "view")).toBeNull();
    expect(resolveFileSurface("text/x-typescript", "view")).toBeNull();
  });

  it("resolves nothing at all for a type that is not text", () => {
    expect(resolveFileSurface("image/png", "edit")).toBeNull();
    expect(resolveFileSurface("image/png", "view")).toBeNull();
  });

  it("lets a later registration replace an earlier one", () => {
    const replacement = stub("BetterMarkdown");
    registerFileSurface("text/markdown", "view", replacement);
    expect(nameOf(resolveFileSurface("text/markdown", "view"))).toBe("BetterMarkdown");
    registerFileSurface("text/markdown", "view", MARKDOWN_VIEW);
  });

  it("keeps the two actions independent — registering one does not imply the other", () => {
    expect(nameOf(resolveFileSurface("application/json", "view"))).toBe("JsonView");
    // No JSON editor was registered here, so it falls through to the plain one.
    expect(nameOf(resolveFileSurface("application/json", "edit"))).toBe("TextEdit");
    // Config registers only an editor here, so its viewer comes from `application/json` — a vendor
    // type inherits down the chain per action, not per type.
    expect(nameOf(resolveFileSurface(CONFIG_JSON, "view"))).toBe("JsonView");
    expect(nameOf(resolveFileSurface(CONFIG_JSON, "edit"))).toBe("ConfigEdit");
  });

  it("lists what it holds", () => {
    expect(registeredMimes()).toContain(WORKFLOW_JSON);
    expect(registeredMimes()).toContain("text/plain");
  });
});
