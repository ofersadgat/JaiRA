/**
 * A scope table, enforced — the first step where a place actually refuses a call.
 *
 * `scopes.test.ts` pins the table's arithmetic; this pins the wiring: that the vocabulary's own
 * declaration of what a tool takes is what gets resolved, that the narrowing reaches BOTH routes a
 * call can travel (a wrapped tool and a delegated agent's callback), and that it narrows rather than
 * widens.
 */
import { describe, expect, it } from "vitest";
import { isPermissionDenied, PermissionLedger, type Approver } from "@declarative-ai/permissions";
import type { ExecServices, FunctionInputs, Tool } from "@declarative-ai/exec";
import { newRegistry } from "../src/wiring";
import { gateTools, scopeNarrowingFor } from "../src/tools";
import { registerAllTools } from "../src/tools";

const ROOT = "/work";
const CTX = {} as ExecServices;

const scopes = [
  { path: "/work/**", tools: { read_file: "allow", glob: "allow" } },
  { path: "/work/app/**", tools: { write_file: "allow", edit: "allow" } },
  { path: "/work/infra/**", default: "deny" },
] as const;

const allowAll: Approver = () => ({ decision: "allow", scope: "once" });

const gated = (names: string[]) => {
  const registry = newRegistry();
  registerAllTools(registry, { cwd: ROOT, files: { vars: { taskId: "t", worktree: ROOT } } as never });
  return gateTools({
    registry,
    names,
    sessionId: "s1",
    approve: allowAll,
    authored: { tools: { read_file: "allow", write_file: "allow", glob: "allow" }, scopes: [...scopes] as never },
    workspaceRoot: ROOT,
  });
};

describe("the narrowing a scope table supplies", () => {
  it("resolves the argument the VOCABULARY says names a place", () => {
    const narrow = scopeNarrowingFor([...scopes] as never, ROOT)!;
    expect(narrow({ name: "read_file" }, { path: "/work/a.ts" } as FunctionInputs)).toBe("allow");
    expect(narrow({ name: "read_file" }, { path: "/work/infra/a.ts" } as FunctionInputs)).toBe("deny");
    // `write_file` is allowed only under app/ — everywhere else the table says nothing and denies.
    expect(narrow({ name: "write_file" }, { path: "/work/app/x.ts" } as FunctionInputs)).toBe("allow");
    expect(narrow({ name: "write_file" }, { path: "/work/x.ts" } as FunctionInputs)).toBe("deny");
  });

  it("reads a native name as the logical one it stands for", () => {
    // A gate asked about the agent's own `Read` must resolve the table written for `read_file`, or
    // the two spellings are two policies.
    const narrow = scopeNarrowingFor([...scopes] as never, ROOT)!;
    expect(narrow({ name: "Read" }, { path: "/work/a.ts" } as FunctionInputs)).toBe("allow");
    expect(narrow({ name: "Read" }, { path: "/work/infra/a.ts" } as FunctionInputs)).toBe("deny");
  });

  it("treats a path-taking call with no path as being about the workspace", () => {
    // `glob` with no directory walks from the root, and that is the place it is about.
    const narrow = scopeNarrowingFor([...scopes] as never, ROOT)!;
    expect(narrow({ name: "glob" }, {} as FunctionInputs)).toBe("allow");
  });

  it("says nothing about a tool that names no place", () => {
    // `undefined`, not `deny`: a table that does not apply must not refuse.
    const narrow = scopeNarrowingFor([...scopes] as never, ROOT)!;
    expect(narrow({ name: "web_search" }, { query: "x" } as FunctionInputs)).toBeUndefined();
  });

  it("is absent entirely when nothing authored a table", () => {
    // A project with no scopes pays nothing and behaves exactly as before.
    expect(scopeNarrowingFor(undefined, ROOT)).toBeUndefined();
    expect(scopeNarrowingFor([], ROOT)).toBeUndefined();
  });
});

describe("both routes a call can travel", () => {
  it("refuses through the GATE — what a delegated agent's callback asks", async () => {
    const { gate } = gated(["read_file"]);
    expect(await gate.check({ name: "read_file" }, { path: "/work/a.ts" })).toMatchObject({ allow: true });
    expect(await gate.check({ name: "read_file" }, { path: "/work/infra/secret" })).toMatchObject({ allow: false });
  });

  it("refuses through the WRAPPED TOOL — what a composed runtime runs", async () => {
    // The same decision by the other road. A scope binding only one of them would be a sandbox with
    // a door in it.
    const { tools } = gated(["read_file"]);
    const read = tools["read_file"] as Tool;
    const denied = await read.run({ path: "/work/infra/secret" } as FunctionInputs, CTX);
    expect(isPermissionDenied(denied as never)).toBe(true);
  });

  it("narrows rather than widens — an allowed mode still loses to a denying scope", async () => {
    // `read_file: "allow"` is authored, and the table still refuses it under infra/.
    const { gate } = gated(["read_file"]);
    expect(await gate.check({ name: "read_file" }, { path: "/work/infra/x" })).toMatchObject({ allow: false });
  });

  it("leaves a project with no table exactly as it was", async () => {
    const registry = newRegistry();
    registerAllTools(registry, { cwd: ROOT, files: { vars: { taskId: "t", worktree: ROOT } } as never });
    const { gate } = gateTools({
      registry,
      names: ["read_file"],
      sessionId: "s2",
      approve: allowAll,
      authored: { tools: { read_file: "allow" } },
      workspaceRoot: ROOT,
    });
    expect(await gate.check({ name: "read_file" }, { path: "/anywhere/at/all" })).toMatchObject({ allow: true });
  });
});

describe("the ledger cannot be talked past a scope", () => {
  it("remembers an approval for the run without rescuing a denied place", async () => {
    // Scope resolves BEFORE the ledger is consulted, so a remembered allow can satisfy an `ask` and
    // can never upgrade a `deny`.
    const registry = newRegistry();
    registerAllTools(registry, { cwd: ROOT, files: { vars: { taskId: "t", worktree: ROOT } } as never });
    let asked = 0;
    const approve: Approver = () => {
      asked++;
      return { decision: "allow", scope: "workflow-run" };
    };
    const { gate } = gateTools({
      registry,
      names: ["read_file"],
      sessionId: "s3",
      approve,
      authored: { tools: { read_file: "ask" }, scopes: [...scopes] as never },
      workspaceRoot: ROOT,
    });
    expect(await gate.check({ name: "read_file" }, { path: "/work/a.ts" })).toMatchObject({ allow: true });
    expect(asked).toBe(1);
    // The approval is remembered — and `infra/` is still refused, without reaching the human again.
    expect(await gate.check({ name: "read_file" }, { path: "/work/infra/x" })).toMatchObject({ allow: false });
    expect(asked).toBe(1);
  });
});

describe("PermissionLedger stays the ledger", () => {
  it("is untouched by scoping — the table is a narrowing, not a second store", () => {
    expect(new PermissionLedger({}).resolveProfile("s1")).toBeDefined();
  });
});
