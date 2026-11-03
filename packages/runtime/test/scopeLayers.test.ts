/**
 * Two layers: an executor's floor, and what narrows within it — a table layered under it
 * (`layeredScopeMode`), and a permission set line's places (decision 0023 §7.2: the floor stays a
 * floor no line widens).
 *
 * The property is one-directional and it is the whole reason the two are resolved SEPARATELY rather
 * than concatenated into one table. Merged, a state's more specific entry would outrank the floor's
 * — which is exactly the widening the floor exists to forbid, arriving through the specificity rule
 * that is right within a single table and wrong across two.
 */
import { describe, expect, it } from "vitest";
import type { FunctionInputs } from "@declarative-ai/exec";
import { layeredScopeMode, type Scope } from "@jaira/shared";
import { parsePermissionSet } from "@jaira/shared";
import { gateTools, registerAllTools, scopeNarrowingFor } from "../src/tools";
import { newRegistry } from "../src/wiring";

const FLOOR: Scope[] = [{ path: "/work/**", tools: { read_file: "allow", write_file: "deny" } }];

describe("a state narrows the floor and cannot widen it", () => {
  it("keeps a state's narrowing where the floor permits", () => {
    const state: Scope[] = [{ path: "/work/infra/**", default: "deny" }];
    expect(layeredScopeMode(FLOOR, state, "read_file", "/work/a.ts")).toBe("allow");
    // The state shuts a door the floor left open — allowed, and the point of narrowing.
    expect(layeredScopeMode(FLOOR, state, "read_file", "/work/infra/a.ts")).toBe("deny");
  });

  it("refuses to let a state open a door the floor shut", () => {
    // The property. A state saying `allow` about something the floor denies is still denied — the
    // same rule as "a state cannot widen past its profile".
    const greedy: Scope[] = [{ path: "/work/app/**", tools: { write_file: "allow" } }];
    expect(layeredScopeMode(FLOOR, greedy, "write_file", "/work/app/x.ts")).toBe("deny");
  });

  it("refuses a place the floor never named, whatever the state says", () => {
    // Unmatched denies in the floor, so a state cannot reach outside the sandbox by describing it.
    const escape: Scope[] = [{ path: "/etc/**", default: "allow" }];
    expect(layeredScopeMode(FLOOR, escape, "read_file", "/etc/passwd")).toBe("deny");
  });

  it("lets either layer stand alone, and says nothing when there is neither", () => {
    expect(layeredScopeMode(FLOOR, undefined, "read_file", "/work/a.ts")).toBe("allow");
    expect(layeredScopeMode(undefined, FLOOR, "read_file", "/work/a.ts")).toBe("allow");
    // Nothing authored ⇒ no narrowing at all, so a project that has not opted in pays nothing.
    expect(layeredScopeMode(undefined, undefined, "read_file", "/work/a.ts")).toBeUndefined();
  });
});

describe("the narrowing the gate is handed: the floor, and a line's places above it", () => {
  it("is the floor's table alone, absent when there is none", () => {
    const narrow = scopeNarrowingFor(FLOOR, "/work")!;
    expect(narrow({ name: "write_file" }, { path: "/work/app/x.ts" } as FunctionInputs)).toBe("deny");
    expect(narrow({ name: "read_file" }, { path: "/work/app/x.ts" } as FunctionInputs)).toBe("allow");
    expect(scopeNarrowingFor(undefined, "/work")).toBeUndefined();
    expect(scopeNarrowingFor([], "/work")).toBeUndefined();
  });

  it("refuses what the floor shut, whatever a line's place allows (decision 0023 §7.2)", async () => {
    const registry = newRegistry();
    registerAllTools(registry, { cwd: "/work", files: { vars: { taskId: "t", worktree: "/work" } } as never });
    const { gate } = gateTools({
      registry,
      names: ["write_file", "read_file"],
      sessionId: "floor-under-places",
      approve: () => ({ decision: "allow", scope: "once" }),
      // The set allows writing under app/ — the floor denies writing anywhere.
      permissionSet: parsePermissionSet({ write_file: { "**": "deny", "/work/app": "allow" }, read_file: { "/work/app": "allow", "**": "ask" } }).permissionSet,
      scopeFloor: FLOOR,
      workspaceRoot: "/work",
    });
    expect(await gate.check({ name: "write_file" }, { path: "/work/app/x.ts" })).toMatchObject({ allow: false });
    // Where both allow, the call runs; a place the floor never named is refused by the floor.
    expect(await gate.check({ name: "read_file" }, { path: "/work/app/x.ts" })).toMatchObject({ allow: true });
    expect(await gate.check({ name: "read_file" }, { path: "/etc/passwd" })).toMatchObject({ allow: false });
  });
});
