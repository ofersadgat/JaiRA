/**
 * The account figure the composer shows after the model chip — moved out of `usageMeters.tsx` unchanged (decision 0015).
 */
import {
  creditPercent,
  formatUsd,
  isSpent,
  toneOfPercent,
  usedPercentFor,
  weeklyWindow,
  windowStatus,
  type LimitAccountView,
  type LimitWindow,
} from "@jaira/shared/browser";

const round = (n: number): number => Math.round(n);

/**
 * One account's figure, worked out once and drawn in several places (usage-readings contract,
 * "API keys"): after the model chip, on a Connections card, in the preview of the setting.
 *
 *  - a subscription: the percent of the tightest window, in its tone;
 *  - a credit (OpenRouter): what is SPENT, in dollars, coloured by the share of the credit that is;
 *  - a key whose provider says nothing (Anthropic, OpenAI): what THIS CONVERSATION cost, grey — red
 *    only once a call was refused for an empty balance — and its ring the conversation's share of
 *    what the key spent in the last seven days.
 */
export interface UsageFigure {
  /** The share a ring draws, 0–100; `null` draws an empty ring. */
  pct: number | null;
  tone: "accent" | "warn" | "bad" | "none";
  /** The number, as written ("62%", "$11.60"). */
  text: string;
  /** Money: the ring carries a $ so it is not read as a subscription. */
  money: boolean;
  /** The figure in words, for the hover. */
  title: string;
}

/** Work out an account's figure — see {@link UsageFigure}. `cost` is the open conversation's, when there is one. */
export function figureOf(account: LimitAccountView, options: { model?: string | undefined; cost?: number | undefined; now: number }): UsageFigure {
  const { model, cost, now } = options;
  if (account.kind === "credit" && account.credit !== undefined) {
    const pct = isSpent(account.reading, now) ? 100 : creditPercent(account.credit);
    return {
      pct,
      tone: toneOfPercent(pct),
      text: formatUsd(account.credit.usedUsd),
      money: true,
      title: `${account.brand} · ${formatUsd(account.credit.usedUsd)} of the credit used${pct !== null ? ` (${round(pct)}%)` : ""}`,
    };
  }
  if (account.kind === "spend" || account.kind === "credit") {
    const week = account.spent7d ?? 0;
    const spent = cost ?? 0;
    const pct = week > 0 ? Math.min(100, (spent / week) * 100) : null;
    const refused = account.creditRefusedAt !== undefined;
    return {
      pct: refused ? 100 : pct,
      tone: refused ? "bad" : "none",
      text: formatUsd(spent),
      money: true,
      title: refused
        ? `${account.brand} refused a call: the balance is empty`
        : `${account.brand} · this conversation ${formatUsd(spent)}${week > 0 ? `, ${round(pct ?? 0)}% of the ${formatUsd(week)} spent on this key in the last 7 days` : ""}`,
    };
  }
  const pct = usedPercentFor(account.reading, model, now);
  return {
    pct,
    tone: toneOfPercent(pct),
    text: pct === null ? "–" : `${round(pct)}%`,
    money: false,
    title: account.reading === null ? `${account.brand}: no usage reading yet` : `${account.brand} · ${pct === null ? "no figure yet" : `${round(pct)}% of the tightest window used`}`,
  };
}


/**
 * A sign-in card's figure (`AccountAllowance`): the account's WEEKLY window — its percent, whether it
 * is used up, and the figure the ring and number draw.
 */
export function weeklyFigureOf(account: LimitAccountView | undefined): { week: LimitWindow | undefined; spent: boolean; pct: number | null; tone: UsageFigure["tone"]; figure: UsageFigure } {
  const week = account?.reading !== null && account?.reading !== undefined ? weeklyWindow(account.reading) : undefined;
  const spent = week !== undefined && windowStatus(week) === "exhausted";
  const pct = week === undefined ? null : spent ? 100 : week.usedPercent;
  const tone = toneOfPercent(pct);
  const figure: UsageFigure = { pct, tone, text: pct === null ? "–" : `${round(pct)}%`, money: false, title: "" };
  return { week, spent, pct, tone, figure };
}

/** The hover of a sign-in card's figure. */
export function weeklyTitleOf(week: LimitWindow | undefined, pct: number | null): string {
  return week === undefined ? "No weekly reading yet — click for every window" : `Weekly window, ${pct === null ? "no figure" : `${round(pct)}% used`} — click for every window`;
}

/**
 * An API key's box on Connections (`KeyUsage`): what is spent — the credit used, in the tone of its
 * share, or what JaiRA's calls on the key cost in the last seven days, grey — and what that is. Nothing
 * for a subscription.
 */
export function keyFigureOf(account: LimitAccountView, now: number): { credit: boolean; figure: UsageFigure; under: string; refused: boolean } {
  const credit = account.kind === "credit" && account.credit !== undefined;
  const figure: UsageFigure = credit
    ? figureOf(account, { now })
    : { pct: null, tone: account.creditRefusedAt !== undefined ? "bad" : "none", text: formatUsd(account.spent7d ?? 0), money: true, title: `${formatUsd(account.spent7d ?? 0)} spent through JaiRA in the last 7 days` };
  const refused = account.creditRefusedAt !== undefined;
  const under = credit ? "credit used" : refused ? "refused: balance empty" : "no balance reported";
  return { credit, figure, under, refused };
}

/**
 * The setting's preview (`UsageFiguresPreview`): the composer's model chip and its figure, on a
 * subscription, a key whose provider reports its credit, and a key whose provider does not.
 */
export const USAGE_PREVIEW_EXAMPLES: ReadonlyArray<{ brand: string; model: string; label: string; figure: UsageFigure }> = [
  { brand: "claude-cli", model: "claude-cli/claude-sonnet-5", label: "subscription", figure: { pct: 62, tone: "accent", text: "62%", money: false, title: "" } },
  { brand: "openrouter", model: "openrouter/claude-sonnet-5", label: "credit reported", figure: { pct: 58, tone: "accent", text: "$11.60", money: true, title: "" } },
  { brand: "anthropic", model: "anthropic/claude-sonnet-5", label: "no balance reported", figure: { pct: 18, tone: "none", text: "$1.20", money: true, title: "" } },
];
