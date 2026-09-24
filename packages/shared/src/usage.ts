/**
 * Usage readings as the app shows them — the context a conversation holds, and the allowance an
 * account has left (docs/engineering/contracts/usage-readings.md).
 *
 * The readings themselves are upstream's (`@declarative-ai/json`); this module adds what the app
 * decides: which ACCOUNT a route spends, the view main hands the renderer, the waiting items a spent
 * account produces, and how a reset time or a context figure is written for a person.
 */
import type { ContextPart, ContextReading, LimitReading, LimitStatus, LimitWindow } from "@declarative-ai/json";
import { contextPercent, limitStatusAt, remainingPercent, tightestWindow, weeklyWindow, windowIsCurrent, windowStatus, windowsForModel } from "@declarative-ai/json";

export type { ContextPart, ContextReading, LimitReading, LimitStatus, LimitWindow };
export { contextPercent, limitStatusAt, remainingPercent, tightestWindow, weeklyWindow, windowIsCurrent, windowStatus, windowsForModel };

/**
 * The account a route spends. Both claude routes share one subscription (the CLI and the Agent SDK
 * sign in with the same login), and codex is one ChatGPT account; every other route — an API key, a
 * local server — is its own account, named by the route.
 */
export function accountOfRoute(route: string): string {
  if (route === "claude-cli" || route === "claude-code") return "claude";
  if (route === "codex-cli") return "codex";
  return route;
}

/** The route prefix of a model id (`claude-cli/claude-sonnet-5` → `claude-cli`); `undefined` for a bare or preset id. */
export function routeOfModel(model: string | undefined | null): string | undefined {
  if (model === undefined || model === null) return undefined;
  const cut = model.indexOf("/");
  return cut > 0 ? model.slice(0, cut) : undefined;
}

/** The routes that spend an API KEY — money, not a subscription's windows. `local` and `embedded` cost nothing. */
export const MONEY_ROUTES: readonly string[] = ["anthropic", "openai", "openrouter"];

/**
 * Which of the three ways an account is drawn (usage-readings contract, "API keys"):
 *
 *  - `subscription` — claude and codex logins: the percent of the tightest window.
 *  - `credit` — an API key whose provider says how much credit there is (OpenRouter): what is
 *    SPENT, in dollars, coloured by how much of the credit that is.
 *  - `spend` — an API key whose provider does not (Anthropic, OpenAI): what THIS CONVERSATION cost,
 *    grey, with its share of what the key spent through JaiRA in the last seven days.
 */
export type UsageCase = "subscription" | "credit" | "spend";

/** An account's credit, when its provider reports it. */
export interface CreditFigures {
  usedUsd: number;
  totalUsd: number;
  /** `account`: the account's whole credit. `key`: a spending limit set on this key. */
  source: "account" | "key";
}

/** One account as main shows it: the board's state, who it is, and whether it can be refreshed. */
export interface LimitAccountView {
  /** The board's key (`claude`, `codex`, a route name). */
  key: string;
  /** The routes that spend it. */
  routes: string[];
  /** The brand behind it, for its mark (`claude-cli`, `codex-cli`, a route). */
  brand: string;
  /** Who is signed in, when an agent says (an email, `ChatGPT`). */
  who?: string;
  /** The plan, from the reading or the sign-in probe (`max`, `plus`). */
  plan?: string | null;
  reading: LimitReading | null;
  /** When the reading arrived (ISO-8601). */
  updatedAt: string | null;
  lastSentAt: string | null;
  refreshing: boolean;
  /** Whether a refresh is offered for this account at all. */
  refreshable: boolean;
  /** Why the last refresh learned nothing, when it did not (an older claude, a signed-out login). */
  unavailable?: string;
  /** How it is drawn — see {@link UsageCase}. */
  kind: UsageCase;
  /** The credit, for a `credit` account. */
  credit?: CreditFigures;
  /** What JaiRA's own calls on this key cost in the last seven days (USD), for a money account. */
  spent7d?: number;
  /**
   * When a call on it was last REFUSED for an empty balance (ISO-8601) — the only way an account whose
   * provider reports no balance is known to be out. Cleared by the next call that goes through.
   */
  creditRefusedAt?: string;
}

/** Every account the board knows, and which account each route spends. */
export interface LimitsView {
  accounts: LimitAccountView[];
  routeAccounts: Record<string, string>;
}

/**
 * A message or a run WAITING for an account's allowance.
 *
 * `waiting` — sent while the account had none left, so it was held rather than sent, and goes by itself
 * at `until`. `refused` — sent, and refused because the allowance ran out; it goes again at `until`
 * only while `retry` is on (the "Try again at …" box). Deleting a waiting message cancels it.
 */
export interface WaitingItem {
  id: string;
  kind: "message" | "run";
  /** The project directory it belongs to. */
  project: string;
  taskId: string;
  /** A message's conversation (the instance it continues). */
  instanceId?: string;
  /** A message's text. */
  message?: string;
  /** The account that ran out. */
  account: string;
  /** When it will be tried (ISO-8601); `null` when the reset time is not known. */
  until: string | null;
  state: "waiting" | "refused";
  /** Try again at `until`. Always on for `waiting`; the box for `refused`. */
  retry: boolean;
  createdAt: string;
  /** The refusal's own words, for a refused item. */
  reason?: string;
  /**
   * Refused because the account's CREDIT ran out: there is no reset to try again at, so there is no
   * "Try again at …" — it goes when somebody sends it again, after adding credit.
   */
  credit?: true;
}

/** The failure code a usage-limit refusal carries (upstream `USAGE_LIMIT_CODE`). */
export const USAGE_LIMIT_CODE = "usage_limit";

/** The failure code a refusal for an empty prepaid balance carries (upstream `CREDIT_EXHAUSTED_CODE`). */
export const CREDIT_EXHAUSTED_CODE = "credit_exhausted";

/** The share of the credit used, 0–100; `null` without a credit. */
export function creditPercent(credit: CreditFigures | undefined): number | null {
  if (credit === undefined || !(credit.totalUsd > 0)) return null;
  return Math.max(0, Math.min(100, (credit.usedUsd / credit.totalUsd) * 100));
}

/** Money for a person: `$11.60`, `$0.04`, `$1,204.00` — always with cents. */
export function formatUsd(usd: number): string {
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Is this account out of allowance right now (and not drawing extra usage)? */
export function isSpent(reading: LimitReading | null | undefined, nowMs: number = Date.now()): boolean {
  return reading !== null && reading !== undefined && reading.overage !== true && limitStatusAt(reading, nowMs) === "exhausted";
}

/** When a spent account comes back: the latest reset among its CURRENT exhausted windows. */
export function spentUntil(reading: LimitReading | null | undefined, nowMs: number = Date.now()): string | null {
  if (reading === null || reading === undefined) return null;
  let latest: string | null = null;
  for (const w of reading.windows) {
    if (!windowIsCurrent(w, nowMs) || windowStatus(w) !== "exhausted" || w.resetsAt === null) continue;
    if (latest === null || w.resetsAt > latest) latest = w.resetsAt;
  }
  return latest;
}

/** The used percent of the window a call on `model` hits first; `null` when no figure is known. */
export function usedPercentFor(reading: LimitReading | null | undefined, model?: string, nowMs: number = Date.now()): number | null {
  if (reading === null || reading === undefined) return null;
  const w = tightestWindow(reading, model, nowMs);
  if (w === undefined) return null;
  return windowStatus(w) === "exhausted" ? 100 : w.usedPercent;
}

/**
 * The tone an ACCOUNT's percent is drawn in: ink at rest, amber from 75, red from 90 (the person's
 * cut-offs, 2026-09-24). Red is a warning, not a verdict — messages wait only once nothing is left
 * ({@link isSpent}). The conversation's context has its own, {@link toneOfContext}.
 */
export function toneOfPercent(percent: number | null | undefined): "accent" | "warn" | "bad" | "none" {
  if (percent === null || percent === undefined) return "none";
  return percent >= 90 ? "bad" : percent >= 75 ? "warn" : "accent";
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const two = (n: number): string => String(n).padStart(2, "0");

/** A reset time for a person: `14:05` today, `Mon 09:00` within the week, `12 Oct` beyond. Local time. */
export function formatResetAt(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (iso === null || iso === undefined) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const now = new Date(nowMs);
  const hm = `${two(t.getHours())}:${two(t.getMinutes())}`;
  const sameDay = t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
  if (sameDay) return hm;
  if (t.getTime() - nowMs < 6.5 * 86_400_000 && t.getTime() > nowMs) return `${DAYS[t.getDay()]} ${hm}`;
  return `${t.getDate()} ${t.toLocaleString("en-GB", { month: "short" })}`;
}

/** How long until a time, for a person: `in 1 h 12 m`, `in 3 d`. */
export function formatUntil(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (iso === null || iso === undefined) return "";
  const ms = Date.parse(iso) - nowMs;
  if (Number.isNaN(ms) || ms <= 0) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m} m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h} h${m % 60 > 0 ? ` ${m % 60} m` : ""}`;
  return `in ${Math.round(h / 24)} d`;
}

/** How old a reading is, for a person: `just now`, `3 min ago`, `2 h ago`. */
export function formatAge(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (iso === null || iso === undefined) return "never";
  const ms = nowMs - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 60_000) return "just now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** Tokens for a person: `76,210` exact, or `76k` short. */
export function formatTokens(n: number, short = false): string {
  if (!short) return n.toLocaleString("en-US");
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/**
 * The percent a meter draws for a context reading.
 *
 * Codex's own `/status` counts a 12,000-token baseline out of both the window and what is held, and a
 * codex reading is drawn to agree with it; everything else is `used / window`.
 */
export function contextFill(reading: ContextReading, route?: string): number | null {
  // Where the route is not at hand (a turn's badge), a codex reading is known by its model's family.
  const codex = route === "codex-cli" || (route === undefined && /^(gpt-|codex)/i.test(reading.model));
  if (codex && reading.window !== null && reading.window > 12_000) {
    const baseline = 12_000;
    const usable = reading.window - baseline;
    return Math.min(100, Math.max(0, (Math.max(0, reading.used - baseline) / usable) * 100));
  }
  return contextPercent(reading);
}

/** The tone a context fill is drawn in: amber from 80, never red — a full context compacts, it does not refuse. */
export function toneOfContext(percent: number | null): "accent" | "warn" | "none" {
  if (percent === null) return "none";
  return percent >= 80 ? "warn" : "accent";
}

/** What a compaction boundary said, read off a stored event entry's data (claude's `compact_boundary`). */
export function compactionOfEvent(data: unknown): { trigger: string; before?: number; after?: number; durationMs?: number } | undefined {
  const e = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
  if (e?.["type"] !== "system" || e["subtype"] !== "compact_boundary") return undefined;
  const m = (e["compact_metadata"] ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const before = num(m["pre_tokens"]);
  const after = num(m["post_tokens"]);
  const durationMs = num(m["duration_ms"]);
  return {
    trigger: typeof m["trigger"] === "string" ? m["trigger"] : "auto",
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}
