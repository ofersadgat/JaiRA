/**
 * `on_user_event` end to end through the runtime (WORKFLOWS.md §7.4).
 *
 * The engine's half — a deferred call parks a transition and blocks the rules behind it — is tested
 * upstream (`hw/test/deferredCall.test.ts`). What is tested HERE is the wiring JaiRA supplies: the
 * shipped document that makes the bare name callable, the registration that makes it wait, the
 * `to_state` the loader filled in from the rule, and the two ways a wait ends — the gesture, and
 * nobody being there to make it.
 */
import { describe, expect, it, vi } from "vitest";
import { loadBundle } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/exec";
import { ON_USER_EVENT, TASK_DRAG } from "@jaira/shared";
import { buildPromptExecutor, executeWorkflow, newRegistry, statusOfResult } from "../src/wiring";
import { hostCalleeSignatures, UserEventHub, type UserEventRequest } from "../src/userEvents";

/**
 * The registry as a CONTRIBUTOR on the search path — the very map `workflowLoadOptions` passes on the
 * real load path, and what makes `on_user_event(...)` resolve with nobody authoring a file.
 *
 * Derived rather than hand-built ON PURPOSE: a test that restated the signature would keep passing
 * after the entry's slots changed, which is the exact failure this whole seam exists to prevent.
 */
const HOST_FUNCTIONS = hostCalleeSignatures();

/**
 * A board level whose first rule waits for a drag, with a rule behind it that would fire at once.
 *
 * `.run.cursor !== 'deploy'` is what an author writes and not test scaffolding: the state's own list
 * is evaluated after EVERY round, so an offer with no such condition is re-made the moment the
 * child it moved the task into finishes — a card offering a drag into the column it is already in.
 * The cursor is where the run last went, so this reads as "while it is not there yet".
 */
const files = {
  "review.json": {
    inputs: { severity: { kind: "json", schema: { type: "number" } } },
    operation: { kind: "function", function: "start" },
    children: { deploy: { state: "deploy" } },
    transitions: [
      { to: "deploy", when: ".inputs.severity > 2 && .run.cursor !== 'deploy' && on_user_event('task_drag')" },
      { to: "terminate.success" },
    ],
  },
  "deploy.json": { operation: { kind: "function", function: "start" } },
};

function harness() {
  const requests: UserEventRequest[] = [];
  const registry = newRegistry();
  registry.functions.set("start", {
    kind: "host",
    impl: async () => ({ value: {} as never }),
    capabilities: { interactive: false, readOnly: true, memoizable: true },
  } as never);
  const hub = new UserEventHub({ onRequest: (request) => requests.push(request), nextId: () => `event-${requests.length + 1}` });
  hub.register(registry, "task-7");

  const run = (severity: number) =>
    executeWorkflow({
      // The documents a HOST ships, which is what makes `on_user_event(...)` resolve without anybody
      // authoring a file — the same map `workflowLoadOptions` passes on the real load path.
      bundle: loadBundle(files, "review", { functions: HOST_FUNCTIONS }),
      inputs: { severity: severity as unknown as JsonValue },
      registry,
      prompt: buildPromptExecutor({ fakeRules: [] }),
    });
  return { hub, requests, run };
}

/** Let the engine reach its wait — the round has to run before there is anything to answer. */
async function settled(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("a guard that waits on a gesture", () => {
  it("parks with the destination its rule names", async () => {
    const { hub, requests, run } = harness();
    const result = run(5);
    await settled();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.event).toBe(TASK_DRAG);
    expect(requests[0]!.taskId).toBe("task-7");
    // Filled in from the transition's own `to`, which is why the author wrote no options at all.
    expect(requests[0]!.options.to_state).toBe("deploy");

    // Withdrawn rather than left standing: the run would otherwise outlive the test, which is exactly
    // what a wait is for and exactly what a test must not leave behind.
    hub.declineAll();
    await result;
  });

  it("does not run the rule behind it while the wait is outstanding", async () => {
    const { hub, requests, run } = harness();
    let done = false;
    const result = run(5).then((r) => {
      done = true;
      return r;
    });
    await settled();
    expect(done).toBe(false);
    expect(requests).toHaveLength(1);

    // …and once withdrawn, it does: `false` is what lets the rule behind it have its turn.
    hub.declineAll();
    expect(statusOfResult(await result)).toBe("completed");
  });

  /** The precondition, honoured by never asking: severity 1 asks nobody and falls straight through. */
  it("asks nobody when the condition ahead of it is false", async () => {
    const { requests, run } = harness();
    const result = await run(1);
    expect(statusOfResult(result)).toBe("completed");
    expect(requests).toHaveLength(0);
  });

  it("takes the transition when the gesture is delivered", async () => {
    const { hub, requests, run } = harness();
    const result = run(5);
    await settled();

    expect(hub.matching(TASK_DRAG, "task-7")).toHaveLength(1);
    expect(hub.deliver(requests[0]!.requestId)).toBe(true);
    expect(statusOfResult(await result)).toBe("completed");
    // The wait is gone — answered, not still on offer.
    expect(hub.list()).toHaveLength(0);
  });

  /** A drop that lands after the run moved on is a race, not a mistake. */
  it("answers false for an id nobody is holding", () => {
    const { hub } = harness();
    expect(hub.deliver("event-nope")).toBe(false);
  });
});

describe("a wait the run no longer needs is withdrawn", () => {
  /**
   * The board's half of "a taken transition cancels the waits it did not answer". The engine cancels
   * the call; what has to happen HERE is that the hub stops listing it, or a card stays draggable for
   * a decision that has already been made somewhere else.
   */
  it("drops the request when the engine cancels the call", async () => {
    const requests: UserEventRequest[] = [];
    const resolved: string[] = [];
    const hub = new UserEventHub({ onRequest: (r) => requests.push(r), onResolved: (id) => resolved.push(id) });
    const registry = newRegistry();
    registry.functions.set("start", {
      kind: "host",
      impl: async () => ({ value: {} as never }),
      capabilities: { interactive: false, readOnly: true, memoizable: true },
    } as never);
    hub.register(registry, "task-7");

    const result = executeWorkflow({
      bundle: loadBundle(
        {
          // The state times out while the wait is outstanding — any ending would do; this is the one
          // a test can cause without a second actor.
          "review.json": {
            operation: { kind: "function", function: "start" },
            limits: { timeout: 0.05 },
            transitions: [{ to: "terminate.success", when: "on_user_event('task_drag')" }],
          },
        },
        "review",
        { functions: HOST_FUNCTIONS },
      ),
      inputs: {},
      registry,
      prompt: buildPromptExecutor({ fakeRules: [] }),
    });
    await settled();
    expect(hub.list()).toHaveLength(1);

    expect(statusOfResult(await result)).toBe("failed");
    // Gone from the list, and reported as resolved — which is what tells the renderer to stop
    // offering it.
    expect(hub.list()).toHaveLength(0);
    expect(resolved).toEqual([requests[0]!.requestId]);
    // And answering it now is a no-op rather than a resurrection.
    expect(hub.deliver(requests[0]!.requestId)).toBe(false);
  });
});

describe("nobody is watching", () => {
  /**
   * An unattended run — the CLI, a schedule. Parking would hang the workflow on a gesture no one can
   * make, so the honest answer is that the gesture did not happen, and the author's fallback rule
   * gets its turn.
   */
  it("answers false immediately with no listener", async () => {
    const registry = newRegistry();
    registry.functions.set("start", {
      kind: "host",
      impl: async () => ({ value: {} as never }),
      capabilities: { interactive: false, readOnly: true, memoizable: true },
    } as never);
    new UserEventHub().register(registry);

    const result = await executeWorkflow({
      bundle: loadBundle(files, "review", { functions: HOST_FUNCTIONS }),
      inputs: { severity: 5 as unknown as JsonValue },
      registry,
      prompt: buildPromptExecutor({ fakeRules: [] }),
    });
    expect(statusOfResult(result)).toBe("completed");
  });
});

describe("a timeout in the options", () => {
  it("answers false when the time is up, and the next rule has its turn", async () => {
    vi.useFakeTimers();
    try {
      const requests: UserEventRequest[] = [];
      const hub = new UserEventHub({ onRequest: (r) => requests.push(r) });
      const registry = newRegistry();
      registry.functions.set("start", {
        kind: "host",
        impl: async () => ({ value: {} as never }),
        capabilities: { interactive: false, readOnly: true, memoizable: true },
      } as never);
      hub.register(registry, "task-7");

      const result = executeWorkflow({
        bundle: loadBundle(
          {
            "review.json": {
              operation: { kind: "function", function: "start" },
              transitions: [
                { to: "terminate.error", when: "on_user_event('task_drag', { timeout: 30 })" },
                { to: "terminate.success" },
              ],
            },
          },
          "review",
          { functions: HOST_FUNCTIONS },
        ),
        inputs: {},
        registry,
        prompt: buildPromptExecutor({ fakeRules: [] }),
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(requests).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(statusOfResult(await result)).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * WORKFLOWS.md §12.2 — the three-column board, exactly as documented.
 *
 * The doc says these states load and run, so they do: the columns are children, the moves are
 * transitions, and the only thing making the cards draggable is a guard that waits. What this pins
 * is the shape a reader will copy — including `.run.cursor`, which is what stops each offer once it
 * has been taken and is the difference between a board and a run that never ends.
 */
const BOARD = {
  "ticket.json": {
    label: "Ticket",
    inputs: {
      issue: { kind: "text", schema: { type: "string" } },
      severity: { schema: { type: "number" } },
    },
    children: {
      triage: { state: "./triage", inputs: { issue: ".inputs.issue" } },
      in_review: { state: "./in_review", inputs: { issue: ".inputs.issue" } },
      done: { state: "./done", inputs: { issue: ".inputs.issue" } },
    },
    sequence: ["triage"],
    transitions: [
      { to: "in_review", when: ".run.cursor === 'triage' && .inputs.severity > 2 && on_user_event('task_drag')" },
      { to: "done", when: ".run.cursor === 'in_review' && on_user_event('task_drag')" },
      { to: "terminate.success", when: ".run.cursor === 'done'" },
    ],
  },
  // The columns are ordinary states; `work` stands in for the agent each one runs.
  "ticket/triage.json": {
    label: "Triage",
    inputs: { issue: { kind: "text", schema: { type: "string" } } },
    outputs: { summary: { schema: { type: "string" }, binding: { expr: "concat('summary of ', .inputs.issue)" } } },
    operation: { kind: "function", function: "start" },
  },
  "ticket/in_review.json": {
    label: "In review",
    inputs: { issue: { kind: "text", schema: { type: "string" } } },
    operation: { kind: "function", function: "start" },
  },
  "ticket/done.json": {
    label: "Done",
    inputs: { issue: { kind: "text", schema: { type: "string" } } },
    operation: { kind: "function", function: "start" },
  },
};

describe("the documented board (WORKFLOWS.md §12.2)", () => {
  function boardHarness() {
    const requests: UserEventRequest[] = [];
    const registry = newRegistry();
    registry.functions.set("start", {
      kind: "host",
      impl: async () => ({ value: {} as never }),
      capabilities: { interactive: false, readOnly: true, memoizable: true },
    } as never);
    const hub = new UserEventHub({ onRequest: (r) => requests.push(r) });
    hub.register(registry, "ticket-1");
    const run = (severity: number) =>
      executeWorkflow({
        bundle: loadBundle(BOARD, "ticket", { functions: HOST_FUNCTIONS }),
        inputs: { issue: "the export is empty" as unknown as JsonValue, severity: severity as unknown as JsonValue },
        registry,
        prompt: buildPromptExecutor({ fakeRules: [] }),
      });
    return { hub, requests, run };
  }

  it("walks the card across all three columns, one drag at a time", async () => {
    const { hub, requests, run } = boardHarness();
    const result = run(4);

    // Triage runs, then the board offers the first move — and only that one.
    await settled();
    expect(requests.map((r) => r.options.to_state)).toEqual(["in_review"]);

    hub.deliver(requests[0]!.requestId);
    await settled();
    // The card is in `in_review` now, and the offer that moved it is NOT re-made: `.run.cursor` has
    // moved on. What is on offer is the next column.
    expect(requests.map((r) => r.options.to_state)).toEqual(["in_review", "done"]);

    hub.deliver(requests[1]!.requestId);
    expect(statusOfResult(await result)).toBe("completed");
    // Three offers would mean the board was still asking after the card reached the last column.
    expect(requests).toHaveLength(2);
  });

  /** The precondition is the guard's own condition: a small ticket is never offered the move. */
  it("offers nothing below the severity the rule names", async () => {
    const { requests, run } = boardHarness();
    expect(statusOfResult(await run(1))).toBe("completed");
    expect(requests).toHaveLength(0);
  });
});

/**
 * The shape `feature.json` actually uses: the offer is a rule on a CHILD MOUNT, gated on an input,
 * and it moves the task to the next phase.
 *
 * Different from every test above, which puts the rule at STATE level and bounds it with
 * `.run.cursor`. A mount rule needs no such bound — the engine makes a child's own transitions
 * eligible only in the round that child finished — and that difference is the whole reason a board
 * of phases can be written without a cursor guard on every row.
 *
 * It is also the case that silently regressed once: `on_user_event` reached the loader through an
 * option that was removed upstream, and a guard whose call does not resolve is DROPPED rather than
 * reported, so eight offers stopped being made and nothing said so.
 */
const PHASES = {
  "feature.json": {
    inputs: {
      manual_advance: { kind: "json", schema: { type: "boolean" }, default: false },
    },
    children: {
      product: { state: "phase" },
      ux: { state: "phase" },
    },
    transitions: [{ to: "terminate.success", when: ".run.cursor === 'ux'" }],
  },
  "phase.json": { operation: { kind: "function", function: "start" } },
} as const;

/** `children.product.transitions`, which is where a rule about the round `product` finished lives. */
const withOffer = (): Record<string, unknown> => {
  const files = JSON.parse(JSON.stringify(PHASES)) as Record<string, Record<string, never>>;
  const root = files["feature.json"] as unknown as {
    children: { product: { transitions?: unknown[] } };
  };
  root.children.product.transitions = [
    { to: "ux", when: ".inputs.manual_advance && on_user_event('task_drag')" },
  ];
  return files;
};

describe("hand-advancing a task between phases (the feature workflow's shape)", () => {
  function board(manualAdvance: boolean) {
    const requests: UserEventRequest[] = [];
    const registry = newRegistry();
    registry.functions.set("start", {
      kind: "host",
      impl: async () => ({ value: {} as never }),
      capabilities: { interactive: false, readOnly: true, memoizable: true },
    } as never);
    const hub = new UserEventHub({ onRequest: (r) => requests.push(r), nextId: () => `event-${requests.length + 1}` });
    hub.register(registry, "task-9");
    const run = executeWorkflow({
      bundle: loadBundle(withOffer(), "feature", { functions: HOST_FUNCTIONS }),
      inputs: { manual_advance: manualAdvance as unknown as JsonValue },
      registry,
      prompt: buildPromptExecutor({ fakeRules: [] }),
    });
    return { hub, requests, run };
  }

  it("offers the NEXT phase as a drop target once the first one finishes", async () => {
    const { hub, requests, run } = board(true);
    await settled();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.event).toBe(TASK_DRAG);
    // `to_state` is filled in from the rule's own `to`, so the board lights up the `ux` column and
    // the author never wrote the name twice.
    expect(requests[0]!.options.to_state).toBe("ux");

    hub.declineAll();
    await run;
  });

  it("moves the task when the card is dragged, and the run then finishes", async () => {
    const { hub, requests, run } = board(true);
    await settled();
    expect(hub.deliver(requests[0]!.requestId)).toBe(true);
    expect(statusOfResult(await run)).toBe("completed");
    expect(hub.list()).toHaveLength(0);
  });

  it("asks nobody, and advances on its own, when manual_advance is false", async () => {
    // `&&` short-circuits before the call, so no wait is registered and no column lights up. This is
    // what makes the flag free: with it off the spine runs exactly as it did before the rule existed.
    const { requests, run } = board(false);
    expect(statusOfResult(await run)).toBe("completed");
    expect(requests).toHaveLength(0);
  });
});
