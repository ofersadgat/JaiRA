/**
 * Large values answered as placeholders, and fetched by their hash (decision 0018 §6).
 *
 * A transcript is mostly what its tools were called with and answered — files read, commands' output,
 * patches — and most of that is never opened. So a session view (and a chat thread, which holds one)
 * goes to a reader with every string over the reader's threshold, inside its tools' calls and results,
 * replaced by `{"$lazy": {size, preview, hash}}`; what was SAID — a turn's text, a text or thinking
 * block — is never replaced, because it is what a transcript is read for.
 *
 * `lazy:value` answers a hash from the strings replaced since this engine started (kept, newest first,
 * up to a bound), and then from the blob table: a string a record stored as a blob has the same hash,
 * so a placeholder outlives the process that made it. One that is in neither is refused — the reader
 * reads its view again, which makes it anew.
 */
import { createHash } from "node:crypto";
import { refusal, type ChatThreadView, type LazyValue, type SessionView, LAZY_KEY } from "@jaira/shared";
import { readBlobs, type JairaDb } from "@jaira/persistence";
import type { JsonValue } from "@declarative-ai/json";
import { createLogger } from "@declarative-ai/log";

const log = createLogger("jaira.service.lazy");

/** A reader on this machine's own window: a fetch is a pipe away. */
export const LAZY_OVER_LOCAL = 64 * 1024;
/** A reader over the network — a phone, a browser (§6's default). */
export const LAZY_OVER_REMOTE = 4 * 1024;

const PREVIEW = 160;
/** Kept replaced strings, in characters, before the oldest go. */
const KEEP_CHARS = 64 * 1024 * 1024;
/** The blocks a turn SAYS in: never replaced. */
const SAID = new Set(["text", "thinking", "redacted_thinking"]);

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export class LazyValues {
  private readonly kept = new Map<string, string>();
  private chars = 0;

  constructor(private readonly db: () => JairaDb | undefined) {}

  /** A session view for a reader whose threshold is `over`. */
  session(view: SessionView, over: number): SessionView {
    return {
      ...view,
      turns: view.turns.map((turn) => this.turn(turn, over)),
      ...(view.sidechains !== undefined ? { sidechains: Object.fromEntries(Object.entries(view.sidechains).map(([k, turns]) => [k, turns.map((t) => this.turn(t, over))])) } : {}),
      ...(view.providerEvents !== undefined ? { providerEvents: view.providerEvents.map((e) => ({ ...e, event: this.leaves(e.event, over) })) } : {}),
    };
  }

  /** A chat thread for a reader whose threshold is `over`. */
  thread(view: ChatThreadView | null, over: number): ChatThreadView | null {
    return view === null ? null : { ...view, session: this.session(view.session, over) };
  }

  /** The string a placeholder stands for. */
  value(hash: string): string {
    const kept = this.kept.get(hash);
    if (kept !== undefined) return kept;
    const db = this.db();
    const stored = db === undefined ? undefined : readBlobs(db, [hash])[hash];
    if (stored !== undefined) return stored;
    throw refusal(log, `no value is kept for ${hash.slice(0, 12)}… — read the view again`);
  }

  private turn<T extends { parts?: JsonValue }>(turn: T, over: number): T {
    if (turn.parts === undefined) return turn;
    const parts = Array.isArray(turn.parts)
      ? turn.parts.map((block) => (block !== null && typeof block === "object" && !Array.isArray(block) && SAID.has(String((block as { type?: unknown }).type)) ? block : this.leaves(block, over)))
      : typeof turn.parts === "string"
        ? turn.parts
        : this.leaves(turn.parts, over);
    return { ...turn, parts };
  }

  /** Every string leaf over `over` replaced, in place. */
  private leaves(value: JsonValue, over: number): JsonValue {
    if (typeof value === "string") return value.length > over ? this.placeholder(value) : value;
    if (Array.isArray(value)) return value.map((item) => this.leaves(item, over));
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.leaves(v as JsonValue, over)]));
    return value;
  }

  private placeholder(text: string): JsonValue {
    const hash = sha256(text);
    if (!this.kept.has(hash)) {
      this.kept.set(hash, text);
      this.chars += text.length;
      for (const [old, kept] of this.kept) {
        if (this.chars <= KEEP_CHARS) break;
        this.kept.delete(old);
        this.chars -= kept.length;
      }
    }
    const lazy: LazyValue = { [LAZY_KEY]: { size: text.length, preview: text.slice(0, PREVIEW), hash } };
    return lazy as unknown as JsonValue;
  }
}
