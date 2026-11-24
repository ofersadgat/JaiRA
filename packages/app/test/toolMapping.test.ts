import { describe, expect, it } from "vitest";
import { parseConfig, toolResourcesOf } from "@jaira/shared";
import { mappingWriteOf, toggledResources, toolMappingGroupsOf } from "../src/renderer/toolMappingModel";
import { mappingOf } from "../src/renderer/permissionBoardHost";

describe("the tool mapping", () => {
  it("ships the one resource each tool acts on", () => {
    expect(toolResourcesOf("read_file")).toEqual(["files.read"]);
    expect(toolResourcesOf("open_app")).toEqual(["programs.open"]);
    expect(toolResourcesOf("write_clipboard")).toEqual(["machine.clipboard"]);
    expect(toolResourcesOf("shell --run_in_background")).toEqual(["programs.run"]);
    expect(toolResourcesOf("runner:ssh")).toEqual(["programs.run"]);
    expect(toolResourcesOf("web_search")).toEqual(["sites.search"]);
    expect(toolResourcesOf("list_tasks")).toEqual(["workflows.see"]);
    expect(toolResourcesOf("stop_task")).toEqual(["workflows.control"]);
    expect(toolResourcesOf("load_skill")).toEqual(["files.skills"]);
    expect(toolResourcesOf("npm run build")).toEqual(["programs.run"]);
    expect(toolResourcesOf("git")).toEqual(["programs.run"]);
    expect(toolResourcesOf("glob")).toEqual(["files.search"]);
    expect(toolResourcesOf("list_services")).toEqual(["programs.see"]);
    expect(toolResourcesOf("install_program")).toEqual(["programs.install"]);
    expect(toolResourcesOf("show_artifact")).toEqual(["files.artifacts"]);
    expect(toolResourcesOf("mcp__github__create_issue")).toEqual([]);
  });

  it("is overridden per tool by the settings, [] meaning none", () => {
    expect(toolResourcesOf("mcp__github__search_code", { mcp__github__search_code: ["repositories.read"] })).toEqual(["repositories.read"]);
    expect(toolResourcesOf("read_file", { read_file: [] })).toEqual([]);
  });

  it("is read from permissions.resources, which refuses a name no resource has", () => {
    expect(parseConfig({ permissions: { resources: { mcp__github__create_issue: ["repositories.write"] } } }).permissions.resources).toEqual({ mcp__github__create_issue: ["repositories.write"] });
    expect(() => parseConfig({ permissions: { resources: { grep: ["files.teleport"] } } })).toThrow(/no resource permission/);
    expect(mappingOf({ permissions: { resources: { grep: ["files.read", 3] } } })).toEqual({ grep: ["files.read"] });
  });

  it("draws a row per tool, marks the page's layer's word, and puts a mapped MCP tool under Other tools", () => {
    const groups = toolMappingGroupsOf({ permissions: { resources: { list_windows: ["programs.screen"], mcp__github__create_issue: ["repositories.write"] } } }, { permissions: { resources: { list_windows: ["programs.screen"] } } });
    const rows = groups.flatMap((group) => group.rows);
    expect(rows.find((row) => row.tool === "list_windows")).toMatchObject({ stated: true, changed: true, resources: [{ name: "programs.screen", label: "Programs · Screen" }] });
    expect(rows.find((row) => row.tool === "read_file")).toMatchObject({ stated: false, changed: false });
    expect(rows.some((row) => row.tool === "runner:*")).toBe(true);
    expect(groups.at(-1)).toMatchObject({ label: "Other tools", rows: [{ tool: "mcp__github__create_issue" }] });
  });

  it("toggles a resource and writes the tool's list, or takes the layer's word away", () => {
    const row = { resources: [{ name: "files.read", label: "", resource: "files", icon: "read" }] };
    expect(toggledResources(row, "machine.clipboard")).toEqual(["files.read", "machine.clipboard"]);
    expect(toggledResources(row, "files.read")).toEqual([]);
    expect(mappingWriteOf("grep", ["files.read"])).toEqual([["permissions", "resources", "grep"], ["files.read"]]);
    expect(mappingWriteOf("grep", undefined)).toEqual([["permissions", "resources", "grep"], undefined]);
  });
});

describe("every tool JaiRA ships", () => {
  it("is under one resource, and only MCP tools and `other` are left under Other", async () => {
    const { TOOL_SPECS } = await import("@jaira/shared");
    expect(TOOL_SPECS.filter((spec) => toolResourcesOf(spec.name).length !== 1).map((spec) => spec.name)).toEqual([]);
  });
});

describe("place sets", () => {
  it("ship, take the machine's projects folder as the root folder, and are added to or replaced by the settings", async () => {
    const { placeSetsOf } = await import("@jaira/shared");
    const sets = placeSetsOf({ "api-keys": ["~/.npmrc"], project: ["$PROJECT", "$WORKTREE"] }, "C:/Users/me/projects");
    expect(sets.find((set) => set.id === "credentials")!.places).toContain("~/.ssh");
    expect(sets.find((set) => set.id === "root")).toMatchObject({ label: "root folder", places: ["C:/Users/me/projects"] });
    expect(sets.find((set) => set.id === "project")).toMatchObject({ label: "project files", places: ["$PROJECT", "$WORKTREE"] });
    expect(sets.find((set) => set.id === "api-keys")).toMatchObject({ custom: true });
  });

  it("are read from permissions.placeSets", () => {
    expect(parseConfig({ permissions: { placeSets: { "api-keys": ["~/.npmrc"] } } }).permissions.placeSets).toEqual({ "api-keys": ["~/.npmrc"] });
    expect(() => parseConfig({ permissions: { placeSets: { "api-keys": "~/.npmrc" } } })).toThrow(/list of places/);
  });

  it("are edited as text, a set that ships replaced in the page's layer and reset", async () => {
    const { placeSetRowsOf, placesOfText, placeSetWriteOf, placeSetNameProblem } = await import("../src/renderer/placeSetsModel");
    const rows = placeSetRowsOf({ permissions: { placeSets: { credentials: ["~/.ssh"] } } }, { permissions: { placeSets: { credentials: ["~/.ssh"] } } }, "D:/code");
    expect(rows[0]).toMatchObject({ id: "credentials", builtin: true, stated: true, places: ["~/.ssh"] });
    expect(rows.find((row) => row.id === "root")).toMatchObject({ fixed: true });
    expect(placesOfText("~/.npmrc, **/secrets/**\n\n ~/.docker ")).toEqual(["~/.npmrc", "**/secrets/**", "~/.docker"]);
    expect(placeSetWriteOf("credentials", undefined)).toEqual([["permissions", "placeSets", "credentials"], undefined]);
    expect(placeSetNameProblem("credentials", rows)).toMatch(/already/);
    expect(placeSetNameProblem("api keys", rows)).toMatch(/no spaces/);
  });
});

describe("a renamed tool's old name", () => {
  it("is read as the new one in a line, a setting and a lookup, with a warning on the line", async () => {
    const { normalizeSubject, parsePermissionSet, TOOL_SPEC_BY_NAME, canonicalToolName } = await import("@jaira/shared");
    expect(normalizeSubject("list_software")).toBe("list_programs");
    expect(normalizeSubject("install_software")).toBe("install_program");
    expect(canonicalToolName("read_file")).toBe("read_file");
    expect(TOOL_SPEC_BY_NAME.get("install_software")?.name).toBe("install_program");
    const parsed = parsePermissionSet({ list_software: "allow", install_software: "ask" });
    expect(Object.keys(parsed.permissionSet.entries).sort()).toEqual(["install_program", "list_programs"]);
    expect(parsed.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message).join(" ")).toMatch(/'list_software' is now 'list_programs'/);
    expect(toolResourcesOf("list_software")).toEqual(["programs.see"]);
    expect(toolResourcesOf("list_programs", { list_software: ["machine.read"] })).toEqual(["machine.read"]);
  });
});
