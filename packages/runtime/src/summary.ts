/**
 * Conversation `summary` mode (DESIGN §14 phase 7, §1h item 1).
 *
 * The problem this solves was measured, not theorized. A real run of the SPEC §9
 * planning workflow sent 232 → 317 → 1,396 → 3,975 → 10,598 → 21,033 → 42,828
 * input tokens across seven calls, because `full_history` re-sends the whole
 * transcript and the re-plan loop repeats the pass up to `limits.max_iterations`.
 * That run cost $0.25 and was still climbing.
 *
 * It is a `SessionStore` decorator, so it needs no engine change: once a
 * conversation passes a budget, its older turns are replaced by one summary turn,
 * and every later state reads the compacted conversation.
 *
 * ## Where compaction happens, and why it moved
 *
 * It used to happen on `put` — "once per write instead of once per reader". There
 * is no `put` any more. A session is a POSITION, records are written through the
 * record store, and this store owns lineage: which conversation a ref names, where
 * it sits, and how a new one comes into being.
 *
 * So compaction happens in {@link SummarizingSessionStore.resolve}, and that is not
 * a workaround — `resolve` is the one point that decides *which conversation this
 * call will use*, which is precisely the question compaction answers. The cost is
 * still paid once per call rather than once per reader.
 *
 * ## Compaction MINTS a conversation; it does not rewrite one
 *
 * `SessionStore.compact` returns a ref to a new conversation whose first record is
 * the summary. That is the contract's own decision and it is load-bearing here:
 * rewriting in place would silently change what every existing ref refers to, and
 * would invalidate the provider's prompt cache — a strict prefix match — on every
 * compaction. A compacted conversation is not a fork either, because a fork's
 * prefix is byte-identical to its origin's and a summary appears nowhere in it.
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
 *    destructive; if the summarizer throws, the origin ref is returned unchanged. A
 *    provider hiccup must degrade to an expensive run, not a lobotomized one.
 *  - **Recent turns stay verbatim.** The last exchange is what the next call
 *    actually responds to; summarizing it away is what makes summary modes feel
 *    lossy.
 */
<<<<<<< HEAD
import type {
  ExecServices,
  Executor,
  JsonValue,
  RecordStore,
  ResolvedSession,
  SessionRequest,
  SessionStore,
} from "@declarative-ai/exec";
=======
import type { Executor, ExecServices, JsonValue, RecordStore, RecordStub, ResolvedSession, SessionRequest, SessionStore } from "@declarative-ai/exec";
>>>>>>> claude/brave-antonelli-dbc5ac
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

/** Produces a replacement for `turns`. Rejecting leaves the conversation intact. */
export type Summarizer = (turns: readonly Turn[], signal?: AbortSignal) => Promise<string>;

/** Marks a turn this module wrote, so a rolling summary is not re-summarized blind. */
export const SUMMARY_TAG = "<conversation-summary>";

const DEFAULT_BUDGET_CHARS = 8_000;
const DEFAULT_KEEP_RECENT = 2;

export interface SummaryEvent {
<<<<<<< HEAD
  /** The conversation compacted — the ref as it was, before the new one was minted. */
  sessionId: string;
  /** The ref the next call will use instead. */
  compactedTo: string;
=======
  /** The stream that was compacted. */
  sessionId: string;
  /** The NEW stream carrying the summary — the origin is untouched. */
  session?: string;
>>>>>>> claude/brave-antonelli-dbc5ac
  /** Turns folded into the summary. */
  compacted: number;
  /** Characters before → after, the saving that motivates the whole feature. */
  before: number;
  after: number;
}

export interface SummarizingSessionStoreOptions {
  summarize: Summarizer;
  /**
   * Sessions to compact, by AUTHORED name. Absent ⇒ every session, which is only
   * right when the caller has already decided that (a CLI flag); normal wiring
   * passes {@link summarySessionsOf}'s result.
   */
  sessions?: ReadonlySet<string>;
  /** Compact once a conversation exceeds this many characters. */
  budgetChars?: number;
  /** Turns at the tail kept verbatim. */
  keepRecentTurns?: number;
  /** The store actually holding lineage and records. Defaults to the in-memory one. */
  inner?: SessionStore<JsonValue>;
  onSummarize?: (event: SummaryEvent) => void;
  /** Reported when a summarization fails and the full conversation is kept. */
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
<<<<<<< HEAD
 * The AUTHORED session name a ref descends from — `planning~compact1@7` → `planning`.
 *
 * A ref is `<id>@<position>`, and a derived conversation's id is `<origin>~<word><n>`.
 * The lineage root is therefore what survives stripping both, and for a named session
 * it is the name the author wrote — the same value hw independently derives as a
 * binding's `resourceKey`. That correspondence is what lets the opt-in set hold
 * authored names while this store only ever sees positions.
 *
 * It also survives repeated compaction, which is the case that made it necessary:
 * without stripping, `planning~compact1` would not be in the opt-in set and a
 * conversation would be compacted exactly once ever.
 */
export function sessionNameOf(ref: string): string {
  const at = ref.lastIndexOf("@");
  const id = at > 0 ? ref.slice(0, at) : ref;
  const tilde = id.indexOf("~");
  return tilde >= 0 ? id.slice(0, tilde) : id;
}

/**
 * A `SessionStore` that keeps a conversation under a size budget by summarizing its
 * older turns into a newly minted one.
 *
 * Everything but `resolve` delegates: lineage, records and derivation are the inner
 * store's business, and duplicating any of it here would be a second implementation
 * of the semantics the contract is careful about.
=======
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
>>>>>>> claude/brave-antonelli-dbc5ac
 */
export class SummarizingSessionStore implements SessionStore<JsonValue> {
  private readonly inner: SessionStore<JsonValue>;
  private readonly budget: number;
  private readonly keepRecent: number;
<<<<<<< HEAD
  /**
   * Per-lineage chain, recording what each compaction went FROM and TO.
   *
   * `from` is what makes it correct rather than merely serial. Two calls racing on the
   * same ref must land on one compacted conversation, so the second reuses the first's
   * result — but a LATER call arrives with a ref further along that same lineage, and
   * must compact from its own position rather than being dragged back to a stale one.
   * Only comparing against `from` tells those two apart.
   */
  private readonly chain = new Map<string, Promise<{ from: string; to: string }>>();

  constructor(private readonly options: SummarizingSessionStoreOptions) {
    this.inner = options.inner ?? new MapSessionStore();
    if (this.inner.compact === undefined) {
      // Refused at construction rather than at the first oversized conversation, which
      // would be a silent no-op until a run happened to get long enough to need it.
      throw new Error("SummarizingSessionStore needs a store that can compact; the given one cannot");
    }
=======
  /** Per-stream write chain: two concurrent releases must not summarize in parallel. */
  private readonly chain = new Map<string, Promise<unknown>>();
  /** Where a compacted stream superseded its origin, so the next caller continues the new one. */
  private readonly superseded = new Map<string, string>();

  constructor(private readonly options: SummarizingSessionStoreOptions) {
    this.inner = options.inner ?? new MapSessionStore<JsonValue>();
>>>>>>> claude/brave-antonelli-dbc5ac
    this.budget = options.budgetChars ?? DEFAULT_BUDGET_CHARS;
    this.keepRecent = Math.max(0, options.keepRecentTurns ?? DEFAULT_KEEP_RECENT);
  }

<<<<<<< HEAD
  async resolve(request: SessionRequest): Promise<ResolvedSession<JsonValue>> {
    // No ref means a conversation is being MINTED, so there is nothing to compact yet.
    if (request.ref === undefined) return this.inner.resolve(request);
    const ref = await this.serialized(request.ref);
    return this.inner.resolve(ref === request.ref ? request : { ...request, ref });
  }

  fork(ref: string, seed?: string): string | Promise<string> {
    return this.inner.fork(ref, seed);
  }

  /**
   * The conversation's contents — compacted first, if it is over budget.
   *
   * Compacting on READ as well as on resolve is what makes summary mode do anything at
   * all. The engine builds its preamble from `messages()` BEFORE the call is dispatched,
   * so a conversation compacted only at resolve time would be inlined into the prompt at
   * full length and compacted immediately afterwards — the cost paid, the saving missed.
   * hw degrades `mode: "summary"` to `full_history` precisely because it has no
   * summarizer of its own; this store is the summarizer, so the compaction has to have
   * happened by the time it answers.
   *
   * So this returns the contents of the conversation the caller will end up in, which is
   * not always the one it named. Both paths run through {@link serialized}, so whichever
   * arrives first does the work and the other reuses it rather than compacting twice.
   */
  async messages(ref: string): Promise<JsonValue[]> {
    return this.inner.messages(await this.serialized(ref));
  }

  compact(ref: string, messages: readonly JsonValue[]): string | Promise<string> {
    return this.inner.compact!(ref, messages);
  }

  resync(ref: string, messages: readonly JsonValue[]): string | Promise<string> {
    if (this.inner.resync === undefined) throw new Error("the underlying store cannot resync");
    return this.inner.resync(ref, messages);
  }

  /**
   * Compact at most once per lineage at a time.
   *
   * Two calls resolving the same conversation concurrently would otherwise both see it
   * over budget, both summarize, and mint two conversations — one of which silently
   * wins. Chaining on the lineage root rather than on the ref is deliberate: the ref
   * CHANGES when compaction succeeds, so keying on it would not serialize the very
   * pair of calls that race.
   */
  private serialized(ref: string): Promise<string> {
    const key = sessionNameOf(ref);
    const settled = this.chain.get(key)?.catch(() => undefined) ?? Promise.resolve(undefined);
    const next = settled.then(async (last) => {
      // Arrived with the ref a completed compaction started from ⇒ that call and this one
      // are the race, and this one lands on the conversation the other minted.
      if (last !== undefined && last.from === ref && last.to !== ref) return { from: ref, to: last.to };
      return { from: ref, to: await this.compactIfOver(ref) };
    });
    this.chain.set(key, next);
    return next.then((r) => r.to);
  }

  /** The whole policy: which sessions, when, and what survives verbatim. */
  private async compactIfOver(ref: string): Promise<string> {
    if (this.options.sessions !== undefined && !this.options.sessions.has(sessionNameOf(ref))) return ref;
    const messages = await this.inner.messages(ref);
    // TODO(sessions §12): this filter is why an AGENT's conversation never compacts.
    //
    // `isTurn` matches a flat `{ role, content: string }`, which is what the engine's own transcript
    // used to hold. A real conversation holds `ModelMessage[]` — `content` is an array of parts
    // (text, tool calls, tool results, reasoning), so `every(isTurn)` is false and this returns early
    // and silently. The conversations that most need compacting — long agent runs full of tool
    // traffic — are exactly the ones that never do, and nothing reports it.
    //
    // Fixing it means summarizing `ModelMessage` rather than `Turn`: render parts down to text for the
    // summarizer's prompt, and keep the recent tail verbatim so tool-call/tool-result pairs stay
    // intact (splitting a pair leaves a call with no result, which providers reject). Until then this
    // is a no-op for agent sessions, which is at least the safe direction.
    if (!Array.isArray(messages) || !messages.every(isTurn)) return ref;
    const turns = messages as unknown as Turn[];
    const before = lengthOf(turns);
    if (before <= this.budget) return ref;
=======
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
>>>>>>> claude/brave-antonelli-dbc5ac

    const keep = this.keepRecent > 0 ? messages.slice(-this.keepRecent) : [];
    const fold = this.keepRecent > 0 ? messages.slice(0, -this.keepRecent) : messages;
    // Nothing to gain from summarizing a single turn into a turn.
<<<<<<< HEAD
    if (fold.length <= 1) return ref;

    try {
      const summary = await this.options.summarize(fold);
      if (summary.trim() === "") return ref;
      const head: Turn = { role: "user", content: `${SUMMARY_TAG}\n${summary.trim()}\n</conversation-summary>` };
      const next = [head, ...keep];
      const compactedTo = await this.inner.compact!(ref, next as unknown as JsonValue[]);
      this.options.onSummarize?.({ sessionId: ref, compactedTo, compacted: fold.length, before, after: lengthOf(next) });
      return compactedTo;
    } catch (e) {
      // Keep everything. An expensive run beats a run that forgot what it was doing.
      this.options.onError?.(ref, e as Error);
      return ref;
=======
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
>>>>>>> claude/brave-antonelli-dbc5ac
    }
  }
}

<<<<<<< HEAD
export { DEFAULT_SESSION, type ConversationModes as SummaryModes } from "@jaira/shared";
=======
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
>>>>>>> claude/brave-antonelli-dbc5ac

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
<<<<<<< HEAD
 * The two session seams a run needs, given its bundle.
 *
 * ⚠️ A run must ALWAYS have these, which is a change from when a session was a name.
 * The engine no longer writes the transcript — "a run with no session layer composed
 * records nothing, and the transcript stays empty" — so returning nothing when no
 * state asked for summarization would mean conversations did not exist at all, not
 * that they were merely uncompacted.
 *
 * What stays conditional is the DECORATOR. A workflow that never asked for
 * summarization should not have its conversations routed through code that could
 * compact them, so it gets the base store directly.
 *
 * `records` is always the BASE store, never the decorator: a conversation's messages
 * are its records, the decorator only intercepts `resolve`, and the two halves must
 * be one store or a call would claim a position in a conversation nobody can read.
=======
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
>>>>>>> claude/brave-antonelli-dbc5ac
 */
export function sessionServicesFor(
  bundle: WorkflowBundle,
  summarize: Summarizer,
  options: Omit<SummarizingSessionStoreOptions, "summarize" | "sessions"> = {},
): { sessions: SessionStore<JsonValue>; records: RecordStore; modes: ConversationModes } {
  const base = options.inner ?? new MapSessionStore();
  const modes = summarySessionsOf(bundle);
<<<<<<< HEAD
  const sessions =
    modes.sessions.size === 0
      ? base
      : new SummarizingSessionStore({ ...options, inner: base, summarize, sessions: modes.sessions });
  return { sessions, records: base as unknown as RecordStore, modes };
=======
  if (modes.sessions.size === 0) return { ...(options.inner !== undefined ? { store: options.inner } : {}), modes };
  return { store: new SummarizingSessionStore({ ...options, summarize, sessions: modes.sessions }), modes };
>>>>>>> claude/brave-antonelli-dbc5ac
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
      // Surfaced as a rejection so the store's catch keeps the full conversation.
      throw new Error(`summarization failed: ${result.error.reason}`);
    }
    const value = result.value;
    return typeof value === "string" ? value : JSON.stringify(value);
  };
}
