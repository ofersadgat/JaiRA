/**
 * A copy of the window's cache kept on the device (decision 0018 §7): a phone's mirror. What the phone
 * has seen is there when it starts, and when no machine answers.
 *
 * It keeps, as files in a {@link MirrorStore}:
 *
 *  - **each engine's index** and its cursor — that engine's clock — so a start asks it only what
 *    changed since; never dropped to make room (indexes are always loaded);
 *  - **views** by their key (a conversation, a task's detail, a placeholder's string), as an engine last
 *    answered them, shown until one answers again.
 *
 * It is a cache, not a truth: an engine's answer replaces whatever is kept. Its size has a limit the
 * person sets — past it, the views read longest ago go first — or none, and then it is a permanent store.
 * A store that fails costs the copy, never the window.
 */
import type { ProjectTask } from "@jaira/shared/browser";

/** Where a mirror keeps its files: named texts, listed with their sizes and when each was last written. */
export interface MirrorStore {
  list(): Promise<ReadonlyArray<{ name: string; size: number; at: number }>>;
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** One engine's index as kept: its cursor, and each task's summary with the stamp of the page it came from. */
export interface KeptIndex {
  cursor: number;
  tasks: Array<[ProjectTask, number]>;
}

/** What a mirror is using, against its limit (`null`: none). */
export interface MirrorUsage {
  bytes: number;
  limit: number | null;
}

export const DEFAULT_MIRROR_LIMIT = 200 * 1024 * 1024;

const INDEX = "index-";
const VIEW = "view-";
const SETTINGS = "settings";
/** Writes wait this long for the changes after them: a streaming conversation is read twice a second. */
const KEEP_INDEX_MS = 1000;
const KEEP_VIEW_MS = 2000;

/** A file name for a key: two FNV-1a hashes, the key itself kept inside the file to tell a collision. */
export function mirrorName(prefix: string, key: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ key.length;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000197) >>> 0;
  }
  return `${prefix}${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

export class SyncMirror {
  /** Every file kept: its size, and when it was last written or read. */
  private readonly files = new Map<string, { size: number; at: number }>();
  private limitBytes: number | null = DEFAULT_MIRROR_LIMIT;
  private readonly ready: Promise<void>;
  private readonly waiting = new Map<string, { timer: ReturnType<typeof setTimeout>; text: () => string }>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: MirrorStore,
    /** How long a write waits for the changes after it (tests: none). */
    private readonly wait: { index: number; view: number } = { index: KEEP_INDEX_MS, view: KEEP_VIEW_MS },
  ) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      for (const file of await this.store.list()) this.files.set(file.name, { size: file.size, at: file.at });
      const settings = JSON.parse((await this.store.read(SETTINGS)) ?? "{}") as { limit?: unknown };
      if (settings.limit === null || (typeof settings.limit === "number" && settings.limit > 0)) this.limitBytes = settings.limit;
    } catch {
      // Nothing kept, or nothing readable: an empty mirror.
    }
  }

  /** Every engine's kept index, by engine. */
  async indexes(): Promise<Map<string, KeptIndex>> {
    await this.ready;
    const out = new Map<string, KeptIndex>();
    for (const name of this.files.keys()) {
      if (!name.startsWith(INDEX)) continue;
      try {
        const kept = JSON.parse((await this.store.read(name)) ?? "null") as ({ source: string } & KeptIndex) | null;
        if (kept !== null && typeof kept.source === "string" && typeof kept.cursor === "number" && Array.isArray(kept.tasks)) out.set(kept.source, { cursor: kept.cursor, tasks: kept.tasks });
      } catch {
        // One unreadable index: that engine starts from nothing.
      }
    }
    return out;
  }

  /** Keep one engine's index, a moment after the last change to it. */
  keepIndex(source: string, index: () => KeptIndex): void {
    this.later(mirrorName(INDEX, source), () => JSON.stringify({ source, ...index() }), this.wait.index);
  }

  /** Forget one engine's index: the machine was forgotten. */
  forgetIndex(source: string): void {
    void this.drop(mirrorName(INDEX, source));
  }

  /** A view as kept, or `undefined`. */
  async view(key: string): Promise<unknown> {
    await this.ready;
    const name = mirrorName(VIEW, key);
    const file = this.files.get(name);
    if (file === undefined) return undefined;
    try {
      const kept = JSON.parse((await this.store.read(name)) ?? "null") as { key: string; value: unknown } | null;
      if (kept === null || kept.key !== key) return undefined;
      file.at = Date.now();
      return kept.value;
    } catch {
      return undefined;
    }
  }

  /** Keep a view as an engine answered it, a moment after its last answer. */
  keepView(key: string, value: unknown): void {
    if (value === undefined) return;
    this.later(mirrorName(VIEW, key), () => JSON.stringify({ key, value }), this.wait.view);
  }

  /** What the mirror is using, and its limit. */
  usage(): MirrorUsage {
    let bytes = 0;
    for (const file of this.files.values()) bytes += file.size;
    return { bytes, limit: this.limitBytes };
  }

  /** Set the limit — `null` for none — kept on the device, and make room for it now. */
  async setLimit(limit: number | null): Promise<void> {
    await this.ready;
    this.limitBytes = limit;
    await this.write(SETTINGS, JSON.stringify({ limit }));
    await this.evict();
    this.changed();
  }

  /** Drop every view kept; the indexes stay. */
  async clearViews(): Promise<void> {
    await this.ready;
    for (const name of [...this.files.keys()]) if (name.startsWith(VIEW)) await this.drop(name);
    this.changed();
  }

  /** Hears when what the mirror uses, or its limit, changes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private later(name: string, text: () => string, ms: number): void {
    const waiting = this.waiting.get(name);
    if (waiting !== undefined) {
      waiting.text = text;
      return;
    }
    const entry = {
      text,
      timer: setTimeout(() => {
        this.waiting.delete(name);
        void this.ready.then(async () => {
          let serialized: string;
          try {
            serialized = entry.text();
          } catch {
            return;
          }
          await this.write(name, serialized);
          await this.evict();
          this.changed();
        });
      }, ms),
    };
    this.waiting.set(name, entry);
  }

  private async write(name: string, text: string): Promise<void> {
    try {
      await this.store.write(name, text);
      // The length in characters, near enough the bytes of what is mostly ASCII JSON.
      this.files.set(name, { size: text.length, at: Date.now() });
    } catch {
      // Full, or refused: this one is not kept.
    }
  }

  private async drop(name: string): Promise<void> {
    const waiting = this.waiting.get(name);
    if (waiting !== undefined) clearTimeout(waiting.timer);
    this.waiting.delete(name);
    this.files.delete(name);
    try {
      await this.store.remove(name);
    } catch {
      // Already gone.
    }
  }

  /** Past the limit, the views read or written longest ago go until it is met. */
  private async evict(): Promise<void> {
    const limit = this.limitBytes;
    if (limit === null) return;
    let bytes = this.usage().bytes;
    if (bytes <= limit) return;
    const views = [...this.files].filter(([name]) => name.startsWith(VIEW)).sort(([, a], [, b]) => a.at - b.at);
    for (const [name, file] of views) {
      if (bytes <= limit) break;
      bytes -= file.size;
      await this.drop(name);
    }
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
