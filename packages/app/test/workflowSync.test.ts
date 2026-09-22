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
 *  - **It does not trust what the model returns.** A proposal names a path, it arrives from a
 *    language model, and `../../..` is a perfectly good relative path — and only `workflows/` and
 *    `prompts/` are directories a sync is entitled to propose into at all.
 *
 * `fake` scripts all three states, so none of this needs a provider.
 */
import { mkdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { specPlanningFiles, syncRules, REVIEW_ARTIFACTS, writeWorkflowFiles, type ConformanceFinding } from "@jaira/runtime";
import { WORKFLOW_DESCRIPTION, WORKFLOW_DESCRIPTION_PATH } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;

const DESCRIPTION = "# Planning\n\nTurn the issue into goals, then write a plan, then critique it.\n";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-sync-"));
  const paths = initProject(dir, testHome());
  writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());
  writeFileSync(join(paths.workflowsDir, "workflow.md"), DESCRIPTION, "utf8");
  service = new AppService({ baseDir: testHome(), watchWorkflows: false });
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
const syncFile = (): string => join(dir, ".jaira", "system", "sync.json");

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
    // `readFile` is the Files-view space, so the description carries the `.jaira/` prefix the tree
    // shows. `syncStatus` below is the layer's own space and does not — see `treeFile`.
    const doc = service.readFile({ layer: "project", path: `.jaira/${WORKFLOW_DESCRIPTION_PATH}` });
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

  it("judges a shared-root description against the shared root, not against the open project", () => {
    // Same path, other layer. The base root of this suite is empty, so the answer is about the file
    // that is not there — not about this project's description, which exists and is not empty. A
    // machine-global document must read the same whichever checkout happens to be open.
    const status = service.syncStatus({ layer: "base", path: WORKFLOW_DESCRIPTION_PATH });
    expect(status).toMatchObject({ layer: "base", exists: false });
    expect(status.blocked).toMatch(/empty/);
  });

  it("says which side moved once there is a baseline", async () => {
    await syncDocument();
    service.writeFile({ layer: "project", path: `.jaira/${WORKFLOW_DESCRIPTION_PATH}`, text: REWRITTEN });

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
    service.writeFile({ layer: "project", path: `.jaira/${WORKFLOW_DESCRIPTION_PATH}`, text: `${REWRITTEN}\nAnd a gate.\n` });
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
    service.writeFile({ layer: "project", path: `.jaira/${WORKFLOW_DESCRIPTION_PATH}`, text: REWRITTEN });
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
  // The model proposes FILES now (path-based), and for a state file the app derives the id back
  // from the path — which is what these helpers exercise.
  const edit = (stateId: string, text: string) => ({
    path: `workflows/${stateId}.json`,
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

  it("places a proposed prompt file under prompts/, category subfolder and all", async () => {
    const result = await syncStates([
      { path: "prompts/review/critique.md", action: "create" as const, text: "Critique the plan.\n", reason: "R2 wants a review prompt", requirements: ["R2"] },
    ]);
    // A prompt file is a file, not a state: no state id, no ownership question, just a draft at the
    // path the model chose for it.
    expect(result.edits?.[0]).toMatchObject({ path: "prompts/review/critique.md", layer: "project", action: "create", applicable: true });
    expect(result.edits?.[0]?.stateId).toBeUndefined();
    // Still a proposal — nothing is written until the person reading it saves it.
    expect(existsSync(join(dir, ".jaira", "prompts", "review", "critique.md"))).toBe(false);
  });

  /**
   * The bare state id, folded in. This is not a hypothetical: a real run proposed fourteen files,
   * every one of them named by state id (`feature/documentation.json`), and every one was refused —
   * so the sync reported that it had found nothing to change after an hour of work.
   */
  it("places a proposal that names the state id rather than the path under it", async () => {
    const result = await syncStates([
      { ...edit("feature/plan/gate", '{"label":"Approve the plan"}'), path: "feature/plan/gate.json" },
    ]);
    expect(result.edits?.[0]).toMatchObject({
      stateId: "feature/plan/gate",
      path: "workflows/feature/plan/gate.json",
      applicable: true,
    });
  });

  it("takes a bare state id with no suffix at all as a state file", async () => {
    const result = await syncStates([{ ...edit("feature/plan/gate", "{}"), path: "feature/plan/gate" }]);
    expect(result.edits?.[0]).toMatchObject({ stateId: "feature/plan/gate", path: "workflows/feature/plan/gate.json" });
  });

  it("refuses a proposal outside workflows/ and prompts/, naming the rule", async () => {
    const result = await syncStates([
      { path: "lib/helper.md", action: "create" as const, text: "x", reason: "", requirements: [] },
    ]);
    expect(result.edits?.[0]).toMatchObject({ applicable: false });
    expect(result.edits?.[0]?.blocked).toMatch(/workflows\/ or prompts\//);
  });

  it("refuses a prompt path that escapes the layer root", async () => {
    const result = await syncStates([
      { path: "prompts/../../escape.md", action: "create" as const, text: "x", reason: "", requirements: [] },
    ]);
    expect(result.edits?.[0]).toMatchObject({ applicable: false });
    expect(result.edits?.[0]?.blocked).toMatch(/not inside/);
  });

  it("keeps what could not be written as a state file, instead of inventing one", async () => {
    const result = await syncStates([], ["a human gate needs a function this project has registered"]);
    expect(result.notes).toContain("a human gate needs a function this project has registered");
  });

  it("opens the diff review itself when asked, and a merged review writes the file", async () => {
    const result = await service.runSync({
      layer: "project",
      path: WORKFLOW_DESCRIPTION_PATH,
      direction: "states",
      // The renderer passes this for every states sync: the reviewer arrives as a pending
      // interaction from MAIN, so it reaches a window that reloaded or navigated away during a
      // run that can take an hour — which is exactly when the blocking channel's result is lost.
      review: true,
      interactions: { [REVIEW_ARTIFACTS]: [{ decisions: [{ id: "c1", decision: "merged" }] } as never] },
      fake: fake({ edits: [edit("feature/plan/gate", '{"label":"Approve the plan"}')] }) as never,
    });
    expect(result.reviewTaskId).toBeDefined();

    // The review runs as its own task and is not awaited by the sync channel; the merged decision
    // is applied by its continuation.
    const file = join(dir, ".jaira", "workflows", "feature", "plan", "gate.json");
    const deadline = Date.now() + 8000;
    while (!existsSync(file)) {
      if (Date.now() > deadline) throw new Error("the merged review never wrote the file");
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(readFileSync(file, "utf8")).toBe('{"label":"Approve the plan"}');
  });

  it("does not open a review when nothing was applicable", async () => {
    const current = readFileSync(join(dir, ".jaira", "workflows", "feature", "plan", "critique.json"), "utf8");
    const result = await service.runSync({
      layer: "project",
      path: WORKFLOW_DESCRIPTION_PATH,
      direction: "states",
      review: true,
      fake: fake({ edits: [edit("feature/plan/critique", current)] }) as never,
    });
    // An identical proposal produces no changeset, so there is nothing to park a reviewer on.
    expect(result.reviewTaskId).toBeUndefined();
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

describe("a description per workflow", () => {
  /** A second, unrelated root, so "did the OTHER workflow move?" is a question that can be asked. */
  const addRelease = (): void => {
    writeFileSync(join(dir, ".jaira", "workflows", "release.json"), '{"label":"Release"}', "utf8");
  };
  const planDescription = (): string => join(dir, ".jaira", "workflows", "feature", "plan.md");

  beforeEach(() => {
    writeFileSync(planDescription(), "# Planning\n\nGoals, a plan, a critique.\n", "utf8");
  });

  const planPath = "workflows/feature/plan.md";

  it("opens as a description, and is judged against the root it is named for", async () => {
    addRelease();
    expect(service.readFile({ layer: "project", path: planPath }).mime).toBe(WORKFLOW_DESCRIPTION);

    const result = await service.runSync({
      layer: "project",
      path: planPath,
      direction: "document",
      fake: fake({ document: { text: REWRITTEN, changes: [] } }) as never,
    });

    // `release` exists and is deliberately absent: the file is about `feature/plan`, so judging it
    // against every workflow in the layer would be judging it against documents it never mentions.
    expect(result.workflows).toEqual(["feature/plan"]);
  });

  it("does not report drift when a workflow it is not about changes", async () => {
    addRelease();
    await service.runSync({
      layer: "project",
      path: planPath,
      direction: "document",
      fake: fake({ document: { text: REWRITTEN, changes: [] } }) as never,
    });
    service.writeFile({ layer: "project", path: `.jaira/${planPath}`, text: REWRITTEN });
    expect(service.syncStatus({ layer: "project", path: planPath })).toMatchObject({ synced: true, statesChanged: false });

    service.writeWorkflow({ stateId: "release", layer: "project", text: '{"label":"Release, revised"}' });

    // The whole point of scoping the baseline: an unrelated edit that shows as drift here is noise
    // of the kind that teaches people to ignore the marker.
    expect(service.syncStatus({ layer: "project", path: planPath }).statesChanged).toBe(false);

    // But an edit inside its own closure does move it.
    service.writeWorkflow({ stateId: "feature/plan/goals", layer: "project", text: '{"label":"Goals, revised"}' });
    expect(service.syncStatus({ layer: "project", path: planPath })).toMatchObject({
      statesChanged: true,
      suggested: "document",
    });
  });

  it("keeps a baseline per description, so settling one does not erase another's", async () => {
    await syncDocument();
    service.writeFile({ layer: "project", path: `.jaira/${WORKFLOW_DESCRIPTION_PATH}`, text: REWRITTEN });
    expect(service.syncStatus({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH }).synced).toBe(true);

    await service.runSync({
      layer: "project",
      path: planPath,
      direction: "document",
      fake: fake({ document: { text: REWRITTEN, changes: [] } }) as never,
    });
    service.writeFile({ layer: "project", path: `.jaira/${planPath}`, text: REWRITTEN });

    // Both, at once. The old file held ONE record and rejected it when the document did not match,
    // so accepting the second sync silently dropped the first one's baseline.
    expect(service.syncStatus({ layer: "project", path: planPath }).synced).toBe(true);
    expect(service.syncStatus({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH }).synced).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(syncFile(), "utf8")).documents).sort()).toEqual([
      planPath,
      WORKFLOW_DESCRIPTION_PATH,
    ]);
  });

  it("says so when a description names a workflow that does not exist", () => {
    writeFileSync(join(dir, ".jaira", "workflows", "typo.md"), "# Typo\n\nSomething.\n", "utf8");

    const status = service.syncStatus({ layer: "project", path: "workflows/typo.md" });

    // A filename typo, reported where the file is open rather than as a failure at run time.
    expect(status.blocked).toMatch(/names no workflow here/);
    expect(status.blocked).toMatch(/feature\/plan/);
  });

  it("refuses to run a sync for a description that names no workflow", async () => {
    writeFileSync(join(dir, ".jaira", "workflows", "typo.md"), "# Typo\n\nSomething.\n", "utf8");
    await expect(
      service.runSync({ layer: "project", path: "workflows/typo.md", direction: "document", fake: fake() as never }),
    ).rejects.toThrow(/unknown workflow 'typo'/);
  });
});

describe("nested descriptions", () => {
  // `feature/plan` is the root; `feature/plan/critique` is a subtree of it with three states. Two
  // descriptions, one inside the other — the case the ownership rule exists for.
  const planMd = "workflows/feature/plan.md";
  const critiqueMd = "workflows/feature/plan/critique.md";
  const write = (rel: string, text: string): void =>
    writeFileSync(join(dir, ".jaira", ...rel.split("/")), text, "utf8");

  beforeEach(() => {
    write(planMd, "# Planning\n\nGoals, a plan, then a critique.\n");
    write(critiqueMd, "# Critique\n\nA model finds weaknesses, then a person approves.\n");
  });

  it("gives each state to the nearest description, and says what it delegated", () => {
    const status = service.syncStatus({ layer: "project", path: planMd });

    expect(status.delegated).toEqual([
      { document: critiqueMd, root: "feature/plan/critique", states: 3 },
    ]);
    // The parent still owns its own states — delegation takes a subtree, not the document.
    expect(status.blocked).toBeUndefined();
  });

  it("does not move the parent's baseline when a delegated state changes", async () => {
    await service.runSync({
      layer: "project",
      path: planMd,
      direction: "document",
      fake: fake({ document: { text: REWRITTEN, changes: [] } }) as never,
    });
    service.writeFile({ layer: "project", path: `.jaira/${planMd}`, text: REWRITTEN });
    expect(service.syncStatus({ layer: "project", path: planMd }).synced).toBe(true);

    // Inside `critique`, which `critique.md` owns.
    service.writeWorkflow({
      stateId: "feature/plan/critique/human_review",
      layer: "project",
      text: '{"label":"Approve, revised"}',
    });
    expect(service.syncStatus({ layer: "project", path: planMd }).statesChanged).toBe(false);

    // Outside it, which `plan.md` owns.
    service.writeWorkflow({ stateId: "feature/plan/goals", layer: "project", text: '{"label":"Goals, revised"}' });
    expect(service.syncStatus({ layer: "project", path: planMd }).statesChanged).toBe(true);
  });

  it("refuses a proposed edit to a state another description owns", async () => {
    const result = await service.runSync({
      layer: "project",
      path: planMd,
      direction: "states",
      fake: fake({
        edits: [
          {
            path: "workflows/feature/plan/critique/human_review.json",
            action: "update",
            text: '{"label":"Approve the plan"}',
            reason: "R2 asks for a human gate",
            requirements: ["R2"],
          },
        ],
      }) as never,
    });

    // Reported rather than dropped: it usually means `critique.md` is the document to change.
    expect(result.edits?.[0]).toMatchObject({ applicable: false });
    expect(result.edits?.[0]?.blocked).toContain(critiqueMd);
  });

  it("leaves a description that delegated everything with nothing to sync, and says so", () => {
    // `workflow.md` is the top of the hierarchy; with `plan.md` below it there is nothing left.
    const status = service.syncStatus({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH });
    expect(status.blocked).toContain(planMd);
    expect(status.delegated?.[0]).toMatchObject({ root: "feature/plan" });
  });
});

describe("runSync refusals", () => {
  it("refuses an empty description", async () => {
    await expect(
      service.runSync({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH, direction: "document", text: "  ", fake: fake() as never }),
    ).rejects.toThrow(/nothing to sync/);
  });

  it("runs against workflows that do not load, rather than refusing over them", async () => {
    writeFileSync(join(dir, ".jaira", "workflows", "broken.json"), "{not json", "utf8");
    // This used to refuse, on the reasoning that partial evidence reads as a clean bill of health.
    // It had the case backwards: a workflow that does not load is the one somebody most wants a sync
    // to help fix, and refusing meant the surface that could have named the broken file greyed its
    // own button out instead. The evidence is no longer partial-and-silent — the digest renders an
    // unloadable root from its files and labels it — so the run proceeds and the breakage is in
    // scope for the proposal.
    const result = await service.runSync({
      layer: "project",
      path: WORKFLOW_DESCRIPTION_PATH,
      direction: "states",
      fake: fake({
        edits: [
          {
            path: "workflows/broken.json",
            action: "update" as const,
            text: '{"label":"Repaired"}',
            reason: "the file does not parse",
            requirements: ["R2"],
          },
        ],
      }) as never,
    });
    expect(result.verdict).toBe("gaps");
    expect(result.edits?.[0]).toMatchObject({ path: "workflows/broken.json", applicable: true });
  });

  it("refuses a project with no workflows at all", async () => {
    const empty = mkdtempSync(join(tmpdir(), "jaira-sync-empty-"));
    const paths = initProject(empty, testHome());
    mkdirSync(paths.workflowsDir, { recursive: true });
    writeFileSync(join(paths.workflowsDir, "workflow.md"), DESCRIPTION, "utf8");
    const other = new AppService({ baseDir: testHome(), watchWorkflows: false });
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

  it("reports what broke, not the parent's view of it", async () => {
    // The composite's own reason is "child 'requirements' terminated with error and no transition
    // handled it" — the state that NOTICED, never the one that failed. A panel showing that has told
    // the person nothing they can act on, which is the whole reason a sync buffers its event stream.
    await expect(
      service.runSync({
        layer: "project",
        path: WORKFLOW_DESCRIPTION_PATH,
        direction: "document",
        fake: [
          { promptIncludes: "Break it into the individual requirements", error: "no API key for route 'anthropic'" },
        ] as never,
      }),
    ).rejects.toThrow(/workflow\/conformance\/requirements: no API key for route 'anthropic'/);
  });
});

/**
 * The shared root is a place workflows are authored, so it is a place a description has to be
 * syncable — and the mode people author shared workflows in is the one with no project open.
 *
 * Nothing here needs a project, and that is the point: the description, the workflows it is judged
 * against, and the baseline it is recorded in are all inside `~/.jaira`. The answer is the same
 * whether a checkout is open, none is, or a different one is tomorrow.
 */
describe("the shared root, with no project open", () => {
  let home: string;
  let base: string;
  let bare: AppService;

  const baseFile = (...parts: string[]): string => join(base, ...parts);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jaira-home-"));
    base = join(home, "shared");
    mkdirSync(join(base, "workflows"), { recursive: true });
    writeWorkflowFiles(join(base, "workflows"), specPlanningFiles());
    writeFileSync(baseFile("workflows", "workflow.md"), DESCRIPTION, "utf8");
    bare = new AppService({ watchWorkflows: false, baseDir: base });
  });

  afterEach(async () => {
    await bare.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("has an answer, rather than telling you to open a project", () => {
    const status = bare.syncStatus({ layer: "base", path: WORKFLOW_DESCRIPTION_PATH });
    // `blocked` is what greys both buttons out, so this assertion IS the bug: the shared root has
    // its own workflows and its own baseline, and neither of them needs a checkout.
    expect(status.blocked).toBeUndefined();
    expect(status.synced).toBe(false);
    expect(status.exists).toBe(true);
  });

  it("proposes shared state files, into the shared root", async () => {
    const result = await bare.runSync({
      layer: "base",
      path: WORKFLOW_DESCRIPTION_PATH,
      direction: "states",
      fake: fake({
        edits: [
          {
            path: "workflows/feature/plan/gate.json",
            action: "create" as const,
            text: '{"label":"Approve the plan"}',
            reason: "R2 asks for a human gate",
            requirements: ["R2"],
          },
        ],
      }) as never,
    });

    expect(result.workflows).toEqual(["feature/plan"]);
    expect(result.edits?.[0]).toMatchObject({
      stateId: "feature/plan/gate",
      // The layer decides where a proposal lands, and with no project the shared root is the only
      // place it could: an edit labelled `project` here would open a draft against no file at all.
      layer: "base",
      path: "workflows/feature/plan/gate.json",
      applicable: true,
    });
    // Still a proposal. Nothing is written until the person reading it saves it.
    expect(existsSync(baseFile("workflows", "feature", "plan", "gate.json"))).toBe(false);
  });

  it("records its baseline in the shared root, where it means the same thing in every window", async () => {
    await bare.runSync({
      layer: "base",
      path: WORKFLOW_DESCRIPTION_PATH,
      direction: "document",
      fake: fake({ document: { text: REWRITTEN, changes: [] } }) as never,
    });
    bare.writeFile({ layer: "base", path: WORKFLOW_DESCRIPTION_PATH, text: REWRITTEN });

    expect(bare.syncStatus({ layer: "base", path: WORKFLOW_DESCRIPTION_PATH })).toMatchObject({
      synced: true,
      documentChanged: false,
      statesChanged: false,
    });
    // In `~/.jaira/system/sync.json` and not in any project's — a machine-global document whose
    // history was scattered across checkouts would have a different answer in every window.
    expect(existsSync(baseFile("system", "sync.json"))).toBe(true);

    // And a shared state moving is drift the shared description is answerable for.
    bare.writeWorkflow({ stateId: "feature/plan/goals", layer: "base", text: '{"label":"Goals, revised"}' });
    expect(bare.syncStatus({ layer: "base", path: WORKFLOW_DESCRIPTION_PATH })).toMatchObject({
      statesChanged: true,
      suggested: "document",
    });
  });

  it("still says to open a project for a project-layer description", () => {
    expect(bare.syncStatus({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH }).blocked).toMatch(/open a project/);
  });
});

/**
 * A sync is a RUN, and now it is recorded like one.
 *
 * It used to call `executeWorkflow` directly: no task, no run, no journal. So a failure could only
 * ever report the parent composite's view of its child ("child 'requirements' terminated with error
 * and no transition handled it"), which names the state that noticed and not the one that broke —
 * and nothing about the run survived long enough to be looked at afterwards.
 *
 * Recording it in JaiRA's OWN project rather than the user's is what makes both halves work: it runs
 * with no project open, and it never appears on a board somebody else owns.
 */
describe("a sync as a task in the system project", () => {
  // Its OWN base root. The suite's other tests share one (`test/setup.ts` points `JAIRA_HOME` at a
  // scratch directory per worker), and JaiRA's project lives in it — so a count asserted against the
  // shared one would be a count of every sync the file has run.
  let home: string;
  let own: AppService;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "jaira-sync-home-"));
    own = new AppService({ watchWorkflows: false, baseDir: join(home, "shared") });
    await own.open(dir);
  });

  afterEach(async () => {
    await own.close();
    rmSync(home, { recursive: true, force: true });
  });

  const systemTasks = () => own.listSystemTasks();

  const syncIt = () =>
    own.runSync({
      layer: "project",
      path: WORKFLOW_DESCRIPTION_PATH,
      direction: "document",
      fake: fake({ document: { text: REWRITTEN, changes: [] } }) as never,
    });

  it("records the run in JaiRA's project and nothing in the user's", async () => {
    await syncIt();

    const rows = systemTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "completed", workflow: "workflow/sync/document" });
    // The user's board is untouched — which is the whole reason these runs have a project of their
    // own rather than borrowing whichever one happens to be open.
    expect(own.listTasks()).toEqual([]);
  });

  it("labels the row with what it was about, so the list is readable", async () => {
    await syncIt();
    const row = systemTasks()[0]!;
    expect(row.labels).toEqual(expect.arrayContaining(["jaira", "sync", "document", "project"]));
    expect(row.title).toContain(WORKFLOW_DESCRIPTION_PATH);
  });

  it("keeps a journal, so a failure names the state that broke rather than the one that noticed", async () => {
    await expect(
      own.runSync({
        layer: "project",
        path: WORKFLOW_DESCRIPTION_PATH,
        direction: "document",
        fake: [{ promptIncludes: "Break it into the individual requirements", error: "no API key for route 'anthropic'" }] as never,
      }),
    ).rejects.toThrow(/workflow\/conformance\/requirements: no API key for route 'anthropic'/);

    // …and the failed run is still there to look at, which it was not when a sync kept no record.
    const rows = systemTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
  });

  it("runs against the workflows it is about, not against JaiRA's own directory", async () => {
    // `ensureWorkspace` would have pointed the run at the system project (`~/.jaira`), which is where
    // it is RECORDED and not what it is about. The workspace is passed explicitly for that reason, and
    // it is what scopes the run's one tool — `read_file` — to the right directory.
    const result = await syncIt();
    expect(result.workflows).toContain("feature/plan");
    expect(systemTasks()[0]?.status).toBe("completed");
  });

  it("refuses a second sync while one is running, and forgets it once it lands", async () => {
    await syncIt();
    // The guard is per holder and cleared in a `finally`, so a completed sync does not wedge the
    // next one — which a run that threw between start and settle would have done.
    await expect(syncIt()).resolves.toBeDefined();
    expect(systemTasks()).toHaveLength(2);
  });
});

/**
 * A run in JaiRA's own project must not make a window ask about a project it has not got.
 *
 * The reported failure: pressing "Propose workflow changes" with no user project open produced
 * "no project is open" from `task:list` and `history:size`. The sync runs in the system project and
 * invalidates ITS task list; the window took that as news about its own and went looking.
 */
describe("what a system run tells the window", () => {
  it("stamps its invalidates with the project they are about", async () => {
    const home = mkdtempSync(join(tmpdir(), "jaira-push-"));
    const pushes: Array<{ type: string; project?: string }> = [];
    const bare = new AppService({
      watchWorkflows: false,
      baseDir: join(home, "shared"),
      publish: (m) => pushes.push(m as { type: string; project?: string }),
    });
    try {
      await bare.open(dir);
      await bare.runSync({
        layer: "project",
        path: WORKFLOW_DESCRIPTION_PATH,
        direction: "document",
        fake: fake({ document: { text: REWRITTEN, changes: [] } }) as never,
      });

      const runNews = pushes.filter((m) => m.type === "run:finished" || m.type === "engine:event");
      expect(runNews.length).toBeGreaterThan(0);
      // Every one names the BASE root, never the open user project — which is what lets the window
      // tell "my tasks changed" from "the root's did".
      for (const m of runNews) expect(m.project).toBe(join(home, "shared"));
      expect(runNews.some((m) => m.project === dir)).toBe(false);
    } finally {
      await bare.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * The reported failure, exactly: press "Propose workflow changes" on a shared-root description with
 * NO project open, and the window fills with `no project is open` from `task:list` and `history:size`.
 *
 * Nothing was wrong with those channels. A task cannot exist without a project and main says so by
 * throwing, deliberately, because an empty answer would hide a real mistake. What was wrong is that
 * the sync runs in JaiRA's OWN project and invalidated ITS task list — and an unstamped invalidate
 * reads as news about whatever the window happens to be showing, which was nothing.
 */
describe("a base-layer sync with no project open", () => {
  let home: string;
  let base: string;
  let bare: AppService;
  let pushes: Array<{ type: string; scope?: string; project?: string }>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jaira-nopush-"));
    base = join(home, "shared");
    mkdirSync(join(base, "workflows"), { recursive: true });
    writeWorkflowFiles(join(base, "workflows"), specPlanningFiles());
    writeFileSync(join(base, "workflows", "workflow.md"), DESCRIPTION, "utf8");
    pushes = [];
    bare = new AppService({
      watchWorkflows: false,
      baseDir: base,
      publish: (m) => pushes.push(m as { type: string; scope?: string; project?: string }),
    });
  });

  afterEach(async () => {
    await bare.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("never tells the window that ITS tasks changed", async () => {
    expect(bare.current()).toBeNull();

    await bare.runSync({
      layer: "base",
      path: WORKFLOW_DESCRIPTION_PATH,
      direction: "document",
      fake: fake({ document: { text: REWRITTEN, changes: [] } }) as never,
    });

    // Every project-scoped push names the project it is about. An unstamped one is machine-wide
    // (`config`, `availability`) and would be acted on by a window with nothing open — which is the
    // bug: `refreshTasks` then calls `task:list`, which throws by design.
    const projectScoped = pushes.filter(
      (m) =>
        m.type === "run:finished" ||
        m.type === "engine:event" ||
        (m.type === "store:invalidate" && (m.scope === "tasks" || m.scope === "board" || m.scope === "task")),
    );
    expect(projectScoped.length).toBeGreaterThan(0);
    // The base root, where a sync is recorded — never the user project, which may not even be open.
    for (const m of projectScoped) expect(m.project).toBe(base);
  });
});

/**
 * A sync you can SEE.
 *
 * The complaint that produced these: pressing the button with no project open did not error any more,
 * and also did not appear to do anything. Nothing logged that it had started, JaiRA's own task list
 * was not reachable from anywhere, and the run's engine events named a task the window had not
 * selected — so a run taking three model calls looked exactly like a button that did nothing.
 */
describe("what a sync with no project open leaves behind", () => {
  let home: string;
  let base: string;
  let bare: AppService;
  let pushes: Array<{ type: string; taskId?: string }>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "jaira-visible-"));
    base = join(home, "shared");
    mkdirSync(join(base, "workflows"), { recursive: true });
    writeWorkflowFiles(join(base, "workflows"), specPlanningFiles());
    writeFileSync(join(base, "workflows", "workflow.md"), DESCRIPTION, "utf8");
    pushes = [];
    bare = new AppService({
      watchWorkflows: false,
      baseDir: base,
      publish: (m) => pushes.push(m as { type: string; taskId?: string }),
    });
  });

  afterEach(async () => {
    await bare.close();
    rmSync(home, { recursive: true, force: true });
  });

  const runIt = () =>
    bare.runSync({
      layer: "base",
      path: WORKFLOW_DESCRIPTION_PATH,
      direction: "document",
      fake: fake({ document: { text: REWRITTEN, changes: [] } }) as never,
    });

  it("says it started, and says how it ended", async () => {
    await runIt();

    const messages = bare.readLogs({ limit: 1000 }).entries.map((e) => e.message);
    // The button was pressed — before, nothing at all recorded that.
    expect(messages.some((m) => m.includes("proposing description changes for base:"))).toBe(true);
    expect(messages.some((m) => m.startsWith("started workflow/sync/document"))).toBe(true);
    expect(messages.some((m) => m.startsWith("completed workflow/sync/document"))).toBe(true);
  });

  it("leaves the run in a list the window can actually read", async () => {
    await runIt();

    // `listSystemTasks` existed and was reachable from nowhere: no IPC channel, no store slice, no
    // view. A run recorded where nothing can read it is not visible.
    const own = bare.listSystemTasks();
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ status: "completed", workflow: "workflow/sync/document" });
  });

  it("narrates itself while it runs, on a channel with no selected task", async () => {
    await runIt();

    // The engine events are what the panel turns into a progress list. They name JaiRA's own task,
    // which the window has not selected — so they are only useful if the panel takes them anyway.
    const events = pushes.filter((m) => m.type === "engine:event");
    expect(events.length).toBeGreaterThan(3);
    expect(new Set(events.map((m) => m.taskId)).size).toBe(1);
  });
});

/**
 * One board PER PROJECT, and each one drillable.
 *
 * The Tasks view is a thing you drill into: columns are a state's children, cards are tasks on their
 * active path, and double-clicking follows the task down. A summary strip of names and status dots is
 * none of that. So JaiRA's own runs get the same board everything else gets — grouped rather than
 * merged, because two projects' columns are columns of different things.
 */
describe("the Tasks view's groups", () => {
  it("lists every project it can draw a board for, the user's first", async () => {
    const groups = service.listProjects();

    // Two, outward from what you are working on: the checkout, and the shared root it can draw
    // workflows from — which is also where JaiRA's own runs are recorded.
    expect(groups.map((g) => g.kind)).toEqual(["user", "shared"]);
    expect(groups[0]).toMatchObject({ project: dir, kind: "user" });
    expect(groups[1]).toMatchObject({ kind: "shared" });
  });

  it("counts each group's own tasks, not the other's", async () => {
    // Its OWN base root: this suite shares one, and every sync is recorded in it — so a count
    // against the shared one would be a count of every sync the file has run.
    const home = mkdtempSync(join(tmpdir(), "jaira-groups-"));
    const own = new AppService({ watchWorkflows: false, baseDir: join(home, "shared") });
    try {
      await own.open(dir);
      own.createTask({ title: "mine", workflow: "feature/plan", inputs: { issue: "x" } });
      await own.runSync({
        layer: "project",
        path: WORKFLOW_DESCRIPTION_PATH,
        direction: "document",
        fake: fake({ document: { text: REWRITTEN, changes: [] } }) as never,
      });

      const groups = own.listProjects();
      expect(groups.find((g) => g.kind === "user")?.tasks).toBe(1);
      // The sync's task is the root's, and appears only under the root.
      expect(groups.find((g) => g.kind === "shared")?.tasks).toBe(1);
    } finally {
      await own.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("draws a real board for JaiRA's own project — columns and cards, not a summary", async () => {
    await syncDocument();
    const system = service.listProjects().find((g) => g.kind === "shared")!.project;

    // Roots first, which is where a group opens: one column per workflow it has run.
    const roots = service.boardRoots({ project: system });
    expect(roots.columns.map((c) => c.stateId)).toContain("workflow/sync/document");

    // …and drilling into one gives that state's children, exactly as it does for a checkout.
    const board = service.board({ level: "workflow/sync/document", project: system });
    expect(board.level).toBe("workflow/sync/document");
    expect(board.columns.map((c) => c.key)).toEqual(["requirements", "assessment", "revision"]);
  });

  it("reads a task's detail from the project it belongs to", async () => {
    await syncDocument();
    const system = service.listProjects().find((g) => g.kind === "shared")!.project;
    const taskId = service.listSystemTasks()[0]!.taskId;

    // A task id is a rowid in ONE database. Unscoped, this is "unknown task" — which is what selecting
    // a JaiRA run in the board would have produced.
    expect(() => service.taskDetail(taskId)).toThrow(/unknown task/);
    expect(service.taskDetail(taskId, system)).toMatchObject({ taskId, status: "completed" });
  });

  it("drills each group independently", async () => {
    await syncDocument();
    const system = service.listProjects().find((g) => g.kind === "shared")!.project;

    // Drilling JaiRA's board says nothing about the checkout's — each group keeps its own level,
    // because looking into one is not a statement about the other.
    const theirs = service.board({ level: "workflow/sync/document", project: system });
    const mine = service.board({ level: "feature/plan" });
    expect(theirs.level).toBe("workflow/sync/document");
    expect(mine.level).toBe("feature/plan");
  });
});
