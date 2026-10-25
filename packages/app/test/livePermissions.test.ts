/**
 * A permission set picked in the composer while the conversation answers reaches what is answering
 * (`chat:settings`) — the person, 2026-10-24: "changing the permissions from auto to full still isnt
 * taking immediate affect. tool calls are still going through auto even after changing to full".
 *
 * What a call is then DECIDED under is proved where the deciding is — the gate and the wrapped tools in
 * `@declarative-ai/permissions`, the engine's `permissionsOf`, `gateTools` — and with a real agent by
 * `shots/permission-switch.mts`. A scripted agent makes no calls, so this proves the plumbing: the
 * opening message (a run) and a later one (a chat turn) each hold their set where a change finds it,
 * the change is read the way a message's settings are, and nothing is held once they end.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import type { PermissionSet, PermissionSetDecl, PushMessage } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";
import { CHAT_SESSION, titleOf } from "../src/renderer/chatWorkflow";

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "builtin", "permission-sets", "chat");
const preset = (name: string): PermissionSetDecl => JSON.parse(readFileSync(join(SHIPPED, `${name}.json`), "utf8")) as PermissionSetDecl;

let dir: string;
let service: AppService;
let pushes: PushMessage[];
/** Told every push as it is published — inside the call that publishes it, so mid-turn. */
let onPush: ((m: PushMessage) => void) | undefined;

beforeEach(async () => {
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-live-permissions-"));
  initProject(dir, testHome());
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

async function until(predicate: () => boolean, label: string, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function held(taskId: string): Array<PermissionSet | undefined> | undefined {
  const sessions = (service as never as { sessions: Map<string, { livePermissions: Map<string, Set<{ permissionSet: PermissionSet | undefined }>> }> }).sessions;
  const cells = [...sessions.values()][0]!.livePermissions.get(taskId);
  return cells === undefined ? undefined : [...cells].map((cell) => cell.permissionSet);
}

/** When the call is dispatched — the turn or run is answering — switch it to `decl`, and note what happened. */
function switchWhileAnswering(taskId: string, decl: PermissionSetDecl): { changed?: number; after?: Array<PermissionSet | undefined> } {
  const seen: { changed?: number; after?: Array<PermissionSet | undefined> } = {};
  onPush = (m) => {
    if (seen.changed !== undefined || m.type !== "engine:event" || m.taskId !== taskId) return;
    // A run's call is `dispatched`; a chat turn's journal says `started`.
    const type = (m.event as { type?: string }).type;
    if (type !== "operation.dispatched" && type !== "operation.started") return;
    seen.changed = service.changeChatSettings({ taskId, overrides: { permissionSet: decl } }).changed;
    seen.after = held(taskId);
  };
  return seen;
}

describe("a permission set picked while the conversation answers", () => {
  it("reaches the OPENING message, which is the run, and is let go of when it ends", async () => {
    const { taskId } = service.createTask({ title: titleOf("go"), workflow: CHAT_SESSION, inputs: { message: "go" } });
    const seen = switchWhileAnswering(taskId, preset("full"));
    await service.startTask({ taskId, overrides: { permissionSet: preset("auto") }, fake: [{ output: "done" }] });
    await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the run to finish");
    expect(seen.changed).toBe(1);
    expect(seen.after).toHaveLength(1);
    // Read the way a message's settings are: the shipped Full, every line allowed.
    expect(seen.after![0]!.entries["web_fetch"]?.mode).toBe("allow");
    expect(seen.after![0]!.other).toBe("allow");
    expect(held(taskId)).toBeUndefined();
  });

  it("reaches a LATER message, which is a chat turn, and is let go of when it ends", async () => {
    const { taskId } = service.createTask({ title: titleOf("one"), workflow: CHAT_SESSION, inputs: { message: "one" } });
    await service.startTask({ taskId, fake: [{ output: "first answer" }] });
    await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the opening run to finish");
    const thread = service.chatThread({ taskId })!;
    const seen = switchWhileAnswering(taskId, preset("full"));
    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "two", overrides: { permissionSet: preset("auto") }, fake: [{ output: "second answer" }] });
    expect(seen.changed).toBe(1);
    expect(seen.after![0]!.entries["shell"]?.mode).toBe("allow");
    expect(held(taskId)).toBeUndefined();
  });

  it("changes nothing in flight when nothing is answering — the next message carries the composer's settings", async () => {
    const { taskId } = service.createTask({ title: titleOf("one"), workflow: CHAT_SESSION, inputs: { message: "one" } });
    await service.startTask({ taskId, fake: [{ output: "first answer" }] });
    await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the opening run to finish");
    expect(service.changeChatSettings({ taskId, overrides: { permissionSet: preset("full") } })).toEqual({ changed: 0 });
  });
});

/**
 * The composer opens on what the conversation was left at (the person, 2026-10-05: "I start a
 * conversation and then change the permission set to chat/smart then I switch to a different
 * conversation where the composer correctly switches to chat/ask and then I switch back to this current
 * conversation the composer should switch back to chat/smart"; 2026-10-24: all four chips, sent or not).
 * What a composer opens with is the detail's `chatSettings`.
 */
describe("a conversation keeps what its composer was left at", () => {
  const started = async (message: string, overrides?: object): Promise<string> => {
    const { taskId } = service.createTask({ title: titleOf(message), workflow: CHAT_SESSION, inputs: { message } });
    await service.startTask({ taskId, fake: [{ output: "answered" }], ...(overrides !== undefined ? { overrides } : {}) });
    await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the opening run to finish");
    return taskId;
  };

  it("keeps a change made after it answered, unsent, on that conversation alone — and a reset gives it back", async () => {
    const one = await started("one");
    const two = await started("two");
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

  it("keeps what a conversation was STARTED with as its own", async () => {
    const taskId = await started("go", { permissionSet: preset("full") });
    expect(service.taskDetail(taskId).chatSettings).toEqual({ permissionSet: preset("full") });
  });

  it("hands what it was left at to a fork, and the settings the fork's message was sent with are the fork's", async () => {
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "two", fake: [{ output: "second answer" }] });
    service.changeChatSettings({ taskId, overrides: { permissionSet: preset("auto") } });
    // The one hand-typed message's point — the run's own prompt has none.
    const at = service.chatThread({ taskId })!.points[0]!.seq!;
    // Forked by a rewind's "start again from here" with no message: the copy is the same conversation.
    const copied = await service.forkTask({ taskId, at });
    expect(service.taskDetail(copied.taskId).chatSettings).toEqual({ permissionSet: preset("auto") });
    // Forked WITH a message: the composer that sent it is the new conversation's.
    const sent = await service.forkTask({ taskId, at, message: "two, differently", overrides: { permissionSet: preset("full") }, fake: [{ output: "another" }] });
    expect(service.taskDetail(sent.taskId).chatSettings).toEqual({ permissionSet: preset("full") });
  });
});
