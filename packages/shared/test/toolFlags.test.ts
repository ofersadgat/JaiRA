/**
 * A tool's line refined by its arguments (decision 0032, ruling 1a): `shell --run_in_background`. Read,
 * refused when it names what the tool does not offer, lowered and read back, and handed to the gate at
 * its loosest. The process tools' old `--scope=` lines are no flag lines any more: what the agent asks
 * for is no permission, whose the process is is (decision 0023 §3.1, amended 2026-11-23) — they are read
 * as OWNER rules on their tool's line.
 */
import { describe, expect, it } from "vitest";
import { gateToolModes, lowerPermissionSet, parsePermissionSet, permissionSetOfEnvironment, subjectKindOf } from "../src/permissionSets";
import { addToPermissionSetText } from "../src/permissionSetEdit";
import { placeKindOf } from "../src/places";
import { callFlagWidthsOf, callFlagsOf, flagLineMatches, parseToolFlagSubject } from "../src/toolFlags";

describe("a flag line is a subject of its own", () => {
  it("is a tool's name followed by its flags — the shell's may go on to name a command", () => {
    expect(subjectKindOf("shell --run_in_background")).toBe("tool-flag");
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
  });
});

describe("reading a set with flag lines", () => {
  it("holds each as a flag line, beside the tool's own", () => {
    const { permissionSet, issues } = parsePermissionSet({
      shell: "ask",
      "shell --run_in_background": "deny",
      "shell --run_in_background npm run dev": "allow",
      "shell --run_in_background npm": { "packages/app": "allow" },
    });
    expect(issues).toEqual([]);
    expect(permissionSet.entries["shell --run_in_background"]).toEqual({ kind: "tool-flag", mode: "deny" });
    expect(permissionSet.entries["shell --run_in_background npm run dev"]).toEqual({ kind: "tool-flag", mode: "allow" });
    expect(permissionSet.entries["shell --run_in_background npm"]).toEqual({ kind: "tool-flag", places: { "packages/app": "allow" } });
  });

  it.each([
    ["shell --background", "'--background' is not a flag of shell — 'shell' takes --run_in_background, --untracked"],
    ["shell --run_in_background=true", "'--run_in_background' takes no value — write '--run_in_background' alone"],
    ["read_file --path=x", "'--path' is not a flag of read_file — 'read_file' takes no flag — a line for it is 'read_file' alone"],
  ])("refuses '%s', saying what the tool offers", (subject, message) => {
    const { permissionSet, issues } = parsePermissionSet({ [subject]: "allow" });
    expect(issues).toEqual([{ path: subject, message, severity: "error" }]);
    expect(permissionSet.entries).toEqual({});
  });

  it("reads `shell --untracked` — a start out of every tree JaiRA follows — as a flag line, alone or naming a program", () => {
    const { permissionSet, issues } = parsePermissionSet({ "shell --untracked": "deny", "shell --untracked schtasks": "ask" });
    expect(issues).toEqual([]);
    expect(permissionSet.entries["shell --untracked"]).toEqual({ kind: "tool-flag", mode: "deny" });
    expect(parseToolFlagSubject("shell --untracked schtasks")).toEqual({ tool: "shell", flags: [{ name: "untracked" }], command: "schtasks" });
    expect(permissionSet.entries["shell --untracked schtasks"]).toEqual({ kind: "tool-flag", mode: "ask" });
  });

  it("refuses unavailable on a flag line", () => {
    expect(parsePermissionSet({ "shell --run_in_background": "unavailable" }).issues[0]?.message).toMatch(/cannot be unavailable — what the model is handed is per tool, not per argument/);
  });
});

describe("a process tool's old `--scope=` line", () => {
  it("is read as an OWNER rule on its tool's line, saying so", () => {
    const { permissionSet, issues } = parsePermissionSet({
      list_processes: "ask",
      "list_processes --scope=session": "allow",
      "stop_process --scope=user": "deny",
      "read_process --scope=all": "ask",
    });
    expect(issues.map((i) => i.severity)).toEqual(["warning", "warning", "warning"]);
    expect(issues[0]!.message).toMatch(/is read as 'list_processes': \{ "owner": \{ "session": "allow" \} \}/);
    expect(permissionSet.entries["list_processes"]).toEqual({ kind: "tool", mode: "ask", places: { "owner=session": "allow" } });
    expect(permissionSet.entries["stop_process"]).toEqual({ kind: "tool", places: { "owner=user": "deny" } });
    expect(permissionSet.entries["read_process"]).toEqual({ kind: "tool", places: { "owner=**": "ask" } });
    expect(Object.keys(permissionSet.entries).some((key) => key.includes("--scope"))).toBe(false);
  });

  it("is refused where it cannot be read so — with places, or a group", () => {
    expect(parsePermissionSet({ "stop_process --scope=user": { node: "allow" } }).issues[0]).toMatchObject({ severity: "error", message: expect.stringMatching(/write it on 'stop_process' as \{ "owner"/) });
    expect(parsePermissionSet({ "stop_process --scope=group": "allow" }).issues[0]).toMatchObject({ severity: "error" });
  });
});

describe("matching a call", () => {
  it("reads a call's flags", () => {
    expect([...callFlagsOf("shell", { command: "npm run dev", run_in_background: true })]).toEqual([["run_in_background", true]]);
    expect([...callFlagsOf("shell", { command: "npm test" })]).toEqual([]);
    expect([...callFlagsOf("list_processes", { scope: "user" })]).toEqual([]);
  });

  it("matches a line naming only flags the call has", () => {
    expect(flagLineMatches(parseToolFlagSubject("shell --run_in_background")!, callFlagsOf("shell", { run_in_background: true }))).toBe(true);
    expect(flagLineMatches(parseToolFlagSubject("shell --run_in_background")!, callFlagsOf("shell", {}))).toBe(false);
  });

  it("offers the call's own flags as the lines an answer may be kept at, narrowest first", () => {
    expect(callFlagWidthsOf("shell", { run_in_background: true })).toEqual(["shell --run_in_background", "shell"]);
    expect(callFlagWidthsOf("shell", {})).toEqual(["shell"]);
  });
});

describe("lowering a set with flag lines", () => {
  const { permissionSet } = parsePermissionSet({
    shell: "ask",
    "shell --run_in_background": "allow",
    read_process: "ask",
    other: "deny",
  });

  it("hands the gate each tool at the loosest of its lines, so the narrowing only tightens", () => {
    const gate = gateToolModes(permissionSet);
    expect(gate["read_process"]).toBe("ask");
    // The shell's line is read per line, whatever it says.
    expect(gate["shell"]).toBe("ask");
    // No flag line is a tool of the gate's.
    expect(Object.keys(gate).some((key) => key.includes(" "))).toBe(false);
  });

  it("is read back exactly: each tool's own mode, and each flag line", () => {
    const lowered = lowerPermissionSet(permissionSet);
    expect(lowered.tools).not.toContain("shell --run_in_background");
    expect(lowered.permissions?.tools?.["shell --run_in_background"]).toBe("allow");
    const read = permissionSetOfEnvironment(lowered.tools, lowered.permissions);
    expect(read.entries["shell --run_in_background"]).toEqual({ kind: "tool-flag", mode: "allow" });
    expect(read.entries["read_process"]).toMatchObject({ kind: "tool", mode: "ask" });
  });
});

describe("an answer kept as a flag line", () => {
  it("is written into a set file as any line is, and reads back as the flag line", () => {
    const text = addToPermissionSetText(`{
  "shell": "ask",
  "other": "deny"
}
`, { "shell --run_in_background npm run dev": "allow" });
    const { permissionSet, issues } = parsePermissionSet(JSON.parse(text));
    expect(issues).toEqual([]);
    expect(permissionSet.entries["shell --run_in_background npm run dev"]).toEqual({ kind: "tool-flag", mode: "allow" });
  });
});
