/**
 * The app's limits board: ONE per process, machine-wide (docs/engineering/contracts/usage-readings.md).
 *
 * The board itself is upstream's (`createLimitsBoard`); this is what the app adds around it — it is
 * remembered across restarts (`~/.jaira/system/limits.json`), it knows how to refresh the accounts
 * the app can reach (claude by asking a claude process, codex from its session files), it tells the
 * renderer when anything changes, and it knows who each account is from the sign-in probes.
 *
 * Every call the app makes through the session layers reports to it (`SessionStores.limits`), so it
 * fills by itself as conversations run; the renderer's meters watch it, which is the only time it
 * refreshes on its own.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLimitsBoard, type Disposable, type LimitsBoard, type LimitState, type PositionLimits } from "@declarative-ai/exec";
import { accountOfRoute, type AgentAccount, type LimitAccountView, type LimitsView, type PushMessage } from "@jaira/shared";
import { claudeUsageCommands, refreshClaudeLimits, refreshCodexLimits } from "@jaira/runtime";

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
  /** Tests: no refresh processes, a fixed clock. */
  refresh?: boolean;
  now?: () => number;
}

interface Stored {
  version: 1;
  accounts: Record<string, LimitState>;
}

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

  constructor(private readonly options: LimitsServiceOptions) {
    this.board = createLimitsBoard({ initial: Object.entries(this.load()), ...(options.now !== undefined ? { now: options.now } : {}) });
    this.position = { limits: this.board, accountOf: accountOfRoute };
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
    }
  }

  /** Every account worth showing, and which account each route spends. */
  view(): LimitsView {
    const routes = [...new Set(this.options.routes())];
    const routeAccounts = Object.fromEntries(routes.map((r) => [r, accountOfRoute(r)]));
    const keys = new Set<string>([...this.board.all().keys()]);
    for (const account of Object.values(routeAccounts)) if (account === "claude" || account === "codex") keys.add(account);
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
        refreshable: this.options.refresh !== false && (key === "claude" || key === "codex"),
        ...(unavailable !== undefined ? { unavailable } : {}),
      };
    });
    return { accounts, routeAccounts };
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

  private load(): Record<string, LimitState> {
    try {
      const stored = JSON.parse(readFileSync(this.options.file, "utf8")) as Partial<Stored>;
      return stored.version === 1 && stored.accounts !== undefined ? stored.accounts : {};
    } catch {
      return {};
    }
  }

  private save(): void {
    const stored: Stored = { version: 1, accounts: Object.fromEntries([...this.board.all()].map(([k, s]) => [k, { ...s, refreshing: false }])) };
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
