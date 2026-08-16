/**
 * The two axes of the tools menu, resolved into what an agent is actually handed.
 *
 * The old control could express two states — declared or not — and the third is where the leak was:
 * a tool nobody granted was merely undeclared, so the agent kept its own built-in and used it. A
 * `read-only` state watched twenty ungoverned reads go by on exactly that.
 */
import { describe, expect, it } from "vitest";
import { TOOL_SPECS } from "@jaira/shared";
import { claudePermissionSettings, claudeReplacements, planAgentTools, profileRules } from "../src/tools";

describe("planAgentTools", () => {
  it("denies the built-in of a tool nobody granted", () => {
    // The leak. Undeclared used to mean "the agent keeps its own", which is the opposite of what
    // leaving a box unticked looks like it means.
    const plan = planAgentTools([]);
    expect(plan.denyNatives).toContain("Read");
    expect(plan.denyNatives).toContain("Bash");
    expect(plan.inject).toEqual([]);
    expect(plan.askNatives).toEqual([]);
  });

  it("declares ours for `app`, so the built-in is displaced", () => {
    const plan = planAgentTools(["read_file"], { read_file: "app" });
    expect(plan.inject).toEqual(["read_file"]);
    // Not asked about — an injected tool is gated by `withPermission` where it executes.
    expect(plan.askNatives).not.toContain("Read");
    // And no longer denied, because it is granted.
    expect(plan.denyNatives).not.toContain("Read");
  });

  it("leaves the built-in for `native` but forces it to our gate", () => {
    // "Native" names the implementation, never the access. Without the ask-rule Claude Code's own
    // policy auto-allows its read-only built-ins and our callback never fires.
    const plan = planAgentTools(["read_file"], { read_file: "native" });
    expect(plan.inject).toEqual([]);
    expect(plan.askNatives).toEqual(["Read"]);
    expect(plan.denyNatives).not.toContain("Read");
  });

  it("defaults a granted tool to `app`", () => {
    // DECLARING a tool has always meant injecting ours, and every authored state relies on it.
    // `native` is the opt-out and it is the one that needs saying.
    expect(planAgentTools(["glob"]).inject).toEqual(["glob"]);
    expect(planAgentTools(["glob"]).askNatives).toEqual([]);
  });

  it("keeps the two axes independent", () => {
    const plan = planAgentTools(["read_file", "glob", "bash"], { read_file: "app", glob: "native" });
    expect(plan.inject).toEqual(["read_file", "bash"]);
    expect(plan.askNatives).toEqual(["Glob"]);
    // Everything ungranted is still shut off.
    expect(plan.denyNatives).toContain("Write");
    expect(plan.denyNatives).toContain("Edit");
  });

  it("covers every tool in the vocabulary exactly once", () => {
    // Nothing may fall between the three states — that gap IS the bug this exists to close.
    const plan = planAgentTools(["read_file"], { read_file: "app" });
    const accounted = plan.inject.length + plan.askNatives.length + plan.denyNatives.length;
    expect(accounted).toBe(TOOL_SPECS.length);
  });
});

describe("claudeReplacements", () => {
  it("maps each tool onto the built-in it stands in for", () => {
    // Injection without displacement is a second set of tools the model ignores — observed on a live
    // run, where the agent reached for `Read` every time with `mcp__dai__read_file` sitting beside it.
    expect(claudeReplacements()).toMatchObject({ read_file: "Read", glob: "Glob", bash: "Bash" });
  });

  it("is derived, so a tool added to the table displaces without a second list", () => {
    const named = Object.keys(claudeReplacements());
    for (const spec of TOOL_SPECS) {
      if (spec.natives?.claude !== undefined) expect(named).toContain(spec.name);
    }
  });
});

describe("claudePermissionSettings", () => {
  it("emits only the lists that have something in them", () => {
    expect(claudePermissionSettings({})).toEqual({});
    expect(claudePermissionSettings({ ask: [], deny: [] })).toEqual({});
  });

  it("carries both postures under the key the transports already read", () => {
    // `providerOptions.claudeCode.settings` reaches `--settings` on the CLI and the SDK's own bag —
    // an escape hatch both already have, so this needs nothing upstream.
    expect(claudePermissionSettings({ ask: ["Read"], deny: ["Write"] })).toEqual({
      claudeCode: { settings: { permissions: { ask: ["Read"], deny: ["Write"] } } },
    });
  });
});

/**
 * The profiles the gate actually consults.
 *
 * Registered under the BUILT-IN names, which shadows upstream's predicates — and that is the point.
 * A predicate answers for the tools we registered and reports `unknown` for an agent's own built-in,
 * and `unknown` escalates: either a human is interrupted once per read, or the call never reaches us
 * and goes by ungoverned. A table has an opinion about every name.
 */
describe("profileRules", () => {
  it("shadows the built-in names, which is how the gate stops escalating", () => {
    const rules = profileRules();
    expect(Object.keys(rules).sort()).toEqual(["full", "plan", "read-only"]);
  });

  it("says something about every tool, and something about the ones we do not have", () => {
    for (const [name, table] of Object.entries(profileRules())) {
      for (const spec of TOOL_SPECS) {
        expect(Object.hasOwn(table.tools, spec.name), `'${name}' says nothing about '${spec.name}'`).toBe(true);
      }
      // `other` is the entry that did not exist, and the reason a built-in could go ungoverned.
      expect(table.other, `'${name}' has no answer for an unknown tool`).toBeDefined();
      expect(table.default).toBeDefined();
    }
  });

  it("keeps read-only meaning read-only, and asks about what it cannot classify", () => {
    const readOnly = profileRules()["read-only"]!;
    expect(readOnly.tools["read_file"]).toBe("ask");
    expect(readOnly.tools["write_file"]).toBe("deny");
    expect(readOnly.tools["bash"]).toBe("deny");
    expect(readOnly.other).toBe("ask");
  });
});
