/**
 * The board behind Settings' warnings and errors (`@jaira/shared` `health.ts` says what each is).
 *
 * What makes an error an error is memory: a tool is only LOST if it was once found working, so the
 * board remembers every agent, route and forge connection a check has seen work
 * (`<base>/system/health.json`). A check that then finds it failing raises an error, one that finds it
 * working clears it, and one that finds it turned off or not configured clears it too — switching a
 * tool off is not losing it.
 *
 * Remembered per CONFIGURATION, which is what a check reads: the one project open, or the shared root
 * while none or several are (`AppService.sessionOf`). A key in one project's `.env.local` works there
 * and is absent everywhere else, and a machine-wide memory read that absence as the key lost: open a
 * second project and Anthropic, OpenAI and OpenRouter all needed attention without having worked there.
 *
 * Dismissing a lost tool FORGETS that it worked, everywhere (the person, 2026-10-21: "if the user
 * dismisses the notification, that should reset it so that it should only show if it started working
 * and then failed again"): the failure it keeps reporting is no longer news, and only a check that sees
 * it work again makes the next failure one. Any other item is hidden until its condition clears. The
 * log is two items, the errors and the warnings written since the person last dismissed them (the
 * person, 2026-09-26: "every warning/error since the last time we cleared/dismissed the log
 * messages"): dismissing one clears its count rather than hiding it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HealthAction, HealthItem, HealthPage } from "@jaira/shared";

/** One tool, as a check reported it. */
export interface HealthObservation {
  name: string;
  /** `ok` works; `failed` does not; anything else (`disabled`, `unconfigured`, …) is not in use. */
  status: string;
  detail: string;
  fix?: string;
}

export interface HealthBoardOptions {
  /** `<base>/system/health.json`. */
  file: string;
  publish: (items: HealthItem[]) => void;
  now?: () => number;
}

interface HealthFile {
  /** Every `<kind>:<name>` a check has seen working, by the configuration it was checked in ({@link HealthBoard.observe}'s `where`). */
  worked: Record<string, string[]>;
  /** Items dismissed and not yet cleared — never a lost tool's, whose dismissal forgets it worked instead. */
  dismissed: string[];
}

export type HealthKind = "executor" | "route" | "forge";

const OBSERVED: readonly string[] = ["executor:", "route:", "forge:"] satisfies readonly `${HealthKind}:`[];
const isObserved = (id: string): boolean => OBSERVED.some((prefix) => id.startsWith(prefix));

/** The log's two items. */
export const LOG_ERRORS = "log:errors";
export const LOG_WARNINGS = "log:warnings";

export class HealthBoard {
  private readonly items = new Map<string, HealthItem>();
  /** What worked, by where it was checked. */
  private readonly worked: Map<string, Set<string>>;
  private readonly dismissed: Set<string>;
  private readonly logCounts = { error: 0, warn: 0 };

  constructor(private readonly options: HealthBoardOptions) {
    const saved = this.read();
    this.worked = new Map(Object.entries(saved.worked).map(([where, ids]) => [where, new Set(ids)]));
    this.dismissed = new Set(saved.dismissed);
  }

  list(): HealthItem[] {
    return [...this.items.values()].filter((item) => !this.dismissed.has(item.id)).sort((a, b) => (a.level === b.level ? a.since - b.since : a.level === "error" ? -1 : 1));
  }

  /**
   * A check's results for one kind of tool: lost tools become errors, working and switched-off ones
   * clear. `where` is the configuration the check read — the open project's session key, or `""` for
   * the shared root — and a tool is lost only if it worked THERE.
   */
  observe(
    kind: HealthKind,
    where: string,
    results: readonly HealthObservation[],
    describe: (name: string) => { title: string; action?: HealthAction; subject?: string },
  ): void {
    let changed = false;
    const worked = this.worked.get(where) ?? new Set<string>();
    for (const result of results) {
      const id = `${kind}:${result.name}`;
      if (result.status === "ok") {
        if (!worked.has(id)) {
          worked.add(id);
          this.worked.set(where, worked);
          changed = true;
        }
        changed = this.drop(id) || changed;
        continue;
      }
      if (result.status !== "failed" || !worked.has(id)) {
        changed = this.drop(id) || changed;
        continue;
      }
      const existing = this.items.get(id);
      if (existing !== undefined && existing.detail === result.detail) continue;
      const { title, action, subject } = describe(result.name);
      this.items.set(id, {
        id,
        level: "error",
        page: "connections",
        title,
        detail: result.detail,
        ...(result.fix !== undefined ? { fix: result.fix } : {}),
        ...(action !== undefined ? { action } : {}),
        ...(subject !== undefined ? { subject } : {}),
        since: existing?.since ?? this.now(),
      });
      changed = true;
    }
    if (changed) this.changed();
  }

  /** Raise or replace one item by id (the updater's and the plugins' warnings). */
  set(item: Omit<HealthItem, "since"> & { since?: number }): void {
    const existing = this.items.get(item.id);
    this.items.set(item.id, { ...item, since: item.since ?? existing?.since ?? this.now() } as HealthItem);
    this.changed();
  }

  /** The condition behind an item cleared. */
  clear(id: string): void {
    if (this.drop(id)) this.changed();
  }

  /** An error or a warning was written to the log. */
  logged(level: "error" | "warn"): void {
    const count = (this.logCounts[level] += 1);
    const id = level === "error" ? LOG_ERRORS : LOG_WARNINGS;
    const noun = level === "error" ? "error" : "warning";
    this.items.set(id, {
      id,
      level: level === "error" ? "error" : "warning",
      page: "logs" satisfies HealthPage,
      title: "Log",
      detail: count === 1 ? `1 ${noun} was logged` : `${count} ${noun}s were logged`,
      action: "open-logs",
      since: this.items.get(id)?.since ?? this.now(),
      count,
    });
    this.changed();
  }

  /**
   * Dismiss one item. A lost tool is forgotten as having worked, wherever it did, so it is raised again
   * only once a check sees it work and then fail; a log count is CLEARED — the next entry starts it
   * again from one; anything else is hidden until its condition clears.
   */
  dismiss(id: string): void {
    if (!this.items.has(id)) return;
    if (id === LOG_ERRORS || id === LOG_WARNINGS) {
      this.logCounts[id === LOG_ERRORS ? "error" : "warn"] = 0;
      this.items.delete(id);
    } else if (isObserved(id)) {
      for (const worked of this.worked.values()) worked.delete(id);
      this.items.delete(id);
    } else {
      this.dismissed.add(id);
    }
    this.changed();
  }

  /** Dismiss everything shown. */
  dismissAll(): void {
    for (const item of this.list()) this.dismiss(item.id);
  }

  private drop(id: string): boolean {
    const had = this.items.delete(id);
    const wasDismissed = this.dismissed.delete(id);
    return had || wasDismissed;
  }

  private changed(): void {
    this.write();
    this.options.publish(this.list());
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private read(): HealthFile {
    try {
      const file = JSON.parse(readFileSync(this.options.file, "utf8")) as Partial<HealthFile>;
      const worked = file.worked !== null && typeof file.worked === "object" && !Array.isArray(file.worked) ? file.worked : {};
      return {
        worked: Object.fromEntries(Object.entries(worked).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))),
        dismissed: Array.isArray(file.dismissed) ? file.dismissed : [],
      };
    } catch {
      return { worked: {}, dismissed: [] };
    }
  }

  private write(): void {
    const worked = Object.fromEntries(
      [...this.worked]
        .filter(([, ids]) => ids.size > 0)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([where, ids]) => [where, [...ids].sort()]),
    );
    try {
      mkdirSync(dirname(this.options.file), { recursive: true });
      writeFileSync(`${this.options.file}.tmp`, `${JSON.stringify({ worked, dismissed: [...this.dismissed].sort() } satisfies HealthFile)}\n`);
      renameSync(`${this.options.file}.tmp`, this.options.file);
    } catch {
      // A board that cannot remember still works for this run; the next check finds the same things.
    }
  }
}
