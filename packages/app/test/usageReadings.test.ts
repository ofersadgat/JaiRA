/**
 * The usage readings, as the screens say them (usage-readings contract, "What the screens show"): how
 * full the conversation is, the account's figure after the model chip and what its card lists, the
 * line over the composer when nothing is left, a sign-in card's weekly figure, an API key's box, the
 * model menu's numbers, the setting's preview, and a compaction read off the agent's own report.
 *
 * These claims were read off the DOM page's markup until that page was deleted. The universal
 * components (`packages/universal/src/components/usage`, `…/chat/UsageCards.tsx`, `…/chat/Composer.tsx`,
 * `…/panel/TurnContext.tsx`) draw from the same pure modules the DOM ones did, so each claim is held on
 * the value the module gives: `usageFigure.ts`, `usageCards.ts`, `limitsStore.ts`'s `accountFor`,
 * `transcript.ts`'s `eventEntry`, and `@jaira/shared`'s `contextFill`, tones and formatters.
 *
 * What a component writes itself is not here: a waiting message's sentences and its verbs, Compact
 * now, a compaction's line, and which of the number and the ring the setting draws.
 *
 * The clock is pinned at a local noon, so "resets 13:00" is the same in every time zone.
 */
import { describe, expect, it } from "vitest";
import { contextFill, formatAge, formatTokens, toneOfContext, type ContextReading, type LimitAccountView, type LimitReading, type LimitsView } from "@jaira/shared/browser";
import { accountFor } from "../src/renderer/limitsStore";
import { eventEntry } from "../src/renderer/transcript";
import { modelWindowOf, readingAgeOf, routeLeftOf, spentNoticeOf, windowRowsOf } from "../src/renderer/usageCards";
import { USAGE_PREVIEW_EXAMPLES, figureOf, keyFigureOf, weeklyFigureOf, weeklyTitleOf } from "../src/renderer/usageFigure";

/** Wednesday 14 January 2026, noon, local: an hour on is 13:00 the same day, 90 hours on is Sunday 06:00. */
const NOW = new Date(2026, 0, 14, 12, 0, 0).getTime();
const at = (ms: number): string => new Date(NOW + ms).toISOString();
const soon = (h: number): string => at(h * 3_600_000);

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
    at: at(0),
    complete: true,
    ...extra,
  },
  updatedAt: at(-180_000),
  lastSentAt: null,
  refreshing: false,
  refreshable: true,
  kind: "subscription",
});

/** The board main publishes: the accounts, and which account each route spends. */
const board = (...accounts: LimitAccountView[]): LimitsView => ({ accounts, routeAccounts: { "claude-cli": "claude", "claude-code": "claude", "codex-cli": "codex" } });

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

describe("the composer's ring", () => {
  it("is ink at rest, and amber at 84% — where the agent is about to compact", () => {
    // The ring draws `contextFill` in `toneOfContext`'s tone. Writing the number beside the ring from
    // 80% is the composer's own rule; the tone turning there is the model's.
    expect(toneOfContext(contextFill(CONTEXT))).toBe("accent");
    const full = contextFill({ ...CONTEXT, used: 168400 });
    expect(full).toBeCloseTo(84.2, 5);
    expect(toneOfContext(full)).toBe("warn");
  });

  it("has no fill when the window is not known, and the tokens are what is said instead", () => {
    const fill = contextFill({ ...CONTEXT, window: null });
    expect(fill).toBeNull();
    expect(toneOfContext(fill)).toBe("none");
    expect(formatTokens(CONTEXT.used, true)).toBe("76k");
  });

  it("opens on the figure, the tokens of the window held, and the auto-compact point", () => {
    // The card writes "38%", "76,210 of 200,000 tokens" and "auto-compacts at 166k" from these.
    expect(contextFill(CONTEXT)).toBeCloseTo(38.105, 5);
    expect(formatTokens(CONTEXT.used)).toBe("76,210");
    expect(formatTokens(CONTEXT.window!)).toBe("200,000");
    expect(formatTokens(CONTEXT.autoCompactAt!, true)).toBe("166k");
  });
});

describe("the account's number, after the model chip", () => {
  const figure = (five: number): ReturnType<typeof figureOf> => figureOf(accountFor(board(claude(five, 33)), "claude-cli")!, { model: "claude-cli/claude-sonnet-5", now: NOW });

  it("is the percent of the tightest window, toned", () => {
    // The Opus window's 71% is not this model's: a call on sonnet hits the 5-hour window first.
    expect(figure(62)).toEqual({ pct: 62, tone: "accent", text: "62%", money: false, title: "claude-cli · 62% of the tightest window used" });
    expect(figure(86)).toMatchObject({ text: "86%", tone: "warn" });
    expect(figure(100)).toMatchObject({ text: "100%", tone: "bad" });
  });

  it("opens on every window, when each resets, and the reading's age", () => {
    const account = claude(62, 33);
    expect(windowRowsOf(account, NOW)).toEqual([
      { id: "five_hour", name: "5-hour", pct: 62, tone: "accent", passed: false, value: "62%", reset: "resets 13:00", resetTitle: soon(1) },
      { id: "seven_day", name: "Weekly", sub: "all models", pct: 33, tone: "accent", passed: false, value: "33%", reset: "resets Sun 06:00", resetTitle: soon(90) },
      { id: "seven_day_opus", name: "Weekly", sub: "Opus only", pct: 71, tone: "accent", passed: false, value: "71%", reset: "resets Sun 06:00", resetTitle: soon(90) },
    ]);
    expect(readingAgeOf(account, formatAge(account.updatedAt, NOW))).toBe("updated 3 min ago, asked directly");
  });

  it("has no account for a route that spends none the board knows, so nothing is drawn", () => {
    const view = board(claude(62, 33));
    expect(accountFor(view, "claude-cli")?.key).toBe("claude");
    expect(accountFor(view, "ollama")).toBeUndefined();
    expect(accountFor(view, undefined)).toBeUndefined();
  });
});

describe("no usage left", () => {
  it("says so over the composer only while the reading says so", () => {
    const notice = (account: LimitAccountView): ReturnType<typeof spentNoticeOf> => spentNoticeOf(accountFor(board(account), "claude-cli"), NOW);
    expect(notice(claude(62, 33))).toBeUndefined();
    expect(notice(claude(100, 33))).toEqual({ bold: "claude-cli has no usage left", rest: " until 13:00. What you send now waits until then." });
    // Extra usage is on: messages still go through, so nothing waits and nothing is said.
    expect(notice(claude(100, 33, { overage: true }))).toBeUndefined();
  });
});

describe("the conversation", () => {
  it("puts the context after each answer on its rail, with the change since the answer before", () => {
    // The badge says the fill after the reply (84%), and its tip the change from the fill before it
    // (38% → "+46%"); both are `contextFill`, read with no route, as a turn's badge has none.
    const after = contextFill({ ...CONTEXT, used: 168400 });
    expect(after).toBeCloseTo(84.2, 5);
    expect(toneOfContext(after)).toBe("warn");
    expect(contextFill(CONTEXT)).toBeCloseTo(38.105, 5);
  });

  it("reads a compaction off the agent's own report", () => {
    expect(eventEntry({ type: "provider_event", payload: { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1, post_tokens: 0 } } })).toEqual([
      { kind: "compaction", trigger: "auto", before: 1, after: 0 },
    ]);
  });

  it("says what a state added in short tokens", () => {
    // A state's header draws "+31k" at its right, open or folded: the plus is the header's, the figure this.
    expect(formatTokens(31000, true)).toBe("31k");
    expect(formatTokens(8000, true)).toBe("8k");
  });
});

describe("the sign-in card", () => {
  it("rings the WEEKLY window, not the tightest one", () => {
    const { week, spent, pct, tone, figure } = weeklyFigureOf(claude(62, 33));
    expect(week?.id).toBe("seven_day");
    expect({ spent, pct, tone }).toEqual({ spent: false, pct: 33, tone: "accent" });
    expect(figure).toMatchObject({ pct: 33, text: "33%", money: false });
    expect(weeklyTitleOf(week, pct)).toBe("Weekly window, 33% used — click for every window");
  });

  it("turns the reset red once the week is used up", () => {
    // `spent` is what the reset line is drawn red by.
    expect(weeklyFigureOf(claude(20, 100))).toMatchObject({ spent: true, pct: 100, tone: "bad" });
    expect(weeklyFigureOf(claude(20, 33)).spent).toBe(false);
  });
});

describe("the model menu", () => {
  it("puts each route's account on its row, and a model's own window on the model's row, without words", () => {
    const account = accountFor(board(claude(62, 33)), "claude-cli");
    expect(routeLeftOf(account, NOW)).toEqual({ bar: 62, text: "62%", tone: "accent", money: false, title: "62% of the tightest window used" });
    // The row carries the number alone; which window it is, is in the hover.
    expect(modelWindowOf(account, "claude-cli/claude-opus-5", NOW)).toEqual({ pct: 71, tone: "accent", text: "71%", title: "Weekly · Opus: 71% used, resets Sun 06:00" });
    expect(modelWindowOf(account, "claude-cli/claude-sonnet-5", NOW)).toBeUndefined();
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
      at: at(0),
    },
    updatedAt: at(0),
  });
const moneyBoard = (...accounts: LimitAccountView[]): LimitsView => ({ accounts, routeAccounts: { "claude-cli": "claude", openrouter: "openrouter", anthropic: "anthropic" } });

describe("an API key's figure", () => {
  it("is what a credit has SPENT, coloured by the share: ink, amber from 75%, red from 90% — never what is left", () => {
    const figure = (used: number): ReturnType<typeof figureOf> => figureOf(accountFor(moneyBoard(credit(used)), "openrouter")!, { now: NOW });
    const rest = figure(11.6);
    expect(rest).toMatchObject({ text: "$11.60", tone: "accent" });
    expect(rest.title).not.toContain("left");
    expect(figure(16).tone).toBe("warn");
    expect(figure(18.6).tone).toBe("bad");
  });

  it("is this conversation's cost for a key whose provider reports no balance, grey — red once refused", () => {
    expect(figureOf(money("anthropic", {}), { cost: 1.2, now: NOW })).toMatchObject({ text: "$1.20", tone: "none" });
    const refused = money("anthropic", { creditRefusedAt: at(0) });
    expect(figureOf(refused, { cost: 1.2, now: NOW })).toMatchObject({ text: "$1.20", tone: "bad" });
    expect(spentNoticeOf(refused, NOW)).toEqual({ bold: "anthropic refused the last message: the balance is empty.", rest: " Add credit, then send it again." });
  });

  it("says in its hover the credit used, or the conversation's share of the key's week", () => {
    // A credit's figure is the account's, whatever the conversation cost.
    const credited = figureOf(credit(11.6), { cost: 1.2, now: NOW });
    expect(credited.text).toBe("$11.60");
    expect(credited.title).toBe("openrouter · $11.60 of the credit used (58%)");
    expect(figureOf(money("anthropic", {}), { cost: 1.2, now: NOW }).title).toBe("anthropic · this conversation $1.20, 18% of the $6.80 spent on this key in the last 7 days");
  });

  it("holds messages once the credit is used up, and says so", () => {
    expect(spentNoticeOf(accountFor(moneyBoard(credit(20)), "openrouter"), NOW)).toEqual({ bold: "openrouter's credit is used up", rest: " ($20.00 used). What you send now waits until credit is added." });
    expect(spentNoticeOf(accountFor(moneyBoard(credit(11.6)), "openrouter"), NOW)).toBeUndefined();
  });
});

describe("the usage figures setting", () => {
  it("has a share for the ring, and marks money so its ring carries a $", () => {
    // Which of the number and the ring is drawn is the component's, by the setting; what each draws is the figure's.
    expect(figureOf(claude(62, 33), { model: "claude-cli/claude-sonnet-5", now: NOW })).toMatchObject({ pct: 62, text: "62%", money: false });
    const spent = figureOf(credit(11.6), { now: NOW });
    expect(spent.money).toBe(true);
    expect(spent.pct).toBeCloseTo(58, 5);
  });

  it("previews each case: a subscription, a credit reported, a key with no balance reported", () => {
    expect(USAGE_PREVIEW_EXAMPLES.map((e) => [e.brand, e.label, e.figure.text, e.figure.money])).toEqual([
      ["claude-cli", "subscription", "62%", false],
      ["openrouter", "credit reported", "$11.60", true],
      ["anthropic", "no balance reported", "$1.20", true],
    ]);
  });
});

describe("an API key on Connections and in the model menu", () => {
  it("shows what the key spent — a credit used, or the last seven days — never what is left", () => {
    const view = moneyBoard(credit(11.6), money("anthropic", {}));
    const box = keyFigureOf(accountFor(view, "openrouter")!, NOW);
    expect(box).toMatchObject({ credit: true, under: "credit used", refused: false });
    expect(box.figure.text).toBe("$11.60");
    const week = keyFigureOf(accountFor(view, "anthropic")!, NOW);
    expect(week).toMatchObject({ credit: false, under: "no balance reported", refused: false });
    expect(week.figure.text).toBe("$6.80");
    expect(routeLeftOf(accountFor(view, "openrouter"), NOW)).toMatchObject({ text: "$11.60", money: true });
    // A key whose provider reports no balance has no share to draw: a number and no bar.
    expect(routeLeftOf(accountFor(view, "anthropic"), NOW)).toMatchObject({ text: "$6.80", money: true, bar: false });
  });
});
