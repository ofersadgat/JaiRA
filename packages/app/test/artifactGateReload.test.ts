/**
 * A review gate re-parked by a reopen still holds the DOCUMENT it is reviewing.
 *
 * The journal elides artifact content in every `instance.entered` row, and a resume rebuilds a live
 * state's inputs from that row — so a `review_artifact` gate that came back after the app closed
 * was handed `{artifact: true, name}` and drew the reference where the document belonged. The
 * engine now puts the content back from the artifact the rebuilt history registered; this pins it
 * from the side a person sees, which is the pending interaction's inputs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { writeWorkflowFiles } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import type { PushMessage } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

const ROOT = "reviewed";
const DOC = "# The deliverables\n\nOne paragraph of them.";

function files(): Record<string, JsonValue> {
  return {
    [ROOT]: {
      label: "Review fixture",
      outputs: { decision: { schema: { type: "string" }, binding: ".children.gate.output.decision" } },
      children: {
        draft: { state: `${ROOT}/draft` },
        gate: { state: `${ROOT}/gate`, inputs: { docs: ".children.draft.output.doc" } },
      },
      sequence: ["draft", "gate"],
    },
    // A document produced without a model: a blob output bound to a literal.
    [`${ROOT}/draft`]: {
      label: "Draft",
      outputs: { doc: { kind: "blob", schema: { type: "string", contentMediaType: "text/markdown" }, binding: { text: DOC } } },
    },
    [`${ROOT}/gate`]: {
      label: "Gate",
      inputs: { docs: { kind: "blob", schema: { type: "string", contentMediaType: "text/markdown" } } },
      outputs: { decision: { schema: { type: "string" } } },
      operation: {
        kind: "function",
        function: "review_artifact",
        args: { prompt: "approve?", artifact: "docs", options: ["approve", "revise"] },
      },
    },
  };
}

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-artifact-gate-"));
  const { workflowsDir } = initProject(dir, testHome());
  writeWorkflowFiles(workflowsDir, files());
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
});

afterEach(async () => {
  await service.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, label: string, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const docsOf = (): unknown => service.pendingInteractions()[0]?.inputs["docs"];

describe("a review gate's document across a close and reopen", () => {
  it("is the document both times, never the bare reference", async () => {
    const { taskId } = service.createTask({ title: "Review", workflow: ROOT });
    await service.startTask({ taskId });
    await until(() => service.pendingInteractions().length === 1, "the gate to park");
    expect(docsOf()).toMatchObject({ artifact: true, content: DOC });

    await service.close();
    service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
    await service.open(dir);
    await until(() => service.pendingInteractions().some((p) => p.resumes === undefined), "the suspended run to re-park its gate");

    // The re-parked gate is handed the same document, not `{artifact: true, name}` with nothing
    // behind it — which is what the journal's elided row would have given it.
    expect(docsOf()).toMatchObject({ artifact: true, content: DOC });
  });
});
