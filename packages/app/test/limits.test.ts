/**
 * The limits board in the app, and messages and runs waiting for an account's allowance.
 *
 * The board is remembered across a restart and says who each account is. The waiting queue keeps a
 * message or a run until its account's reset — sent or resumed then, or at once when asked, remembered
 * across a restart until then, and dropped when something else has answered it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LimitReading, PushMessage, WaitingItem } from "@jaira/shared";
import { LimitsService } from "@jaira/service/limits";
import { WaitingQueue, type WaitingHost } from "@jaira/service/waiting";
import { LiveTurnLog } from "@jaira/service/liveTurns";
import { initProject, type Project } from "@jaira/persistence";
import type { FakeRule } from "@jaira/runtime";
import { eventually, shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";

const spent = (resets = new Date(Date.now() + 3_600_000).toISOString()): LimitReading => ({
  route: "claude-cli",
  plan: "max",
  windows: [{ id: "five_hour", label: "5-hour", minutes: 300, usedPercent: 100, resetsAt: resets, status: "exhausted" }],
  status: "exhausted",
  source: "stream",
  at: new Date().toISOString(),
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-limits-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the board in the app", () => {
  it("remembers what it knew across a restart, and says who each account is", async () => {
    const file = join(dir, "limits.json");
    const pushes: PushMessage[] = [];
    const options = {
      file,
      publish: (m: PushMessage) => void pushes.push(m),
      claudeCommand: () => undefined,
      probes: () => [{ name: "claude-cli", accounts: [{ label: "me@example.com", plan: "max", active: true }] }],
      routes: () => ["claude-cli", "codex-cli", "anthropic"],
      refresh: false,
    };
    const first = new LimitsService(options);
    first.board.report("claude", spent());
    first.close(); // writes what it holds
    const second = new LimitsService(options);
    const view = second.view();
    const claude = view.accounts.find((a) => a.key === "claude")!;
    expect(claude.reading?.windows[0]?.id).toBe("five_hour");
    expect(claude.who).toBe("me@example.com");
    expect(claude.routes).toEqual(["claude-cli"]);
    expect(view.routeAccounts).toEqual({ "claude-cli": "claude", "codex-cli": "codex", anthropic: "anthropic" });
    expect(view.accounts.map((a) => a.key)).toContain("codex");
    second.close();
  });

  it("reads an account at once when its login is new, and not again for one it has seen, across a restart too", async () => {
    const file = join(dir, "limits.json");
    let who: string | undefined;
    const options = {
      file,
      publish: () => undefined,
      claudeCommand: () => undefined,
      probes: () => [{ name: "claude-cli", ...(who !== undefined ? { accounts: [{ label: who, active: true }] } : {}) }],
      routes: () => ["claude-cli"],
      refresh: false,
    };
    const asked: string[] = [];
    const offer = (s: LimitsService): void => void s.board.offerRefresh("claude", async () => (asked.push(who ?? "-"), spent()));
    const first = new LimitsService(options);
    offer(first);
    first.noticeAccounts(); // nobody signed in: nothing to read
    who = "me@example.com";
    first.noticeAccounts();
    first.noticeAccounts(); // the same login again
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual(["me@example.com"]);
    expect(first.board.state("claude").reading?.windows[0]?.id).toBe("five_hour");
    first.close();

    const second = new LimitsService(options);
    offer(second);
    second.noticeAccounts(); // seen before the restart
    who = "you@example.com";
    second.noticeAccounts(); // somebody else's login
    await new Promise((r) => setTimeout(r, 0)); // one refresh at a time: a second joins the first
    second.signedIn("claude"); // the same login signed in again is read again
    second.noticeAccounts();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual(["me@example.com", "you@example.com", "you@example.com"]);
    second.close();
  });

  it("tells the renderer when anything changes", async () => {
    const pushes: PushMessage[] = [];
    const service = new LimitsService({ file: join(dir, "l.json"), publish: (m) => void pushes.push(m), claudeCommand: () => undefined, probes: () => [], routes: () => [], refresh: false });
    service.board.report("claude", spent());
    await new Promise((r) => setTimeout(r, 150));
    expect(pushes.some((m) => m.type === "limits:changed")).toBe(true);
    service.close();
  });
});

describe("the waiting queue", () => {
  const host = (overrides: Partial<WaitingHost> = {}): WaitingHost & { sent: WaitingItem[]; resumed: WaitingItem[] } => {
    const sent: WaitingItem[] = [];
    const resumed: WaitingItem[] = [];
    return {
      sent,
      resumed,
      sendMessage: async (item) => void sent.push(item),
      resumeRun: async (item) => void resumed.push(item),
      stillSpentUntil: async () => null,
      changed: () => undefined,
      ...overrides,
    };
  };

  it("sends a waiting message when its time comes, and remembers it across a restart until then", async () => {
    const file = join(dir, "waiting.json");
    const h = host();
    const q = new WaitingQueue(file, h);
    q.add({ kind: "message", project: dir, taskId: "t1", instanceId: "i1", message: "hi", account: "claude", until: new Date(Date.now() + 3_600_000).toISOString(), state: "waiting", retry: true });
    q.close();
    const again = new WaitingQueue(file, h);
    expect(again.list()).toHaveLength(1);
    const [item] = again.list();
    await again.act(item!.id, "sendNow");
    expect(h.sent.map((i) => i.message)).toEqual(["hi"]);
    expect(again.list()).toHaveLength(0);
    again.close();
  });

  it("does not arm a refused item whose box is unchecked, and turning it on arms it", async () => {
    const h = host();
    const q = new WaitingQueue(join(dir, "w.json"), h);
    const item = q.add({ kind: "run", project: dir, taskId: "t1", account: "claude", until: new Date(Date.now() - 20_000).toISOString(), state: "refused", retry: false });
    await new Promise((r) => setTimeout(r, 1_200));
    expect(h.resumed).toHaveLength(0);
    await q.act(item.id, "retry", true);
    await new Promise((r) => setTimeout(r, 1_300));
    expect(h.resumed.map((i) => i.taskId)).toEqual(["t1"]);
    q.close();
  });

  it("waits for the later reset when the account is still spent at the old one", async () => {
    const later = new Date(Date.now() + 7_200_000).toISOString();
    const h = host({ stillSpentUntil: async () => later });
    const q = new WaitingQueue(join(dir, "w2.json"), h);
    q.add({ kind: "message", project: dir, taskId: "t1", instanceId: "i1", message: "hi", account: "claude", until: new Date(Date.now() - 20_000).toISOString(), state: "waiting", retry: true });
    await new Promise((r) => setTimeout(r, 1_300));
    expect(h.sent).toHaveLength(0);
    expect(q.list()[0]!.until).toBe(later);
    q.close();
  });

  it("drops what a run starting again answers", () => {
    const q = new WaitingQueue(join(dir, "w3.json"), host());
    q.add({ kind: "run", project: dir, taskId: "t1", account: "claude", until: null, state: "refused", retry: true });
    q.add({ kind: "message", project: dir, taskId: "t1", instanceId: "i", message: "m", account: "claude", until: null, state: "waiting", retry: true });
    q.dropWhere((i) => i.kind === "run" && i.taskId === "t1");
    expect(q.list().map((i) => i.kind)).toEqual(["message"]);
    q.close();
  });
});

describe("a message to a conversation whose account is spent (decision 0029 §2)", { timeout: 60_000 }, () => {
  let project: string;
  let service: AppService;
  beforeEach(async () => {
    shippedLayer();
    project = mkdtempSync(join(tmpdir(), "jaira-hold-"));
    initProject(project, testHome());
    service = new AppService({ baseDir: testHome(), publish: () => undefined });
    await service.open(project);
  });
  afterEach(async () => {
    for (const item of service.listWaiting()) await service.actOnWaiting({ id: item.id, action: "drop" });
    await service.close();
    rmSync(project, { recursive: true, force: true });
  });

  const MODEL = "claude-cli/claude-sonnet-5";
  const open = (): Project => (service as unknown as { session(): { project: Project } }).session().project;
  const parked = (taskId: string): boolean =>
    (service as unknown as { session(): { hub: { list(): Array<{ component: string; taskId?: string }> } } }).session().hub.list().some((r) => r.component === "input" && r.taskId === taskId);
  const said = (taskId: string): string[] => (service.chatThread({ taskId })?.session.turns ?? []).map((t) => `${t.role}: ${t.text ?? ""}`);
  /** The shipped conversation, opened with "one" under `rules` — its reply in, and waiting for the next message. */
  async function talking(rules: FakeRule[]): Promise<string> {
    const { taskId } = service.createTask({ title: "one", workflow: "session", conversation: true, inputs: { message: "one", improve: false } });
    await service.startTask({ taskId, fake: rules as never });
    await eventually(() => said(taskId).length >= 2 && parked(taskId), "the opening reply", 20_000);
    return taskId;
  }

  it("waits for the reset instead of being sent, and deleting it cancels it", async () => {
    const taskId = await talking([{ promptIncludes: "one", output: "first answer" }, { promptIncludes: "carry on", output: "carried on" }]);
    service.limits.board.report("claude", spent());
    const sent = await service.sendChatMessage({ taskId, instanceId: "", message: "carry on", overrides: { model: MODEL } });

    expect(sent.waiting).toMatchObject({ kind: "message", state: "waiting", account: "claude", message: "carry on", retry: true });
    expect(sent.failure).toBeUndefined();
    // Nothing was sent: the conversation still waits for it, and says what it said.
    expect(parked(taskId)).toBe(true);
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer"]);
    expect(service.listWaiting({ taskId })).toHaveLength(1);

    await service.actOnWaiting({ id: sent.waiting!.id, action: "drop" });
    expect(service.listWaiting({ taskId })).toHaveLength(0);
  });

  it("is kept with 'Try again at …' when its reply is refused — and trying again answers the same wait, not a second copy", async () => {
    const taskId = await talking([
      { promptIncludes: "one", output: "first answer" },
      { promptIncludes: "two", error: "you have used up your allowance", code: "usage_limit" },
    ]);
    await service.sendChatMessage({ taskId, instanceId: "", message: "two" });
    // The program caught it and waits for the next message; the message is kept, refused.
    await eventually(() => service.listWaiting({ taskId }).length === 1 && parked(taskId), "the refused message to be kept", 20_000);
    const [refused] = service.listWaiting({ taskId });
    expect(refused).toMatchObject({ kind: "message", state: "refused", account: "claude", message: "two", reason: "you have used up your allowance" });
    expect(refused!.branchAt).toBeDefined();
    expect(open().runtime.get(taskId)?.status).toBe("running");

    // The allowance is back: the same message goes again, at its own place.
    const task = open().tasks.read(taskId);
    open().tasks.write({ ...task, scripted: [{ promptIncludes: "one", output: "first answer" }, { promptIncludes: "two", output: "second answer" }] as never });
    await service.actOnWaiting({ id: refused!.id, action: "sendNow" });
    await eventually(() => said(taskId).includes("assistant: second answer") && parked(taskId), "the reply to 'two'", 20_000);
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: two", "assistant: second answer"]);
    expect(service.listWaiting({ taskId })).toEqual([]);
  });
});

describe("a context reading on the live turn", () => {
  it("lands on the last answer instead of becoming a row, and a limits reading is dropped", () => {
    const log = new LiveTurnLog();
    log.apply("t", { session: { id: "s", seq: 0 }, at: 1, entry: { kind: "message", role: "assistant", content: [{ type: "text", text: "done" }] } });
    const r1 = log.apply("t", { session: { id: "s", seq: 0 }, at: 2, entry: { kind: "event", event: { type: "context", reading: { used: 900, window: 200000, model: "m", at: "t" } } } });
    const r2 = log.apply("t", { session: { id: "s", seq: 0 }, at: 3, entry: { kind: "event", event: { type: "limits", reading: spent() as never } } });
    expect(r1.entry).toBeUndefined();
    expect(r2.entry).toBeUndefined();
    const entries = log.snapshot("t")!.entries as Array<{ kind: string; context?: { used: number } }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.context?.used).toBe(900);
  });
});

describe("money accounts", () => {
  const DAY = 86_400_000;
  const make = (file: string, clock: { t: number }, extra: object = {}) =>
    new LimitsService({ file, publish: () => undefined, claudeCommand: () => undefined, probes: () => [], routes: () => ["anthropic", "openrouter", "claude-cli", "local"], refresh: false, now: () => clock.t, ...extra });

  it("keeps what each call on a key cost for a ROLLING seven days, and remembers it", () => {
    const file = join(dir, "money.json");
    const clock = { t: Date.parse("2026-09-20T10:00:00.000Z") };
    const service = make(file, clock);
    service.spent("anthropic", 1.2);
    clock.t += 6 * DAY;
    service.spent("anthropic", 0.5);
    expect(service.view().accounts.find((a) => a.key === "anthropic")?.spent7d).toBeCloseTo(1.7);
    service.close();
    clock.t += 1.5 * DAY; // the first call is now more than seven days old
    const again = make(file, clock);
    expect(again.view().accounts.find((a) => a.key === "anthropic")?.spent7d).toBeCloseTo(0.5);
    again.close();
  });

  it("draws an API key as spend, a subscription as one, and a free route not at all", () => {
    const service = make(join(dir, "k.json"), { t: Date.now() });
    const kinds = Object.fromEntries(service.view().accounts.map((a) => [a.key, a.kind]));
    expect(kinds).toMatchObject({ anthropic: "spend", openrouter: "spend", claude: "subscription" });
    expect(kinds["local"]).toBeUndefined();
    service.close();
  });

  it("marks an account whose call was refused for an empty balance, until a call goes through", () => {
    const service = make(join(dir, "r.json"), { t: Date.now() });
    service.creditRefused("anthropic");
    expect(service.view().accounts.find((a) => a.key === "anthropic")?.creditRefusedAt).toBeDefined();
    service.spent("anthropic", 0.01);
    expect(service.view().accounts.find((a) => a.key === "anthropic")?.creditRefusedAt).toBeUndefined();
    service.close();
  });

  it("reads OpenRouter's credit into a credit, and a used-up credit is spent", async () => {
    const real = globalThis.fetch;
    let used = 11.6;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: { total_credits: 20, total_usage: used } }), { status: 200 })) as typeof fetch;
    try {
      const service = make(join(dir, "o.json"), { t: Date.now() }, { refresh: true, openRouterKey: () => "k" });
      await service.refresh("openrouter");
      let openrouter = service.view().accounts.find((a) => a.key === "openrouter")!;
      expect(openrouter.kind).toBe("credit");
      expect(openrouter.credit).toEqual({ usedUsd: 11.6, totalUsd: 20, source: "account" });
      expect(openrouter.reading?.windows[0]?.usedPercent).toBeCloseTo(58);
      expect(openrouter.refreshable).toBe(true);
      used = 20;
      await service.refresh("openrouter");
      openrouter = service.view().accounts.find((a) => a.key === "openrouter")!;
      expect(openrouter.reading?.status).toBe("exhausted");
      service.close();
    } finally {
      globalThis.fetch = real;
    }
  });
});
