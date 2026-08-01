/**
 * Conversation `summary` mode (DESIGN §14 phase 7, §1h item 1).
 *
 * The problem this solves was measured, not theorized. A real run of the SPEC §9
 * planning workflow sent 232 → 317 → 1,396 → 3,975 → 10,598 → 21,033 → 42,828
 * input tokens across seven calls, because `full_history` re-sends the whole
 * transcript and the re-plan loop repeats the pass up to `limits.max_iterations`.
 * That run cost $0.25 and was still climbing.
 *
 * The engine already reads a session's transcript from `ctx.services.sessions`,
 * and "an app-provided store wins" — its own note. So the summarizer lives here,
 * as a `SessionStore` decorator, and needs no engine change: once a session's
 * transcript passes a budget, the older turns are replaced with one summary turn,
 * and every later state's preamble reads the compacted transcript.
 *
 * Three properties are load-bearing:
 *
 *  - **Only sessions that asked for it are compacted.** A state declaring
 *    `environment.conversation.mode: "full_history"` means it, and silently
 *    summarizing under it would be a lie. {@link summarySessionsOf} reads the
 *    authored modes out of the bundle, so opting in is an authoring decision.
 *    Since the session model removed the implicit shared session, that opt-in is
 *    necessarily about a NAMED session: an undeclared state's stream is private
 *    and holds one operation's exchange, which there is nothing to compact.
 *  - **A failed summarization never loses the transcript.** Compaction is
 *    destructive; if the summarizer throws, the full turns are stored instead. A
 *    provider hiccup must degrade to an expensive run, not a lobotomized one.
 *  - **Recent turns stay verbatim.** The last exchange is what the next call
 *    actually responds to; summarizing it away is what makes summary modes feel
 *    lossy.
 */
import type { Executor, ExecServices, JsonValue, RecordStore, RecordStub, ResolvedSession, SessionRequest, SessionStore } from "@declarative-ai/exec";
import { MapSessionStore, promptOp } from "@declarative-ai/exec";
import type { WorkflowBundle, WorkflowMetrics } from "@declarative-ai/hw";
import { SchemaValidator } from "@declarative-ai/validate";
import { conversationModesOf, type ConversationModes } from "@jaira/shared";

/**
 * One conversation turn. Structurally the engine's own `Turn` (which it does not
 * export) — a `ModelMessage`-compatible shape.
 */
export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/** Produces a replacement for `turns`. Rejecting leaves the transcript intact. */
export type Summarizer = (turns: readonly Turn[], signal?: AbortSignal) => Promise<string>;

/** Marks a turn this module wrote, so a rolling summary is not re-summarized blind. */
export const SUMMARY_TAG = "<conversation-summary>";

const DEFAULT_BUDGET_CHARS = 8_000;
const DEFAULT_KEEP_RECENT = 2;

export interface SummaryEvent {
  /** The stream that was compacted. */
  sessionId: string;
  /** The NEW stream carrying the summary — the origin is untouched. */
  session?: string;
  /** Turns folded into the summary. */
  compacted: number;
  /** Characters before → after, the saving that motivates the whole feature. */
  before: number;
  after: number;
}

export interface SummarizingSessionStoreOptions {
  summarize: Summarizer;
  /**
   * Sessions to compact. Absent ⇒ every session, which is only right when the
   * caller has already decided that (a CLI flag); normal wiring passes
   * {@link summarySessionsOf}'s result.
   */
  sessions?: ReadonlySet<string>;
  /** Compact once a transcript exceeds this many characters. */
  budgetChars?: number;
  /** Turns at the tail kept verbatim. */
  keepRecentTurns?: number;
  /** The store actually holding state. Defaults to an in-memory map. */
  inner?: SessionStore<JsonValue>;
  onSummarize?: (event: SummaryEvent) => void;
  /** Reported when a summarization fails and the full transcript is kept. */
  onError?: (sessionId: string, error: Error) => void;
}

const lengthOf = (turns: readonly Turn[]): number =>
  turns.reduce((n, turn) => n + turn.content.length + turn.role.length + 2, 0);

function isTurn(value: unknown): value is Turn {
  if (value === null || typeof value !== "object") return false;
  const turn = value as { role?: unknown; content?: unknown };
  return (turn.role === "user" || turn.role === "assistant") && typeof turn.content === "string";
}

/**
 * A `SessionStore` decorator that keeps a conversation under a size budget by
 * summarizing its older turns.
 *
 * ## Compaction produces a NEW session
 *
 * It used to rewrite the transcript in place on `put`. That is the root problem the session
 * model exists to fix (DESIGN §7.3): anything holding "the conversation as of turn 14"
 * silently started referring to different content, and the provider's prompt cache — a
 * strict prefix match — was invalidated on every compaction.
 *
 * So the compacted conversation is a new stream with a `compaction` edge to its
 * origin, and the origin is left exactly as it was. It is deliberately **not a fork**:
 * a fork's prefix is byte-identical to its origin's, which is precisely what a position
 * asserts, and a compacted stream begins with a summary that appears nowhere in the
 * origin. Calling it a fork would make the notation lie.
 *
 * Compaction happens on RELEASE rather than on read, so the cost is paid once per write
 * instead of once per reader, and starting a state never blocks on a model call.
 *
 * Three properties are load-bearing:
 *
 *  - **Only sessions that asked for it are compacted.** A state declaring
 *    `environment.conversation.mode: "full_history"` means it, and silently
 *    summarizing under it would be a lie.
 *  - **A failed summarization never loses the transcript.** If the summarizer throws,
 *    the stream is left alone. A provider hiccup must degrade to an expensive run, not
 *    a lobotomized one.
 *  - **Recent turns stay verbatim.** The last exchange is what the next call actually
 *    responds to; summarizing it away is what makes summary modes feel lossy.
 */
export class SummarizingSessionStore implements SessionStore<JsonValue> {
  private readonly inner: SessionStore<JsonValue>;
  private readonly budget: number;
  private readonly keepRecent: number;
  /** Per-stream write chain: two concurrent releases must not summarize in parallel. */
  private readonly chain = new Map<string, Promise<unknown>>();
  /** Where a compacted stream superseded its origin, so the next caller continues the new one. */
  private readonly superseded = new Map<string, string>();

  constructor(private readonly options: SummarizingSessionStoreOptions) {
    this.inner = options.inner ?? new MapSessionStore<JsonValue>();
    this.budget = options.budgetChars ?? DEFAULT_BUDGET_CHARS;
    this.keepRecent = Math.max(0, options.keepRecentTurns ?? DEFAULT_KEEP_RECENT);
  }

  async messages(ref: string): Promise<JsonValue[]> {
    await this.chain.get(streamOf(ref));
    // NOT redirected through `current`. A ref that names a POSITION is a commitment to content, and
    // following it to a compaction would hand back a different conversation than the one asked for —
    // which is the in-place rewrite this design exists to remove, reintroduced at the read side.
    // A BARE id carries no such commitment: it means "this conversation now", so it follows.
    return await this.inner.messages(hasPosition(ref) ? ref : this.current(ref));
  }

  compact(originRef: string, messages: readonly JsonValue[]): string | Promise<string> {
    return this.inner.compact?.(originRef, messages) ?? originRef;
  }

  resync(originRef: string, messages: readonly JsonValue[]): string | Promise<string> {
    return this.inner.resync?.(originRef, messages) ?? originRef;
  }

  fork(ref: string, seed?: string): string | Promise<string> {
    return this.inner.fork(this.current(ref), seed);
  }

  async resolve(request: SessionRequest): Promise<ResolvedSession<JsonValue>> {
    const asked = request.ref;
    // Continue whatever superseded this conversation. A caller holding a pre-compaction ref would
    // otherwise keep appending to the one compaction was meant to retire, and grow it forever.
    const ref = asked !== undefined ? this.current(asked) : undefined;
    await (ref !== undefined ? this.chain.get(streamOf(ref)) : undefined);
    return await this.inner.resolve(ref !== undefined ? { ...request, ref } : request);
  }

  // --- The record half, decorated so compaction follows the write -------------------

  open(stub: RecordStub): void {
    (this.inner as unknown as RecordStore).open(stub);
  }

  /**
   * Fill the record in, then consider compacting.
   *
   * AFTER the write, not during it: compaction is a policy over a finished conversation, and a call
   * should never wait on a summarization it did not ask for. The per-conversation chain is what keeps
   * two concurrent writes from summarizing in parallel.
   */
  close(id: string, settled: Parameters<RecordStore["close"]>[1]): void {
    (this.inner as unknown as RecordStore).close(id, settled);
    // A session record's id is `<branch>:<seq>` (its POSITION — see `withRecord`), so the position it
    // just filled is recoverable from it. A record outside any conversation has no such id and is
    // nothing this decorator has an opinion about.
    const at = id.lastIndexOf(":");
    if (at <= 0) return;
    const seq = Number(id.slice(at + 1));
    if (!Number.isInteger(seq)) return;
    const end = `${id.slice(0, at)}@${seq + 1}`;
    const work = this.maybeCompact(end);
    this.chain.set(
      streamOf(end),
      work.catch(() => undefined),
    );
  }

  /**
   * Where a conversation currently lives, once any pending compaction has settled.
   *
   * Public because compaction MOVES a conversation: the ref a call ended at names the pre-compaction
   * stream, and the summary lives on a new one. Anything that wants "this conversation now" — an
   * observer, the next caller holding only a name — needs to be able to ask rather than guess.
   */
  async currentRef(ref: string): Promise<string> {
    await this.chain.get(streamOf(ref));
    return this.current(ref);
  }

  /** The stream a ref should actually be continued on, following any compaction that replaced it. */
  private current(ref: string): string {
    const seen = new Set<string>();
    let at = ref;
    while (!seen.has(streamOf(at))) {
      seen.add(streamOf(at));
      const next = this.superseded.get(streamOf(at));
      if (next === undefined) return at;
      at = next;
    }
    return at;
  }

  /** The whole policy: which sessions, when, and what survives verbatim. */
  private async maybeCompact(endRef: string): Promise<string> {
    const stream = streamOf(endRef);
    if (this.options.sessions !== undefined && !this.options.sessions.has(rootOf(stream))) return endRef;
    const messages = await this.inner.messages(endRef);
    // The `{ role, content: string }` filter is GONE. It silently dropped anything with parts, which
    // for an agentic adapter is the entire transcript — so a session that needed compaction most was
    // the one that never got it. What cannot be measured as text is measured by its serialized size.
    const before = charsOf(messages);
    if (before <= this.budget) return endRef;

    const keep = this.keepRecent > 0 ? messages.slice(-this.keepRecent) : [];
    const fold = this.keepRecent > 0 ? messages.slice(0, -this.keepRecent) : messages;
    // Nothing to gain from summarizing a single turn into a turn.
    if (fold.length <= 1) return endRef;

    try {
      const summary = await this.options.summarize(fold.map(asTurn));
      if (summary.trim() === "") return endRef;
      const head = { role: "user", content: `${SUMMARY_TAG}\n${summary.trim()}\n</conversation-summary>` } as unknown as JsonValue;
      const entries = [head, ...keep];
      const compacted = await this.compact(endRef, entries);
      // The origin is untouched; later callers holding its ref are redirected here.
      this.superseded.set(stream, compacted);
      this.options.onSummarize?.({
        sessionId: stream,
        compacted: fold.length,
        before,
        after: charsOf(entries),
        session: compacted,
      });
      return compacted;
    } catch (e) {
      // Keep everything. An expensive run beats a run that forgot what it was doing.
      this.options.onError?.(stream, e as Error);
      return endRef;
    }
  }
}

/** The stream half of a ref — the store owns the spelling, so this only splits off a trailing position. */
function streamOf(ref: string): string {
  return hasPosition(ref) ? ref.slice(0, ref.lastIndexOf("@")) : ref;
}

/** Whether a ref commits to a POSITION, or merely names a conversation. */
function hasPosition(ref: string): boolean {
  const at = ref.lastIndexOf("@");
  return at > 0 && Number.isInteger(Number(ref.slice(at + 1)));
}

/** The originating stream behind any chain of compactions, which is what a mode was declared against. */
function rootOf(stream: string): string {
  const at = stream.indexOf("~");
  return at > 0 ? stream.slice(0, at) : stream;
}

/** Size as the provider will see it. Serialized, because a message is parts as often as it is text. */
const charsOf = (messages: readonly JsonValue[]): number =>
  messages.reduce<number>((n, message) => n + (typeof message === "string" ? message.length : JSON.stringify(message).length), 0);

/** A stored message as the summarizer's `Turn` — text where there is text, serialized where there is not. */
function asTurn(message: JsonValue): Turn {
  if (isTurn(message)) return message;
  const role = (message as { role?: unknown })?.role;
  return { role: role === "assistant" ? "assistant" : "user", content: JSON.stringify(message) };
}

export { type ConversationModes as SummaryModes } from "@jaira/shared";

/**
 * The effective conversation modes of a bundle. The query itself lives in
 * `@jaira/shared` because the workflow browser lints the same declaration
 * (a session mixing `summary` and `full_history`) that the runtime acts on.
 *
 * Reads the LOADED states rather than the authored `source`, because a mode may be inherited from
 * an ancestor's `environment` (WORKFLOWS.md §5) and appear in no state file at all. Installing the
 * summarizer off the authored text would then leave an inheriting state unsummarized — the exact
 * silent-drift case the mode exists to make explicit.
 */
export function summarySessionsOf(bundle: WorkflowBundle): ConversationModes {
  return conversationModesOf(bundle.states as unknown as Record<string, unknown>);
}

/**
 * The session store a run should use, given its bundle.
 *
 * Two independent decisions, and conflating them was a bug waiting to happen:
 *
 *  - **Durability** is the caller's, expressed by passing `inner`. A run with a
 *    durable store gets it whether or not anything asked for summarization.
 *  - **Compaction** is the author's. The summarizing decorator goes on only when a
 *    state declared `summary` mode, because a workflow that never asked should not
 *    have its transcripts routed through code that could compact them.
 *
 * This used to return `undefined` whenever no state asked for `summary`, which
 * meant a durable store handed in as `inner` was silently discarded — transcripts
 * would survive a run only if that run also happened to want summarization.
 */
export function sessionStoreFor(
  bundle: WorkflowBundle,
  summarize: Summarizer,
  options: Omit<SummarizingSessionStoreOptions, "summarize" | "sessions"> = {},
): { store?: SessionStore<JsonValue>; modes: ConversationModes } {
  const modes = summarySessionsOf(bundle);
  if (modes.sessions.size === 0) return { ...(options.inner !== undefined ? { store: options.inner } : {}), modes };
  return { store: new SummarizingSessionStore({ ...options, summarize, sessions: modes.sessions }), modes };
}

/** The prompt the summarizer sends. Kept explicit so its bias is reviewable. */
export const SUMMARY_SYSTEM =
  "You compress a conversation between a user and an AI assistant that is executing a " +
  "software-engineering workflow. Preserve decisions, requirements, constraints, file and " +
  "symbol names, and open questions. Drop pleasantries, restated context, and superseded " +
  "drafts. Write for a reader who must continue the work with only your summary. Do not " +
  "add commentary about the summarization itself.";

export interface PromptSummarizerOptions {
  /** Model override; absent ⇒ the run's configured default. */
  model?: string;
  /** Rough cap on the summary, in characters. */
  targetChars?: number;
  /**
   * Services the summarizing call runs with. Defaults to a bare validator, which
   * is all a standalone prompt op needs — the engine's own services belong to a
   * state's operation, not to this out-of-band call.
   */
  services?: ExecServices;
}

/**
 * A {@link Summarizer} backed by the run's own prompt executor — so it uses the
 * project's configured model and, in a scripted run, the fake executor rather than
 * a real provider.
 */
export function promptSummarizer(
  prompt: Executor<ExecServices, WorkflowMetrics>,
  options: PromptSummarizerOptions = {},
): Summarizer {
  const services: ExecServices = options.services ?? { validator: new SchemaValidator() };
  const target = options.targetChars ?? 1_500;
  return async (turns, signal) => {
    const transcript = turns.map((t) => `${t.role}: ${t.content}`).join("\n\n");
    const op = promptOp({
      system: SUMMARY_SYSTEM,
      user: `Summarize the following conversation in at most ${target} characters.\n\n${transcript}`,
      ...(options.model !== undefined ? { model: options.model } : {}),
      output: { name: "summary", schema: { type: "string" } as const },
    });
    const handle = prompt.start(op, {
      ...services,
      ...(signal !== undefined ? { abortSignal: signal } : {}),
    });
    const result = await handle.result;
    if ("error" in result && result.error !== undefined) {
      // Surfaced as a rejection so the store's catch keeps the full transcript.
      throw new Error(`summarization failed: ${result.error.reason}`);
    }
    const value = result.value;
    return typeof value === "string" ? value : JSON.stringify(value);
  };
}
