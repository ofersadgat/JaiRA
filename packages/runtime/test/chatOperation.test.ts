/**
 * What a hand-typed continuation runs as.
 *
 * The thing these tests are really pinning is that the settings come from the SNAPSHOT and not from
 * a second implementation of §5's merge rules. The loader already merged the environment chain into
 * `LoadedState`, so a chain walk here would be both redundant and a source of drift — see the module
 * header. Every case below is therefore written as "one loaded state, already merged", because that
 * is the only shape the snapshot ever holds.
 */
import { describe, expect, it } from "vitest";
import type { LoadedState } from "@declarative-ai/hw";
import { ALWAYS_GRANTED_TOOLS } from "@jaira/shared";
import { chatOperationOf, chatPlanFor, type ChatSettings } from "../src/chatOperation";

/** A loaded state with a prompt operation — the post-merge shape a snapshot pins. */
const speaking = (patch: {
  id?: string;
  config?: Record<string, unknown>;
  system?: string;
  environment?: LoadedState["environment"];
}): LoadedState =>
  ({
    id: patch.id ?? "plan/draft",
    operation: {
      kind: "prompt",
      user: "draft the plan",
      ...(patch.system !== undefined ? { system: patch.system } : {}),
      config: patch.config ?? {},
      input: {},
      output: { text: { kind: "text" } },
    },
    ...(patch.environment !== undefined ? { environment: patch.environment } : {}),
  }) as unknown as LoadedState;

/** A pure composite: children, no operation, nothing to continue. */
const composite = (id: string): LoadedState => ({ id }) as unknown as LoadedState;

describe("where the settings come from", () => {
  it("reads the host's own merged call config, not its ancestors'", () => {
    // The ancestor is deliberately louder than the host. If anything here walked the chain and
    // merged, the ancestor's model would win at some layer; the snapshot's answer is that the host
    // already HAS the merged value, and the ancestor is not consulted at all.
    const plan = chatPlanFor([
      speaking({ config: { model: "anthropic/claude-sonnet-5" } }),
      speaking({ id: "plan", config: { model: "openai/gpt-5", temperature: 0.9 } }),
    ]);
    expect(plan.settings.model).toBe("anthropic/claude-sonnet-5");
    expect(plan.passthrough["temperature"]).toBeUndefined();
    expect(plan.from).toBe("plan/draft");
  });

  it("carries the system prompt, so the continuation talks to the same agent", () => {
    const plan = chatPlanFor([speaking({ system: "You are a planner." })]);
    expect(plan.system).toBe("You are a planner.");
  });

  it("takes tools and permissions off the merged execution environment", () => {
    const plan = chatPlanFor([speaking({ environment: { tools: ["bash"], permissions: { profile: "read-only" } } })]);
    expect(plan.settings.tools).toEqual(["bash"]);
    expect(plan.settings.permissions).toEqual({ profile: "read-only" });
  });

  it("passes through every knob hw does not own, so a later one still reaches the model", () => {
    const plan = chatPlanFor([speaking({ config: { model: "m", temperature: 0.2, providerOptions: { anthropic: {} } } })]);
    expect(plan.passthrough).toEqual({ temperature: 0.2, providerOptions: { anthropic: {} } });
  });
});

describe("a composite has no conversation of its own", () => {
  it("continues under the nearest ancestor that speaks", () => {
    const plan = chatPlanFor([composite("feature"), composite("feature/plan"), speaking({ id: "root", config: { model: "m" } })]);
    expect(plan.settings.model).toBe("m");
    expect(plan.from).toBe("root");
  });

  it("says nothing was inherited when the whole path is composites", () => {
    // `unset` rather than an absent key: "nothing was inherited" is what tells the composer to show
    // the project default, and an absent key would be indistinguishable from not having asked.
    const plan = chatPlanFor([composite("a"), composite("b")]);
    expect(plan.settings.model).toBeUndefined();
    expect(plan.origin.model).toBe("unset");
    expect(plan.from).toBeUndefined();
  });
});

describe("what the composer changed, and what it inherited", () => {
  const host = speaking({ config: { model: "inherited-model" }, environment: { tools: ["bash"] } });

  it("lets an override win per field, and says which is which", () => {
    const plan = chatPlanFor([host], { model: "picked-model" });
    expect(plan.settings.model).toBe("picked-model");
    expect(plan.origin.model).toBe("override");
    // Untouched fields stay inherited rather than being cleared by the presence of a neighbour.
    expect(plan.settings.tools).toEqual(["bash"]);
    expect(plan.origin.tools).toBe("inherited");
  });

  it("treats an empty tool list as a real answer, not as absence", () => {
    // §5.2: `tools` merges by REPLACEMENT and `[]` is how an inherited tool is dropped. Reading it
    // as "nothing was said" would silently hand `bash` back to a call the person just disarmed.
    const plan = chatPlanFor([host], { tools: [] });
    expect(plan.settings.tools).toEqual([]);
    expect(plan.origin.tools).toBe("override");
  });
});

describe("a setting the host declared as an expression", () => {
  it("is reported rather than silently defaulted", () => {
    const plan = chatPlanFor([speaking({ config: { model: { expr: ".inputs.model" } } })]);
    expect(plan.settings.model).toBeUndefined();
    expect(plan.origin.model).toBe("unset");
    expect(plan.unresolved).toEqual([{ field: "model", expr: ".inputs.model" }]);
  });

  it("is still overridable — picking a model answers the question the expression could not", () => {
    const plan = chatPlanFor([speaking({ config: { model: { expr: ".inputs.model" } } })], { model: "picked" });
    expect(plan.settings.model).toBe("picked");
    expect(plan.origin.model).toBe("override");
    expect(plan.unresolved).toHaveLength(1);
  });
});

describe("the operation one message runs as", () => {
  const plan = chatPlanFor([speaking({ system: "sys", config: { model: "m", temperature: 0.3 }, environment: { tools: ["bash"] } })]);

  it("binds the session to an exact position and asks for no fork", () => {
    // The whole of continue-or-fork: §3 appends when the position is still the head and forks when
    // it is not. Setting `fork` would force a branch even where an append was available.
    const { environment } = chatOperationOf(plan, { message: "why did that fail?", session: { id: "s@14" } });
    expect(environment.session).toEqual({ id: "s@14" });
    expect(environment.fork).toBeUndefined();
  });

  it("uses the message verbatim as the prompt", () => {
    // Never a template. `{{.inputs.x}}` in something a person typed is text they wrote, not an
    // interpolation they requested.
    const { operation } = chatOperationOf(plan, { message: "check {{.inputs.path}} please", session: { id: "s@1" } });
    expect(operation.user).toBe("check {{.inputs.path}} please");
    expect(operation.system).toBe("sys");
  });

  it("rebuilds the call config from the plan, settings over passthrough", () => {
    const settings: ChatSettings = { model: "override-model" };
    const withOverride = chatPlanFor([speaking({ config: { model: "m", temperature: 0.3 } })], settings);
    const { operation } = chatOperationOf(withOverride, { message: "hi", session: { id: "s@1" } });
    expect(operation.config).toEqual({ temperature: 0.3, model: "override-model" });
  });

});

describe("tools on a continued turn", () => {
  it("are carried into the call, for the CALLER to gate", () => {
    // They reach the operation as names. Resolving a name to something callable — and wrapping it in
    // the permission guard — is gateTools, which reuses the same withPermission the engine does,
    // so there is still one implementation of "resolve a mode, consult smart, escalate to the human".
    const inherited = chatPlanFor([speaking({ environment: { tools: ["bash"] } })]);
    // Table order rather than grant order — `planAgentTools` walks `TOOL_SPECS`.
    expect(chatOperationOf(inherited, { message: "run the tests", session: { id: "s@1" } }).environment.tools).toEqual([
      "show_artifact",
      "bash",
    ]);
  });

  it("take the person's whole list over the state's, rather than adding to it", () => {
    const asked = chatPlanFor([speaking({ environment: { tools: ["bash"] } })], { tools: [] });
    // An empty list is how an inherited tool is DROPPED — reading it as "nothing was said" would hand bash
    // back to a call the person just disarmed. `bash` is gone; what remains is the always-granted set,
    // which is not a grant the person made and so is not one they can take back here.
    expect(chatOperationOf(asked, { message: "just answer", session: { id: "s@1" } }).environment.tools).toEqual([
      ...ALWAYS_GRANTED_TOOLS,
    ]);
  });

  it("reach a conversation that declared none at all", () => {
    // `chat/assistant.json` has no `tools` key, which is what made the tool list's omission bite
    // hardest: the plainest conversation is the one most likely to be asked for a picture.
    const bare = chatPlanFor([speaking({ environment: {} })]);
    expect(bare.settings.tools).toBeUndefined();
    expect(chatOperationOf(bare, { message: "draw me something", session: { id: "s@1" } }).environment.tools).toEqual([
      ...ALWAYS_GRANTED_TOOLS,
    ]);
  });

  it("still report what the state had, so the composer can start from it", () => {
    const plan = chatPlanFor([speaking({ environment: { tools: ["bash"] } })]);
    expect(plan.settings.tools).toEqual(["bash"]);
    expect(plan.origin.tools).toBe("inherited");
  });
});
