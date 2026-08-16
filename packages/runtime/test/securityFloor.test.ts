/**
 * The floor a state cannot drop.
 *
 * `withPromptDefaults` merges a node's defaults UNDER the state's config, so a state that names a
 * setting keeps it — right for a default, wrong for a sandbox. This merges the other way, and the
 * case that forces it is not even deliberate: `providerOptions` merges shallowly, so a state setting
 * an unrelated provider's options would take the compiled scope rules with it.
 */
import { describe, expect, it } from "vitest";
import type { ExecServices, InlineFamily, Operation } from "@declarative-ai/exec";
import type { JsonValue } from "@declarative-ai/json";
import { withSecurityFloor } from "../src/executorTree";
import { claudePermissionSettings, compileClaudeScopeRules } from "../src/tools";

/** An executor that records the op it was actually asked to run. */
function recording() {
  const seen: Array<Operation<InlineFamily>> = [];
  const executor = {
    capabilities: { streaming: false } as never,
    metrics: {} as never,
    start: (op: Operation<InlineFamily>, _ctx: ExecServices) => {
      seen.push(op);
      return { result: Promise.resolve({ value: null }) } as never;
    },
  };
  return { executor, seen };
}

const promptOp = (config: Record<string, JsonValue>): Operation<InlineFamily> =>
  ({ kind: "prompt", user: "hi", config, input: {}, output: { name: "text", kind: "text" } }) as unknown as Operation<InlineFamily>;

const configOf = (op: Operation<InlineFamily>) => (op as unknown as { config: Record<string, JsonValue> }).config;

/** The floor as a caller builds it: the rules are the `providerOptions` VALUE, the key is ours. */
const FLOOR = { providerOptions: claudePermissionSettings({ deny: ["Read(/etc/**)"] }) as JsonValue };

describe("a security floor", () => {
  it("reaches a call that authored nothing", () => {
    const { executor, seen } = recording();
    void withSecurityFloor(FLOOR, executor as never).start(promptOp({}), {} as ExecServices);
    expect(configOf(seen[0]!)).toMatchObject(FLOOR);
  });

  it("survives a state that authors an UNRELATED provider's options", () => {
    // The accident this exists for. A shallow merge would replace the whole `providerOptions` key,
    // so a state naming `anthropic` would silently take the sandbox with it.
    const { executor, seen } = recording();
    const op = promptOp({ providerOptions: { anthropic: { cacheControl: true } } as JsonValue });
    void withSecurityFloor(FLOOR, executor as never).start(op, {} as ExecServices);
    const sent = configOf(seen[0]!)["providerOptions"] as Record<string, unknown>;
    expect(sent["anthropic"]).toEqual({ cacheControl: true });
    expect(sent["claudeCode"]).toBeDefined();
  });

  it("cannot be dropped by a state authoring rules of its own — the lists UNION", () => {
    // A state adding `deny: ["Bash"]` and a floor adding `deny: ["Read(/etc/**)"]` both mean their
    // entry, and the strictest posture keeps both. Replacement either way loses one.
    const { executor, seen } = recording();
    const op = promptOp({ providerOptions: claudePermissionSettings({ deny: ["Bash"] }) as JsonValue });
    void withSecurityFloor(FLOOR, executor as never).start(op, {} as ExecServices);
    const permissions = ((configOf(seen[0]!)["providerOptions"] as Record<string, Record<string, Record<string, Record<string, string[]>>>>)
      ["claudeCode"]!["settings"]!["permissions"]!);
    expect(permissions["deny"]).toContain("Bash");
    expect(permissions["deny"]).toContain("Read(/etc/**)");
  });

  it("leaves everything else about the call alone", () => {
    const { executor, seen } = recording();
    void withSecurityFloor(FLOOR, executor as never).start(promptOp({ model: "anthropic/x", temperature: 0.2 }), {} as ExecServices);
    expect(configOf(seen[0]!)).toMatchObject({ model: "anthropic/x", temperature: 0.2 });
  });

  it("does not touch a function op", () => {
    const { executor, seen } = recording();
    const fn = { kind: "function", functionRef: "x" } as unknown as Operation<InlineFamily>;
    void withSecurityFloor(FLOOR, executor as never).start(fn, {} as ExecServices);
    expect(seen[0]).toBe(fn);
  });
});

describe("what the floor is built from", () => {
  it("is the scope table, compiled into the agent's own rules", () => {
    // The run path's half of the rule compiler. Without it a workflow's states bounded nothing but
    // our own callbacks, and the agent's built-ins ran under its default posture.
    const floor = claudePermissionSettings(
      compileClaudeScopeRules([{ path: "/work/**", tools: { read_file: "allow" } }, { path: "/work/infra/**", default: "deny" }] as never),
    );
    const permissions = (floor as unknown as Record<string, Record<string, Record<string, Record<string, string[]>>>>)
      ["claudeCode"]!["settings"]!["permissions"]!;
    expect(permissions["allow"]).toContain("Read(/work/**)");
    expect(permissions["deny"]).toContain("Read(/work/infra/**)");
  });

  it("is empty when no scopes are authored, so nothing is folded in at all", () => {
    expect(claudePermissionSettings(compileClaudeScopeRules([]))).toEqual({});
  });
});
