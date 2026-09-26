/**
 * The command runners' gate in a permission set on the page (decision 0007, amended 2026-09-26,
 * later): under Execution, a group whose head is `runner:*` and a row per runner — its own line with a
 * minus, or none, then the group's mode, faded.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COMMAND_RUNNERS, parsePermissionSet, TOOL_SPECS, type PermissionSetDecl, type ToolChoice } from "@jaira/shared";
import { holdsRunners, runnerFallbackOf, runnerRowsOf, sectionCountOf, withoutRunners, withRunners, withSubject } from "../src/renderer/composerPermissionSet";
import { PermissionSetCard, RUNNERS_FOLD } from "../src/renderer/permissionSetCard";

const shipped = (name: string): PermissionSetDecl =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../shared/builtin/permission-sets/chat/${name}.json`, import.meta.url)), "utf8")) as PermissionSetDecl;
const READ_ONLY = parsePermissionSet(shipped("read-only")).permissionSet;
const TOOLS: ToolChoice[] = TOOL_SPECS.map((spec) => ({ name: spec.name }));

describe("the command runners' lines", () => {
  it("lists every runner, each with its own line's mode where it has one, the group's answering for the rest", () => {
    const rows = runnerRowsOf(READ_ONLY);
    expect(rows.map((row) => row.program)).toEqual(COMMAND_RUNNERS.map((runner) => runner.program));
    expect(rows.find((row) => row.program === "sudo")?.own).toBe("deny");
    expect(rows.find((row) => row.program === "npm")?.own).toBeUndefined();
    expect(runnerFallbackOf(READ_ONLY)).toBe("allow");
  });

  it("adds the group at ask, takes every runner line out with its minus, and counts the lines in Execution's badge", () => {
    const bare = parsePermissionSet({ bash: "deny", other: "deny" }).permissionSet;
    expect(holdsRunners(bare)).toBe(false);
    const gated = withRunners(bare);
    expect(gated.entries["runner:*"]).toEqual({ kind: "runner", mode: "ask" });
    expect(withSubject(gated, "runner:npm", "allow").entries["runner:npm"]).toEqual({ kind: "runner", mode: "allow" });
    expect(holdsRunners(withoutRunners(READ_ONLY))).toBe(false);
    expect(sectionCountOf(READ_ONLY, "execution") - sectionCountOf(withoutRunners(READ_ONLY), "execution")).toBe(8);
  });
});

describe("the group on the card", () => {
  const draw = (permissionSet = READ_ONLY, folds: string[] = ["execution", RUNNERS_FOLD], readOnly = false): string =>
    renderToStaticMarkup(createElement(PermissionSetCard, { permissionSet, tools: TOOLS, folds: new Set(folds), onChange: () => undefined, readOnly }));

  it("draws the group under Execution, a row per runner, a minus only on those with a line of their own", () => {
    const html = draw();
    expect(html).toContain("Command runners");
    expect(html.match(/class="set-runner[ "]/g)).toHaveLength(COMMAND_RUNNERS.length);
    // Rows with no line of their own follow the group, faded; sudo and its kind have their own.
    expect(html.match(/set-runner set-runner-follows/g)).toHaveLength(COMMAND_RUNNERS.length - 7);
    expect(html).toContain('title="remove sudo"');
    expect(html).not.toContain('title="remove npm"');
    // Closed, the head names the runners that have a line of their own.
    expect(draw(READ_ONLY, ["execution"])).toContain("sudo · doas · su · ssh · docker · podman · kubectl");
  });

  it("offers the group in Execution's add-menu when the set has no runner line", () => {
    const bare = parsePermissionSet({ bash: "ask", other: "ask" }).permissionSet;
    const html = renderToStaticMarkup(createElement(PermissionSetCard, { permissionSet: bare, tools: TOOLS, folds: new Set(["execution"]), onChange: () => undefined, startAdding: "execution" }));
    expect(html).toContain("Command runners");
    expect(html).not.toContain("set-runner");
  });
});
