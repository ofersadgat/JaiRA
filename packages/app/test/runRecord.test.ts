/**
 * What a finished run leaves behind, and whether it is enough to say where the run GOT TO.
 *
 * The question this answers is the one a resume asks first: after a run stops, can the values it had
 * produced be read back — not the shape of the tree, which `projection.test.ts` already covers, but
 * the VALUES. What each state was called with, and what its operation returned.
 *
 * It is pinned as a test rather than left to a reading of the schema because the answer is not
 * visible in one place. DESIGN §4.2's irreducible pair splits it deliberately: the journal records
 * THAT operations ran and never what they returned, and `operation_records` records what they
 * returned and never how they were ordered. Reading either half alone says the values are missing.
 * Migration 5 is what closes it — `state_machine_events.operation_id` is a generated column over the
 * hash hw stamps on every settled operation, and it is exactly the `record_id` `withRecord` gives an
 * unplaced call — so the join is a column on both sides rather than a reconstruction.
 *
 * The components workflow is the subject because its root binds every one of its outputs through
 * `.children.<key>.outputs.*`, which is precisely the read a resumed parent would have to make.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject } from "@jaira/persistence";
import { componentsWorkflowFiles, COMPONENTS_ID, writeWorkflowFiles } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import type { PushMessage } from "@jaira/shared";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-runrecord-"));
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

async function until(predicate: () => boolean, label: string, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function answer(component: string, value: JsonValue): Promise<void> {
  await until(() => service.pendingInteractions().some((p) => p.component === component), `the ${component} gate`);
  service.submitInteraction(service.pendingInteractions().find((p) => p.component === component)!.requestId, value);
}

/** Drive the five gates to completion and hand back the task id. */
async function runToCompletion(): Promise<string> {
  const taskId = service.createTask({
    title: "Component tour",
    workflow: COMPONENTS_ID,
    inputs: { doc: "# The Plan\n\nship it" },
  }).taskId;
  await service.startTask({ taskId });
  await answer("choose_option", { decision: "approve", comments: "looks fine" });
  await answer("review_artifact", { decision: "approve" });
  await answer("edit_artifact", { content: "# Edited\n\nnew body" });
  await answer("fill_form", { title: "t", severity: "significant", estimate: 3 });
  await answer("confirm_action", { confirmed: true });
  await until(() => pushes.some((p) => p.type === "run:finished"), "the run to finish");
  return taskId;
}

interface EventRow {
  instance_id: number | null;
  type: string;
  payload_json: string;
  operation_id: string | null;
}

describe("what a stopped run can be read back from", () => {
  it("joins each instance to what its operation returned", async () => {
    const taskId = await runToCompletion();
    const project = openProject(dir);
    try {
      const events = project.db
        .prepare(
          `SELECT instance_id, type, payload_json, operation_id FROM state_machine_events
            WHERE task_id = ? ORDER BY seq`,
        )
        .all(taskId) as EventRow[];

      // The join, walked the way a resume would: for every operation that settled, the event names
      // the instance AND the record, and the record holds the value.
      const returned = new Map<string, JsonValue>();
      for (const event of events) {
        if (event.type !== "operation.completed" || event.operation_id === null) continue;
        const stateId = (JSON.parse(event.payload_json) as { stateId: string }).stateId;
        const row = project.db
          .prepare(`SELECT status, result_json FROM operation_records WHERE task_id = ? AND record_id = ?`)
          .get(taskId, event.operation_id) as { status: string; result_json: string } | undefined;
        expect(row, `no record for ${stateId}'s operation`).toBeDefined();
        expect(row!.status).toBe("completed");
        returned.set(stateId, (JSON.parse(row!.result_json) as { value: JsonValue }).value);
      }

      // Every gate's answer is on disk, under the state that produced it — which is what a parent
      // binding `.children.choose.outputs.decision` needs in order to be re-resolved.
      expect(returned.get("components/choose")).toEqual({ decision: "approve", comments: "looks fine" });
      expect(returned.get("components/review")).toEqual({ decision: "approve" });
      expect(returned.get("components/edit")).toEqual({ content: "# Edited\n\nnew body" });
      expect(returned.get("components/form")).toEqual({ title: "t", severity: "significant", estimate: 3 });
      expect(returned.get("components/confirm")).toEqual({ confirmed: true });
    } finally {
      project.close();
    }
  }, 30000);

  it("records what each state was CALLED WITH, upstream outputs included", async () => {
    // The second, independent copy of a sibling's output: a child's resolved inputs are journaled on
    // the way in, and this workflow threads each gate's answer into the next one's inputs. So a
    // value that reached a downstream state is recoverable even without the join above.
    const taskId = await runToCompletion();
    const project = openProject(dir);
    try {
      const entered = (
        project.db
          .prepare(`SELECT payload_json FROM state_machine_events WHERE task_id = ? AND type = 'instance.entered' ORDER BY seq`)
          .all(taskId) as Array<{ payload_json: string }>
      ).map((r) => JSON.parse(r.payload_json) as { stateId: string; childKey?: string; parentInstanceId?: number; inputs: Record<string, JsonValue> });

      // The root's own inputs, and the parentage that makes the rest a tree.
      expect(entered[0]).toMatchObject({ stateId: "components", inputs: { doc: "# The Plan\n\nship it" } });
      expect(entered.filter((e) => e.parentInstanceId === 1).map((e) => e.childKey)).toEqual([
        "choose",
        "review",
        "edit",
        "form",
        "confirm",
      ]);

      // `review.previous` IS `choose`'s decision, and `confirm.previous` IS the form's severity.
      expect(entered.find((e) => e.childKey === "review")?.inputs["previous"]).toBe("approve");
      expect(entered.find((e) => e.childKey === "confirm")?.inputs["previous"]).toBe("significant");
    } finally {
      project.close();
    }
  }, 30000);

  it("keeps the root's own outputs on the run row", async () => {
    // The one set of outputs stored outright rather than joined — `finishTaskRun` writes the
    // workflow's result to `runs.outputs_json`. It is the END of the run, so it answers nothing
    // about where a stopped one got to; it is here to mark the boundary between what is stored and
    // what is reconstructed.
    const taskId = await runToCompletion();
    const project = openProject(dir);
    try {
      const run = project.db.prepare(`SELECT outcome, outputs_json FROM runs WHERE task_id = ?`).get(taskId) as {
        outcome: string;
        outputs_json: string;
      };
      expect(run.outcome).toBe("success");
      expect(JSON.parse(run.outputs_json)).toMatchObject({
        decision: "approve",
        review: "approve",
        severity: "significant",
        confirmed: true,
      });
    } finally {
      project.close();
    }
  }, 30000);
});
