/**
 * Remotes in a CLI run (decision 0004): what `wireRemotes` adds to a durable run's registry.
 *
 * Driven directly rather than through the binary, because the forge has to be fixtures and a
 * subprocess cannot be handed a transport. Git is real and local (`remoteRig.ts`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostFunction, type FunctionInputs, type JsonValue } from "@declarative-ai/exec";
import { initProject, openProject, type Project } from "@jaira/persistence";
import { INTERACTIVE, NodeExec, REMOTE_FUNCTIONS, REVIEW_ARTIFACTS, newRegistry } from "@jaira/runtime";
import type { Changeset } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { wireRemotes } from "../src/remoteWiring";
import { replayForge, type Replay } from "../../runtime/test/forgeReplay";
import { buildRig, type Rig } from "../../runtime/test/remoteRig";

vi.setConfig({ testTimeout: 90_000 });

let rig: Rig;
let replay: Replay;
let project: Project;
let logged: string[];
let wired: { dispose(): void } | undefined;

function open(policy: Record<string, unknown> = { remote: { publish: "allow" } }): void {
  const home = testHome();
  const paths = initProject(rig.work, home);
  const settings = JSON.parse(readFileSync(paths.settingsFile, "utf8")) as Record<string, unknown>;
  writeFileSync(paths.settingsFile, JSON.stringify({ ...settings, policy }, null, 2));
  mkdirSync(join(rig.work, ".jaira"), { recursive: true });
  writeFileSync(join(rig.work, ".jaira", ".env.local"), 'GITLAB_TOKEN="good"\n');
  project = openProject(rig.work, { baseDir: home });
}

beforeEach(() => {
  rig = buildRig();
  replay = replayForge();
  logged = [];
});
afterEach(() => {
  wired?.dispose();
  wired = undefined;
  project?.close();
  rig.dispose();
});

function wire(registry = newRegistry(), extra: { scripted?: boolean } = {}) {
  wired = wireRemotes(registry, {
    project,
    taskId: "t-1",
    taskTitle: "Review the implementation",
    workspace: { root: rig.work, isWorktree: false },
    exec: new NodeExec(),
    scripted: extra.scripted ?? true,
    http: replay.http,
    log: (message) => logged.push(message),
  });
  const call = async (name: string, inputs: Record<string, unknown> = {}) => {
    const result = (await registry.functions.get(name)!.impl(inputs as FunctionInputs, { workspace: { root: rig.work } } as never)) as { value?: Record<string, JsonValue>; error?: { reason?: string } };
    return { value: result.value, error: result.error?.reason };
  };
  return { registry, call };
}

const changeset = (): Changeset => ({
  source: `git:${rig.git(rig.work, "rev-parse", "main")}`,
  changes: [{ id: "c1", path: "app.txt", action: "update", before: "one\ntwo\nthree\n", after: "one\ntwo, revised\nthree\n" }],
});

describe("a durable CLI run", () => {
  it("has the five primitives and on_remote_event, as the app's runs do", () => {
    open();
    const { registry } = wire();
    for (const name of [...REMOTE_FUNCTIONS, "on_remote_event"]) expect(registry.functions.has(name), name).toBe(true);
  });

  it("refuses to publish with a sentence when it would have to ask and no terminal is attached", async () => {
    open({});
    const { call } = wire();
    expect((await call("remote_push")).error).toMatch(/needs a person's say-so and nobody can be asked/);
    expect(rig.git(rig.bare, "branch", "--format=%(refname:short)")).toBe("main");
  });

  it("pushes and opens under a policy that allows it, and remembers the request on the task", async () => {
    open();
    const { call } = wire();
    await call("remote_push");
    const opened = await call("remote_open");
    expect(opened.value!["remote"]).toMatchObject({ number: 7430, branch: "jaira/t-1/review" });
    expect(project.remotes.get("t-1", "review")).toMatchObject({ number: 7430 });
  });
});

describe("the gate's second door at a terminal", () => {
  it("races the forge against the prompt, and WITHDRAWS a prompt the forge beat", async () => {
    open();
    const registry = newRegistry();
    let withdrawn = false;
    // A reviewer nobody answers — a person who went to lunch — that honours the abort it is handed.
    registry.functions.set(
      REVIEW_ARTIFACTS,
      hostFunction(
        (_inputs: FunctionInputs, ctx: { abortSignal?: AbortSignal } | undefined) =>
          new Promise((_resolve, reject) => {
            ctx?.abortSignal?.addEventListener("abort", () => {
              withdrawn = true;
              reject(new Error("withdrawn"));
            });
          }),
        INTERACTIVE,
      ),
    );
    const { call } = wire(registry);
    const result = await call(REVIEW_ARTIFACTS, { prompt: "Review the implementation", options: ["approve", "revise", "cut"], remote: { to: "origin", target: "main" }, changeset: changeset() });
    // The fixture's request is merged: the forge answered first, through the run's own watcher.
    expect(result.value).toMatchObject({ decision: "approve", settled_by: { via: "remote", who: "mara", act: "merged", effect: "adopt" }, decisions: [{ id: "c1", decision: "merged" }] });
    expect(withdrawn).toBe(true);
    expect(project.remotes.get("t-1", "review")).toMatchObject({ awaiting: false });
  });

  it("lets the person win when they answer first, and tells the forge once what was decided", async () => {
    open();
    const registry = newRegistry();
    registry.functions.set(
      REVIEW_ARTIFACTS,
      hostFunction(async () => ({ value: { decision: "revise", decisions: [{ id: "c1", decision: "comment", comment: "Say what was revised." }] } as never }), INTERACTIVE),
    );
    // The forge's read never comes back, so only the terminal can answer.
    const held = replay.http;
    replay.http = async (request) => (request.method === "GET" && /\/merge_requests\/7430(\/|$)/.test(new URL(request.url).pathname) ? new Promise(() => undefined) : held(request));
    const { call } = wire(registry);
    const result = await call(REVIEW_ARTIFACTS, { prompt: "Review the implementation", options: ["approve", "revise", "cut"], remote: { to: "origin", target: "main" }, changeset: changeset() });
    expect(result.value).toMatchObject({ decision: "revise", settled_by: { via: "local", who: "Test Author" }, remote: { number: 7430 } });
    const notes = replay.seen.filter((r) => r.method === "POST" && r.url.endsWith("/7430/notes")).map((r) => (r.body as { body: string }).body);
    expect(notes).toEqual(["`app.txt` — Say what was revised.", "Decided in JaiRA by Test Author: **revise** (1 comment)."]);
  });

  it("is the plain gate when the state names no remote", async () => {
    open();
    const registry = newRegistry();
    registry.functions.set(REVIEW_ARTIFACTS, hostFunction(async () => ({ value: { decisions: [{ id: "c1", decision: "merged" }] } as never }), INTERACTIVE));
    const { call } = wire(registry);
    expect((await call(REVIEW_ARTIFACTS, { prompt: "Review", changeset: changeset() })).value).toEqual({ decisions: [{ id: "c1", decision: "merged" }] });
    expect(replay.seen).toEqual([]);
  });
});
