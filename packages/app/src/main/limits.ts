/**
 * The app's limits board: ONE per process, machine-wide (docs/engineering/contracts/usage-readings.md).
 *
 * The board itself is upstream's (`createLimitsBoard`); this is what the app adds around it — it is
 * remembered across restarts (`~/.jaira/system/limits.json`), it knows how to refresh the accounts
 * the app can reach (claude by asking a claude process, codex from its session files), it tells the
 * renderer when anything changes, and it knows who each account is from the sign-in probes.
 *
 * Every call the app makes through the session layers reports to it (`SessionStores.limits`), so it
 * fills by itself as conversations run. It refreshes on its own while the renderer's meters watch
 * it, and once for an account it has not seen before (`noticeAccounts`).
 *
 * An API key is MONEY rather than windows (usage-readings contract, "API keys"). What each call on a
 * key cost is kept here, per account, for seven days — the board holds percents and no provider says
 * what a key has spent — and OpenRouter, the one provider that says how much credit there is, is
 * refreshed into a credit. A refusal for an empty balance is remembered until a call goes through.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLimitsBoard, type Disposable, type LimitsBoard, type LimitState, type PositionLimits } from "@declarative-ai/exec";
import { accountOfRoute, MONEY_ROUTES, type AgentAccount, type CreditFigures, type LimitAccountView, type LimitReading, type LimitsView, type PushMessage, type UsageCase } from "@jaira/shared";
import { claudeUsageCommands, readOpenRouterCredit, refreshClaudeLimits, refreshCodexLimits } from "@jaira/runtime";

export interface LimitsServiceOptions {
  /** Where the board is remembered. */
  file: string;
  /** How a change reaches the renderer (a bare, machine-wide push). */
  publish: (message: PushMessage) => void;
  /** The configured claude command, when one is configured. */
  claudeCommand: () => string | undefined;
  /** What the sign-in probes last said, per executor — who each account is. */
  probes: () => ReadonlyArray<{ name: string; accounts?: AgentAccount[] }>;
  /** Every route the app knows (model routes and agent executors), to say which account each spends. */
  routes: () => readonly string[];
  /** The OpenRouter key, resolved, when one is configured — what its credit is read with. */
  openRouterKey?: () => string | undefined;
  /** Tests: no refresh processes, a fixed clock. */
  refresh?: boolean;
  now?: () => number;
}

interface Stored {
  version: 1;
  accounts: Record<string, LimitState>;
  /** What each call on a money account cost: `[at ms, usd]`, the last seven days. */
  spend?: Record<string, Array<[number, number]>>;
  /** The last credit read, per account. */
  credit?: Record<string, CreditFigures>;
  /** When a call on the account was last refused for an empty balance. */
  refused?: Record<string, string>;
  /** Who each account was when last seen — see {@link LimitsService.noticeAccounts}. */
  seen?: Record<string, string>;
}

/** How long spend is kept, and what "the last seven days" means — rolling, not a calendar week. */
const SPEND_WINDOW_MS = 7 * 86_400_000;

const BRAND: Record<string, string> = { claude: "claude-cli", codex: "codex-cli" };

export class LimitsService {
  readonly board: LimitsBoard;
  /** What the session layers are built with — see `SessionStores.limits`. */
  readonly position: PositionLimits;
  private readonly unavailable = new Map<string, string>();
  private readonly listening: Disposable;
  private watching: Disposable | undefined;
  private watchers = 0;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly spend = new Map<string, Array<[number, number]>>();
  private readonly credit = new Map<string, CreditFigures>();
  private readonly refused = new Map<string, string>();
  private readonly seen = new Map<string, string>();

  constructor(private readonly options: LimitsServiceOptions) {
    const stored = this.load();
    for (const [k, rows] of Object.entries(stored.spend ?? {})) this.spend.set(k, rows);
    for (const [k, c] of Object.entries(stored.credit ?? {})) this.credit.set(k, c);
    for (const [k, at] of Object.entries(stored.refused ?? {})) this.refused.set(k, at);
    for (const [k, who] of Object.entries(stored.seen ?? {})) this.seen.set(k, who);
    this.board = createLimitsBoard({ initial: Object.entries(stored.accounts ?? {}), ...(options.now !== undefined ? { now: options.now } : {}) });
    this.position = { limits: this.board, accountOf: accountOfRoute, spent: (account, _route, costUsd) => this.spent(account, costUsd) };
    // Listening, not watching: persisting and forwarding changes must not start the refresh timer.
    this.listening = this.board.subscribe(() => this.changed(), { watch: false });
    if (options.refresh !== false) {
      this.board.offerRefresh("claude", async (signal) => {
        const out = await refreshClaudeLimits(claudeUsageCommands(options.claudeCommand()), signal);
        if (out.reading !== undefined) this.unavailable.delete("claude");
        else if (out.unavailable !== undefined) this.unavailable.set("claude", out.unavailable);
        return out.reading;
      });
      this.board.offerRefresh("codex", async () => {
        const reading = await refreshCodexLimits();
        if (reading !== undefined) this.unavailable.delete("codex");
        else this.unavailable.set("codex", "no codex session on this machine has reported its limits yet");
        return reading;
      });
      this.board.offerRefresh("openrouter", async (signal) => {
        const key = options.openRouterKey?.();
        if (key === undefined) return undefined;
        const credit = await readOpenRouterCredit(key, signal);
        if (credit === undefined) {
          this.unavailable.set("openrouter", "this key has no spending limit and cannot read the account's credit (that needs a management key)");
          return undefined;
        }
        this.unavailable.delete("openrouter");
        this.credit.set("openrouter", credit);
        return creditReading("openrouter", credit, new Date(this.now()).toISOString());
      });
    }
  }

  /** A call on a money account cost this much — kept for the last seven days. */
  spent(account: string, costUsd: number): void {
    if (!(costUsd > 0)) return;
    const now = this.now();
    const rows = (this.spend.get(account) ?? []).filter(([at]) => now - at < SPEND_WINDOW_MS);
    rows.push([now, costUsd]);
    this.spend.set(account, rows);
    // A call that went through says the balance is not empty any more.
    this.refused.delete(account);
    this.changed();
  }

  /** A call on this account was refused because its balance is empty. */
  creditRefused(account: string): void {
    this.refused.set(account, new Date(this.now()).toISOString());
    this.changed();
  }

  /** What JaiRA's calls on this account cost in the last seven days. */
  spentLastWeek(account: string): number {
    const now = this.now();
    return (this.spend.get(account) ?? []).reduce((sum, [at, usd]) => (now - at < SPEND_WINDOW_MS ? sum + usd : sum), 0);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Every account worth showing, and which account each route spends. */
  view(): LimitsView {
    const routes = [...new Set(this.options.routes())];
    const routeAccounts = Object.fromEntries(routes.map((r) => [r, accountOfRoute(r)]));
    const keys = new Set<string>([...this.board.all().keys()]);
    for (const account of Object.values(routeAccounts)) if (account === "claude" || account === "codex" || MONEY_ROUTES.includes(account)) keys.add(account);
    const probes = this.options.probes();
    const accounts: LimitAccountView[] = [...keys].sort().map((key) => {
      const state = this.board.state(key);
      const spending = routes.filter((r) => routeAccounts[r] === key);
      const login = probes
        .filter((p) => accountOfRoute(p.name) === key)
        .flatMap((p) => p.accounts ?? [])
        .find((a) => a.active);
      const plan = state.reading?.plan ?? login?.plan ?? null;
      const unavailable = this.unavailable.get(key);
      const money = MONEY_ROUTES.includes(key);
      const credit = money ? this.credit.get(key) : undefined;
      const kind: UsageCase = !money ? "subscription" : credit !== undefined ? "credit" : "spend";
      const refusedAt = this.refused.get(key);
      return {
        key,
        routes: spending.length > 0 ? spending : [BRAND[key] ?? key],
        brand: BRAND[key] ?? key,
        ...(login !== undefined ? { who: login.label } : {}),
        plan,
        reading: state.reading,
        updatedAt: state.updatedAt,
        lastSentAt: state.lastSentAt,
        refreshing: state.refreshing,
        refreshable: this.options.refresh !== false && (key === "claude" || key === "codex" || (key === "openrouter" && this.options.openRouterKey?.() !== undefined)),
        ...(unavailable !== undefined ? { unavailable } : {}),
        kind,
        ...(credit !== undefined ? { credit } : {}),
        ...(money ? { spent7d: this.spentLastWeek(key) } : {}),
        ...(refusedAt !== undefined ? { creditRefusedAt: refusedAt } : {}),
      };
    });
    return { accounts, routeAccounts };
  }

  /**
   * The sign-ins or the keys may have changed: read at once every account that is NEW — a login that
   * was not there, somebody else's login, an OpenRouter key put in — rather than showing nothing, or
   * the last login's figures, until the first reply or a Refresh. An account seen before, across a
   * restart too, is left to the board's own rules; one that went away has nothing to read.
   */
  noticeAccounts(): void {
    for (const [key, who] of this.identities()) {
      if (this.seen.get(key) === who) continue;
      this.seen.set(key, who);
      this.changed();
      void this.board.refresh(key).catch(() => undefined);
    }
  }

  /** A sign-in just succeeded on this account: the next {@link noticeAccounts} reads it, even when it is the same login again. */
  signedIn(account: string): void {
    this.seen.delete(account);
  }

  /** Who each account is now: its login, or which OpenRouter key (a hash of it — never the key). */
  private identities(): Map<string, string> {
    const out = new Map<string, string>();
    for (const probe of this.options.probes()) {
      const login = probe.accounts?.find((a) => a.active);
      if (login !== undefined) out.set(accountOfRoute(probe.name), login.label);
    }
    const openRouter = this.options.openRouterKey?.();
    if (openRouter !== undefined) out.set("openrouter", createHash("sha256").update(openRouter).digest("hex").slice(0, 16));
    return out;
  }

  /** A person pressed Refresh. */
  async refresh(account: string): Promise<LimitsView> {
    await this.board.refresh(account);
    return this.view();
  }

  /** A meter came on screen (`true`) or went away (`false`). */
  watch(on: boolean): void {
    this.watchers = Math.max(0, this.watchers + (on ? 1 : -1));
    if (this.watchers > 0 && this.watching === undefined) this.watching = this.board.subscribe(() => undefined, { watch: true });
    if (this.watchers === 0 && this.watching !== undefined) {
      this.watching.dispose();
      this.watching = undefined;
    }
  }

  close(): void {
    this.listening.dispose();
    this.watching?.dispose();
    this.board.close();
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.save();
    }
    if (this.pushTimer !== undefined) clearTimeout(this.pushTimer);
  }

  private changed(): void {
    // Coalesced: a stream event, a refresh starting and one ending are three changes in a breath.
    if (this.saveTimer === undefined) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined;
        this.save();
      }, 1_000);
      (this.saveTimer as { unref?: () => void }).unref?.();
    }
    if (this.pushTimer === undefined) {
      this.pushTimer = setTimeout(() => {
        this.pushTimer = undefined;
        try {
          this.options.publish({ type: "limits:changed", view: this.view() });
        } catch {
          // A window that went away costs this push, not the board.
        }
      }, 100);
      (this.pushTimer as { unref?: () => void }).unref?.();
    }
  }

  private load(): Partial<Stored> {
    try {
      const stored = JSON.parse(readFileSync(this.options.file, "utf8")) as Partial<Stored>;
      return stored.version === 1 ? stored : {};
    } catch {
      return {};
    }
  }

  private save(): void {
    const now = this.now();
    const stored: Stored = {
      version: 1,
      accounts: Object.fromEntries([...this.board.all()].map(([k, s]) => [k, { ...s, refreshing: false }])),
      spend: Object.fromEntries([...this.spend].map(([k, rows]) => [k, rows.filter(([at]) => now - at < SPEND_WINDOW_MS)])),
      credit: Object.fromEntries(this.credit),
      refused: Object.fromEntries(this.refused),
      seen: Object.fromEntries(this.seen),
    };
    try {
      mkdirSync(dirname(this.options.file), { recursive: true });
      const tmp = `${this.options.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(stored, null, 2) + "\n", "utf8");
      renameSync(tmp, this.options.file);
    } catch {
      // Remembering is a convenience: the next reading fills the board again.
    }
  }
}

/**
 * A credit as a board reading: one window, `Credit`, the share used — so everything that reads a
 * reading (spent, the tightest window, `most-left`) reads a credit too. No reset: credit comes back
 * when somebody adds it, which is why a message held on it is looked at again every half hour.
 */
export function creditReading(route: string, credit: CreditFigures, at: string): LimitReading {
  const usedPercent = credit.totalUsd > 0 ? Math.min(100, (credit.usedUsd / credit.totalUsd) * 100) : 100;
  const exhausted = credit.usedUsd >= credit.totalUsd;
  return {
    route,
    plan: null,
    windows: [{ id: "credit", label: "Credit", minutes: null, usedPercent, resetsAt: null, ...(exhausted ? { status: "exhausted" as const } : {}) }],
    status: exhausted ? "exhausted" : "ok",
    source: "query",
    at,
    complete: true,
  };
}
