/**
 * What a simulation's pass is decided under (decision 0029 §5 step 5): the conversation's own set with
 * the sandbox standing over it — fenced where the sandbox says where it stops — and nobody to ask.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalHub } from "@jaira/runtime";
import { parsePermissionSet } from "@jaira/shared";
import { sandboxedPermissionSet } from "../src/simulation";

const SANDBOX = (() => {
  const { description: _description, ...lines } = JSON.parse(readFileSync(join(__dirname, "..", "..", "shared", "builtin", "permission-sets", "improve", "simulation.json"), "utf8")) as Record<string, unknown>;
  return lines;
})();

describe("a simulation's permission set", () => {
  const base = parsePermissionSet({
    read_file: { "**": "ask", $WORKTREE: "ask" },
    edit: { "**": "smart", "~/notes": "allow" },
    write_file: { mode: "ask", implementation: "native" },
    shell: "smart",
    "git push": "ask",
    web_fetch: "ask",
  }).permissionSet;
  const set = sandboxedPermissionSet(base, SANDBOX);

  it("fences the lines that write and run: the workspace only, and nothing the conversation allowed elsewhere", () => {
    expect(set.entries["edit"]).toMatchObject({ mode: "deny", places: expect.objectContaining({ $WORKTREE: "allow", $AGENT_WORKSPACE: "allow", "$WORKTREE/.jaira": "deny" }) });
    expect(set.entries["edit"]!.places).not.toHaveProperty("~/notes");
    expect(set.entries["shell"]).toMatchObject({ mode: "deny", places: expect.objectContaining({ $WORKTREE: "allow" }) });
    // Whose code runs a tool stays the conversation's.
    expect(set.entries["write_file"]).toMatchObject({ mode: "deny", implementation: "native" });
  });

  it("lets it read its workspace and keeps what the conversation said of reading elsewhere", () => {
    expect(set.entries["read_file"]).toMatchObject({ mode: "ask", places: expect.objectContaining({ $WORKTREE: "allow", "**/.env": "deny" }) });
    expect(set.entries["web_fetch"]).toMatchObject({ mode: "ask" });
  });

  it("refuses pushing, merging and publishing, and hands the agent no tool the conversation did not hold", () => {
    expect(set.entries["git push"]).toMatchObject({ mode: "deny" });
    expect(set.entries["npm publish"]).toMatchObject({ mode: "deny" });
    expect(set.entries["git_push"]).toMatchObject({ mode: "deny", offered: false });
    expect(set.entries["start_task"]).toMatchObject({ mode: "deny", offered: false });
    // A tool no line names — an MCP server's that publishes, say — is refused too.
    expect(set.other).toBe("deny");
  });
});

describe("a task nobody answers for", () => {
  it("is refused what would be asked, at once, and asks again once it is let go", async () => {
    const asked: string[] = [];
    const hub = new ApprovalHub({ onRequest: (r) => asked.push(r.requestId) });
    const release = hub.unattend("t1", "a simulation is trying a change");
    expect(await hub.askFor({ tool: "shell", subject: "shell", function: "smart", input: { command: "ls" } }, { taskId: "t1" })).toBe("deny");
    expect(asked).toEqual([]);
    // Another task is asked as ever.
    void hub.askFor({ tool: "shell", subject: "shell", function: "smart", input: { command: "ls -a" } }, { taskId: "t2" });
    expect(asked).toHaveLength(1);
    release();
    void hub.askFor({ tool: "shell", subject: "shell", function: "smart", input: { command: "ls -l" } }, { taskId: "t1" });
    expect(asked).toHaveLength(2);
    hub.denyAll();
  });
});
