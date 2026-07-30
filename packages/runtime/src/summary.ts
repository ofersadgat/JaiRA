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
 *  - **A failed summarization never loses the transcript.** Compaction is
 *    destructive; if the summarizer throws, the full turns are stored instead. A
 *    provider hiccup must degrade to an expensive run, not a lobotomized one.
 *  - **Recent turns stay verbatim.** The last exchange is what the next call
 *    actually responds to; summarizing it away is what makes summary modes feel
 *    lossy.
 */
import type { Executor, ExecServices, JsonValue, SessionState, SessionStore } from "@declarative-ai/exec";
import { promptOp } from "@declarative-ai/exec";
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
  sessionId: string;
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
 * A `SessionStore` that keeps a session's transcript under a size budget by
 * summarizing its older turns.
 *
 * Compaction happens on `put` rather than on `get`, so the cost is paid once per
 * write instead of once per reader, and a `get` never blocks a state's start on a
 * model call.
 */
export class SummarizingSessionStore implements SessionStore<JsonValue> {
  private readonly inner: SessionStore<JsonValue>;
  private readonly budget: number;
  private readonly keepRecent: number;
  /** Per-session write chain: two concurrent puts must not summarize in parallel. */
  private readonly chain = new Map<string, Promise<void>>();

  constructor(private readonly options: SummarizingSessionStoreOptions) {
    this.inner = options.inner ?? new MapStore();
    this.budget = options.budgetChars ?? DEFAULT_BUDGET_CHARS;
    this.keepRecent = Math.max(0, options.keepRecentTurns ?? DEFAULT_KEEP_RECENT);
  }

  async get(logicalId: string): Promise<SessionState<JsonValue> | undefined> {
    // Wait for a pending compaction: reading mid-write would hand the next state a
    // transcript that is about to be replaced.
    await this.chain.get(logicalId);
    return this.inner.get(logicalId);
  }

  put(logicalId: string, state: SessionState<JsonValue>): Promise<void> {
    const previous = this.chain.get(logicalId) ?? Promise.resolve();
    const next = previous.then(() => this.write(logicalId, state));
    this.chain.set(
      logicalId,
      next.catch(() => undefined),
    );
    return next;
  }

  private async write(logicalId: string, state: SessionState<JsonValue>): Promise<void> {
    const compacted = await this.compact(logicalId, state);
    await this.inner.put(logicalId, compacted);
  }

  /** The whole policy: which sessions, when, and what survives verbatim. */
  private async compact(logicalId: string, state: SessionState<JsonValue>): Promise<SessionState<JsonValue>> {
    if (this.options.sessions !== undefined && !this.options.sessions.has(logicalId)) return state;
    const messages = state.messages;
    if (!Array.isArray(messages) || !messages.every(isTurn)) return state;
    const turns = messages as unknown as Turn[];
    const before = lengthOf(turns);
    if (before <= this.budget) return state;

    const keep = this.keepRecent > 0 ? turns.slice(-this.keepRecent) : [];
    const fold = this.keepRecent > 0 ? turns.slice(0, -this.keepRecent) : turns;
    // Nothing to gain from summarizing a single turn into a turn.
    if (fold.length <= 1) return state;

    try {
      const summary = await this.options.summarize(fold);
      if (summary.trim() === "") return state;
      const head: Turn = { role: "user", content: `${SUMMARY_TAG}\n${summary.trim()}\n</conversation-summary>` };
      const next = [head, ...keep];
      this.options.onSummarize?.({ sessionId: logicalId, compacted: fold.length, before, after: lengthOf(next) });
      return { ...state, messages: next as unknown as JsonValue[] };
    } catch (e) {
      // Keep everything. An expensive run beats a run that forgot what it was doing.
      this.options.onError?.(logicalId, e as Error);
      return state;
    }
  }
}

/** The default backing store (the engine's own `MapSessionStore` is not exported). */
class MapStore implements SessionStore<JsonValue> {
  private readonly map = new Map<string, SessionState<JsonValue>>();
  get(logicalId: string): SessionState<JsonValue> | undefined {
    return this.map.get(logicalId);
  }
  put(logicalId: string, state: SessionState<JsonValue>): void {
    this.map.set(logicalId, state);
  }
}

export { DEFAULT_SESSION, type ConversationModes as SummaryModes } from "@jaira/shared";

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
 * The session store a run should use, given its bundle: a summarizing store when
 * any state asked for `summary` mode, and nothing (the engine's own) otherwise.
 *
 * Returning `undefined` rather than an always-on decorator matters: a workflow
 * that never asked for summarization should not have its transcripts routed
 * through code that could compact them.
 */
export function sessionStoreFor(
  bundle: WorkflowBundle,
  summarize: Summarizer,
  options: Omit<SummarizingSessionStoreOptions, "summarize" | "sessions"> = {},
): { store?: SessionStore<JsonValue>; modes: ConversationModes } {
  const modes = summarySessionsOf(bundle);
  if (modes.sessions.size === 0) return { modes };
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
