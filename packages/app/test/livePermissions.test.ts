/**
 * A permission set picked in the composer while the conversation answers reaches what is answering
 * (`chat:settings`) — the person, 2026-10-24: "changing the permissions from auto to full still isnt
 * taking immediate affect. tool calls are still going through auto even after changing to full".
 *
 * What a call is then DECIDED under is proved where the deciding is — the gate and the wrapped tools in
 * `@declarative-ai/permissions`, the engine's `permissionsOf`, `gateTools` — and with a real agent by
 * `shots/permission-switch.mts`. A scripted agent makes no calls, so this proves the plumbing: a run
 * holds its set where a change finds it — a conversation of one prompt's run (its opening message, which
 * is the whole of it: `jsonConversation`), and a PROGRAM conversation's run (decision 0029 §2: the
 * shipped `session`, whose reply to every message is a call of the run, for as long as it goes on) — the
 * change is read the way a message's settings are, and nothing is held once the run ends.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import type { FakeRule } from "@jaira/runtime";
import type { PermissionSet, PermissionSetDecl, PushMessage } from "@jaira/shared";
import { eventually, jsonConversation, shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";
import { CHAT_SESSION, titleOf } from "../src/renderer/chatWorkflow";

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "builtin", "permission-sets");
const preset = (name: string): PermissionSetDecl => JSON.parse(readFileSync(join(SHIPPED, `${name}.json`), "utf8")) as PermissionSetDecl;

let dir: string;
let workflowsDir: string;
let service: AppService;
let pushes: PushMessage[];
/** Told every push as it is published — inside the call that publishes it, so mid-reply. */
let onPush: ((m: PushMessage) => void) | undefined;

beforeEach(async () => {
  // The shipped `session` is the program conversation; a test about a conversation of one prompt writes
  // its own over it (`oneShot`).
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-live-permissions-"));
  workflowsDir = initProject(dir, testHome()).workflowsDir;
  pushes = [];
  onPush = undefined;
  service = new AppService({
    baseDir: testHome(),
    publish: (m) => {
      pushes.push(m);
      onPush?.(m);
    },
  });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

const finished = (taskId: string): boolean => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId);

type Session = {
  livePermissions: Map<string, Set<{ permissionSet: PermissionSet | undefined; stack?: { layers: Array<{ id: string }> } }>>;
  hub: { list(): Array<{ component: string; taskId?: string }> };
  project: { db: { prepare: (sql: string) => { all: (...a: unknown[]) => Array<{ request_json: string; result_json: string | null }> } } };
};
const session = (): Session => [...(service as never as { sessions: Map<string, Session> }).sessions.values()][0]!;

function held(taskId: string): Array<PermissionSet | undefined> | undefined {
  const cells = session().livePermissions.get(taskId);
  return cells === undefined ? undefined : [...cells].map((cell) => cell.permissionSet);
}

/** A program conversation waiting at its `input()` for the next message. */
const parked = (taskId: string): boolean => session().hub.list().some((r) => r.component === "input" && r.taskId === taskId);

/** A conversation of ONE prompt, started on `message`: its run is the opening message, and ends with it. */
async function oneShot(message: string, overrides?: object): Promise<string> {
  jsonConversation(workflowsDir);
  const { taskId } = service.createTask({ title: titleOf(message), workflow: CHAT_SESSION, inputs: { message } });
  await service.startTask({ taskId, fake: [{ output: "answered" }], ...(overrides !== undefined ? { overrides } : {}) });
  await eventually(() => finished(taskId), "the opening run to finish", 8_000);
  return taskId;
}

/**
 * A PROGRAM conversation (the shipped `session`) that has answered `message` and waits for the next.
 * Every call it will make is scripted when it starts: `rules` first, so a later message's own rule wins.
 */
async function talking(message: string, rules: FakeRule[] = []): Promise<string> {
  const { taskId } = service.createTask({ title: titleOf(message), workflow: CHAT_SESSION, conversation: true, inputs: { message, improve: false } });
  await service.startTask({ taskId, fake: [...rules, { promptIncludes: message, output: "first answer" }] });
  await eventually(() => service.sessionHistory({ taskId }).length >= 1 && parked(taskId), "the first reply", 20_000);
  return taskId;
}

/** Send a program conversation `message`, and wait for its reply and for it to wait again. */
async function say(taskId: string, message: string, overrides?: object): Promise<void> {
  const replies = service.sessionHistory({ taskId }).length;
  await service.sendChatMessage({ taskId, instanceId: "", message, ...(overrides !== undefined ? { overrides } : {}) });
  await eventually(() => service.sessionHistory({ taskId }).length > replies && parked(taskId), `the reply to "${message}"`, 20_000);
}

/** When a call is dispatched — the conversation is answering — switch it to `decl`, and note what happened. */
function switchWhileAnswering(taskId: string, decl: PermissionSetDecl): { changed?: number; after?: Array<PermissionSet | undefined> } {
  const seen: { changed?: number; after?: Array<PermissionSet | undefined> } = {};
  onPush = (m) => {
    if (seen.changed !== undefined || m.type !== "engine:event" || m.taskId !== taskId) return;
    if ((m.event as { type?: string }).type !== "operation.dispatched") return;
    seen.changed = service.changeChatSettings({ taskId, overrides: { permissionSet: decl } }).changed;
    seen.after = held(taskId);
  };
  return seen;
}

describe("a permission set picked while a conversation of one prompt answers", () => {
  it("reaches the OPENING message, which is the run, and is let go of when it ends", async () => {
    jsonConversation(workflowsDir);
    const { taskId } = service.createTask({ title: titleOf("go"), workflow: CHAT_SESSION, inputs: { message: "go" } });
    const seen = switchWhileAnswering(taskId, preset("full"));
    await service.startTask({ taskId, overrides: { permissionSet: preset("auto") }, fake: [{ output: "done" }] });
    await eventually(() => finished(taskId), "the run to finish", 8_000);
    expect(seen.changed).toBe(1);
    expect(seen.after).toHaveLength(1);
    // Read the way a message's settings are: the shipped Full, every line allowed.
    expect(seen.after![0]!.entries["web_fetch"]?.mode).toBe("allow");
    expect(seen.after![0]!.other).toBe("allow");
    expect(held(taskId)).toBeUndefined();
  });

  it("changes nothing in flight once its one prompt is answered — nothing is answering, and the change is only kept", async () => {
    const taskId = await oneShot("one");
    expect(service.changeChatSettings({ taskId, overrides: { permissionSet: preset("full") } })).toEqual({ changed: 0 });
    expect(service.taskDetail(taskId).chatSettings).toEqual({ permissionSet: preset("full") });
  });
});

describe("a permission set picked while a program conversation answers (decision 0029 §2)", { timeout: 60_000 }, () => {
  it("reaches a LATER message, a call of the program's run, and the calls after it — let go of when the conversation ends", async () => {
    const taskId = await talking("one", [{ promptIncludes: "two", output: "second answer" }]);
    const seen = switchWhileAnswering(taskId, preset("full"));
    await say(taskId, "two", { permissionSet: preset("auto") });
    expect(seen.changed).toBe(1);
    expect(seen.after![0]!.entries["shell"]?.mode).toBe("allow");
    // Still the run's while it waits for the next message: that message's reply is decided under it too.
    expect(held(taskId)![0]!.entries["shell"]?.mode).toBe("allow");
    expect(await service.endConversation({ taskId })).toEqual({ ended: true });
    await eventually(() => finished(taskId), "the conversation to end", 20_000);
    expect(held(taskId)).toBeUndefined();
  });

  it("moves the STACK the rows name their layers by with the set, when a stack is picked mid-reply (decision 0023 §2.7)", async () => {
    const taskId = await talking("one", [{ promptIncludes: "two", output: "second answer" }]);
    const stacks: unknown[] = [];
    onPush = (m) => {
      if (stacks.length > 0 || m.type !== "engine:event" || m.taskId !== taskId || (m.event as { type?: string }).type !== "operation.dispatched") return;
      service.changeChatSettings({ taskId, overrides: { permissionSet: { layers: ["$/permission-sets/full"], web_search: "unavailable" } as never } });
      stacks.push(...[...(session().livePermissions.get(taskId) ?? [])].map((cell) => cell.stack?.layers.map((layer) => layer.id)));
    };
    await say(taskId, "two", { permissionSet: { layers: ["$/permission-sets/auto"] } as never });
    // `full` stands on the security profile it names (`security/guarded`, 2026-11-25), its layer under it.
    expect(stacks).toEqual([["security/guarded", "full", "tools"]]);
  });
});

/**
 * The composer opens on what the conversation was left at (the person, 2026-10-05: "I start a
 * conversation and then change the permission set to chat/smart then I switch to a different
 * conversation where the composer correctly switches to chat/ask and then I switch back to this current
 * conversation the composer should switch back to chat/smart"; 2026-10-24: all four chips, sent or not).
 * What a composer opens with is the detail's `chatSettings`.
 */
describe("a conversation keeps what its composer was left at", { timeout: 60_000 }, () => {
  it("keeps a change made after it answered, unsent, on that conversation alone — and a reset gives it back", async () => {
    const one = await oneShot("one");
    const two = await oneShot("two");
    const picked = { model: "fake/chosen", reasoning: { effort: "high" }, permissionSet: preset("auto") } as const;
    service.changeChatSettings({ taskId: one, overrides: picked as never });
    expect(service.taskDetail(one).chatSettings).toEqual(picked);
    // The other conversation opens on its own — nothing picked there.
    expect(service.taskDetail(two).chatSettings).toBeUndefined();
    // Saying the same thing again moves nothing; a reset of every chip leaves nothing kept.
    const writes = pushes.filter((m) => m.type === "store:invalidate" && (m as { taskId?: string }).taskId === one).length;
    service.changeChatSettings({ taskId: one, overrides: picked as never });
    expect(pushes.filter((m) => m.type === "store:invalidate" && (m as { taskId?: string }).taskId === one).length).toBe(writes);
    service.changeChatSettings({ taskId: one, overrides: {} });
    expect(service.taskDetail(one).chatSettings).toBeUndefined();
  });

  it("sends a message sent with LESS than the conversation keeps with what it keeps (2026-11-09)", async () => {
    // A composer that has not read the conversation's settings yet sends `{}`; the message must not go
    // without the stack the conversation keeps.
    const taskId = await talking("one", [
      { promptIncludes: "two", output: "second answer" },
      { promptIncludes: "three", output: "third answer" },
    ]);
    const kept = { permissionSet: { layers: ["$/permission-sets/read-only"] } };
    service.changeChatSettings({ taskId, overrides: kept as never });
    await say(taskId, "two", {});
    // What a message names still wins over what is kept.
    await say(taskId, "three", { model: "fake/chosen" });
    // What each message was sent with: the answer its `input()` took.
    const sent = session()
      .project.db.prepare(`SELECT request_json, result_json FROM operation_records WHERE task_id = ? ORDER BY started_at`)
      .all(taskId)
      .filter((row) => (JSON.parse(row.request_json) as { functionRef?: string }).functionRef === "input" && row.result_json !== null)
      .map((row) => (JSON.parse(row.result_json!) as { value?: { settings?: unknown } }).value?.settings);
    expect(sent).toEqual([kept, { ...kept, model: "fake/chosen" }]);
    // And the reply was decided under the stack kept: read-only, over the security profile it stands on.
    expect([...(session().livePermissions.get(taskId) ?? [])].map((cell) => cell.stack?.layers.map((layer) => layer.id))).toEqual([["security/guarded", "read-only"]]);
  });

  it("keeps a conversation pinned to a set by its name from before the move on that set, renamed, when its stack is cleared (2026-11-09)", async () => {
    // A pin made before the presets left `chat/`: the state named its set by the old reference, and the
    // set was there. Planted after the move ran at open, as the files stood before it.
    const old = ["$/permission-sets/", "ch", "at/ask-first"].join("");
    const jaira = join(dir, ".jaira");
    mkdirSync(join(jaira, "permission-sets", "ch" + "at"), { recursive: true });
    writeFileSync(join(jaira, "permission-sets", "ch" + "at", "ask-first.json"), JSON.stringify({ $ref: "$SYSTEM/permission-sets/ask-first" }));
    // A conversation of one prompt (`jsonConversation`), naming its set the old way.
    jsonConversation(workflowsDir);
    const own = JSON.parse(readFileSync(join(jaira, "workflows", "session.json"), "utf8")) as { operation: Record<string, unknown> };
    writeFileSync(join(jaira, "workflows", "session.json"), JSON.stringify({ ...own, operation: { ...own.operation, tools: old } }));
    const { taskId } = service.createTask({ title: titleOf("one"), workflow: CHAT_SESSION, inputs: { message: "one" } });
    await service.startTask({ taskId, fake: [{ output: "answered" }] });
    await eventually(() => finished(taskId), "the opening run to finish", 8_000);
    const pinned = readdirSync(join(jaira, "system", "snapshots"), { recursive: true }).filter((file) => String(file).endsWith("session.json")).map((file) => readFileSync(join(jaira, "system", "snapshots", String(file)), "utf8"));
    expect(pinned.some((text) => text.includes(old))).toBe(true);
    // The move, done: the old file is gone, the pin is frozen with the old name in it.
    rmSync(join(jaira, "permission-sets", "ch" + "at"), { recursive: true });
    rmSync(join(jaira, "workflows", "session.json"));
    // Its composer reads the set renamed as its stack, not the old name off the pin — which matches no
    // file, so it would draw no layer and a layer laid on it would build a stack that offers nothing.
    const instanceId = service.chatThread({ taskId })!.instanceId;
    expect(service.chatPlan({ taskId, instanceId, overrides: {} })?.settings.permissionSet).toEqual({ layers: ["$/permission-sets/ask-first"] });
    // What the composer picked is its own.
    expect(service.chatPlan({ taskId, instanceId, overrides: { permissionSet: { layers: ["$/permission-sets/full"] } as never } })?.settings.permissionSet).toEqual({ layers: ["$/permission-sets/full"] });
    // A chip changed on a composer that kept no stack: the conversation is given the set, renamed —
    // its composer would otherwise read the old name off the pin, a set that matches no file.
    service.changeChatSettings({ taskId, overrides: { model: "fake/chosen" } });
    expect(service.taskDetail(taskId).chatSettings).toEqual({ model: "fake/chosen", permissionSet: { layers: ["$/permission-sets/ask-first"] } });
  });

  it("keeps what a conversation was STARTED with as its own", async () => {
    const taskId = await oneShot("go", { permissionSet: preset("full") });
    expect(service.taskDetail(taskId).chatSettings).toEqual({ permissionSet: preset("full") });
  });

  it("hands what it was left at to a fork, and the settings the fork's message was sent with are the fork's", async () => {
    // The forks are scripted too: a fork resumes the program, and a message to it is answered.
    const script: FakeRule[] = [
      { promptIncludes: "two, differently", output: "another" },
      { promptIncludes: "two", output: "second answer" },
    ];
    const taskId = await talking("one", script);
    await say(taskId, "two");
    service.changeChatSettings({ taskId, overrides: { permissionSet: preset("auto") } });
    // The one hand-typed message's point — the opening message is the run's own.
    const at = service.chatThread({ taskId })!.points[0]!.seq!;
    // Forked by a rewind's "start again from here" with no message: the copy is the same conversation.
    const copied = await service.forkTask({ taskId, at, fake: script as never });
    expect(service.taskDetail(copied.taskId).chatSettings).toEqual({ permissionSet: preset("auto") });
    // Forked WITH a message: the composer that sent it is the new conversation's.
    const sent = await service.forkTask({ taskId, at, message: "two, differently", overrides: { permissionSet: preset("full") }, fake: script as never });
    expect(service.taskDetail(sent.taskId).chatSettings).toEqual({ permissionSet: preset("full") });
  });
});
