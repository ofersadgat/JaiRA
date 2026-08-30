/**
 * The premise, checked against the real loader.
 *
 * `chatOperation.ts` reads the settings off ONE `LoadedState` and does not walk the ancestor chain,
 * on the claim that the loader already merged that chain in (§5). Every other test in this area
 * hand-builds a `LoadedState`, which proves the reading and not the claim — if the loader put the
 * merged model somewhere else, or stopped merging into children at all, those tests would go on
 * passing while the composer showed the wrong model for every state in the product.
 *
 * So this one authors a real environment chain, puts it through `loadBundle`, and asserts that what
 * comes out the far end is what the composer will show.
 */
import { describe, expect, it } from "vitest";
import { loadBundle } from "@declarative-ai/hw";
import { chatPlanFor } from "../src/chatOperation";

/**
 * A root that declares defaults for its whole subtree, and two children under it.
 *
 * `draft` overrides the model and adds a tool; `review` declares nothing and should inherit
 * everything. That pair is the test: one proves the merge happens, the other proves it reaches a
 * state that never mentioned the fields.
 */
const files: Record<string, unknown> = {
  chat: {
    label: "Chat",
    inputs: { topic: { schema: { type: "string" } } },
    environment: {
      model: "root/model",
      temperature: 0.4,
      tools: ["bash"],
      permissions: { profile: "read-only" },
      conversation: { mode: "summary" },
      system: "You are careful.",
    },
    children: {
      draft: { state: "chat/draft", inputs: { topic: ".inputs.topic" } },
      review: { state: "chat/review", inputs: { topic: ".inputs.topic" } },
    },
    sequence: ["draft", "review"],
    transitions: [{ to: "terminate.success", when: ".children.review.outcome === 'success'" }],
  },
  "chat/draft": {
    inputs: { topic: { schema: { type: "string" } } },
    outputs: { text: { schema: { type: "string" } } },
    environment: { model: "child/model" },
    operation: { kind: "prompt", prompt: "Draft something about {{.inputs.topic}}", output: { text: { kind: "text" } } },
  },
  "chat/review": {
    inputs: { topic: { schema: { type: "string" } } },
    outputs: { text: { schema: { type: "string" } } },
    operation: { kind: "prompt", prompt: "Review it", output: { text: { kind: "text" } } },
  },
};

const bundle = loadBundle(files, "chat");
const stateOf = (id: string) => bundle.states[id];

describe("the loader really does merge the chain into each state", () => {
  it("gives a child that declared nothing the whole inherited environment", () => {
    // The claim the whole module rests on. `chat/review` mentions no model, no tools and no
    // permissions; if these are absent here, reading one LoadedState is not enough and the design
    // is wrong rather than the test.
    const plan = chatPlanFor([stateOf("chat/review")]);
    expect(plan.settings.model).toBe("root/model");
    expect(plan.settings.tools).toEqual(["bash"]);
    expect(plan.settings.permissions).toMatchObject({ profile: "read-only" });
    expect(plan.origin.model).toBe("inherited");
  });

  it("lets the nearest layer win, already resolved — no merging left to do here", () => {
    const plan = chatPlanFor([stateOf("chat/draft")]);
    expect(plan.settings.model).toBe("child/model");
    // The root's other fields survive the child's override of one of them, which is §5.2's
    // per-field rule and is the loader's job, not this module's.
    expect(plan.settings.tools).toEqual(["bash"]);
    expect(plan.passthrough["temperature"]).toBe(0.4);
  });

  it("carries the inherited system prompt", () => {
    expect(chatPlanFor([stateOf("chat/review")]).system).toBe("You are careful.");
  });

  it("names the state the settings came from", () => {
    expect(chatPlanFor([stateOf("chat/draft")]).from).toBe("chat/draft");
  });

  it("finds nothing to continue on the pure composite, and walks out to one that speaks", () => {
    // The root has children and no operation of its own. On its own it inherits nothing; given a
    // path, it continues under the nearest state that actually holds a conversation.
    expect(chatPlanFor([stateOf("chat")]).from).toBeUndefined();
    expect(chatPlanFor([stateOf("chat"), stateOf("chat/draft")]).from).toBe("chat/draft");
  });
});
