/**
 * `read-only-scratch`: read-only, with scratch space in the agent's own folder.
 *
 * The set is `read-only` but for its two writers, which refuse everywhere except `$AGENT_WORKSPACE`
 * (decision 0023 ruling 19) and refuse a credential even there. This pins what that line does at
 * the runtime: Claude keeps its own Write and Edit (asked per call, never pre-approved), each call is
 * judged at its place — allowed in the agent's folder, refused in the project — and Codex, which cannot be
 * told where, keeps its sandbox shut and is served JaiRA's tool instead.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FunctionInputs } from "@declarative-ai/exec";
import { claudeProjectsDir } from "@declarative-ai/agents-api";
import { createToolGate, PermissionLedger } from "@declarative-ai/permissions";
import { linePlaces, lowerPermissionSet, parsePermissionSet, permissionsOfPermissionSet, type PermissionSet } from "@jaira/shared";
import { compilePolicy } from "../src/policy";
import { placeNarrowingFor } from "../src/tools";
import { compileClaudePlaceRules, namedPlacesOf } from "../src/linePlaces";
import { CLAUDE_TOOLS, CODEX_TOOLS, planAgentTools } from "../src/agentTools";
import { noteCallAgent } from "../src/callAgent";

const shipped = (name: string): PermissionSet =>
  parsePermissionSet(JSON.parse(readFileSync(fileURLToPath(new URL(`../../shared/builtin/permission-sets/${name}.json`, import.meta.url)), "utf8"))).permissionSet;

const SCRATCH = shipped("read-only-scratch");
const READ_ONLY = shipped("read-only");
const ROOT = "C:/work/app";
const claudeFolder = `${claudeProjectsDir().replace(/\\/g, "/")}/C--work-app`;

describe("read-only-scratch", () => {
  it("keeps Claude's own Write and Edit, put to the gate per call, where read-only does not keep them", () => {
    // Native, because JaiRA's own `write_file` keeps the workspace (ruling 18) and would refuse the folder.
    const scratch = planAgentTools(SCRATCH, CLAUDE_TOOLS);
    expect(scratch.askNatives).toEqual(expect.arrayContaining(["Write", "Edit", "MultiEdit"]));
    expect(scratch.inject).not.toContain("write_file");
    expect(scratch.inject).not.toContain("edit");
    const readOnly = planAgentTools(READ_ONLY, CLAUDE_TOOLS);
    expect(readOnly.askNatives).not.toContain("Write");
    expect(readOnly.askNatives).not.toContain("Edit");
  });

  it("keeps Claude's own Read beside its own Write and Edit, which refuse a file their Read has not read", () => {
    // t-elvj5dhzoy, 2026-11-11: Read was displaced by ours, so every Edit of MEMORY.md was refused
    // "File has not been read yet" and the Read asked for next was "disabled for this session".
    const scratch = planAgentTools(SCRATCH, CLAUDE_TOOLS);
    expect(scratch.askNatives).toContain("Read");
    expect(scratch.displaced).not.toContain("Read");
    expect(scratch.denyNatives).not.toContain("Read");
    // Ours is still served beside it.
    expect(scratch.inject).toContain("read_file");
    // It is judged by the read line, at its places: the project's reads are pre-allowed as before.
    const rules = compileClaudePlaceRules(linePlaces(SCRATCH), { root: ROOT, named: namedPlacesOf(ROOT, undefined, CLAUDE_TOOLS), declaration: CLAUDE_TOOLS });
    expect(rules.allow).toEqual(expect.arrayContaining([`Read(${ROOT})`, `Read(${ROOT}/**)`]));
    // Where the writers are ours, so is the reader: `read-only` keeps no Read of Claude's.
    const readOnly = planAgentTools(READ_ONLY, CLAUDE_TOOLS);
    expect(readOnly.askNatives).not.toContain("Read");
    expect(readOnly.displaced).toContain("Read");
  });

  it("hands Claude an allow rule for its own folder only — everywhere else falls to the per-call ask", () => {
    const rules = compileClaudePlaceRules(linePlaces(SCRATCH), { root: ROOT, named: namedPlacesOf(ROOT, undefined, CLAUDE_TOOLS), declaration: CLAUDE_TOOLS });
    const writes = (list: string[]) => list.filter((rule) => rule.startsWith("Write("));
    expect(writes(rules.allow)).toEqual([`Write(${claudeFolder})`, `Write(${claudeFolder}/**)`]);
    expect(writes(rules.deny)).toEqual(expect.arrayContaining(["Write(**/.env)"]));
    // No writer rule names the project: a write there is not pre-allowed, and is put to the gate, which refuses it.
    const writers = [...rules.allow, ...rules.ask, ...rules.deny].filter((rule) => /^(Write|Edit|MultiEdit|NotebookEdit)\(/.test(rule));
    expect(writers.some((rule) => rule.includes(ROOT))).toBe(false);
    expect(rules.allow.filter((rule) => rule.startsWith("Edit("))).toEqual([`Edit(${claudeFolder})`, `Edit(${claudeFolder}/**)`]);
  });

  it("keeps Codex's sandbox shut: a switch cannot be told where, so JaiRA's writer is served instead", () => {
    expect(planAgentTools(SCRATCH, CODEX_TOOLS).switches).toEqual({ "workspace-write": false });
  });

  it("never pre-approves a write: the gate's word with no input is not `allow`", () => {
    const policy = compilePolicy({}, { permissionSet: SCRATCH, workspaceRoot: ROOT });
    const gate = createToolGate({
      ledger: new PermissionLedger({ baseline: policy.baseline ?? {} }),
      sessionId: "s",
      approve: () => ({ decision: "deny", scope: "once" }),
      tools: { write_file: { readOnly: false }, edit: { readOnly: false } },
      authored: permissionsOfPermissionSet(SCRATCH) as never,
      ...(policy.scopeOf !== undefined ? { scopeOf: policy.scopeOf } : {}),
    });
    expect(gate.modeOf({ name: "write_file", readOnly: false })).not.toBe("allow");
    expect(gate.modeOf({ name: "edit", readOnly: false })).not.toBe("allow");
  });

  it("allows a write in the calling agent's folder and refuses one in the project, elsewhere, or from no agent", () => {
    const block = lowerPermissionSet(SCRATCH, "$/permission-sets/read-only-scratch").permissions!;
    const narrow = placeNarrowingFor({ root: ROOT, named: namedPlacesOf(ROOT) });
    const write = (tool: string, path: string, agent?: typeof CLAUDE_TOOLS) => {
      const input = { path, content: "x" } as FunctionInputs;
      if (agent !== undefined) noteCallAgent(input, agent);
      return narrow({ name: tool }, input, block as never);
    };
    for (const tool of ["write_file", "edit"]) {
      expect(write(tool, `${claudeFolder}/memory/notes.md`, CLAUDE_TOOLS), tool).toBe("allow");
      expect(write(tool, `${claudeFolder}/scratch/plan.md`, CLAUDE_TOOLS), tool).toBe("allow");
      expect(write(tool, `${ROOT}/src/index.ts`, CLAUDE_TOOLS), tool).toBe("deny");
      expect(write(tool, "C:/Users/someone/Documents/x.txt", CLAUDE_TOOLS), tool).toBe("deny");
      // Another agent's folder is not its own, and a call no agent made has no folder.
      expect(write(tool, `${claudeFolder}/memory/notes.md`, CODEX_TOOLS), tool).toBe("deny");
      expect(write(tool, `${claudeFolder}/memory/notes.md`), tool).toBe("deny");
      // A credential by name is refused inside the agent's folder too.
      expect(write(tool, `${claudeFolder}/.env`, CLAUDE_TOOLS), tool).toBe("deny");
    }
  });
});
