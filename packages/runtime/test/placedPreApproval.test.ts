/**
 * A tool whose line has PLACES is never pre-approved (decision 0023 §3.10).
 *
 * The gate is handed a placed line at its LOOSEST answer, and a call is brought down to its own by the
 * per-call narrowing. A delegated agent pre-approves every tool whose mode, read with no input, is
 * `allow` (`--allowedTools`), and a pre-approved tool is never put to the gate — so the narrowing never
 * ran. Under `chat/read-only`, whose `read_file` is `allow` in the project and `ask` elsewhere and at
 * `**​/.env`, every read was pre-approved and none was asked about: the engine hands a delegated agent
 * its raw tools and its own gate, built from the policy's `scopeOf`. Seen in a real conversation, where
 * a read of `~/.claude/…` came back refused by the tool in 9 ms with nobody asked.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createToolGate, PermissionLedger } from "@declarative-ai/permissions";
import { parsePermissionSet, permissionsOfPermissionSet, type PermissionSet } from "@jaira/shared";
import { compilePolicy } from "../src/policy";
import { gateTools } from "../src/tools";
import { newRegistry } from "../src/wiring";

const shipped = (name: string): PermissionSet =>
  parsePermissionSet(JSON.parse(readFileSync(fileURLToPath(new URL(`../../shared/builtin/permission-sets/chat/${name}.json`, import.meta.url)), "utf8"))).permissionSet;

/** The gate the engine builds for a delegated agent: its own, over the policy's narrowing and the state's lowered block. */
const engineGate = (permissionSet: PermissionSet, scopes?: Parameters<typeof compilePolicy>[1] extends infer O ? (O extends { scopes?: infer S } ? S : never) : never) => {
  const policy = compilePolicy({}, { permissionSet, workspaceRoot: "/work", ...(scopes !== undefined ? { scopes } : {}) });
  return createToolGate({
    ledger: new PermissionLedger({ baseline: policy.baseline ?? {} }),
    sessionId: "s",
    approve: () => ({ decision: "deny", scope: "once" }),
    tools: { read_file: { readOnly: true }, glob: { readOnly: true }, web_search: { readOnly: true } },
    authored: permissionsOfPermissionSet(permissionSet) as never,
    ...(policy.scopeOf !== undefined ? { scopeOf: policy.scopeOf } : {}),
  });
};

describe("what a delegated agent may pre-approve", () => {
  it("does not pre-approve a tool whose places ask somewhere", () => {
    for (const set of ["read-only", "auto", "full"]) {
      const gate = engineGate(shipped(set));
      // Every shipped set asks about credential files, wherever its reads are allowed.
      expect({ set, mode: gate.modeOf({ name: "read_file", readOnly: true }) }).not.toEqual({ set, mode: "allow" });
      expect({ set, mode: gate.modeOf({ name: "glob", readOnly: true }) }).not.toEqual({ set, mode: "allow" });
    }
  });

  it("still pre-approves a line with no places, where nothing narrows it", () => {
    const gate = engineGate(parsePermissionSet({ read_file: "allow", web_search: "allow" }).permissionSet);
    expect(gate.modeOf({ name: "read_file", readOnly: true })).toBe("allow");
    expect(gate.modeOf({ name: "web_search", readOnly: true })).toBe("allow");
  });

  it("does not pre-approve a place tool under the executor's floor, which refuses what it does not name", () => {
    const gate = engineGate(parsePermissionSet({ read_file: "allow", web_search: "allow" }).permissionSet, [{ path: "/work/**", default: "allow" }]);
    expect(gate.modeOf({ name: "read_file", readOnly: true })).not.toBe("allow");
    // A tool that names no path is the floor's to leave alone.
    expect(gate.modeOf({ name: "web_search", readOnly: true })).toBe("allow");
  });

  it("still pre-approves a turn's wrapped tools, whose wrapper decides each call when it runs", () => {
    const set = shipped("read-only");
    const { gate } = gateTools({ registry: newRegistry(), names: [], sessionId: "s", permissionSet: set, workspaceRoot: "/work" });
    // No tool was wrapped here, so nothing is pre-gated: the gate's own word is not `allow`.
    expect(gate.modeOf({ name: "read_file", readOnly: true })).not.toBe("allow");
  });
});
