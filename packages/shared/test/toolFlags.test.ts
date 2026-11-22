/**
 * A tool's line refined by its arguments (decision 0032, ruling 1a): `shell --run_in_background`,
 * `list_processes --scope=user`. Read, refused when it names what the tool does not offer, lowered and
 * read back, and handed to the gate at its loosest.
 */
import { describe, expect, it } from "vitest";
import {
  gateToolModes,
  lowerPermissionSet,
  parsePermissionSet,
  permissionSetOfEnvironment,
  subjectKindOf,
} from "../src/permissionSets";
import { addToPermissionSetText } from "../src/permissionSetEdit";
import { placeKindOf } from "../src/places";
import { callFlagWidthsOf, callFlagsOf, flagLineMatches, parseToolFlagSubject } from "../src/toolFlags";

describe("a flag line is a subject of its own", () => {
  it("is a tool's name followed by its flags — the shell's may go on to name a command", () => {
    expect(subjectKindOf("shell --run_in_background")).toBe("tool-flag");
    expect(subjectKindOf("list_processes --scope=user")).toBe("tool-flag");
    expect(subjectKindOf("stop_process --scope=group --group=docker")).toBe("tool-flag");
    expect(subjectKindOf("shell --run_in_background npm run dev")).toBe("tool-flag");
    expect(parseToolFlagSubject("shell --run_in_background npm run dev")).toEqual({ tool: "shell", flags: [{ name: "run_in_background" }], command: "npm run dev" });
  });

  it("leaves a program that shares a tool's name a command, as it always was", () => {
    // `grep` is a tool AND a program; the tool takes no flag, so `grep --include` is the program's line.
    expect(subjectKindOf("grep --include")).toBe("command");
    expect(subjectKindOf("git push --force")).toBe("command");
    expect(subjectKindOf("shell")).toBe("tool");
  });

  it("takes the place its tool takes", () => {
    expect(placeKindOf("shell --run_in_background")).toBe("path");
    expect(placeKindOf("shell --run_in_background npm run dev")).toBe("path");
    expect(placeKindOf("stop_process --scope=user")).toBe("program");
    expect(placeKindOf("list_processes --scope=user")).toBeUndefined();
  });
});

describe("reading a set with flag lines", () => {
  it("holds each as a flag line, beside the tool's own", () => {
    const { permissionSet, issues } = parsePermissionSet({
      shell: "ask",
      "shell --run_in_background": "deny",
      "shell --run_in_background npm run dev": "allow",
      list_processes: "ask",
      "list_processes --scope=session": "allow",
      "stop_process --scope=user": { "**": "ask", node: "allow" },
    });
    expect(issues).toEqual([]);
    expect(permissionSet.entries["shell --run_in_background"]).toEqual({ kind: "tool-flag", mode: "deny" });
    expect(permissionSet.entries["shell --run_in_background npm run dev"]).toEqual({ kind: "tool-flag", mode: "allow" });
    expect(permissionSet.entries["list_processes --scope=session"]).toEqual({ kind: "tool-flag", mode: "allow" });
    expect(permissionSet.entries["stop_process --scope=user"]).toEqual({ kind: "tool-flag", mode: "ask", places: { node: "allow" } });
  });

  it.each([
    ["shell --background", "'--background' is not a flag of shell — 'shell' takes --run_in_background"],
    ["list_processes --scope=everyone", "'everyone' is not a scope — '--scope' is one of session, jaira, user, group, system, all"],
    ["list_processes --sort=cpu", "'--sort' is not a flag of list_processes — 'list_processes' takes --scope=session|jaira|user|group|system|all, --group=<group>"],
    ["shell --run_in_background=true", "'--run_in_background' takes no value — write '--run_in_background' alone"],
    ["list_processes --scope", "'--scope' takes a value — --scope=session|jaira|user|group|system|all"],
    ["list_processes --scope=user --scope=all", "'--scope' is named twice — a line names each flag once"],
    ["list_processes --scope=user node", "'node' follows the flags, and only the shell's line names a command after them — 'list_processes' takes --scope=session|jaira|user|group|system|all, --group=<group>"],
    ["read_file --path=x", "'--path' is not a flag of read_file — 'read_file' takes no flag — a line for it is 'read_file' alone"],
  ])("refuses '%s', saying what the tool offers", (subject, message) => {
    const { permissionSet, issues } = parsePermissionSet({ [subject]: "allow" });
    expect(issues).toEqual([{ path: subject, message, severity: "error" }]);
    expect(permissionSet.entries).toEqual({});
  });

  it("refuses unavailable on a flag line, and a place map where the tool takes no place", () => {
    expect(parsePermissionSet({ "list_processes --scope=user": "unavailable" }).issues[0]?.message).toMatch(/cannot be unavailable — what the model is handed is per tool, not per argument/);
    expect(parsePermissionSet({ "list_processes --scope=user": { "**": "ask", x: "allow" } }).issues[0]?.message).toMatch(/takes no place/);
  });
});

describe("matching a call", () => {
  it("reads a left-out scope as its default, session", () => {
    expect([...callFlagsOf("list_processes", {})]).toEqual([["scope", "session"]]);
    expect([...callFlagsOf("stop_process", { pid: 1, scope: "group", group: "docker" })]).toEqual([
      ["scope", "group"],
      ["group", "docker"],
    ]);
    expect([...callFlagsOf("shell", { command: "npm run dev", run_in_background: true })]).toEqual([["run_in_background", true]]);
    expect([...callFlagsOf("shell", { command: "npm test" })]).toEqual([]);
  });

  it("matches a line naming only flags the call has, at its values", () => {
    const call = callFlagsOf("stop_process", { scope: "group", group: "Docker" });
    expect(flagLineMatches(parseToolFlagSubject("stop_process --scope=group")!, call)).toBe(true);
    expect(flagLineMatches(parseToolFlagSubject("stop_process --scope=group --group=docker")!, call)).toBe(true);
    expect(flagLineMatches(parseToolFlagSubject("stop_process --scope=group --group=staff")!, call)).toBe(false);
    expect(flagLineMatches(parseToolFlagSubject("stop_process --scope=user")!, call)).toBe(false);
  });

  it("offers the call's own flags as the lines an answer may be kept at, narrowest first", () => {
    expect(callFlagWidthsOf("list_processes", { scope: "user" })).toEqual(["list_processes --scope=user", "list_processes"]);
    expect(callFlagWidthsOf("stop_process", { scope: "group", group: "docker" })).toEqual(["stop_process --scope=group --group=docker", "stop_process --scope=group", "stop_process"]);
    expect(callFlagWidthsOf("stop_process", { scope: "group", group: "Domain Users" })).toEqual(["stop_process --scope=group", "stop_process"]);
  });
});

describe("lowering a set with flag lines", () => {
  const { permissionSet } = parsePermissionSet({
    shell: "ask",
    "shell --run_in_background": "ask",
    list_processes: "ask",
    "list_processes --scope=session": "allow",
    stop_process: "deny",
    "stop_process --scope=session": "allow",
    read_process: "ask",
    other: "deny",
  });

  it("hands the gate each tool at the loosest of its lines, so the narrowing only tightens", () => {
    const gate = gateToolModes(permissionSet);
    expect(gate["list_processes"]).toBe("allow");
    expect(gate["stop_process"]).toBe("allow");
    expect(gate["read_process"]).toBe("ask");
    // The shell's line is read per line, whatever it says.
    expect(gate["shell"]).toBe("ask");
    // No flag line is a tool of the gate's.
    expect(Object.keys(gate).some((key) => key.includes(" "))).toBe(false);
  });

  it("is read back exactly: each tool's own mode, and each flag line", () => {
    const lowered = lowerPermissionSet(permissionSet);
    expect(lowered.tools).not.toContain("list_processes --scope=session");
    expect(lowered.permissions?.tools?.["list_processes --scope=session"]).toBe("allow");
    const read = permissionSetOfEnvironment(lowered.tools, lowered.permissions);
    expect(read.entries["list_processes"]).toMatchObject({ kind: "tool", mode: "ask" });
    expect(read.entries["stop_process"]).toMatchObject({ kind: "tool", mode: "deny" });
    expect(read.entries["list_processes --scope=session"]).toEqual({ kind: "tool-flag", mode: "allow" });
    expect(read.entries["shell --run_in_background"]).toEqual({ kind: "tool-flag", mode: "ask" });
    expect(read.entries["read_process"]).toMatchObject({ kind: "tool", mode: "ask" });
  });
});

describe("an answer kept as a flag line", () => {
  it("is written into a set file as any line is, and reads back as the flag line", () => {
    const text = addToPermissionSetText(`{
  "shell": "ask",
  "other": "deny"
}
`, { "shell --run_in_background npm run dev": "allow", "list_processes --scope=user": "deny" });
    const { permissionSet, issues } = parsePermissionSet(JSON.parse(text));
    expect(issues).toEqual([]);
    expect(permissionSet.entries["shell --run_in_background npm run dev"]).toEqual({ kind: "tool-flag", mode: "allow" });
    expect(permissionSet.entries["list_processes --scope=user"]).toEqual({ kind: "tool-flag", mode: "deny" });
  });
});
