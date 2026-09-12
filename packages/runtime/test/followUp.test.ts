/**
 * The follow-up loop's pieces: the prompt a round asks with, how a reply becomes the next round, how
 * the rounds merge — and the hub's hold / release / repark, which is what keeps one engine promise
 * open across several requests.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@declarative-ai/json";
import { parseComponentConfig, type ChooseOptionConfig } from "@jaira/shared";
import {
  askedSoFar,
  FOLLOW_UP_ROUND,
  followUpOperation,
  followUpQuestionsOf,
  mergedAnswers,
  nextRoundInputs,
  PRIOR_ANSWERS,
  PRIOR_QUESTIONS,
  roundOf,
  wantsFollowUp,
} from "../src/followUp";
import { InteractionHub, type HubRequest } from "../src/interaction";
import { newRegistry } from "../src/wiring";

const inputs: Record<string, JsonValue> = {
  prompt: "The draft could not settle these.",
  follow_up: true,
  questions: [
    { name: "sort", question: "Where does a stopped conversation sort?", options: ["above", "below"], default: "below", custom: true, optional: true },
    { name: "rows", question: "Do rows carry counts?", options: ["counts", "name only"] },
  ],
  issue: "# The issue\n\nUpdate the side panel.",
};
const config = parseComponentConfig("choose_option", inputs) as ChooseOptionConfig;

describe("a follow-up round", () => {
  it("is asked for by the flag, and only where the state offered it", () => {
    expect(wantsFollowUp(config, { answers: { rows: "counts" }, follow_up: true })).toBe(true);
    expect(wantsFollowUp(config, { answers: { rows: "counts" }, follow_up: false })).toBe(false);
    expect(wantsFollowUp(config, { answers: { rows: "counts" } })).toBe(false);
    const plain = parseComponentConfig("choose_option", { ...inputs, follow_up: undefined }) as ChooseOptionConfig;
    expect(wantsFollowUp(plain, { answers: { rows: "counts" }, follow_up: true })).toBe(false);
  });

  it("asks the model with the prompt, every question and its answer, and the state's other inputs as context", () => {
    const op = followUpOperation(config, inputs, { rows: "counts" });
    expect(op.kind).toBe("prompt");
    expect(op.user).toContain("The draft could not settle these.");
    expect(op.user).toContain('"name": "sort"');
    // A passed question shows as unanswered — the default stood.
    expect(op.user).toContain('"answer": null');
    expect(op.user).toContain('"answer": "counts"');
    // The context is the inputs that are not the config and not the loop's own bookkeeping.
    expect(op.user).toContain("Update the side panel.");
    expect(op.user).not.toContain('"follow_up": true');
    expect(op.user).toContain("round 1 of");
    expect(op.output.kind).toBe("json");
  });

  it("reads the reply as another authored round, dropping a name already asked", () => {
    const reply: JsonValue = {
      questions: [
        { name: "sort", question: "again?", options: ["a", "b"] },
        { name: "grouping", question: "Group by workflow?", options: [{ value: "yes" }, { value: "no", description: "flat" }], default: "yes", custom: true, optional: true },
      ],
    };
    const next = followUpQuestionsOf(reply, askedSoFar(config, inputs));
    expect(next.map((q) => q.name)).toEqual(["grouping"]);
    expect(next[0]).toMatchObject({ default: "yes", custom: true, optional: true });
    expect(followUpQuestionsOf({ questions: [] }, [])).toEqual([]);
    expect(followUpQuestionsOf(undefined, [])).toEqual([]);
    expect(followUpQuestionsOf("nonsense", [])).toEqual([]);
  });

  it("refuses a malformed follow-up rather than parking a gate nobody can answer", () => {
    // A default that is not one of its options is the authored-round rule, applied to the model's.
    expect(() =>
      followUpQuestionsOf({ questions: [{ name: "n", question: "?", options: ["a"], default: "z" }] }, []),
    ).toThrow(/default 'z' is not one of/);
  });

  it("carries the questions and answers so far into the next round, and merges them back at the end", () => {
    const answers = mergedAnswers(inputs, { answers: { rows: "counts" }, follow_up: true });
    expect(answers).toEqual({ rows: "counts" });
    const next = followUpQuestionsOf({ questions: [{ name: "grouping", question: "Group by workflow?", options: ["yes", "no"] }] }, askedSoFar(config, inputs));
    const round2 = nextRoundInputs(config, inputs, answers, next);
    expect(round2["questions"]).toEqual(next);
    expect(round2[PRIOR_ANSWERS]).toEqual({ rows: "counts" });
    expect((round2[PRIOR_QUESTIONS] as JsonValue[]).map((q) => (q as { name: string }).name)).toEqual(["sort", "rows"]);
    expect(round2[FOLLOW_UP_ROUND]).toBe(2);
    expect(roundOf(round2)).toBe(2);
    // The context rides along untouched, so the model's next prompt reads it too.
    expect(round2["issue"]).toBe(inputs["issue"]);
    // Round 2's config is the follow-up questions; its answers merge over round 1's.
    const config2 = parseComponentConfig("choose_option", round2) as ChooseOptionConfig;
    expect(config2.questions?.map((q) => q.name)).toEqual(["grouping"]);
    expect(mergedAnswers(round2, { answers: { grouping: "yes" } })).toEqual({ rows: "counts", grouping: "yes" });
    expect(askedSoFar(config2, round2).map((q) => q.name)).toEqual(["sort", "rows", "grouping"]);
  });
});

describe("the hub holds a request and parks it again", () => {
  function hub(): { hub: InteractionHub; requested: HubRequest[]; resolved: string[] } {
    const requested: HubRequest[] = [];
    const resolved: string[] = [];
    const h = new InteractionHub({
      onRequest: (r) => requested.push(r),
      onResolved: (id, fate) => resolved.push(`${id}:${fate}`),
    });
    return { hub: h, requested, resolved };
  }

  async function parked(h: InteractionHub): Promise<{ promise: Promise<unknown>; requestId: string }> {
    const registry = newRegistry();
    h.register(registry, "choose_option", "t-1");
    const entry = registry.functions.get("choose_option")!;
    if (entry.kind !== "host") throw new Error("a gate registers as a host function");
    const promise = entry.impl({ prompt: "?", questions: inputs["questions"]! }, {} as never);
    await Promise.resolve();
    return { promise, requestId: h.list()[0]!.requestId };
  }

  it("takes a held request off the list and closes its row, but keeps the engine waiting", async () => {
    const { hub: h, resolved } = hub();
    const { promise, requestId } = await parked(h);
    let done = false;
    void promise.then(() => (done = true));
    expect(h.hold(requestId)?.requestId).toBe(requestId);
    expect(h.list()).toEqual([]);
    expect(resolved).toEqual([`${requestId}:settled`]);
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(false);
    // Nothing to answer under that id any more: a second submit cannot race the decision.
    expect(h.submit(requestId, { answers: {} })).toBe(false);
    expect(h.hold(requestId)).toBeUndefined();
  });

  it("releases a held request with its final value", async () => {
    const { hub: h } = hub();
    const { promise, requestId } = await parked(h);
    h.hold(requestId);
    expect(h.release(requestId, { answers: { rows: "counts" } })).toBe(true);
    expect(await promise).toEqual({ value: { answers: { rows: "counts" } } });
    expect(h.release(requestId, {})).toBe(false);
  });

  it("re-parks a held request as a NEW request on the same promise", async () => {
    const { hub: h, requested, resolved } = hub();
    const { promise, requestId } = await parked(h);
    h.hold(requestId);
    const next = h.repark(requestId, { prompt: "?", questions: [{ name: "grouping", question: "?", options: ["a", "b"] }] });
    expect(next).toBeDefined();
    expect(next!.requestId).not.toBe(requestId);
    expect(next!.component).toBe("choose_option");
    expect(next!.taskId).toBe("t-1");
    expect(requested.map((r) => r.requestId)).toEqual([requestId, next!.requestId]);
    expect(h.list().map((r) => r.requestId)).toEqual([next!.requestId]);
    // Answering the new request settles the ORIGINAL call: one function invocation, one result.
    expect(h.submit(next!.requestId, { answers: { grouping: "a" } })).toBe(true);
    expect(await promise).toEqual({ value: { answers: { grouping: "a" } } });
    expect(resolved).toEqual([`${requestId}:settled`, `${next!.requestId}:settled`]);
  });

  it("unblocks a held request on shutdown, as it does a parked one", async () => {
    const { hub: h } = hub();
    const { promise, requestId } = await parked(h);
    h.hold(requestId);
    h.rejectAll("closing");
    const result = (await promise) as { error?: { reason: string } };
    expect(result.error?.reason).toBe("closing");
  });
});
