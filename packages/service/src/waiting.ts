/**
 * Messages and runs WAITING for an account's allowance (usage-readings contract, "What the screens show").
 *
 * Two ways in, both decided by the reading and never guessed:
 *
 *  - a message sent while the account is KNOWN to have nothing left is held rather than sent
 *    (`waiting`), and goes by itself when the window resets;
 *  - a message or a run the provider REFUSED because the allowance ran out (`refused`) goes again at
 *    the reset only while its "Try again at …" box is checked (`retry`) — which starts the way the
 *    `limits.retryOnReset` setting says.
 *
 * At the reset the account is asked again first. If it is still spent (a later reset, or a reading
 * that knew better), the item waits for the new time instead of being refused a second time. Deleting
 * an item cancels it; "Send now anyway" sends it straight away, spent or not.
 *
 * Remembered in `~/.jaira/system/waiting.json`, so a restart still sends what was waiting.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WaitingItem } from "@jaira/shared";

export interface WaitingHost {
  /** Send a waiting message now. */
  sendMessage(item: WaitingItem): Promise<void>;
  /** Resume a waiting run now. */
  resumeRun(item: WaitingItem): Promise<void>;
  /** Ask the account again; the time it comes back if it is STILL spent, else `null`. */
  stillSpentUntil(account: string): Promise<string | null>;
  /** The list changed. */
  changed(items: WaitingItem[]): void;
}

/** A timer cannot be set further out than this; a longer wait re-arms when it fires. */
const MAX_TIMER_MS = 24 * 3_600_000;
/** When the reset time is unknown, how often to look again. */
const UNKNOWN_RESET_MS = 30 * 60_000;
/** A reset reported as a moment ago is tried this long after it, so the provider has turned over. */
const AFTER_RESET_MS = 15_000;

export class WaitingQueue {
  private readonly items = new Map<string, WaitingItem>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = 0;

  constructor(
    private readonly file: string,
    private readonly host: WaitingHost,
    private readonly now: () => number = Date.now,
  ) {
    for (const item of this.load()) {
      this.items.set(item.id, item);
      this.arm(item);
    }
  }

  list(filter: { project?: string; taskId?: string } = {}): WaitingItem[] {
    return [...this.items.values()]
      .filter((i) => (filter.project === undefined || i.project === filter.project) && (filter.taskId === undefined || i.taskId === filter.taskId))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  /** Add one, armed for its time. */
  add(item: Omit<WaitingItem, "id" | "createdAt">): WaitingItem {
    const full: WaitingItem = { ...item, id: `w-${this.now().toString(36)}-${(++this.seq).toString(36)}`, createdAt: new Date(this.now()).toISOString() };
    this.items.set(full.id, full);
    this.arm(full);
    this.changed();
    return full;
  }

  /** Send now anyway, delete, or turn "Try again at …" on or off. */
  async act(id: string, action: "sendNow" | "drop" | "retry", retry?: boolean): Promise<WaitingItem[]> {
    const item = this.items.get(id);
    if (item === undefined) return this.list();
    if (action === "drop") {
      this.remove(id);
    } else if (action === "retry") {
      const next = { ...item, retry: retry ?? !item.retry };
      this.items.set(id, next);
      this.disarm(id);
      this.arm(next);
      this.changed();
    } else {
      this.remove(id);
      await this.go(item);
    }
    return this.list();
  }

  /** Remove every item a test matches — a run starting again answers whatever waited to start it. */
  dropWhere(test: (item: WaitingItem) => boolean): void {
    let dropped = false;
    for (const item of [...this.items.values()]) {
      if (!test(item)) continue;
      this.disarm(item.id);
      this.items.delete(item.id);
      dropped = true;
    }
    if (dropped) this.changed();
  }

  /** Everything stops; nothing is lost (it is on disk). */
  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private arm(item: WaitingItem): void {
    if (!item.retry && item.state === "refused") return;
    const at = item.until !== null ? Date.parse(item.until) + AFTER_RESET_MS : this.now() + UNKNOWN_RESET_MS;
    const wait = Math.min(MAX_TIMER_MS, Math.max(1_000, at - this.now()));
    const timer = setTimeout(() => {
      this.timers.delete(item.id);
      void this.due(item.id);
    }, wait);
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(item.id, timer);
  }

  private disarm(id: string): void {
    const t = this.timers.get(id);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(id);
  }

  private async due(id: string): Promise<void> {
    const item = this.items.get(id);
    if (item === undefined) return;
    const at = item.until !== null ? Date.parse(item.until) : undefined;
    // Not yet (a wait longer than one timer): arm again for the rest.
    if (at !== undefined && at > this.now()) {
      this.arm(item);
      return;
    }
    const still = await this.host.stillSpentUntil(item.account).catch(() => null);
    const current = this.items.get(id);
    if (current === undefined) return; // deleted while asking
    if (still !== null && Date.parse(still) > this.now()) {
      const next = { ...current, until: still };
      this.items.set(id, next);
      this.arm(next);
      this.changed();
      return;
    }
    this.remove(id);
    await this.go(current);
  }

  private async go(item: WaitingItem): Promise<void> {
    try {
      if (item.kind === "run") await this.host.resumeRun(item);
      else await this.host.sendMessage(item);
    } catch {
      // A send that fails is reported where every send is — the conversation, the run's own view.
    }
  }

  private remove(id: string): void {
    this.disarm(id);
    if (this.items.delete(id)) this.changed();
  }

  private changed(): void {
    this.save();
    try {
      this.host.changed(this.list());
    } catch {
      // the push is best-effort
    }
  }

  private load(): WaitingItem[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { version?: number; items?: WaitingItem[] };
      return raw.version === 1 && Array.isArray(raw.items) ? raw.items : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, items: this.list() }, null, 2) + "\n", "utf8");
      renameSync(tmp, this.file);
    } catch {
      // best-effort
    }
  }
}
