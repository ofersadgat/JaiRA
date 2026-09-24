/** Usage readings as the app shows them — accounts, spent, the words a person reads, and the preset that picks by what is left. */
import { describe, expect, it } from "vitest";
import {
  accountOfRoute,
  chooseMostLeft,
  compactionOfEvent,
  contextFill,
  formatAge,
  formatResetAt,
  formatTokens,
  formatUntil,
  isSpent,
  parsePresetModel,
  presetModelSummary,
  routeOfModel,
  spentUntil,
  toneOfContext,
  toneOfPercent,
  usedPercentFor,
  creditPercent,
  formatUsd,
  type LimitReading,
  type ModelAvailability,
} from "../src/index";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const reading = (five: number | null, week: number | null, extra: Partial<LimitReading> = {}): LimitReading => ({
  route: "claude-cli",
  plan: "max",
  windows: [
    { id: "five_hour", label: "5-hour", minutes: 300, usedPercent: five, resetsAt: "2026-09-24T14:05:00.000Z", ...(five !== null && five >= 100 ? { status: "exhausted" as const } : {}) },
    { id: "seven_day", label: "Weekly", minutes: 10080, usedPercent: week, resetsAt: "2026-09-28T09:00:00.000Z" },
    { id: "seven_day_opus", label: "Weekly · Opus", minutes: 10080, usedPercent: 71, resetsAt: "2026-09-28T09:00:00.000Z", model: "opus" },
  ],
  status: five !== null && five >= 100 ? "exhausted" : "ok",
  source: "query",
  at: "2026-09-24T11:00:00.000Z",
  complete: true,
  ...extra,
});

describe("which account a route spends", () => {
  it("puts both claude routes on one account, codex on its own, and every other route on itself", () => {
    expect(accountOfRoute("claude-cli")).toBe("claude");
    expect(accountOfRoute("claude-code")).toBe("claude");
    expect(accountOfRoute("codex-cli")).toBe("codex");
    expect(accountOfRoute("anthropic")).toBe("anthropic");
    expect(routeOfModel("claude-cli/claude-sonnet-5")).toBe("claude-cli");
    expect(routeOfModel("coder")).toBeUndefined();
  });
});

describe("spent, and until when", () => {
  it("is spent while an exhausted window is current, and not once it has reset", () => {
    const spent = reading(100, 44);
    expect(isSpent(spent, NOW)).toBe(true);
    expect(spentUntil(spent, NOW)).toBe("2026-09-24T14:05:00.000Z");
    expect(isSpent(spent, Date.parse("2026-09-24T14:06:00Z"))).toBe(false);
  });

  it("is never spent while extra usage is being drawn", () => {
    expect(isSpent(reading(100, 44, { overage: true }), NOW)).toBe(false);
  });

  it("reads the percent of the window a call on a model hits first", () => {
    expect(usedPercentFor(reading(62, 33), "claude-sonnet-5", NOW)).toBe(62);
    expect(usedPercentFor(reading(20, 33), "claude-opus-5-5", NOW)).toBe(71);
    expect(usedPercentFor(null, "x", NOW)).toBeNull();
  });

  it("tones a percent ink at rest, amber from 80, red at 100", () => {
    // Amber from 75, red from 90 (the person's cut-offs, 2026-09-24) — red is a warning; spent is 100.
    expect([toneOfPercent(62), toneOfPercent(74.9), toneOfPercent(75), toneOfPercent(89), toneOfPercent(90), toneOfPercent(100), toneOfPercent(null)]).toEqual([
      "accent",
      "accent",
      "warn",
      "warn",
      "bad",
      "bad",
      "none",
    ]);
  });
});

describe("the words a person reads", () => {
  it("writes a reset as a time today, a day and time within the week, a date beyond", () => {
    const local = (iso: string): Date => new Date(iso);
    const today = local("2026-09-24T14:05:00");
    expect(formatResetAt(today.toISOString(), local("2026-09-24T12:00:00").getTime())).toBe("14:05");
    expect(formatResetAt(local("2026-09-28T09:00:00").toISOString(), local("2026-09-24T12:00:00").getTime())).toBe("Mon 09:00");
    expect(formatUntil("2026-09-24T13:12:00.000Z", NOW)).toBe("in 1 h 12 m");
    expect(formatAge("2026-09-24T11:57:00.000Z", NOW)).toBe("3 min ago");
    expect(formatTokens(76210)).toBe("76,210");
    expect(formatTokens(76210, true)).toBe("76k");
  });
});

describe("how full a context is", () => {
  it("is used over window, and agrees with codex's /status for a codex reading", () => {
    expect(contextFill({ used: 76210, window: 200000, model: "claude-sonnet-5", at: "t" })).toBeCloseTo(38.1, 1);
    // codex: a 12,000-token baseline off both
    expect(contextFill({ used: 15416, window: 258400, model: "gpt-5.6-terra", at: "t" })).toBeCloseTo(((15416 - 12000) / (258400 - 12000)) * 100, 3);
    expect(contextFill({ used: 5, window: null, model: "m", at: "t" })).toBeNull();
    expect(toneOfContext(84)).toBe("warn");
  });

  it("reads what a stored compaction boundary said", () => {
    expect(compactionOfEvent({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 104000, post_tokens: 24000 } })).toEqual({ trigger: "manual", before: 104000, after: 24000 });
    expect(compactionOfEvent({ type: "rate_limit_event" })).toBeUndefined();
  });
});

describe("a preset that picks the candidate with the most left", () => {
  const available = (model: string): ModelAvailability => ({ available: true, route: model.startsWith("gpt") ? "codex-cli" : "claude-cli" }) as ModelAvailability;

  it("parses and says the rule", () => {
    const model = parsePresetModel({ candidates: ["claude-opus-5-5", "gpt-5.6-terra"], choose: "most-left" }, "model");
    expect(presetModelSummary(model)).toBe("most left: opus · gpt-5.6-terra");
  });

  it("takes the most left, then an unknown, and a known-spent account last", () => {
    expect(chooseMostLeft(["claude-opus-5-5", "gpt-5.6-terra"], available, (m) => (m.startsWith("gpt") ? 67 : 29))).toMatchObject({ model: "gpt-5.6-terra" });
    expect(chooseMostLeft(["claude-opus-5-5", "gpt-5.6-terra"], available, (m) => (m.startsWith("gpt") ? null : 0))).toMatchObject({ model: "gpt-5.6-terra" });
    // No readings at all: exactly first-available.
    expect(chooseMostLeft(["claude-opus-5-5", "gpt-5.6-terra"], available, () => null)).toMatchObject({ model: "claude-opus-5-5" });
  });
});

describe("money", () => {
  it("writes dollars with cents, always", () => {
    expect([formatUsd(11.6), formatUsd(0.04), formatUsd(1204), formatUsd(0)]).toEqual(["$11.60", "$0.04", "$1,204.00", "$0.00"]);
  });

  it("says what share of a credit is used, and nothing without a credit to share", () => {
    expect(creditPercent({ usedUsd: 11.6, totalUsd: 20, source: "account" })).toBeCloseTo(58);
    expect(creditPercent({ usedUsd: 25, totalUsd: 20, source: "key" })).toBe(100);
    expect(creditPercent({ usedUsd: 1, totalUsd: 0, source: "key" })).toBeNull();
    expect(creditPercent(undefined)).toBeNull();
  });
});
