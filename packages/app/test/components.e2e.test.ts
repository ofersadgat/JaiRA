/**
 * All five built-in components (SPEC §8.1) driven through a real run: each gate
 * parks, is answered through the same channel the UI uses, and its result lands on
 * the state's declared outputs.
 *
 * This is the phase-4 milestone minus the provider — no LLM is involved, so the
 * component contracts are exercised in isolation from model behaviour.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { componentsWorkflowFiles, COMPONENTS_ID, writeWorkflowFiles } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import type { PendingInteraction, PushMessage } from "@jaira/shared";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-components-"));
  const paths = initProject(dir);
  writeWorkflowFiles(paths.workflowsDir, componentsWorkflowFiles());
  pushes = [];
  service = new AppService({ publish: (m) => pushes.push(m) });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, label: string, budgetMs = 5000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Wait for the next parked gate and return it.
 *
 * Also asserts it is the *only* one parked: the demo workflow threads each gate's
 * output into the next, and that dataflow dependency — not the `sequence`, which is
 * a cursor rather than a barrier — is what serializes them (SPEC §10.4). Without
 * the chain all five would park at once, so this assertion is what keeps the
 * one-question-at-a-time behaviour honest.
 */
async function nextGate(component: string): Promise<PendingInteraction> {
  await until(() => service.pendingInteractions().some((p) => p.component === component), `the ${component} gate`);
  const pending = service.pendingInteractions();
  expect(pending.map((p) => p.component)).toEqual([component]);
  return pending[0]!;
}

async function answer(component: string, value: JsonValue): Promise<PendingInteraction> {
  const gate = await nextGate(component);
  service.submitInteraction(gate.requestId, value);
  return gate;
}

describe("the five built-in components", () => {
  it("runs a workflow through every component and collects their results", async () => {
    const taskId = service.createTask({
      title: "Component tour",
      workflow: COMPONENTS_ID,
      inputs: { doc: "# The Plan\n\nship it" },
    }).taskId;
    await service.startTask({ taskId });

    // 1. choose_option — options and the comments box come from the config.
    const choose = await nextGate("choose_option");
    expect(choose.config).toMatchObject({
      component: "choose_option",
      prompt: "Pick a direction for the plan.",
      options: [{ value: "approve" }, { value: "request_changes" }, { value: "block", tone: "danger" }],
      comments: true,
    });
    service.submitInteraction(choose.requestId, { decision: "approve", comments: "looks good" });

    // 2. review_artifact — the artifact it names is among the resolved inputs, so
    // the component can render it.
    const review = await nextGate("review_artifact");
    expect(review.config).toMatchObject({ component: "review_artifact", artifact: "plan_doc" });
    expect(JSON.stringify(review.inputs["plan_doc"])).toContain("# The Plan");
    service.submitInteraction(review.requestId, { decision: "approve" });

    // 3. edit_markdown — seeded from `source`, returns the edited content.
    const edit = await nextGate("edit_markdown");
    expect(edit.config).toMatchObject({ component: "edit_markdown", source: "plan_doc" });
    service.submitInteraction(edit.requestId, { content: "# The Plan (edited)" });

    // 4. fill_form — the JSON-Schema subset reaches the UI as typed fields.
    const form = await nextGate("fill_form");
    expect(form.config).toMatchObject({
      component: "fill_form",
      fields: [
        { name: "title", type: "string" },
        { name: "severity", type: "enum", enum: ["minor", "significant", "critical"] },
        { name: "estimate", type: "number" },
        { name: "blocking", type: "boolean", optional: true },
        { name: "notes", type: "string", multiline: true, optional: true },
      ],
    });
    service.submitInteraction(form.requestId, { title: "Follow-up", severity: "significant", estimate: 2 });

    // 5. confirm_action.
    await answer("confirm_action", { confirmed: true });

    await until(() => pushes.some((m) => m.type === "run:finished"), "the run to finish");
    const detail = service.taskDetail(taskId);
    expect(detail.status).toBe("completed");
    const outputs = detail.runs[0]!.outputs as Record<string, unknown>;
    expect(outputs["decision"]).toBe("approve");
    expect(outputs["review"]).toBe("approve");
    expect(JSON.stringify(outputs["edited"])).toContain("# The Plan (edited)");
    expect(outputs["severity"]).toBe("significant");
    expect(outputs["confirmed"]).toBe(true);
  }, 20_000);

  it("refuses each component's out-of-contract answers at the boundary", async () => {
    const taskId = service.createTask({
      title: "Contract checks",
      workflow: COMPONENTS_ID,
      inputs: { doc: "# doc" },
    }).taskId;
    await service.startTask({ taskId });

    const choose = await nextGate("choose_option");
    expect(() => service.submitInteraction(choose.requestId, { decision: "nope" })).toThrow(/not one of/);
    service.submitInteraction(choose.requestId, { decision: "approve" });

    const review = await nextGate("review_artifact");
    expect(() => service.submitInteraction(review.requestId, { decision: "approve", comments: 1 })).toThrow(
      /comments must be a string/,
    );
    service.submitInteraction(review.requestId, { decision: "reject" });

    const edit = await nextGate("edit_markdown");
    expect(() => service.submitInteraction(edit.requestId, { content: 42 })).toThrow(/content must be a string/);
    service.submitInteraction(edit.requestId, { content: "ok" });

    const form = await nextGate("fill_form");
    // A required field missing, an enum out of range, and a number as text.
    expect(() => service.submitInteraction(form.requestId, { severity: "significant", estimate: 1 })).toThrow(
      /title is required/,
    );
    expect(() =>
      service.submitInteraction(form.requestId, { title: "t", severity: "extreme", estimate: 1 }),
    ).toThrow(/severity must be one of/);
    expect(() =>
      service.submitInteraction(form.requestId, { title: "t", severity: "minor", estimate: "two" }),
    ).toThrow(/estimate must be a number/);
    // Optional fields may be omitted entirely.
    service.submitInteraction(form.requestId, { title: "t", severity: "minor", estimate: 1 });

    const confirm = await nextGate("confirm_action");
    expect(() => service.submitInteraction(confirm.requestId, { confirmed: "yes" })).toThrow(
      /confirmed must be a boolean/,
    );
    service.submitInteraction(confirm.requestId, { confirmed: false });

    await until(() => pushes.some((m) => m.type === "run:finished"), "the run to finish");
    expect(service.taskDetail(taskId).status).toBe("completed");
  }, 20_000);
});
