/**
 * The usage readings, drawn — each state one static render (usage-readings contract, "What the
 * screens show"): the composer's ring and its popover, the account's number and its popover, the
 * spent line, a turn's badge, the compaction line, a waiting message, the sign-in card's weekly ring,
 * the model menu's numbers and a state header's delta.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextReading, LimitAccountView, LimitReading, WaitingItem } from "@jaira/shared";
import { publishLimits, publishUsageFigures, publishWaiting } from "../src/renderer/limitsStore";
import {
  AccountAllowance,
  AllowanceNumber,
  KeyUsage,
  UsageFiguresPreview,
  CompactionLine,
  ContextDetail,
  ContextMeter,
  ModelWindow,
  RouteLeft,
  SpentNotice,
  TurnContext,
  WaitingLine,
  WaitingMessage,
} from "../src/renderer/usageMeters";
import { StateHeader } from "../src/renderer/stateSurface";
import { eventEntry } from "../src/renderer/transcript";

const soon = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();

const claude = (five: number, week: number, extra: Partial<LimitReading> = {}): LimitAccountView => ({
  key: "claude",
  routes: ["claude-cli"],
  brand: "claude-cli",
  who: "me@example.com",
  plan: "max",
  reading: {
    route: "claude-cli",
    plan: "max",
    windows: [
      { id: "five_hour", label: "5-hour", minutes: 300, usedPercent: five, resetsAt: soon(1), ...(five >= 100 ? { status: "exhausted" as const } : {}) },
      { id: "seven_day", label: "Weekly", minutes: 10080, usedPercent: week, resetsAt: soon(90) },
      { id: "seven_day_opus", label: "Weekly · Opus", minutes: 10080, usedPercent: 71, resetsAt: soon(90), model: "opus" },
    ],
    status: five >= 100 ? "exhausted" : "ok",
    source: "query",
    at: new Date().toISOString(),
    complete: true,
    ...extra,
  },
  updatedAt: new Date(Date.now() - 180_000).toISOString(),
  lastSentAt: null,
  refreshing: false,
  refreshable: true,
  kind: "subscription",
});

const board = (...accounts: LimitAccountView[]): void =>
  publishLimits({ accounts, routeAccounts: { "claude-cli": "claude", "claude-code": "claude", "codex-cli": "codex" } });

const draw = (type: unknown, props: object): string => renderToStaticMarkup(createElement(type as never, props as never));

const CONTEXT: ContextReading = {
  used: 76210,
  window: 200000,
  model: "claude-sonnet-5",
  autoCompactAt: 166000,
  breakdown: [
    { name: "System prompt", tokens: 9800 },
    { name: "System tools", tokens: 14300, parts: [{ name: "Bash", tokens: 2900 }] },
    { name: "Messages", tokens: 49010, parts: [{ name: "Tool results", tokens: 30200, parts: [{ name: "Read", tokens: 21600 }] }] },
  ],
  at: "t",
};

afterEach(() => {
  board();
  publishWaiting([]);
  publishUsageFigures("number");
});

describe("the composer's ring", () => {
  it("is the ring alone at rest, and says its number from 80%", () => {
    expect(draw(ContextMeter, { context: CONTEXT })).not.toContain("um-meter-text");
    const full = draw(ContextMeter, { context: { ...CONTEXT, used: 168400 } });
    expect(full).toContain("84%");
    expect(full).toContain("um-warn");
  });

  it("is an empty dashed ring before the first reply, and says the tokens when the window is not known", () => {
    expect(draw(ContextMeter, { context: undefined })).toContain("is-empty");
    expect(draw(ContextMeter, { context: { ...CONTEXT, window: null } })).toContain("76k");
  });

  it("opens on the figure, the auto-compact point, Compact now and the categories", () => {
    const open = draw(ContextMeter, { context: CONTEXT, startOpen: true, onCompact: () => undefined });
    expect(open).toContain("38%");
    expect(open).toContain("76,210 of 200,000 tokens");
    expect(open).toContain("auto-compacts at 166k (83%)");
    expect(open).toContain("Compact now");
    expect(open).toContain("System tools");
    expect(open).toContain("um-tick");
  });

  it("waits for the turn in flight, and offers no Compact where the agent cannot compact", () => {
    expect(draw(ContextDetail, { context: CONTEXT, busy: true, onCompact: () => undefined })).toContain("Compact after this turn");
    expect(draw(ContextDetail, { context: CONTEXT })).not.toContain("Compact now");
  });

  it("opens a category's detail beside the card", () => {
    const hovered = draw(ContextDetail, { context: CONTEXT, hover: "Messages" });
    expect(hovered).toContain("um-fly");
    expect(hovered).toContain("Tool results");
    expect(hovered).toContain("Read");
  });
});

describe("the account's number, after the model chip", () => {
  it("is the percent of the tightest window, toned", () => {
    board(claude(62, 33));
    expect(draw(AllowanceNumber, { route: "claude-cli", model: "claude-cli/claude-sonnet-5" })).toContain(">62%<");
    board(claude(86, 33));
    expect(draw(AllowanceNumber, { route: "claude-cli", model: "claude-cli/claude-sonnet-5" })).toContain("um-t-warn");
    board(claude(100, 33));
    expect(draw(AllowanceNumber, { route: "claude-cli", model: "claude-cli/claude-sonnet-5" })).toContain("um-t-bad");
  });

  it("opens on every window, when each resets, the age, Refresh and the other accounts", () => {
    board(claude(62, 33), { ...claude(2, 33), key: "codex", brand: "codex-cli", routes: ["codex-cli"], who: "ChatGPT", plan: "plus" });
    const open = draw(AllowanceNumber, { route: "claude-cli", model: "claude-sonnet-5", startOpen: true });
    expect(open).toContain("5-hour");
    expect(open).toContain("Opus only");
    expect(open).toContain("updated 3 min ago");
    expect(open).toContain("Refresh");
    expect(open).toContain("Your other accounts");
    expect(open).toContain("codex-cli · ChatGPT");
  });

  it("draws nothing for a route that spends no account the board knows", () => {
    board(claude(62, 33));
    expect(draw(AllowanceNumber, { route: "ollama" })).toBe("");
  });
});

describe("no usage left", () => {
  it("says so over the composer only while the reading says so", () => {
    board(claude(62, 33));
    expect(draw(SpentNotice, { route: "claude-cli" })).toBe("");
    board(claude(100, 33));
    const line = draw(SpentNotice, { route: "claude-cli" });
    expect(line).toContain("claude-cli has no usage left");
    expect(line).toContain("What you send now waits until then.");
    board(claude(100, 33, { overage: true }));
    expect(draw(SpentNotice, { route: "claude-cli" })).toBe("");
  });

  const item = (extra: Partial<WaitingItem>): WaitingItem => ({
    id: "w1",
    kind: "message",
    project: "p",
    taskId: "t",
    instanceId: "i",
    message: "carry on",
    account: "claude",
    until: soon(1),
    state: "waiting",
    retry: true,
    createdAt: "t",
    ...extra,
  });

  it("draws a waiting message faded, with Send now anyway and Delete — no Cancel", () => {
    board(claude(100, 33));
    const html = draw(WaitingMessage, { item: item({}) });
    expect(html).toContain("um-bubble-wait");
    expect(html).toContain("Waiting: sends at");
    expect(html).toContain("Send now anyway");
    expect(html).toContain("Delete");
    expect(html).not.toContain("Cancel");
  });

  it("draws a refusal with Try again at …, checked as the item says", () => {
    board(claude(100, 33));
    const on = draw(WaitingLine, { item: item({ state: "refused", retry: true }) });
    expect(on).toContain("Refused: claude-cli has no usage left.");
    expect(on).toContain("Try again at");
    expect(on).toContain("checked");
    const run = draw(WaitingLine, { item: item({ kind: "run", state: "refused", retry: false }), run: true, onStop: () => undefined });
    expect(run).toContain("Refused mid-turn");
    expect(run).toContain("Stop the run");
    expect(run).not.toContain('checked=""');
  });
});

describe("the conversation", () => {
  it("puts the context after each answer on its rail, with the change since the answer before", () => {
    const html = draw(TurnContext, { context: { ...CONTEXT, used: 168400 }, before: CONTEXT });
    expect(html).toContain("84%");
    expect(html).toContain("+46% since the reply before");
  });

  it("draws a compaction as a line, from the agent's own report or worked out from a drop", () => {
    expect(draw(CompactionLine, { trigger: "auto", before: 168000, after: 42000, durationMs: 18000, window: 200000 })).toContain("84% → 21%");
    expect(draw(CompactionLine, { trigger: "manual", before: 104000, after: 24000, window: 200000 })).toContain("compacted at your request");
    expect(draw(CompactionLine, { derived: true, before: 142000, after: 38000, window: 200000 })).toContain("say why");
    expect(eventEntry({ type: "provider_event", payload: { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1, post_tokens: 0 } } })).toEqual([
      { kind: "compaction", trigger: "auto", before: 1, after: 0 },
    ]);
  });

  it("says what a state added at the right of its header, open or folded, and no cost", () => {
    const open = draw(StateHeader, { open: true, name: "draft", label: "Draft the features", meta: "10:02:11 · 3 m 12 s", added: 31000, onToggle: () => undefined });
    const shut = draw(StateHeader, { open: false, name: "critique", summary: undefined, meta: "10:05:24 · 3 m 5 s", added: 8000, onToggle: () => undefined });
    expect(open).toContain('<span class="lh-meta"><span class="lh-added"');
    expect(open).toContain("+31k");
    expect(shut).toContain("+8k");
    expect(shut).not.toContain("$");
  });
});

describe("the sign-in card", () => {
  it("rings the WEEKLY window, and says when the week resets on its own line", () => {
    board(claude(62, 33));
    const html = draw(AccountAllowance, { account: claude(62, 33), plan: "Max plan" });
    expect(html).toContain("Max plan");
    expect(html).toContain(">33%<");
    expect(html).toContain("Weekly · resets");
    expect(html).not.toContain(">62%<");
  });

  it("turns the reset red once the week is used up", () => {
    const html = draw(AccountAllowance, { account: claude(20, 100, {}), plan: "Plus plan" });
    expect(html).toContain("is-spent");
  });
});

describe("the model menu", () => {
  it("puts each route's account on its row, and a model's own window on the model's row, without words", () => {
    board(claude(62, 33));
    expect(draw(RouteLeft, { route: "claude-cli" })).toContain(">62%<");
    const opus = draw(ModelWindow, { route: "claude-cli", model: "claude-cli/claude-opus-5" });
    expect(opus).toContain(">71%<");
    expect(opus).not.toContain("Opus weekly");
    expect(draw(ModelWindow, { route: "claude-cli", model: "claude-cli/claude-sonnet-5" })).toBe("");
  });
});

const money = (key: string, extra: Partial<LimitAccountView>): LimitAccountView => ({
  key,
  routes: [key],
  brand: key,
  who: `${key.toUpperCase()}_API_KEY`,
  plan: null,
  reading: null,
  updatedAt: null,
  lastSentAt: null,
  refreshing: false,
  refreshable: false,
  kind: "spend",
  spent7d: 6.8,
  ...extra,
});
const credit = (used: number): LimitAccountView =>
  money("openrouter", {
    kind: "credit",
    credit: { usedUsd: used, totalUsd: 20, source: "account" },
    reading: {
      route: "openrouter",
      plan: null,
      windows: [{ id: "credit", label: "Credit", minutes: null, usedPercent: (used / 20) * 100, resetsAt: null, ...(used >= 20 ? { status: "exhausted" as const } : {}) }],
      status: used >= 20 ? "exhausted" : "ok",
      source: "query",
      at: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  });
const moneyBoard = (...accounts: LimitAccountView[]): void =>
  publishLimits({ accounts, routeAccounts: { "claude-cli": "claude", openrouter: "openrouter", anthropic: "anthropic" } });

describe("an API key's figure", () => {
  it("is what a credit has SPENT, coloured by the share: ink, amber from 75%, red from 90% — never what is left", () => {
    moneyBoard(credit(11.6));
    const rest = draw(AllowanceNumber, { route: "openrouter" });
    expect(rest).toContain(">$11.60<");
    expect(rest).toContain("um-t-accent");
    expect(rest).not.toContain("left");
    moneyBoard(credit(16));
    expect(draw(AllowanceNumber, { route: "openrouter" })).toContain("um-t-warn");
    moneyBoard(credit(18.6));
    expect(draw(AllowanceNumber, { route: "openrouter" })).toContain("um-t-bad");
  });

  it("is this conversation's cost for a key whose provider reports no balance, grey — red once refused", () => {
    moneyBoard(money("anthropic", {}));
    const rest = draw(AllowanceNumber, { route: "anthropic", cost: 1.2 });
    expect(rest).toContain(">$1.20<");
    expect(rest).toContain("um-t-none");
    moneyBoard(money("anthropic", { creditRefusedAt: new Date().toISOString() }));
    expect(draw(AllowanceNumber, { route: "anthropic", cost: 1.2 })).toContain("um-t-bad");
    expect(draw(SpentNotice, { route: "anthropic" })).toContain("the balance is empty");
  });

  it("opens on the conversation, then the credit used or the key's week", () => {
    moneyBoard(credit(11.6), money("anthropic", {}));
    const credited = draw(AllowanceNumber, { route: "openrouter", cost: 1.2, startOpen: true });
    expect(credited).toContain("This conversation");
    expect(credited).toContain("Credit used");
    expect(credited).not.toContain("left");
    expect(credited).toContain("$6.80 in the last 7 days"); // the other account, anthropic
    const spend = draw(AllowanceNumber, { route: "anthropic", cost: 1.2, startOpen: true });
    expect(spend).toContain("18% of the $6.80 spent on this key in the last 7 days");
    expect(spend).toContain("doesn&#x27;t report the balance");
  });

  it("holds messages once the credit is used up, and says so", () => {
    moneyBoard(credit(20));
    expect(draw(SpentNotice, { route: "openrouter" })).toContain("credit is used up");
  });
});

describe("the usage figures setting", () => {
  it("draws the number, the ring (with a $ for money), both, or nothing", () => {
    board(claude(62, 33));
    publishUsageFigures("ring");
    const ring = draw(AllowanceNumber, { route: "claude-cli", model: "claude-cli/claude-sonnet-5" });
    expect(ring).toContain("um-ring");
    expect(ring).not.toContain(">62%<");
    publishUsageFigures("both");
    const both = draw(AllowanceNumber, { route: "claude-cli", model: "claude-cli/claude-sonnet-5" });
    expect(both).toContain("um-ring");
    expect(both).toContain(">62%<");
    publishUsageFigures("off");
    expect(draw(AllowanceNumber, { route: "claude-cli", model: "claude-cli/claude-sonnet-5" })).toBe("");
    moneyBoard(credit(11.6));
    publishUsageFigures("ring");
    expect(draw(AllowanceNumber, { route: "openrouter" })).toContain("um-dollar");
  });

  it("governs the sign-in card too: the number alone by default, no ring", () => {
    const html = draw(AccountAllowance, { account: claude(62, 33), plan: "Max plan" });
    expect(html).toContain(">33%<");
    expect(html).not.toContain("um-ring");
  });

  it("previews each case in the mode being chosen", () => {
    const number = draw(UsageFiguresPreview, { mode: "number" });
    expect(number).toContain("62%");
    expect(number).toContain("$11.60");
    expect(number).toContain("$1.20");
    expect(draw(UsageFiguresPreview, { mode: "off" })).not.toContain("um-num");
    expect(draw(UsageFiguresPreview, { mode: "ring" })).toContain("um-dollar");
  });
});

describe("an API key on Connections and in the model menu", () => {
  it("shows what the key spent — a credit used, or the last seven days — never what is left", () => {
    moneyBoard(credit(11.6), money("anthropic", {}));
    const box = draw(KeyUsage, { route: "openrouter" });
    expect(box).toContain("$11.60");
    expect(box).toContain("credit used");
    const week = draw(KeyUsage, { route: "anthropic" });
    expect(week).toContain("$6.80");
    expect(week).toContain("no balance reported");
    expect(draw(RouteLeft, { route: "openrouter" })).toContain("$11.60");
    expect(draw(RouteLeft, { route: "anthropic" })).toContain("$6.80");
  });

  it("offers no Try again for a refusal on an empty balance — there is no reset", () => {
    const item: WaitingItem = { id: "w", kind: "message", project: "p", taskId: "t", account: "anthropic", until: null, state: "refused", retry: false, credit: true, createdAt: new Date().toISOString() };
    const html = draw(WaitingLine, { item });
    expect(html).toContain("balance is empty");
    expect(html).not.toContain("checkbox");
  });
});
