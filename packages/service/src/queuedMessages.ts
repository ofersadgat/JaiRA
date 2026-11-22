/**
 * Messages QUEUED for a program conversation's next `input()` (decision 0033 §9).
 *
 * A message sent while one of the program's calls runs is not steered into it unasked any more: it is
 * shown at once as queued, kept here, and given to the program the next time it waits — the oldest
 * first, one per `input()`. "Send now" steers it into the running reply instead, where that reply can
 * take it; "Delete" drops it. Nothing here decides when a program waits: the engine's hub says so when
 * an `input()` parks, and the service hands it the head of this list then (`AppService.drainQueued`).
 *
 * Remembered in `~/.jaira/system/queued.json`, so a restart still delivers what was queued: the resumed
 * run parks at its `input()` again, and is answered from here.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatSettings, QueuedMessageView } from "@jaira/shared";

export class QueuedMessages {
  private readonly items: QueuedMessageView[];
  private seq = 0;

  constructor(
    private readonly file: string,
    private readonly changed: (items: QueuedMessageView[]) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.items = this.load();
  }

  /** Oldest first, narrowed to a project and a task when asked. */
  list(filter: { project?: string; taskId?: string } = {}): QueuedMessageView[] {
    return this.items.filter((i) => (filter.project === undefined || i.project === filter.project) && (filter.taskId === undefined || i.taskId === filter.taskId));
  }

  get(id: string): QueuedMessageView | undefined {
    return this.items.find((i) => i.id === id);
  }

  /** The message the program's next `input()` takes. */
  first(project: string, taskId: string): QueuedMessageView | undefined {
    return this.items.find((i) => i.project === project && i.taskId === taskId);
  }

  add(project: string, taskId: string, text: string, settings?: ChatSettings): QueuedMessageView {
    const at = this.now();
    const item: QueuedMessageView = { id: `q-${at.toString(36)}-${(++this.seq).toString(36)}`, project, taskId, text, ...(settings !== undefined && Object.keys(settings).length > 0 ? { settings } : {}), at };
    this.items.push(item);
    this.save();
    return item;
  }

  /** `true` when it was here to remove. */
  remove(id: string): boolean {
    const at = this.items.findIndex((i) => i.id === id);
    if (at < 0) return false;
    this.items.splice(at, 1);
    this.save();
    return true;
  }

  /** Everything queued for a task goes — the conversation was deleted. */
  dropTask(project: string, taskId: string): void {
    const before = this.items.length;
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i]!.project === project && this.items[i]!.taskId === taskId) this.items.splice(i, 1);
    if (this.items.length !== before) this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items }, null, 2));
      renameSync(tmp, this.file);
    } catch {
      // A queue that cannot be written still delivers while the app runs; only a restart would lose it.
    }
    try {
      this.changed(this.list());
    } catch {
      // the push is best-effort
    }
  }

  private load(): QueuedMessageView[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { version?: number; items?: QueuedMessageView[] };
      return raw.version === 1 && Array.isArray(raw.items) ? raw.items.filter((i) => typeof i?.id === "string" && typeof i.text === "string") : [];
    } catch {
      return [];
    }
  }
}
