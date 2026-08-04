/**
 * Keeping `workflows/workflow.md` and the state files in step, driven headlessly.
 *
 * Three promises are tested here, and they are the three the feature is made of.
 *
 *  - **It writes nothing.** A sync returns a proposal. If it ever touched a file, the description
 *    somebody wrote would be rewritten by a model before they read a word of it.
 *  - **It knows which side moved.** That is the whole reason there is a recorded baseline, and the
 *    reason it advances on ACCEPTANCE rather than on the run: a proposal produced and discarded left
 *    both sides where they were.
 *  - **It does not trust what the model returns.** A state id is a path, it arrives from a language
 *    model, and `../../..` is a perfectly good relative path.
 *
 * `fake` scripts all three states, so none of this needs a provider.
 */
import { mkdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { specPlanningFiles, syncRules, writeWorkflowFiles, type ConformanceFinding } from "@jaira/runtime";
import { WORKFLOW_DESCRIPTION, WORKFLOW_DESCRIPTION_PATH } from "@jaira/shared";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;

const DESCRIPTION = "# Planning\n\nTurn the issue into goals, then write a plan, then critique it.\n";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-sync-"));
  const paths = initProject(dir);
  writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());
  writeFileSync(join(paths.workflowsDir, "workflow.md"), DESCRIPTION, "utf8");
  service = new AppService({ watchWorkflows: false });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

const REQUIREMENTS = [
  { id: "R1", requirement: "the issue becomes goals", category: "step" as const, quote: "Turn the issue into goals" },
  { id: "R2", requirement: "a human approves the plan", category: "human_gate" as const, quote: "then critique it" },
];

const finding = (id: string, status: ConformanceFinding["status"], states: string[] = []): ConformanceFinding => ({
  id,
  requirement: REQUIREMENTS.find((r) => r.id === id)!.requirement,
  status,
  states,
  detail: status === "satisfied" ? "the state does this" : "nothing renders a gate to a person",
});

const FINDINGS = [finding("R1", "satisfied", ["feature/plan/goals"]), finding("R2", "missing")];

/** The `fake` script for one sync — every state answered, so no provider is involved. */
function fake(over: Parameters<typeof syncRules>[0] extends infer T ? Partial<T> : never = {}): unknown {
  return syncRules({
    requirements: REQUIREMENTS,
    verdict: "gaps",
    findings: FINDINGS,
    ...over,
  });
}

const descriptionFile = (): string => join(dir, ".jaira", ...WORKFLOW_DESCRIPTION_PATH.split("/"));
const syncFile = (): string => join(dir, ".jaira", "sync.json");

const REWRITTEN = "# Planning\n\nGoals, then a plan, then a critique by a model.\n";

async function syncDocument(text?: string) {
  return service.runSync({
    layer: "project",
    path: WORKFLOW_DESCRIPTION_PATH,
    direction: "document",
    ...(text !== undefined ? { text } : {}),
    fake: fake({ document: { text: REWRITTEN, changes: [{ summary: "the critique is a model, not a person", requirements: ["R2"] }] } }) as never,
  });
}

describe("the description as a file", () => {
  it("opens as its own type, which is what puts the sync panel on it", () => {
    const doc = service.readFile({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH });
    expect(doc.mime).toBe(WORKFLOW_DESCRIPTION);
    expect(doc.text).toBe(DESCRIPTION);
  });
});

describe("syncStatus", () => {
  it("says there is no baseline before anything has been synced", () => {
    const status = service.syncStatus({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH });
    expect(status.synced).toBe(false);
    expect(status.suggested).toBeNull();
    expect(status.blocked).toBeUndefined();
  });

  it("answers about the text the editor has, not the file on disk", () => {
    // The panel is looking at a draft; a status computed from the saved file would describe a
    // document nobody has on screen.
    const status = service.syncStatus({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH, text: "" });
    expect(status.blocked).toMatch(/empty/);
  });

  it("refuses to judge a shared-root description against one project", () => {
    const status = service.syncStatus({ layer: "base", path: WORKFLOW_DESCRIPTION_PATH });
    expect(status.blocked).toMatch(/shared root/);
  });

  it("says which side moved once there is a baseline", async () => {
    await syncDocument();
    service.writeFile({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH, text: REWRITTEN });

    expect(service.syncStatus({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH })).toMatchObject({
      synced: true,
      documentChanged: false,
      statesChanged: false,
      suggested: null,
    });

    // Edit a state, and the description is what is now out of date.
    service.writeWorkflow({ stateId: "feature/plan/goals", layer: "project", text: '{"label":"Goals, revised"}' });
    const afterState = service.syncStatus({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH });
    expect(afterState).toMatchObject({ documentChanged: false, statesChanged: true, suggested: "document" });
    expect(afterState.changedStates).toEqual([{ path: "feature/plan/goals.json", change: "edited" }]);

    // Edit the description too, and there is no longer a mechanical answer.
    service.writeFile({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH, text: `${REWRITTEN}\nAnd a gate.\n` });
    expect(service.syncStatus({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH })).toMatchObject({
      documentChanged: true,
      statesChanged: true,
      suggested: null,
    });
  });
});

describe("runSync towards the document", () => {
  it("returns the rewritten description and writes nothing", async () => {
    const result = await syncDocument();
    expect(result.document?.text).toBe(REWRITTEN);
    expect(result.document?.changes[0]?.requirements).toEqual(["R2"]);
    // The file is untouched: what came back is a proposal, and the renderer holds it as a draft.
    expect(readFileSync(descriptionFile(), "utf8")).toBe(DESCRIPTION);
    expect(existsSync(syncFile())).toBe(false);
  });

  it("reports the findings behind the rewrite, and overrules a verdict its own findings contradict", async () => {
    const result = await service.runSync({
      layer: "project",
      path: WORKFLOW_DESCRIPTION_PATH,
      direction: "document",
      fake: fake({ verdict: "conforms", document: { text: REWRITTEN, changes: [] } }) as never,
    });
    // The findings are the evidence; a run that lists a missing requirement and then says it
    // conforms is not believed here either.
    expect(result.verdict).toBe("gaps");
    expect(result.findings.map((f) => f.id)).toEqual(["R1", "R2"]);
    expect(result.workflows).toEqual(["feature/plan"]);
  });

  it("records the baseline only when the proposal is saved", async () => {
    await syncDocument();
    expect(existsSync(syncFile())).toBe(false);
    service.writeFile({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH, text: REWRITTEN });
    // Accepting it is what makes the two agree — producing it did not.
    expect(service.syncStatus({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH }).synced).toBe(true);
  });

  it("records the baseline immediately when there was nothing to change", async () => {
    const result = await service.runSync({
      layer: "project",
      path: WORKFLOW_DESCRIPTION_PATH,
      direction: "document",
      fake: fake({ verdict: "conforms", findings: [finding("R1", "satisfied"), finding("R2", "satisfied")], document: { text: DESCRIPTION, changes: [] } }) as never,
    });
    expect(result.notes[0]).toMatch(/already describes/);
    // Otherwise a project that IS in step would report drift forever with no button that could
    // ever clear it.
    expect(service.syncStatus({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH })).toMatchObject({
      synced: true,
      documentChanged: false,
      statesChanged: false,
    });
  });

  it("syncs the draft it was given rather than the saved file", async () => {
    const result = await syncDocument("# Planning\n\nAnd a human gate at the end.\n");
    expect(result.document?.text).toBe(REWRITTEN);
    expect(readFileSync(descriptionFile(), "utf8")).toBe(DESCRIPTION);
  });
});

describe("runSync towards the states", () => {
  const edit = (stateId: string, text: string) => ({
    stateId,
    action: "create" as const,
    text,
    reason: "R2 asks for a human gate",
    requirements: ["R2"],
  });

  async function syncStates(edits: Array<ReturnType<typeof edit>>, notes: string[] = []) {
    return service.runSync({
      layer: "project",
      path: WORKFLOW_DESCRIPTION_PATH,
      direction: "states",
      fake: fake({ edits, notes }) as never,
    });
  }

  it("places a proposed file, and writes nothing", async () => {
    const result = await syncStates([edit("feature/plan/gate", '{"label":"Approve the plan"}')]);
    expect(result.edits).toHaveLength(1);
    expect(result.edits?.[0]).toMatchObject({
      stateId: "feature/plan/gate",
      layer: "project",
      path: "workflows/feature/plan/gate.json",
      action: "create",
      applicable: true,
    });
    expect(existsSync(join(dir, ".jaira", "workflows", "feature", "plan", "gate.json"))).toBe(false);
  });

  it("calls an edit to an existing state an update, whatever the model called it", async () => {
    const result = await syncStates([edit("feature/plan/critique", '{"label":"Critique, with a gate"}')]);
    expect(result.edits?.[0]?.action).toBe("update");
  });

  it("drops a proposal that is identical to the file it would replace", async () => {
    const current = readFileSync(join(dir, ".jaira", "workflows", "feature", "plan", "critique.json"), "utf8");
    const result = await syncStates([edit("feature/plan/critique", current)]);
    // Otherwise the tree would mark a file as edited when saving it would change nothing.
    expect(result.edits).toEqual([]);
    expect(result.notes.join(" ")).toMatch(/already identical/);
  });

  it("refuses a state id that points outside the workflows directory", async () => {
    const result = await syncStates([edit("../../../escape", '{"label":"nope"}')]);
    expect(result.edits?.[0]?.applicable).toBe(false);
    expect(result.edits?.[0]?.blocked).toMatch(/does not name a state/);
  });

  it("reports rather than applies a JSON proposal for a YAML state", async () => {
    writeFileSync(join(dir, ".jaira", "workflows", "yamlish.yaml"), "label: Yamlish\n", "utf8");
    const result = await syncStates([edit("yamlish", '{"label":"Yamlish"}')]);
    expect(result.edits?.[0]).toMatchObject({ applicable: false, path: "workflows/yamlish.yaml" });
    expect(result.edits?.[0]?.blocked).toMatch(/YAML/);
  });

  it("keeps what could not be written as a state file, instead of inventing one", async () => {
    const result = await syncStates([], ["a human gate needs a function this project has registered"]);
    expect(result.notes).toContain("a human gate needs a function this project has registered");
  });

  it("records the baseline when every proposed file has been saved", async () => {
    const result = await syncStates([
      edit("feature/plan/gate", '{"label":"Approve the plan"}'),
      edit("feature/plan", '{"label":"Planning, with a gate"}'),
    ]);
    expect(result.edits?.every((e) => e.applicable)).toBe(true);

    service.writeWorkflow({ stateId: "feature/plan/gate", layer: "project", text: '{"label":"Approve the plan"}' });
    // Half-accepted is not accepted: the workflows still do not run what the description asks for.
    expect(service.syncStatus({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH }).synced).toBe(false);

    service.writeWorkflow({ stateId: "feature/plan", layer: "project", text: '{"label":"Planning, with a gate"}' });
    expect(service.syncStatus({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH })).toMatchObject({
      synced: true,
      documentChanged: false,
      statesChanged: false,
    });
  });
});

describe("runSync refusals", () => {
  it("refuses an empty description", async () => {
    await expect(
      service.runSync({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH, direction: "document", text: "  ", fake: fake() as never }),
    ).rejects.toThrow(/nothing to sync/);
  });

  it("refuses to judge workflows it could not read in full", async () => {
    writeFileSync(join(dir, ".jaira", "workflows", "broken.json"), "{not json", "utf8");
    // A conformance answer over partial evidence reads as a clean bill of health, and here it would
    // become a rewritten document describing workflows the run never saw.
    await expect(
      service.runSync({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH, direction: "document", fake: fake() as never }),
    ).rejects.toThrow(/does not load/);
  });

  it("refuses a project with no workflows at all", async () => {
    const empty = mkdtempSync(join(tmpdir(), "jaira-sync-empty-"));
    const paths = initProject(empty);
    mkdirSync(paths.workflowsDir, { recursive: true });
    writeFileSync(join(paths.workflowsDir, "workflow.md"), DESCRIPTION, "utf8");
    const other = new AppService({ watchWorkflows: false });
    await other.open(empty);
    try {
      expect(other.syncStatus({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH }).blocked).toMatch(/no workflows/);
      await expect(
        other.runSync({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH, direction: "states", fake: fake() as never }),
      ).rejects.toThrow(/no workflows/);
    } finally {
      await other.close();
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("reports that nothing was running when a cancel arrives late", () => {
    expect(service.cancelSync()).toEqual({ canceled: false });
  });
});
