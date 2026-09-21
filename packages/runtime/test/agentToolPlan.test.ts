/**
 * The two axes of the tools menu, resolved into what an agent is actually handed.
 *
 * The old control could express two states — declared or not — and the third is where the leak was:
 * a tool nobody granted was merely undeclared, so the agent kept its own built-in and used it. A
 * `read-only` state watched twenty ungoverned reads go by on exactly that.
 */
import { describe, expect, it } from "vitest";
import {
  ALWAYS_GRANTED_TOOLS,
  parseToolset,
  replacementsOf,
  TOOL_SPEC_BY_NAME,
  TOOL_SPECS,
  toolsetOfLegacy,
  unmappedNatives,
  withAlwaysGranted,
} from "@jaira/shared";
import { AGENT_TOOLS, agentToolsOf, nativeNamesByRoute } from "../src/agents";
import { CLAUDE_TOOLS, CODEX_TOOLS, CODEX_WRITE_SWITCH, GENERIC_CLI_TOOLS, planAgentTools, refusalsOf, viewOfToolset } from "../src/agentTools";
import { claudePermissionSettings, claudeReplacements } from "../src/tools";

/** A toolset MAP holding these tools — the form whose absences REMOVE (decision 0007 §3). */
const mapOf = (tools: readonly string[], implementations: Record<string, "app" | "native"> = {}) =>
  parseToolset(Object.fromEntries(tools.map((name) => [name, { mode: "ask", ...(implementations[name] !== undefined ? { implementation: implementations[name] } : {}) }]))).toolset;

describe("planAgentTools", () => {
  it("denies the built-in of a tool a MAP does not hold", () => {
    // The leak. Undeclared used to mean "the agent keeps its own", which is the opposite of what
    // leaving a tool out of a toolset looks like it means.
    const plan = planAgentTools(mapOf([]));
    expect(plan.denyNatives).toContain("Read");
    expect(plan.denyNatives).toContain("Bash");
    // The always-granted set, and nothing else — see the `alwaysGranted` block below.
    expect(plan.inject).toEqual([...ALWAYS_GRANTED_TOOLS]);
    expect(plan.askNatives).toEqual([]);
  });

  it("removes NOTHING a legacy list merely did not mention — a list was a grant, and still is", () => {
    // The workflows people run today are lists, and lean on the agent's own `Glob`, `Grep` and web
    // tools. Which reading a state means is chosen when it is migrated (0007 step 7), not inferred.
    for (const plan of [planAgentTools([]), planAgentTools(["read_file"]), planAgentTools(toolsetOfLegacy(["read_file"], { tools: { read_file: "allow" } }))]) {
      expect(plan.denyNatives).toEqual([]);
      expect(plan.askNatives).toEqual([]);
    }
    // What it removes is what the old code removed: the built-in our injected tool stands in for…
    expect(planAgentTools(["read_file"]).displaced).toEqual(["Read"]);
    // …and what an old `profile: "read-only"` denied — upstream's own list, name for name.
    const readOnly = planAgentTools(toolsetOfLegacy(["read_file"], { profile: "read-only", tools: { read_file: "allow" } }));
    expect([...readOnly.denyNatives].sort()).toEqual(["Agent", "Bash", "Edit", "MultiEdit", "NotebookEdit", "SlashCommand", "Task", "Write"]);
    expect(readOnly.denyNatives).not.toContain("Glob");
    expect(readOnly.denyNatives).not.toContain("WebFetch");
  });

  it("declares ours for `app`, so the built-in is displaced", () => {
    const plan = planAgentTools(["read_file"], { read_file: "app" });
    expect(plan.inject).toEqual(["read_file", ...ALWAYS_GRANTED_TOOLS]);
    // Not asked about — an injected tool is gated by `withPermission` where it executes.
    expect(plan.askNatives).not.toContain("Read");
    // Not REMOVED for want of a grant — DISPLACED, because ours stands in for it. Either way the
    // agent does not get its own `Read`, which is what makes "ours" mean anything.
    expect(plan.denyNatives).not.toContain("Read");
    expect(plan.displaced).toEqual(["Read"]);
  });

  it("leaves the built-in for `native` but forces it to our gate", () => {
    // "Native" names the implementation, never the access. Without the ask-rule Claude Code's own
    // policy auto-allows its read-only built-ins and our callback never fires.
    const plan = planAgentTools(["read_file"], { read_file: "native" });
    expect(plan.inject).toEqual([...ALWAYS_GRANTED_TOOLS]);
    expect(plan.askNatives).toEqual(["Read"]);
    expect(plan.denyNatives).not.toContain("Read");
  });

  it("defaults a granted tool to `app`", () => {
    // DECLARING a tool has always meant injecting ours, and every authored state relies on it.
    // `native` is the opt-out and it is the one that needs saying.
    expect(planAgentTools(["glob"]).inject).toEqual(["glob", ...ALWAYS_GRANTED_TOOLS]);
    expect(planAgentTools(["glob"]).askNatives).toEqual([]);
  });

  it("keeps the two axes independent", () => {
    const plan = planAgentTools(mapOf(["read_file", "glob", "bash"], { read_file: "app", glob: "native" }));
    // TABLE order, not the order they were granted in — the plan walks `TOOL_SPECS`, which is why
    // `show_artifact` lands between the two rather than after them.
    expect(plan.inject).toEqual(["read_file", "show_artifact", "bash"]);
    expect(plan.askNatives).toEqual(["Glob"]);
    // Everything ungranted is still shut off.
    expect(plan.denyNatives).toContain("Write");
    expect(plan.denyNatives).toContain("Edit");
  });

  it("leaves no tool with a built-in unaccounted for", () => {
    // Nothing may fall between the three states — that gap IS the bug this exists to close. The
    // measure is tools that HAVE a native counterpart, because that is where falling through costs
    // something: an ungranted tool whose built-in stays live is a capability nobody granted. A tool
    // with no counterpart (`show_artifact`) leaves no built-in behind to deny.
    const plan = planAgentTools(mapOf(["read_file", "glob"], { read_file: "app", glob: "native" }));
    // EVERY native the executor declares as a standard tool lands in exactly one place: displaced by
    // ours, kept and asked about, or removed.
    const placed = [...plan.displaced, ...plan.askNatives, ...plan.denyNatives].sort();
    const declared = Object.entries(CLAUDE_TOOLS.natives).filter(([, standard]) => standard !== null).map(([native]) => native).sort();
    expect(placed).toEqual(declared);
    expect(new Set(placed).size).toBe(placed.length);
    // And the nativeless one is genuinely absent rather than silently denied under some other name.
    expect(plan.denyNatives).not.toContain("show_artifact");
  });
});

/**
 * The tool a declared list does not get to leave out.
 *
 * A conversation asked for a mockup could not produce one: `chat/agent` declares `bash`, `read_file`
 * and `write_file`, so `show_artifact` was never handed over, `write_file` was refused by the
 * `.jaira/**` rule, and 29,000 characters of HTML went into the answer instead. The rule that fixes
 * it is narrow on purpose — a tool qualifies only by adding no reach, which today is exactly one.
 */
describe("alwaysGranted", () => {
  it("is the tools that add no reach — today, `show_artifact` alone", () => {
    // Guarded rather than assumed: the whole argument for skipping the list is CONFINEMENT, so a
    // tool that can write wherever it likes must never be added to this set.
    expect([...ALWAYS_GRANTED_TOOLS]).toEqual(["show_artifact"]);
    // No agent declares a native for it either: there is nothing to displace and nothing to remove.
    for (const name of ALWAYS_GRANTED_TOOLS) expect(Object.values(CLAUDE_TOOLS.natives)).not.toContain(name);
    expect(TOOL_SPEC_BY_NAME.get("show_artifact")?.alwaysGranted).toBe(true);
  });

  it("is injected by a list that never mentions it", () => {
    expect(planAgentTools(["bash", "read_file", "write_file"]).inject).toContain("show_artifact");
  });

  it("is injected by no list at all — the conversation with no tools is the one that draws", () => {
    expect(planAgentTools([]).inject).toContain("show_artifact");
  });

  it("is not doubled when the list does mention it", () => {
    // `withAlwaysGranted` is the fold, and a list that already names the tool must come back the
    // same length — a duplicate declaration is a second tool as far as an agent's schema is concerned.
    expect(planAgentTools(["show_artifact"]).inject).toEqual(["show_artifact"]);
    expect(withAlwaysGranted(["show_artifact", "bash"])).toEqual(["show_artifact", "bash"]);
  });
});

describe("claudeReplacements", () => {
  it("maps each tool onto the built-in it stands in for", () => {
    // Injection without displacement is a second set of tools the model ignores — observed on a live
    // run, where the agent reached for `Read` every time with `mcp__dai__read_file` sitting beside it.
    expect(claudeReplacements()).toMatchObject({ read_file: ["Read"], glob: ["Glob"], bash: ["Bash"] });
    // EVERY native doing the job, or denying `Edit` leaves `MultiEdit` to do the same thing.
    expect(claudeReplacements()["edit"]).toEqual(["Edit", "MultiEdit", "NotebookEdit"]);
  });

  it("is read off the executor's declaration, so a native added there displaces without a second list", () => {
    expect(claudeReplacements()).toEqual(replacementsOf(CLAUDE_TOOLS));
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
 * What each agent executor DECLARES (decision 0007 §3).
 *
 * The `natives: { claude: … }` column left the shared vocabulary: which built-in is which standard
 * tool is a fact about the agent, so its executor states it. The table stays the one standard list.
 */
describe("the executors' declarations", () => {
  it("names only standard tools the vocabulary holds", () => {
    for (const [agent, declaration] of Object.entries({ ...AGENT_TOOLS, generic: GENERIC_CLI_TOOLS })) {
      for (const [native, standard] of Object.entries(declaration.natives)) {
        if (standard !== null) expect(TOOL_SPEC_BY_NAME.has(standard), `${agent}: '${native}' is '${standard}', which is no standard tool`).toBe(true);
      }
      for (const subjects of Object.values(declaration.switches ?? {})) {
        for (const subject of subjects) expect(TOOL_SPEC_BY_NAME.has(subject), `${agent}: switch subject '${subject}'`).toBe(true);
      }
    }
  });

  it("is claude's for both claude transports, codex's own, and nothing for a CLI nobody described", () => {
    expect(agentToolsOf("claude-code")).toBe(CLAUDE_TOOLS);
    expect(agentToolsOf("claude-cli")).toBe(CLAUDE_TOOLS);
    expect(agentToolsOf("codex-cli")).toBe(CODEX_TOOLS);
    expect(agentToolsOf("aider")).toBe(GENERIC_CLI_TOOLS);
    expect(CLAUDE_TOOLS.natives).toMatchObject({ Read: "read_file", Bash: "bash", Edit: "edit", Write: "write_file", Glob: "glob", Grep: "grep", WebFetch: "web_fetch", WebSearch: "web_search" });
    expect(CODEX_TOOLS.switches).toEqual({ "workspace-write": ["write_file", "edit", "bash"] });
    expect(GENERIC_CLI_TOOLS).toEqual({ channel: "none", natives: {} });
  });

  it("tells the composer what a route calls its own tool — only where the implementation is a choice", () => {
    expect(nativeNamesByRoute("read_file")).toEqual({ "claude-code": "Read", "claude-cli": "Read" });
    // Codex cannot be served ours at all, so there is no pick to offer on its line.
    expect(nativeNamesByRoute("bash")).toEqual({ "claude-code": "Bash", "claude-cli": "Bash" });
    expect(nativeNamesByRoute("show_artifact")).toEqual({});
  });
});

describe("a native with no standard tool answers to `other`", () => {
  const toolset = (map: Record<string, unknown>) => parseToolset(map).toolset;

  it("is NOT removed up front for want of an entry", () => {
    // `Task`, `Agent`, `SlashCommand`: nothing in the vocabulary does that job, and absence from the
    // toolset is what removes a STANDARD tool's native — never one of these.
    const plan = planAgentTools(toolset({ read_file: "allow" }));
    for (const native of unmappedNatives(CLAUDE_TOOLS)) {
      expect(plan.denyNatives).not.toContain(native);
      expect(plan.askNatives).not.toContain(native);
    }
  });

  it("is refused as configuration when `other` is `deny` — a deny needs no person", () => {
    const plan = planAgentTools(toolset({ read_file: "allow", other: "deny" }));
    expect(plan.denyNatives).toEqual(expect.arrayContaining(["Task", "Agent", "SlashCommand"]));
  });

  it("is forced to the callback when `other` was WRITTEN as `ask`, so `other` decides the call", () => {
    const plan = planAgentTools(toolset({ read_file: "allow", other: "ask" }));
    expect(plan.askNatives).toEqual(expect.arrayContaining(["Task", "Agent", "SlashCommand"]));
    expect(plan.denyNatives).not.toContain("Task");
    // An `allow` needs neither: the agent's own flow runs it, and the callback says yes if asked.
    expect(planAgentTools(toolset({ other: "allow" })).askNatives).toEqual([]);
  });
});

describe("the implementation choice, per tool", () => {
  const toolset = (map: Record<string, unknown>) => parseToolset(map).toolset;

  it("injects ours by default and keeps the built-in where the entry says `native`", () => {
    const plan = planAgentTools(toolset({ read_file: "allow", grep: { mode: "ask", implementation: "native" }, other: "deny" }));
    expect(plan.inject).toEqual(["read_file", "show_artifact"]);
    expect(plan.displaced).toEqual(["Read"]);
    // Kept, and forced through the permission callback so the entry's `ask` still decides.
    expect(plan.askNatives).toEqual(["Grep"]);
    expect(plan.denyNatives).not.toContain("Grep");
  });

  it("delivers a `deny` beside `native` as a removal, not as a question", () => {
    const plan = planAgentTools(toolset({ bash: { mode: "deny", implementation: "native" } }));
    expect(plan.askNatives).not.toContain("Bash");
    expect(plan.denyNatives).toContain("Bash");
  });

  it("never grants outside the toolset: whatever is not held is not injected, kept or asked about", () => {
    const held = ["read_file", "glob"];
    const plan = planAgentTools(toolset({ read_file: "allow", glob: { mode: "allow", implementation: "native" } }));
    expect(plan.inject.filter((name) => !ALWAYS_GRANTED_TOOLS.includes(name))).toEqual(["read_file"]);
    for (const native of plan.askNatives) expect(held).toContain(CLAUDE_TOOLS.natives[native]);
    for (const spec of TOOL_SPECS) {
      if (held.includes(spec.name) || spec.alwaysGranted === true) continue;
      for (const [native, standard] of Object.entries(CLAUDE_TOOLS.natives)) {
        if (standard === spec.name) expect(plan.denyNatives, `${native} is ${spec.name}, which the toolset does not hold`).toContain(native);
      }
    }
  });
});

describe("a coarse transport's switch is derived from the toolset", () => {
  const toolset = (map: Record<string, unknown>) => parseToolset(map).toolset;
  const on = (grant: Parameters<typeof planAgentTools>[0]) => planAgentTools(grant, {}, CODEX_TOOLS).switches[CODEX_WRITE_SWITCH];

  it("leaves codex's writing sandbox OFF unless the toolset holds a subject it unlocks", () => {
    expect(on(toolset({ read_file: "allow", glob: "allow", other: "deny" }))).toBe(false);
    expect(on(toolset({ read_file: "allow", edit: "ask" }))).toBe(true);
    expect(on(toolset({ bash: "smart" }))).toBe(true);
    // Held and refused is not held.
    expect(on(toolset({ read_file: "allow", bash: "deny", write_file: "deny" }))).toBe(false);
  });

  it("is off for the map an old `profile: \"read-only\"` reads as, whatever the list granted", () => {
    expect(on(toolsetOfLegacy(["read_file", "bash", "write_file"], { profile: "read-only" }))).toBe(false);
    expect(on(toolsetOfLegacy(["read_file", "bash"]))).toBe(true);
  });
});

describe("what a transport that enforces nothing cannot run", () => {
  it("is a toolset that REFUSES something — named, so the refusal can say what", () => {
    expect(refusalsOf(viewOfToolset(toolsetOfLegacy(["read_file"], { profile: "read-only" })))).toEqual(["edit", "write_file", "bash", "other"]);
    expect(refusalsOf(viewOfToolset(toolsetOfLegacy(["read_file", "bash"])))).toEqual([]);
  });
});
