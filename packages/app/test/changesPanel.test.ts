/**
 * The Changes tab's reading of a record (main's `changeLog.ts`) and its file tree (`changesModel.ts`):
 * calls paired with their results, a subagent's calls attributed to it, a shell line judged part by
 * part, and folders that hold only a folder merged into one row.
 */
import { describe, expect, it } from "vitest";
import { categoryOf, judgedCallsOf, rawCallsOf, type ReadOnlyJudge } from "@jaira/service/changeLog";
import { treeOf } from "../src/renderer/changesModel";
import type { FileChange } from "@jaira/shared";

const at = "2026-09-26T14:00:00.000Z";
const record = {
  value: {
    entries: [
      { kind: "message", role: "assistant", timestamp: at, provider: "anthropic", content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "git status && git commit -m x", description: "Commit it" } }] },
      { kind: "message", role: "user", timestamp: at, provider: "anthropic", content: [{ type: "tool_result", tool_use_id: "c1", content: "[main abc1234] x" }] },
      { kind: "message", role: "assistant", timestamp: at, provider: "anthropic", content: [{ type: "tool_use", id: "t1", name: "Task", input: { description: "Split the nav", prompt: "…" } }] },
      { kind: "message", role: "assistant", timestamp: at, provider: "anthropic", sidechain: { id: "agent-1", parentToolUseId: "t1" }, content: [{ type: "tool_use", id: "s1", name: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" } }] },
      { kind: "message", role: "user", timestamp: at, provider: "anthropic", sidechain: { id: "agent-1", parentToolUseId: "t1" }, content: [{ type: "tool_result", tool_use_id: "s1", is_error: false, content: "ok", data: { structuredPatch: [] } }] },
    ],
  },
};

describe("reading a record", () => {
  it("pairs each call with its result, and attributes a subagent's calls to the call that spawned it", () => {
    const calls = rawCallsOf(record as never);
    expect(calls.map((c) => [c.id, c.name, c.ok, c.by?.kind === "subagent" ? c.by.name : undefined])).toEqual([
      ["c1", "Bash", true, undefined],
      ["t1", "Task", undefined, undefined],
      ["s1", "Edit", true, "Split the nav"],
    ]);
    expect(calls[0]!.text).toBe("[main abc1234] x");
  });

  it("judges a shell line part by part: a status passes, a commit does not", () => {
    // A stand-in for the read-only set: git status and reads pass, anything else is a change.
    const judge: ReadOnlyJudge = (name, args) => (name === "bash" || name === "Bash" ? /^git status$/.test(String((args as { command: string }).command)) : name === "Read");
    const [bash] = judgedCallsOf([record as never], { judge, dialect: "posix" });
    expect(bash!.change).toBe(true);
    expect(bash!.parts?.map((p) => [p.program, p.subcommand, p.change])).toEqual([
      ["git", "status", false],
      ["git", "commit", true],
    ]);
  });

  it("files a call where the tool menu files its tool", () => {
    expect(categoryOf("Edit")).toEqual({ standard: "edit", category: "files" });
    expect(categoryOf("mcp__dai__open_merge_request")).toEqual({ standard: "open_merge_request", category: "git" });
    expect(categoryOf("mcp__linear__update_issue")).toEqual({ category: "mcp" });
    expect(categoryOf("SomethingNew")).toEqual({ category: "other" });
  });
});

describe("the file tree", () => {
  const file = (path: string): FileChange => ({ path, action: "modify", hunks: [], calls: [] });

  it("merges a folder that holds only a folder into one row, and nests the rest", () => {
    const rows = treeOf([file("packages/app/src/renderer/styles.css"), file("packages/app/src/renderer/settings/nav.tsx"), file("packages/app/test/a.test.ts"), file("README.md")]);
    expect(rows.map((row) => (row.kind === "folder" ? `${"  ".repeat(row.depth)}${row.name}/` : `${"  ".repeat(row.depth)}${row.file.path.split("/").pop()}`))).toEqual([
      "packages/app/",
      "  src/renderer/",
      "    settings/",
      "      nav.tsx",
      "    styles.css",
      "  test/",
      "    a.test.ts",
      "README.md",
    ]);
  });
});
