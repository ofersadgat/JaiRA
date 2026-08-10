/**
 * The provider hierarchy, and the field plumbing over it.
 *
 * Two things carry the weight here, and both are about a form that cannot lie:
 *
 *  - **A kind's settings are its OWN.** The screen used to offer an Anthropic API key in order to
 *    run `claude`, which signs itself in and would have ignored one — a box that invited someone to
 *    store a secret nothing reads and then believe the provider was configured.
 *  - **A field's text round-trips.** Every control has a format and a parse, and an empty box means
 *    UNSET rather than zero or an empty list, which is what makes "clear it and save" the way a
 *    layer goes back to inheriting.
 */
import { describe, expect, it } from "vitest";
import type { ExecutorInfo } from "@jaira/shared/browser";
import {
  MODEL_PROVIDERS,
  agentProviders,
  allFields,
  fieldText,
  fieldValue,
  providerBlockPath,
  type FieldSpec,
} from "../src/renderer/providerSpecs";
import { providerState } from "../src/renderer/providersPane";

const executor = (over: Partial<ExecutorInfo>): ExecutorInfo => ({
  name: "claude-cli",
  kind: "cli",
  enabled: true,
  credentialUse: "none",
  policyEnforcement: "callback",
  ...over,
});

const pathsOf = (spec: { levels: Array<{ fields: FieldSpec[] }> }): string[] =>
  allFields(spec as never).map((f) => f.path);

describe("the provider hierarchy", () => {
  it("lists the four model providers, each ending in its own level", () => {
    expect(MODEL_PROVIDERS.map((p) => p.id)).toEqual(["anthropic", "openrouter", "local", "embedded"]);
    // The local server is an API provider AND a local server — two levels, because the settings come
    // from two different places in the hierarchy and flattening them loses which is which.
    const local = MODEL_PROVIDERS.find((p) => p.id === "local")!;
    expect(local.levels.map((l) => l.title)).toEqual(["API provider", "Local server"]);
    expect(pathsOf(local)).toEqual(["credential", "baseURL", "supportsStructuredOutputs", "serve"]);
  });

  /**
   * The two Claude runtimes take OPPOSITE settings, and this is the assertion that matters most.
   *
   * They were one shared block, which is how the form came to ask for an API key to run a binary
   * that has its own login. The CLI gets a command and no key; the SDK gets a key and no command.
   */
  it("asks the CLI for a binary and the SDK for a key, and neither for the other's", () => {
    const cli = agentProviders([executor({})])[0]!;
    const sdk = agentProviders([executor({ name: "claude-code", kind: "sdk", credentialUse: "required" })])[0]!;

    expect(pathsOf(cli)).toContain("command");
    expect(pathsOf(cli)).not.toContain("credential");
    expect(cli.credential).toBe("none");

    expect(pathsOf(sdk)).toContain("credential");
    expect(pathsOf(sdk)).not.toContain("command");
    expect(sdk.credential).toBe("required");
  });

  it("puts every agent under the shared agent level, then its own", () => {
    const codex = agentProviders([executor({ name: "codex-cli", kind: "codex", credentialUse: "optional" })])[0]!;

    // provider → agent → CLI agent → codex: each level says what it adds to the one above.
    expect(codex.levels.map((l) => l.title)).toEqual(["Agent provider", "CLI agent", "Codex"]);
    expect(pathsOf(codex)).toEqual(["command", "sandbox", "credential"]);
  });

  it("knows where each provider's block lives, and that a generic CLI has no path", () => {
    expect(providerBlockPath(MODEL_PROVIDERS[0]!)).toEqual(["models", "routes", "anthropic"]);
    const cli = agentProviders([executor({})])[0]!;
    expect(providerBlockPath(cli)).toEqual(["agents", "claudeCli"]);
    // A generic entry is an ARRAY ENTRY found by name, so a path walk would address the wrong thing.
    const generic = agentProviders([executor({ name: "opencode", kind: "generic", credentialUse: "optional" })])[0]!;
    expect(providerBlockPath(generic)).toBeNull();
  });
});

describe("a field's value, as text", () => {
  const field = (over: Partial<FieldSpec>): FieldSpec => ({
    path: "x",
    label: "X",
    hint: "",
    control: "text",
    ...over,
  });

  it("round-trips a launch command as one line", () => {
    const serve = { command: "ollama", args: ["serve"] };
    expect(fieldText("serve", serve)).toBe("ollama serve");
    expect(fieldValue(field({ control: "serve" }), "ollama serve")).toEqual(serve);
  });

  it("round-trips argv as one argument per line, so a space cannot split one", () => {
    const args = ["--message", "review this change", "{prompt}"];
    expect(fieldValue(field({ control: "argv" }), fieldText("argv", args))).toEqual(args);
  });

  it("treats an empty box as UNSET rather than as an empty value", () => {
    // The difference between "this layer says nothing" and "this layer says nothing, verbosely" —
    // and the only way a project can go back to inheriting.
    expect(fieldValue(field({}), "   ")).toBeUndefined();
    expect(fieldValue(field({ control: "argv" }), "\n\n")).toBeUndefined();
    expect(fieldValue(field({ control: "env" }), "")).toBeUndefined();
    expect(fieldValue(field({ control: "json" }), "")).toBeUndefined();
    expect(fieldValue(field({ control: "patterns" }), "")).toBeUndefined();
  });

  it("reads the one boolean select as a boolean, and only when it is false", () => {
    // `true` is the default, so a layer stating it overrides nothing — writing it would be noise.
    const f = field({ path: "supportsStructuredOutputs", control: "select" });
    expect(fieldText("select", false)).toBe("no");
    expect(fieldText("select", true)).toBe("");
    expect(fieldValue(f, "no")).toBe(false);
    expect(fieldValue(f, "")).toBeUndefined();
  });

  it("refuses a pasted key where a secret NAME belongs", () => {
    const f = field({ control: "secret-name" });
    expect(() => fieldValue(f, "sk-ant not a name")).toThrow(/NAMES the key/);
    expect(fieldValue(f, "ANTHROPIC_API_KEY")).toBe("ANTHROPIC_API_KEY");
  });

  it("throws on malformed JSON rather than saving nothing and saying so nowhere", () => {
    expect(() => fieldValue(field({ control: "json", label: "Weights" }), "{ nope")).toThrow(/Weights/);
  });
});

/**
 * The four states a provider can be in.
 *
 * Four, not two, and that is the whole point: a checkbox can say only on or off, so an unavailable
 * provider rendered as a ticked box — which is how the screen came to claim four working providers
 * on a machine configured for none. "Enabled" is an intention; "ready" is an observation.
 */
describe("what a provider's row says", () => {
  const probe = (status: "ok" | "failed" | "disabled" | "not-checked") => ({ name: "x", status, detail: "" });

  it("distinguishes turned off, never checked, not set up, broken and ready", () => {
    expect(providerState(false, probe("ok"))).toBe("off");
    expect(providerState(true, undefined)).toBe("unchecked");
    expect(providerState(true, probe("not-checked"))).toBe("unconfigured");
    expect(providerState(true, probe("failed"))).toBe("unavailable");
    expect(providerState(true, probe("ok"))).toBe("available");
  });

  it("never reports an unavailable provider as ready just because it is enabled", () => {
    // The exact failure the pill replaced the checkbox for.
    expect(providerState(true, probe("failed"))).not.toBe("available");
  });
});
