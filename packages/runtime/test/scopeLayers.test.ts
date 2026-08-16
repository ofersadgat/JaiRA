/**
 * Two layers: an executor's floor, and a state narrowing within it.
 *
 * The property is one-directional and it is the whole reason the two are resolved SEPARATELY rather
 * than concatenated into one table. Merged, a state's more specific entry would outrank the floor's
 * — which is exactly the widening the floor exists to forbid, arriving through the specificity rule
 * that is right within a single table and wrong across two.
 */
import { describe, expect, it } from "vitest";
import type { FunctionInputs } from "@declarative-ai/exec";
import { layeredScopeMode, type Scope } from "@jaira/shared";
import { scopeNarrowingFor } from "../src/tools";

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

describe("the narrowing the gate is handed composes both layers", () => {
  it("applies the floor even when the state's table is silent", () => {
    const narrow = scopeNarrowingFor([{ path: "/work/app/**", default: "allow" }], "/work", undefined, FLOOR)!;
    expect(narrow({ name: "write_file" }, { path: "/work/app/x.ts" } as FunctionInputs)).toBe("deny");
    expect(narrow({ name: "read_file" }, { path: "/work/app/x.ts" } as FunctionInputs)).toBe("allow");
  });

  it("exists as soon as EITHER layer does", () => {
    expect(scopeNarrowingFor(undefined, "/work", undefined, FLOOR)).toBeDefined();
    expect(scopeNarrowingFor(FLOOR, "/work")).toBeDefined();
    expect(scopeNarrowingFor(undefined, "/work")).toBeUndefined();
  });
});
