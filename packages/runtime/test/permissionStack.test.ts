/**
 * The STACK, below the UI (decision 0023 §2.5–§2.8, §4.4): what a call is judged under once a set is
 * a stack of layers — who decided each part (§2.7), the runtime layer's answers (§2.6 step 4), a direct
 * call put to the person with where it acts (§3.8), and a task pinned under the old place tables, which
 * must not run unbounded (the fail-closed fix for §3.7).
 */
import { describe, expect, it } from "vitest";
import type { FunctionInputs } from "@declarative-ai/exec";
import {
  lowerPermissionSet,
  parsePermissionSet,
  resolveChatPermissionStack,
  type PermissionSetReader,
  type PermissionsDecl,
} from "@jaira/shared";
import { CommandGrants, commandDecisionOf, compilePolicy, decideCommand, STALE_SCOPES_REASON } from "../src/policy";
import { ApprovalHub } from "../src/approval";
import { shellPermissionSetOf } from "../src/commandParts";
import { namedPlacesOf } from "../src/linePlaces";

const ROOT = "/work";

/** A reader over a table of set files, as the loader's would follow `$/permission-sets/<id>`. */
const readerOver = (files: Record<string, unknown>): PermissionSetReader => (reference) => {
  const id = /permission-sets\/(.+)$/.exec(reference)?.[1];
  const value = id !== undefined ? files[id] : undefined;
  if (value === undefined) throw new Error(`reference '${reference}' matches no file`);
  return { value, key: id!, from: reference };
};

const FILES = {
  "chat/ask-first": { read_file: "ask", shell: "ask", git: "ask", "git status": "allow", write_file: "ask", other: "ask" },
  "chat/build-safe": { "npm run build": { packages: "allow" }, git: "allow" },
  "web/docs-sites": { web_fetch: { "docs.example.com": "allow" }, "git push": "deny" },
};
const read = readerOver(FILES);
const STANDING = { chat: ["$/permission-sets/chat/build-safe"] };

/** A conversation's settings read through its stack, as the service reads them before a turn. */
const conversation = (settings: Record<string, unknown>) => resolveChatPermissionStack(settings, read, { standing: STANDING });

describe("who decided each part (§2.7)", () => {
  const stacked = conversation({ layers: ["$/permission-sets/chat/ask-first", "$/permission-sets/web/docs-sites"], write_file: "allow" });
  const decide = (line: string, grants?: CommandGrants) =>
    decideCommand({}, line, "posix", {
      permissionSet: shellPermissionSetOf(stacked.permissionSet)!,
      permissionSetSource: "inline",
      stack: stacked.stack,
      root: ROOT,
      places: { root: ROOT, named: { $PROJECT: ROOT } },
      ...(grants !== undefined ? { grants } : {}),
    });

  it("names the layer of the line that decided, at the place that did", () => {
    const parts = decide("git status && git log && git push && cd packages/app && npm run build").parts.parts;
    const by = (text: string) => parts.find((part) => part.text === text)!.decidedBy;
    // `git status` is the preset's own line; `git` the standing layer's, newer than the preset's `git`.
    expect(by("git status")).toMatchObject({ entry: "git status", layer: "chat/ask-first" });
    expect(by("git log")).toMatchObject({ entry: "git", layer: "chat/build-safe" });
    // The conversation's own layer refuses a push, under every layer below it.
    expect(by("git push")).toMatchObject({ entry: "git push", layer: "web/docs-sites", source: "permissionSet" });
    expect(by("npm run build")).toMatchObject({ entry: "npm run build", place: "packages", layer: "chat/build-safe" });
  });

  it("lists the stack newest first for the dialog — tools, runtime, the conversation's layers, the standing one, the preset", () => {
    const approval = decide("git commit -m x", new CommandGrants()).parts;
    expect(approval.stack).toEqual(["tools", "runtime", "web/docs-sites", "chat/build-safe", "chat/ask-first"]);
  });

  it("names `runtime` for an answer given in this task", () => {
    const grants = new CommandGrants();
    grants.remember("terraform plan", "allow");
    const part = decide("terraform plan", grants).parts.parts[0]!;
    expect(part.decidedBy).toMatchObject({ source: "remembered", layer: "runtime" });
  });

  it("names the layer in a RUN too, read off the lowered block's stack", () => {
    const block = lowerPermissionSet(stacked.permissionSet, "inline", stacked.stack).permissions!;
    const policy = compilePolicy({}, { execEnv: { wsl: "test" }, workspaceRoot: ROOT });
    const input = { command: "git log" };
    policy.scopeOf!({ name: "shell" }, input as FunctionInputs, block as never);
    expect(commandDecisionOf(input)!.parts.parts[0]!.decidedBy.layer).toBe("chat/build-safe");
  });

  it("names the layer in a TURN, from the stack the policy was compiled for", () => {
    const policy = compilePolicy({}, { execEnv: { wsl: "test" }, workspaceRoot: ROOT, permissionSet: stacked.permissionSet, stack: stacked.stack });
    const input = { command: "git push" };
    expect(policy.scopeOf!({ name: "shell" }, input as FunctionInputs, undefined as never)).toBe("deny");
    expect(commandDecisionOf(input)!.parts.parts[0]!.decidedBy.layer).toBe("web/docs-sites");
  });
});

describe("the runtime layer: answers given in this task (§2.6 step 4)", () => {
  const set = { shell: "ask", git: "allow", "git status": "allow", "git push": "ask", other: "ask" };
  const decide = (line: string, grants: CommandGrants) =>
    decideCommand({}, line, "posix", { permissionSet: shellPermissionSetOf(parsePermissionSet(set).permissionSet)!, grants, root: ROOT, places: { root: ROOT } });

  it("keeps a DENY for this run at the width chosen, and refuses the next part it covers", async () => {
    let asked: string | undefined;
    const hub = new ApprovalHub({ onRequest: (request) => void (asked = request.requestId) });
    const input = { command: "git push origin main" };
    const policy = compilePolicy({}, { execEnv: { wsl: "test" }, workspaceRoot: ROOT, permissionSet: parsePermissionSet(set).permissionSet, grants: hub.grants("t1") });
    expect(policy.scopeOf!({ name: "shell" }, input as FunctionInputs, undefined as never)).toBe("ask");
    const answer = hub.approver({ taskId: "t1" })({ tool: "shell", input, sessionId: "s" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hub.decide(asked!, "deny", "workflow-run", ["git push"])).toBe(true);
    expect(await answer).toEqual({ decision: "deny", scope: "once" });
    expect(hub.grants("t1").list()).toEqual({ "git push": "deny" });
    // The next push is refused by the run's answer, without anybody being asked.
    const next = decide("git push origin feature", hub.grants("t1"));
    expect(next.action).toBe("deny");
    expect(next.parts.parts[0]!.decidedBy).toMatchObject({ source: "remembered", layer: "runtime" });
  });

  it("lets a refusal kept at a wider width refuse what a layer below ALLOWS no more specifically — and not a more specific line", () => {
    const grants = new CommandGrants();
    grants.remember("git", "deny");
    // `git log` answers to the set's `git: allow`; the run's `git: deny` is newer at the same width.
    expect(decide("git log", grants).action).toBe("deny");
    // `git status` has a line of its own, more specific than `git`, which still stands (§2.2).
    expect(decide("git status", grants).action).toBe("allow");
  });

  it("never lifts a refusal with an allowance (invariant 28)", () => {
    const grants = new CommandGrants();
    grants.remember("git push", "allow");
    expect(decideCommand({}, "git push", "posix", { permissionSet: shellPermissionSetOf(parsePermissionSet({ "git push": "deny", shell: "ask" }).permissionSet)!, grants }).action).toBe("deny");
  });

  it("does not stand over the TOOLS layer, which is newer still", () => {
    const stacked = conversation({ layers: ["$/permission-sets/chat/ask-first"], "git log": "allow" });
    const grants = new CommandGrants();
    grants.remember("git", "deny");
    const line = (text: string) =>
      decideCommand({}, text, "posix", { permissionSet: shellPermissionSetOf(stacked.permissionSet)!, stack: stacked.stack, grants, root: ROOT, places: { root: ROOT } });
    expect(line("git log").parts.parts[0]!.decidedBy).toMatchObject({ layer: "tools" });
    expect(line("git log").action).toBe("allow");
    expect(line("git diff").action).toBe("deny");
  });
});

describe("a direct call put to the person with where it acts (§3.8)", () => {
  const set = { read_file: { "**": "ask", src: "allow" }, write_file: "ask", other: "deny" };
  const block = (): PermissionsDecl => lowerPermissionSet(parsePermissionSet(set).permissionSet, "$/permission-sets/x/y").permissions!;

  it("carries ONE part with the place widths it may be kept at, and is settled by an answer kept at a place", () => {
    const grants = new CommandGrants();
    const policy = compilePolicy({}, { execEnv: { wsl: "test" }, workspaceRoot: ROOT, grants });
    const input = { path: "docs/guide/a.md" };
    expect(policy.scopeOf!({ name: "read_file" }, input as FunctionInputs, block() as never)).toBe("ask");
    const part = commandDecisionOf(input)!.parts.parts[0]!;
    expect(part).toMatchObject({ kind: "tool", subject: "read_file", verdict: "asks", widths: ["read_file"] });
    expect(part.where).toMatchObject({ kind: "path", at: "/work/docs/guide/a.md" });
    expect(part.where!.widths.map((w) => w.place)).toEqual(["docs/guide/a.md", "docs/guide", "$PROJECT", "**"]);
    // A line with no places is asked about with where it acts too, so the dialog can offer Where.
    const write = { path: "notes/b.md", content: "x" };
    expect(policy.scopeOf!({ name: "write_file" }, write as FunctionInputs, block() as never)).toBe("ask");
    expect(commandDecisionOf(write)!.parts.parts[0]!.where!.widths.map((w) => w.place)).toContain("notes");
    // "For this run, in docs": the next read there is allowed, and one elsewhere still asks.
    grants.remember("read_file", "allow", "docs");
    const again = { path: "docs/other.md" };
    expect(policy.scopeOf!({ name: "read_file" }, again as FunctionInputs, block() as never)).toBeUndefined();
    expect(commandDecisionOf(again)!.action).toBe("allow");
    expect(policy.scopeOf!({ name: "read_file" }, { path: "lib/x.ts" } as FunctionInputs, block() as never)).toBe("ask");
    // And a refusal kept at a place refuses there.
    grants.remember("write_file", "deny", "notes");
    expect(policy.scopeOf!({ name: "write_file" }, { path: "notes/c.md", content: "y" } as FunctionInputs, block() as never)).toBe("deny");
  });
});

describe("a task pinned under the old place tables FAILS CLOSED (§3.7)", () => {
  const set = { read_file: "allow", shell: "allow", web_search: "allow", other: "deny" };
  /** A block as a snapshot pinned before 2026-11-02 holds it: a set, and the state table beside it. */
  const pinned = (): PermissionsDecl =>
    ({ ...lowerPermissionSet(parsePermissionSet(set).permissionSet).permissions!, scopes: [{ glob: "docs/**", tools: { read_file: "allow" } }] }) as unknown as PermissionsDecl;
  const policy = compilePolicy({}, { execEnv: { wsl: "test" }, workspaceRoot: ROOT, scopes: undefined });

  it("refuses every call that names a place, and every shell line, saying to start the task again", () => {
    const read = { path: "docs/a.md" };
    expect(policy.scopeOf!({ name: "read_file" }, read as FunctionInputs, pinned() as never)).toBe("deny");
    expect(commandDecisionOf(read)!.reason).toBe(STALE_SCOPES_REASON);
    expect(STALE_SCOPES_REASON).toMatch(/start the task again/);
    const line = { command: "ls" };
    expect(policy.scopeOf!({ name: "shell" }, line as FunctionInputs, pinned() as never)).toBe("deny");
    // An agent's own tools are judged by the standard tool they are.
    expect(policy.scopeOf!({ name: "Read" }, { file_path: "src/a.ts", path: "src/a.ts" } as FunctionInputs, pinned() as never)).toBe("deny");
    expect(policy.scopeOf!({ name: "Bash" }, { command: "git status" } as FunctionInputs, pinned() as never)).toBe("deny");
  });

  it("leaves a call that names no place as it was, and a block without the key untouched", () => {
    expect(policy.scopeOf!({ name: "web_search" }, { query: "x" } as FunctionInputs, pinned() as never)).toBeUndefined();
    const fresh = lowerPermissionSet(parsePermissionSet(set).permissionSet).permissions!;
    expect(policy.scopeOf!({ name: "read_file" }, { path: "docs/a.md" } as FunctionInputs, fresh as never)).toBeUndefined();
  });

  it("refuses through a conversation turn's gate too — the block a turn inherits from the pinned state", () => {
    const turn = compilePolicy({}, { execEnv: { wsl: "test" }, workspaceRoot: ROOT, permissionSet: parsePermissionSet(set).permissionSet, places: undefined } as never);
    expect(turn.scopeOf!({ name: "read_file" }, { path: "docs/a.md" } as FunctionInputs, pinned() as never)).toBe("deny");
  });
});

describe("named places on this machine", () => {
  it("are what the policy resolves `$PROJECT` against", () => {
    expect(namedPlacesOf(ROOT).$PROJECT).toBe(ROOT);
  });
});
