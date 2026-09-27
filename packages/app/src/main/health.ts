/**
 * The board behind Settings' warnings and errors (`@jaira/shared` `health.ts` says what each is).
 *
 * What makes an error an error is memory: a tool is only LOST if it was once found working, so the
 * board remembers, per machine, every agent, route and forge connection a check has seen work
 * (`<base>/system/health.json`). A check that then finds it failing raises an error, one that finds it
 * working clears it, and one that finds it turned off or not configured clears it too — switching a
 * tool off is not losing it.
 *
 * Dismissing an item hides it until its condition clears; the same problem coming back after that is
 * news again. The log is two items, the errors and the warnings written since the person last
 * dismissed them (the person, 2026-09-26: "every warning/error since the last time we cleared/dismissed
 * the log messages"): dismissing one clears its count rather than hiding it.
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
  /** Every `<kind>:<name>` a check has seen working. */
  worked: string[];
  /** Items dismissed and not yet cleared. */
  dismissed: string[];
}

export type HealthKind = "executor" | "route" | "forge";

/** The log's two items. */
export const LOG_ERRORS = "log:errors";
export const LOG_WARNINGS = "log:warnings";

export class HealthBoard {
  private readonly items = new Map<string, HealthItem>();
  private readonly worked: Set<string>;
  private readonly dismissed: Set<string>;
  private readonly logCounts = { error: 0, warn: 0 };

  constructor(private readonly options: HealthBoardOptions) {
    const saved = this.read();
    this.worked = new Set(saved.worked);
    this.dismissed = new Set(saved.dismissed);
  }

  list(): HealthItem[] {
    return [...this.items.values()].filter((item) => !this.dismissed.has(item.id)).sort((a, b) => (a.level === b.level ? a.since - b.since : a.level === "error" ? -1 : 1));
  }

  /** A check's results for one kind of tool: lost tools become errors, working and switched-off ones clear. */
  observe(kind: HealthKind, results: readonly HealthObservation[], describe: (name: string) => { title: string; action?: HealthAction; subject?: string }): void {
    let changed = false;
    for (const result of results) {
      const id = `${kind}:${result.name}`;
      if (result.status === "ok") {
        if (!this.worked.has(id)) {
          this.worked.add(id);
          changed = true;
        }
        changed = this.drop(id) || changed;
        continue;
      }
      if (result.status !== "failed" || !this.worked.has(id)) {
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
    });
    this.changed();
  }

  /**
   * Dismiss one item. A problem is hidden until its condition clears; a log count is CLEARED — the
   * next entry starts it again from one.
   */
  dismiss(id: string): void {
    if (!this.items.has(id)) return;
    if (id === LOG_ERRORS || id === LOG_WARNINGS) {
      this.logCounts[id === LOG_ERRORS ? "error" : "warn"] = 0;
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
      return { worked: Array.isArray(file.worked) ? file.worked : [], dismissed: Array.isArray(file.dismissed) ? file.dismissed : [] };
    } catch {
      return { worked: [], dismissed: [] };
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.options.file), { recursive: true });
      writeFileSync(`${this.options.file}.tmp`, `${JSON.stringify({ worked: [...this.worked].sort(), dismissed: [...this.dismissed].sort() } satisfies HealthFile)}\n`);
      renameSync(`${this.options.file}.tmp`, this.options.file);
    } catch {
      // A board that cannot remember still works for this run; the next check finds the same things.
    }
  }
}
