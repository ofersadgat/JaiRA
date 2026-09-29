/**
 * What the usage cards SAY — the account's windows and their words, the line over the composer when an
 * account has nothing left, and the figures beside a route and a model in the model menu — moved
 * unchanged out of `usageMeters.tsx`, which draws them from here, so the universal composer's cards
 * (decision 0015, `packages/universal/src/components/chat/UsageCards.tsx`) say the same.
 */
import {
  creditPercent,
  formatResetAt,
  formatUsd,
  isSpent,
  spentUntil,
  toneOfPercent,
  usedPercentFor,
  windowIsCurrent,
  windowStatus,
  type LimitAccountView,
  type LimitWindow,
} from "@jaira/shared/browser";

const round = (n: number): number => Math.round(n);

/** Split a window's label into its name and what it counts ("Weekly · Opus" → Weekly, Opus only). */
export function windowName(w: LimitWindow, hasModelWindows: boolean): { name: string; sub?: string } {
  const [name, model] = w.label.split(" · ");
  if (model !== undefined) return { name: name!, sub: `${model} only` };
  return hasModelWindows && w.minutes === 10080 ? { name: w.label, sub: "all models" } : { name: w.label };
}

export function sourceWords(source: string): string {
  switch (source) {
    case "stream":
      return "from a conversation";
    case "query":
      return "asked directly";
    case "file":
      return "from codex's session file";
    case "headers":
      return "from the last call";
    default:
      return source;
  }
}

export const capital = (s: string): string => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1));

/** One window of the account card: its name, bar, figure and reset — `AccountPopover`'s row. */
export interface WindowRow {
  id: string;
  name: string;
  sub?: string;
  pct: number | null;
  tone: string;
  /** The window has passed: drawn at .6, its tone none. */
  passed: boolean;
  value: string;
  reset: string;
  resetTitle?: string;
}

/** The account card's windows: the current ones, and any spent. */
export function windowRowsOf(account: LimitAccountView, now: number): WindowRow[] {
  const windows = (account.reading?.windows ?? []).filter((w) => windowIsCurrent(w, now) || windowStatus(w) === "exhausted");
  const hasModelWindows = windows.some((w) => w.model !== undefined);
  return windows.map((w) => {
    const spent = windowStatus(w) === "exhausted";
    const pct = spent ? 100 : w.usedPercent;
    const tone = toneOfPercent(pct);
    const { name, sub } = windowName(w, hasModelWindows);
    const passed = !windowIsCurrent(w, now);
    return {
      id: w.id,
      name,
      ...(sub !== undefined ? { sub } : {}),
      pct,
      tone: passed ? "none" : tone,
      passed,
      value: spent && w.usedPercent === null ? "spent" : pct === null ? "–" : `${round(pct)}%`,
      reset: w.resetsAt === null ? "" : passed ? `passed ${formatResetAt(w.resetsAt, now)}` : `resets ${formatResetAt(w.resetsAt, now)}`,
      ...(w.resetsAt !== null ? { resetTitle: w.resetsAt } : {}),
    };
  });
}

/** The account card's foot: how old the reading is, and where it came from. */
export function readingAgeOf(account: LimitAccountView, age: string | undefined): string {
  const reading = account.reading;
  return account.kind === "spend"
    ? "counted from each call's cost"
    : account.updatedAt === null
      ? "never read"
      : `updated ${age ?? ""}${reading !== null ? `, ${account.kind === "credit" ? "asked the provider" : sourceWords(reading.source)}` : ""}`;
}

/**
 * The line over the composer while the account has nothing left — or, for a key whose provider
 * reports no balance, once a call on it was refused for an empty one: its bold words and the rest.
 */
export function spentNoticeOf(account: LimitAccountView | undefined, now: number): { bold: string; rest: string } | undefined {
  if (account === undefined) return undefined;
  if (account.kind === "spend" && account.creditRefusedAt !== undefined) {
    return { bold: `${account.brand} refused the last message: the balance is empty.`, rest: " Add credit, then send it again." };
  }
  if (!isSpent(account.reading, now)) return undefined;
  if (account.kind === "credit") {
    return { bold: `${account.brand}'s credit is used up`, rest: `${account.credit !== undefined ? ` (${formatUsd(account.credit.usedUsd)} used)` : ""}. What you send now waits until credit is added.` };
  }
  const until = spentUntil(account.reading, now);
  return { bold: `${account.brand} has no usage left`, rest: `${until !== null ? ` until ${formatResetAt(until, now)}` : ""}. What you send now waits until then.` };
}

/** A route's figure in the model menu (`RouteLeft`): a bar or none, the number, its tone and title. */
export function routeLeftOf(account: LimitAccountView | undefined, now: number): { bar: number | null | false; text: string; tone: string; money: boolean; title: string } | undefined {
  if (account === undefined) return undefined;
  if (account.kind === "spend" || (account.kind === "credit" && account.credit === undefined)) {
    const week = account.spent7d ?? 0;
    if (week <= 0 && account.creditRefusedAt === undefined) return undefined;
    const tone = account.creditRefusedAt !== undefined ? "bad" : "none";
    return { bar: false, text: formatUsd(week), tone, money: true, title: `${formatUsd(week)} spent through JaiRA on this key in the last 7 days` };
  }
  if (account.kind === "credit" && account.credit !== undefined) {
    const pct = isSpent(account.reading, now) ? 100 : creditPercent(account.credit);
    return { bar: pct, text: formatUsd(account.credit.usedUsd), tone: toneOfPercent(pct), money: true, title: `${formatUsd(account.credit.usedUsd)} of the credit used${pct !== null ? ` (${round(pct)}%)` : ""}` };
  }
  if (account.reading === null) return undefined;
  const spent = isSpent(account.reading, now);
  const pct = usedPercentFor(account.reading, undefined, now);
  if (pct === null && !spent) return undefined;
  const tone = spent ? "bad" : toneOfPercent(pct);
  const until = spent ? spentUntil(account.reading, now) : null;
  return {
    bar: spent ? false : pct,
    text: spent ? (until !== null ? formatResetAt(until, now) : "spent") : `${round(pct ?? 0)}%`,
    tone,
    money: false,
    title: spent ? `no usage left until ${formatResetAt(until, now)}` : `${round(pct ?? 0)}% of the tightest window used`,
  };
}

/** A model's own window in the model menu (`ModelWindow`): the one that counts this model alone. */
export function modelWindowOf(account: LimitAccountView | undefined, model: string, now: number): { pct: number | null; tone: string; text: string; title: string } | undefined {
  const id = model.toLowerCase();
  const own = (account?.reading?.windows ?? []).filter((w) => w.model !== undefined && id.includes(w.model.toLowerCase()) && windowIsCurrent(w, now));
  if (own.length === 0) return undefined;
  const w = own.reduce((a, b) => ((b.usedPercent ?? 0) > (a.usedPercent ?? 0) ? b : a));
  const pct = windowStatus(w) === "exhausted" ? 100 : w.usedPercent;
  return {
    pct,
    tone: toneOfPercent(pct),
    text: pct === null ? "–" : `${round(pct)}%`,
    title: `${w.label}: ${pct === null ? "no figure" : `${round(pct)}% used`}${w.resetsAt !== null ? `, resets ${formatResetAt(w.resetsAt, now)}` : ""}`,
  };
}
