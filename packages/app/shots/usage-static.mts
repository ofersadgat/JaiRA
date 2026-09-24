/**
 * The usage readings, server-rendered to one static page — the real components over the real
 * stylesheet, with no Electron in the way (usage-readings contract, "What the screens show").
 *
 * `npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/usage-static.mts <out.html> [light|dark]`
 *
 * The board is seeded with example accounts (claude at 62% of its 5-hour window, 33% of the week;
 * codex at 2% and 33%; an OpenRouter key with $11.60 of a $20 credit used; an Anthropic key that spent
 * $6.80 in the last seven days), so every stage draws what a person would see with those readings.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatPlanView, ContextReading, LimitAccountView, WaitingItem } from "@jaira/shared";
import type { TranscriptEntry } from "../src/renderer/transcript";
import { Composer, type ComposerOpen } from "../src/renderer/composer";
import { publishLimits, publishUsageFigures } from "../src/renderer/limitsStore";
import { ContextDetail, KeyUsage, UsageFiguresPreview, WaitingLine, WaitingMessage } from "../src/renderer/usageMeters";
import type { UsageFigures } from "@jaira/shared";
import { Paper, Transcript } from "../src/renderer/transcriptView";
import { StateHeader } from "../src/renderer/stateSurface";
import { LoginCards } from "../src/renderer/providersPane";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: usage-static.mts <out.html> [light|dark]");

const at = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();
const account = (key: string, brand: string, who: string, plan: string, five: number, week: number, opus?: number): LimitAccountView => ({
  key,
  routes: [brand],
  brand,
  who,
  plan,
  kind: "subscription" as const,
  reading: {
    route: brand,
    plan,
    windows: [
      { id: key === "codex" ? "primary" : "five_hour", label: "5-hour", minutes: 300, usedPercent: five, resetsAt: at(1.2), ...(five >= 100 ? { status: "exhausted" as const } : {}) },
      { id: key === "codex" ? "secondary" : "seven_day", label: "Weekly", minutes: 10080, usedPercent: week, resetsAt: at(94), ...(week >= 100 ? { status: "exhausted" as const } : {}) },
      ...(opus !== undefined ? [{ id: "seven_day_opus", label: "Weekly · Opus", minutes: 10080, usedPercent: opus, resetsAt: at(94), model: "opus" }] : []),
    ],
    status: five >= 100 || week >= 100 ? "exhausted" : "ok",
    source: key === "codex" ? "file" : "query",
    at: new Date().toISOString(),
    complete: true,
  },
  updatedAt: new Date(Date.now() - 180_000).toISOString(),
  lastSentAt: null,
  refreshing: false,
  refreshable: true,
});
/** An API key: a credit (OpenRouter) with `used` of $20 spent, or spend alone (Anthropic). */
const key = (route: string, extra: Partial<LimitAccountView>): LimitAccountView => ({
  key: route,
  routes: [route],
  brand: route,
  who: `${route.toUpperCase()}_API_KEY`,
  plan: null,
  reading: null,
  updatedAt: new Date(Date.now() - 120_000).toISOString(),
  lastSentAt: null,
  refreshing: false,
  refreshable: route === "openrouter",
  kind: "spend",
  spent7d: 6.8,
  ...extra,
});
const credit = (used: number): LimitAccountView =>
  key("openrouter", {
    kind: "credit",
    credit: { usedUsd: used, totalUsd: 20, source: "account" },
    spent7d: 4.1,
    reading: {
      route: "openrouter",
      plan: null,
      windows: [{ id: "credit", label: "Credit", minutes: null, usedPercent: (used / 20) * 100, resetsAt: null, ...(used >= 20 ? { status: "exhausted" as const } : {}) }],
      status: used >= 20 ? "exhausted" : "ok",
      source: "query",
      at: new Date().toISOString(),
      complete: true,
    },
  });
const seed = (claudeFive: number, claudeWeek = 33, codexWeek = 33, money: { used?: number; refused?: boolean; figures?: UsageFigures } = {}): void => {
  publishUsageFigures(money.figures ?? "number");
  publishLimits({
    accounts: [
      account("claude", "claude-cli", "ofer.sadgat@gmail.com", "max", claudeFive, claudeWeek, 71),
      account("codex", "codex-cli", "ChatGPT", "plus", 2, codexWeek),
      credit(money.used ?? 11.6),
      key("anthropic", money.refused === true ? { creditRefusedAt: new Date().toISOString() } : {}),
    ],
    routeAccounts: { "claude-cli": "claude", "claude-code": "claude", "codex-cli": "codex", anthropic: "anthropic", openrouter: "openrouter" },
  });
};

const CONTEXT: ContextReading = {
  used: 76210,
  window: 200000,
  model: "claude-sonnet-5",
  autoCompactAt: 166000,
  breakdown: [
    { name: "System prompt", tokens: 9800 },
    { name: "System tools", tokens: 14300, parts: [{ name: "Bash", tokens: 2900 }, { name: "Edit", tokens: 2400 }, { name: "Read", tokens: 2100 }] },
    { name: "MCP tools", tokens: 3500, parts: [{ name: "dai", tokens: 1500, parts: [{ name: "approve", tokens: 600 }, { name: "ask_user", tokens: 900 }] }, { name: "31 more", tokens: 0, note: "deferred — not in context yet" }] },
    { name: "Messages", tokens: 48610, parts: [{ name: "Tool results", tokens: 30200, parts: [{ name: "Read", tokens: 21600 }, { name: "Bash", tokens: 6200 }, { name: "Grep", tokens: 2400 }] }, { name: "Answers", tokens: 9800 }, { name: "Your messages", tokens: 2200 }] },
  ],
  at: "t",
};

const plan = (model: string): ChatPlanView =>
  ({
    settings: { model },
    origin: { model: "inherited", reasoning: "inherited", tools: "unset", permissions: "unset", implementations: "unset", permissionSet: "unset" },
    from: "chat/session",
    unresolved: [],
    live: "idle",
    effective: { model, reasoning: "high", permissions: "ask first" },
    available: {
      routes: ["anthropic", "openrouter", "claude-cli", "codex-cli"],
      tools: [],
      models: [
        { id: "claude-cli/claude-opus-5", route: "claude-cli" },
        { id: "claude-cli/claude-sonnet-5", route: "claude-cli" },
        { id: "claude-cli/claude-haiku-4-5", route: "claude-cli" },
      ],
      permissionSets: [],
      bucket: "chat",
    },
  }) as unknown as ChatPlanView;

const noop = (): undefined => undefined;
const composer = (startOpen: ComposerOpen, context: ContextReading | undefined = CONTEXT, text = "", model = "claude-cli/claude-sonnet-5", cost?: number): ReactElement =>
  createElement(Composer, {
    plan: plan(model),
    overrides: {},
    onOverrides: noop,
    onSend: noop,
    placeholder: "Reply…",
    value: text,
    onValue: noop,
    startOpen,
    usage: { context, onCompact: noop, ...(cost !== undefined ? { cost } : {}) },
  });

const turns: TranscriptEntry[] = [
  { kind: "message", role: "user", text: "Why does the inbox strip skip gates when two questions are waiting?", at: Date.now() - 3_600_000 },
  { kind: "message", role: "assistant", text: "The strip lists agent questions first, then approvals, then gates, and keeps at most two of each kind.", at: Date.now() - 3_590_000, context: { ...CONTEXT, used: 24000 } },
  { kind: "message", role: "user", text: "Read every strip test and tell me which ones pin that order.", at: Date.now() - 3_000_000 },
  { kind: "message", role: "assistant", text: "Three tests pin it: inboxStrip.order, overflow.count and gates.last.", at: Date.now() - 2_990_000, context: CONTEXT },
  { kind: "message", role: "user", text: "Now read the renderer and the three components it draws.", at: Date.now() - 2_400_000 },
  { kind: "message", role: "assistant", text: "The change is one comparator in inboxOrder.ts; the components need nothing.", at: Date.now() - 2_390_000, context: { ...CONTEXT, used: 168400 } },
  { kind: "compaction", trigger: "auto", before: 168400, after: 42000, durationMs: 18000, at: Date.now() - 1_800_000 },
  { kind: "message", role: "assistant", text: "Done — gates now sort by age with the questions.", at: Date.now() - 1_790_000, context: { ...CONTEXT, used: 43000 } },
] as TranscriptEntry[];

const waiting = (extra: Partial<WaitingItem>): WaitingItem => ({
  id: "w1",
  kind: "message",
  project: "p",
  taskId: "t",
  instanceId: "i",
  message: "Now split inboxOrder into its own module and move the tests",
  account: "claude",
  until: at(1.2),
  state: "waiting",
  retry: true,
  createdAt: new Date().toISOString(),
  ...extra,
});

const headers = (): ReactElement =>
  createElement(
    "div",
    { className: "sb-panel" },
    createElement("section", { className: "sb-sheet" },
      createElement("div", { className: "sb-body" },
        createElement("div", { className: "st-block" }, createElement(StateHeader, { open: true, name: "draft", label: "Draft the features", meta: "10:02:11 · 3 m 12 s", added: 31000, status: "completed", onToggle: noop })),
        createElement("div", { className: "st-block is-shut" }, createElement(StateHeader, { open: false, name: "critique", meta: "10:05:24 · 3 m 5 s", added: 8000, status: "completed", onToggle: noop })),
        createElement("div", { className: "st-block" }, createElement(StateHeader, { open: true, tone: "accent", name: "verify", label: "Verify the features", meta: "10:08:31 · 1 m 20 s so far", added: 30000, status: "running", onToggle: noop })),
      ),
    ),
  );

const cards = (): ReactElement =>
  createElement(
    "div",
    { className: "set-group" },
    createElement(
      "ul",
      { className: "cfg-rows" },
      ...[
        { agent: "claude-cli", accounts: [{ label: "ofer.sadgat@gmail.com", plan: "max", method: "claude.ai", active: true }] },
        { agent: "codex-cli", accounts: [{ label: "ChatGPT", plan: "plus", active: true }] },
      ].map((row) =>
        createElement(
          "li",
          { key: row.agent, className: "cfg-row conn-row available" },
          createElement("div", { className: "conn-main" }, createElement("div", { className: "cfg-row-head" }, createElement("span", { className: "cfg-row-title" }, row.agent))),
          createElement("ul", { className: "conn-boxes" }, createElement(LoginCards, { agent: row.agent, command: undefined, accounts: row.accounts, signingIn: false, busy: false, onSignIn: noop, onCancel: noop, onSignOut: noop })),
          createElement("div", { className: "conn-controls" }),
        ),
      ),
    ),
  );

const keyBoxes = (): ReactElement =>
  createElement(
    "ul",
    { className: "conn-boxes" },
    ...["openrouter", "anthropic"].map((route) =>
      createElement(
        "li",
        { key: route, className: "cfg-key-box" },
        createElement("span", { className: "cfg-login-who" }, `${route.toUpperCase()}_API_KEY`),
        createElement("span", { className: "cfg-login-facts" }, createElement("span", null, "in the keychain")),
        createElement(KeyUsage, { route }),
      ),
    ),
  );

const previews = (): ReactElement =>
  createElement("div", { style: { display: "grid", gap: 8 } }, ...(["off", "number", "ring", "both"] as const).map((mode) => createElement(UsageFiguresPreview, { key: mode, mode })));

type Stage = { name: string; caption: string; lift: number; width?: number; draw: () => ReactElement; seed?: () => void };
const STAGES: Stage[] = [
  { name: "composer-rest", caption: "the composer: the account's 62% after the model chip, the conversation's ring before the paperclip", lift: 0, draw: () => composer({}), seed: () => seed(62) },
  { name: "composer-context", caption: "the ring opened: this conversation — the breakdown, where it compacts, Compact now", lift: 420, draw: () => composer({ usage: "context" }), seed: () => seed(62) },
  { name: "context-hover", caption: "a category opened: Messages", lift: 0, width: 760, draw: () => createElement("div", { className: "cx-pop um-pop", style: { position: "relative", bottom: "auto", left: 360, width: 380 } }, createElement(ContextDetail, { context: CONTEXT, onCompact: noop, hover: "Messages" })), seed: () => seed(62) },
  { name: "composer-account", caption: "the number opened: every window of the account, when each resets, the other accounts", lift: 330, draw: () => composer({ usage: "account" }), seed: () => seed(62) },
  { name: "composer-warn", caption: "a window at 86%, and the context at 84%", lift: 0, draw: () => composer({}, { ...CONTEXT, used: 168400 }), seed: () => seed(86) },
  { name: "composer-spent", caption: "no usage left: the line over the box, the red number, and Send as a clock", lift: 0, draw: () => composer({}, CONTEXT, "Now split inboxOrder into its own module"), seed: () => seed(100) },
  { name: "composer-model", caption: "the model menu: each route's account, and the Opus-only window on its model", lift: 290, draw: () => composer({ card: "Model" }), seed: () => seed(62) },
  { name: "transcript", caption: "every answer's context on its rail; a compaction as a line", lift: 0, draw: () => createElement(Paper, null, createElement(Transcript, { session: null, entries: turns })), seed: () => seed(62) },
  { name: "waiting", caption: "a message waiting for the reset; a refused one with Try again at …", lift: 0, draw: () => createElement("div", { className: "um-waiting-host" }, createElement(WaitingMessage, { item: waiting({}) }), createElement(WaitingLine, { item: waiting({ id: "w2", state: "refused" }) })), seed: () => seed(100) },
  { name: "run-waiting", caption: "a run refused mid-turn", lift: 0, draw: () => createElement("div", { className: "cx-doing um-waiting-run" }, createElement(WaitingLine, { item: waiting({ kind: "run", state: "refused" }), run: true, onStop: noop })), seed: () => seed(100) },
  { name: "headers", caption: "each state's header: what it added, at the right before the time — open or folded, no cost", lift: 0, draw: headers, seed: () => seed(62) },
  { name: "cards", caption: "Settings → Connections: the weekly figure and when the week resets (codex's week used up)", lift: 0, draw: cards, seed: () => seed(62, 33, 100) },
  // API keys: money, not windows.
  { name: "credit-composer", caption: "an OpenRouter key: what the credit has SPENT, coloured by its share (58%: ink)", lift: 0, draw: () => composer({}, CONTEXT, "", "openrouter/anthropic/claude-sonnet-5", 1.2), seed: () => seed(62) },
  { name: "credit-warn", caption: "$16.00 of $20 (80%): amber from 75%", lift: 0, draw: () => composer({}, CONTEXT, "", "openrouter/anthropic/claude-sonnet-5", 1.2), seed: () => seed(62, 33, 33, { used: 16 }) },
  { name: "credit-spent", caption: "the credit used up: the line over the box, and messages wait", lift: 0, draw: () => composer({}, CONTEXT, "Now split inboxOrder", "openrouter/anthropic/claude-sonnet-5", 6.1), seed: () => seed(62, 33, 33, { used: 20 }) },
  { name: "credit-popover", caption: "the figure opened: this conversation, then the credit used — never what is left", lift: 330, draw: () => composer({ usage: "account" }, CONTEXT, "", "openrouter/anthropic/claude-sonnet-5", 1.2), seed: () => seed(62) },
  { name: "spend-composer", caption: "an Anthropic key: this conversation's cost, grey", lift: 0, draw: () => composer({}, CONTEXT, "", "anthropic/claude-sonnet-5", 1.2), seed: () => seed(62) },
  { name: "spend-refused", caption: "refused for an empty balance: red, and the line says so", lift: 0, draw: () => composer({}, CONTEXT, "", "anthropic/claude-sonnet-5", 1.2), seed: () => seed(62, 33, 33, { refused: true }) },
  { name: "spend-popover", caption: "the figure opened: the conversation's share of the key's last seven days", lift: 330, draw: () => composer({ usage: "account" }, CONTEXT, "", "anthropic/claude-sonnet-5", 1.2), seed: () => seed(62) },
  { name: "both", caption: "Usage figures: Both — the ring (with a $ for money) beside the figure", lift: 0, draw: () => composer({}, CONTEXT, "", "openrouter/anthropic/claude-sonnet-5", 1.2), seed: () => seed(62, 33, 33, { figures: "both" }) },
  { name: "money-menu", caption: "the model menu: a credit's dollars beside its bar, a spend key's week in grey", lift: 290, draw: () => composer({ card: "Model" }, CONTEXT, "", "anthropic/claude-sonnet-5", 1.2), seed: () => seed(62) },
  { name: "key-boxes", caption: "Settings → Connections: an API key's box — what it spent", lift: 0, draw: keyBoxes, seed: () => seed(62) },
  { name: "preview", caption: "Appearance → Conversation → Usage figures: the preview, in each mode", lift: 0, draw: previews, seed: () => seed(62) },
];

const css = pathToFileURL(join(import.meta.dirname, "..", "src", "renderer", "styles.css")).href;
const html = STAGES.map((s) => {
  s.seed?.();
  return (
    `<p style="margin:26px 0 8px;font:12px sans-serif;color:var(--dim)">${s.name} · ${s.caption}</p>` +
    `<div data-stage="${s.name}" style="width:${s.width ?? 932}px;padding-top:${s.lift}px;background:var(--bg);position:relative">${renderToStaticMarkup(s.draw())}</div>`
  );
}).join("");
writeFileSync(
  out,
  `<!doctype html><html data-theme="${process.argv[3] ?? "light"}" data-palette="ink"><head><meta charset="utf8"><link rel="stylesheet" href="${css}"></head>` +
    `<body style="overflow:auto;height:auto;padding:16px;background:var(--bg)">${html}</body></html>`,
);
console.log(`wrote ${out}`);
