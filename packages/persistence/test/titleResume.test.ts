/**
 * A computed title is paid for ONCE across a resume (SPEC §5.3).
 *
 * The engine journals a settled title as `value.settled`; JaiRA folds it back into
 * `LoadedInstance.fields`; `loadRun` uses a field it is handed verbatim and evaluates only the ones it
 * is not. So the chain under test is the real one — an engine run recording into a project's journal,
 * `buildTaskLoad` reading that journal, and a second engine loading the description — with a fake
 * prompt executor counting which models were asked. The control case strips `fields` from the same
 * description and watches the title prompt get asked again, which is what makes the first assertion
 * mean something.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  newCapabilityRegistry,
  type Capabilities,
  type ExecHandle,
  type ExecResult,
  type ExecServices,
  type Executor,
  type InlineFamily,
  type Operation,
  type PromptOp,
  type ResolvedValue,
} from "@declarative-ai/exec";
import {
  emptyWorkflowMetrics,
  loadBundle,
  mergeWorkflowMetrics,
  validateBundle,
  WorkflowEngine,
  type EngineEvent,
  type LoadedInstance,
  type WorkflowMetrics,
} from "@declarative-ai/hw";
import { SchemaValidator } from "@declarative-ai/validate";
import { testHome } from "@jaira/testing";
import { buildTaskLoad, initProject, openProject, releaseRevivedFailures, type Project } from "../src/index";

const ROOT = "/p/.jaira";
const WF = `${ROOT}/workflows`;
const FUNCTIONS = `${ROOT}/functions`;

/** The files `loadBundle` resolves `title(...)` against: a prompt that answers with a name. */
const files: Record<string, string> = {
  [`${WF}/plan.json`]: "{}",
  [`${FUNCTIONS}/title.json`]: JSON.stringify({
    kind: "prompt",
    prompt: "Name this: {{.inputs.issue}}",
    model: "titler",
    input: { issue: { kind: "text", index: 0, schema: { type: "string" } } },
    output: { title: { schema: { type: "string" } } },
  }),
};

/** A root whose title is asked of a prompt, and whose model is chosen by that title. */
const states = {
  "plan.json": {
    label: "Planning",
    title: { binding: { expr: "title(.inputs.issue).title", environment: { session: null }, failureValue: "Untitled" } },
    inputs: { issue: { kind: "text", schema: { type: "string" } } },
    outputs: { done: { schema: { type: "string" } } },
    operation: {
      kind: "prompt",
      prompt: "Work on {{.inputs.issue}}",
      model: { expr: "startsWith(.title, 'Ship') ? 'fast' : 'slow'" },
    },
  },
};

function bundle() {
  const loaded = loadBundle(states, "plan", {
    defaultRoot: [WF, FUNCTIONS],
    roots: { JAIRA: ROOT },
    vfs: {
      list: (dir) => {
        const prefix = `${dir}/`;
        return [...new Set(Object.keys(files).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")).map((p) => p.slice(prefix.length)))];
      },
      read: (path) => files[path],
    },
  });
  expect(validateBundle(loaded).errors).toEqual([]);
  return loaded;
}

const CAPS: Capabilities = {
  structuredOutput: true,
  sessionResume: false,
  streaming: false,
  interactive: false,
  readOnly: true,
  mutatesWorkspace: false,
  policyEnforcement: "none",
  memoizable: true,
  runtime: "edge-safe",
};

const metrics = { durationMs: 1, costUsd: 0, costSource: "unknown" as const };

/**
 * A prompt executor that records each call's model and answers by it. The title prompt names the
 * issue; the main call answers with the model it ran under — or fails, when `failMain` says so.
 */
class CountingPrompt implements Executor<ExecServices, WorkflowMetrics> {
  readonly metrics = { merge: mergeWorkflowMetrics, empty: emptyWorkflowMetrics };
  readonly capabilities = CAPS;
  readonly models: string[] = [];
  constructor(private readonly failMain = false) {}

  start(operation: Operation<InlineFamily>): ExecHandle<ResolvedValue, WorkflowMetrics> {
    const op = operation as PromptOp<InlineFamily>;
    const config = op.config !== null && typeof op.config === "object" && !Array.isArray(op.config) ? op.config : {};
    const model = typeof config.model === "string" ? config.model : "";
    this.models.push(model);
    const result: ExecResult<ResolvedValue, WorkflowMetrics> =
      model === "titler"
        ? { value: { title: "Ship: the docs" }, metrics }
        : this.failMain
          ? { error: { classification: "permanent", reason: "the main call fell over" }, metrics }
          : { value: { done: model }, metrics };
    return { events: (async function* () {})(), result: Promise.resolve(result), cancel: async () => {} };
  }
}

let dir: string;
let project: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-title-resume-"));
  initProject(dir, testHome());
  project = openProject(dir, { baseDir: testHome() });
  project.runtime.insert("t", 1000);
  project.runtime.beginTask("t", "h", 1000);
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

function engineFor(prompt: CountingPrompt, persistence = project.events.recorder("t")): WorkflowEngine {
  return new WorkflowEngine({ bundle: bundle(), registry: newCapabilityRegistry<WorkflowMetrics>(), prompt, validator: new SchemaValidator(), persistence });
}

const titlesJournaled = (): number =>
  project.events.list("t").filter(({ event }) => event.type === "value.settled" && (event as Extract<EngineEvent, { type: "value.settled" }>).field === "title").length;

describe("resuming a titled instance", () => {
  it("hands the settled title back as a field, and the continuing run never asks for it again", async () => {
    // The first attempt settles its title, then dies in its own operation with nothing to handle it.
    const first = new CountingPrompt(true);
    const failed = await engineFor(first).run({ inputs: { issue: "the docs" } });
    expect(failed.outcome).toBe("error");
    expect(first.models).toEqual(["titler", "fast"]);
    expect(titlesJournaled()).toBe(1);

    const load = buildTaskLoad(project, "t", bundle().states);
    expect(load.blocked).toBeUndefined();
    expect(load.unreadable).toEqual([]);
    expect(load.loaded?.live).toBe(true);
    expect(load.loaded?.fields?.title).toBe("Ship: the docs");
    releaseRevivedFailures(project, load);

    // The retry: the model the title chose is used, and the title prompt is not paid for twice.
    const retry = new CountingPrompt();
    const result = await engineFor(retry).loadRun(load.loaded!);
    expect(result.outcome).toBe("success");
    expect(retry.models).toEqual(["fast"]);
    expect(result.outputs?.done).toBe("fast");
    expect(titlesJournaled()).toBe(1);
  });

  it("asks for the title again when the description does not carry it — the control", async () => {
    await engineFor(new CountingPrompt(true)).run({ inputs: { issue: "the docs" } });
    const load = buildTaskLoad(project, "t", bundle().states);
    const strip = (node: LoadedInstance): LoadedInstance => {
      const { fields: _fields, ...rest } = node;
      return { ...rest, ...(node.children !== undefined ? { children: node.children.map(strip) } : {}) };
    };
    const retry = new CountingPrompt();
    // Its own in-memory journal, so the control neither reads nor writes the project's.
    const result = await engineFor(retry, { record: () => {} }).loadRun(strip(load.loaded!));
    expect(result.outcome).toBe("success");
    expect(retry.models).toEqual(["titler", "fast"]);
  });
});
