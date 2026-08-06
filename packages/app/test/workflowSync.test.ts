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
import { hashText, initProject, stateHashes } from "@jaira/persistence";
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

  it("judges a shared-root description against the shared root, not against the open project", () => {
    // Same path, other layer. The base root of this suite is empty, so the answer is about the file
    // that is not there — not about this project's description, which exists and is not empty. A
    // machine-global document must read the same whichever checkout happens to be open.
    const status = service.syncStatus({ layer: "base", path: WORKFLOW_DESCRIPTION_PATH });
    expect(status).toMatchObject({ layer: "base", exists: false });
    expect(status.blocked).toMatch(/empty/);
  });

  it("reads a baseline written in the older single-record shape", () => {
    // A project that synced before descriptions could nest must not be told, on its first open,
    // that everything has drifted.
    const text = readFileSync(descriptionFile(), "utf8");
    writeFileSync(
      syncFile(),
      JSON.stringify({
        document: WORKFLOW_DESCRIPTION_PATH,
        documentHash: hashText(text),
        states: stateHashes(join(dir, ".jaira", "workflows")),
        at: 1,
        direction: "document",
      }),
      "utf8",
    );

    expect(service.syncStatus({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH })).toMatchObject({
      synced: true,
      documentChanged: false,
      statesChanged: false,
    });
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
    service.writeFile({ layer: "project", path: planPath, text: REWRITTEN });
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
    service.writeFile({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH, text: REWRITTEN });
    expect(service.syncStatus({ layer: "project", path: WORKFLOW_DESCRIPTION_PATH }).synced).toBe(true);

    await service.runSync({
      layer: "project",
      path: planPath,
      direction: "document",
      fake: fake({ document: { text: REWRITTEN, changes: [] } }) as never,
    });
    service.writeFile({ layer: "project", path: planPath, text: REWRITTEN });

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
    service.writeFile({ layer: "project", path: planMd, text: REWRITTEN });
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
            stateId: "feature/plan/critique/human_review",
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
            stateId: "feature/plan/gate",
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
    // In `~/.jaira/sync.json` and not in any project's — a machine-global document whose history
    // was scattered across checkouts would have a different answer in every window.
    expect(existsSync(baseFile("sync.json"))).toBe(true);

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
