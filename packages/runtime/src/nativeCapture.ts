/**
 * Capturing the agent's OWN session file at operation close — the record's missing half.
 *
 * A delegated agent's record is built from its stream, and the stream is not the whole story: the
 * agent also writes a session file (`~/.claude/projects/<encoded-cwd>/<id>.jsonl`) holding lines
 * that never ride the wire — its context injections (`attachment` lines: deferred tools, skill
 * listings, task reminders), the structured `toolUseResult` beside every tool turn, its bookkeeping
 * (`queue-operation`, `ai-title`, `last-prompt`), and the uuid/parentUuid threading and timestamps
 * on every line. Nothing recovers those later, because the file is the AGENT'S: pruned on its
 * schedule, appended to across resumes, gone with the config dir. Copying at close is the honest
 * capture, and close is the one moment that sees every recorded call.
 *
 * Hence a {@link RecordStore} DECORATOR rather than executor work: the store's `close` is where a
 * settled call and its `providerSessionId` meet, on the prompt path (whole `LlmOutput` payload) and
 * the agent-function path (`SessionOutcome` only) alike. The captured lines land on the stored
 * payload as `nativeLines` — `LlmOutput`'s declared pinned-index shape — beside the messages they
 * annotate, so the transcript reader finds them where it already looks.
 *
 * Best-effort BY DESIGN: a capture failure logs and stores the record exactly as before. The record
 * is the run's memory and the capture is an enrichment of it; refusing to close a record because a
 * prunable file was unreadable would trade the whole memory for the annotation.
 */
import {
  nativeLinesOf,
  readNativeSession,
  readNativeSidechains,
  type AgentSessionReader,
  type NativeLine,
  type NativeSidechainFile,
} from "@declarative-ai/agents-api";
import type { JsonValue, RecordStore } from "@declarative-ai/exec";

type Settled = Parameters<RecordStore["close"]>[1];

/** The captured delta: the main file's kept lines, and each subagent file's, keyed like `sidechains`. */
interface Captured {
  nativeLines?: NativeLine[];
  nativeSidechains?: Record<string, { agentId: string; meta?: JsonValue; lines: NativeLine[] }>;
}

export interface NativeCaptureOptions {
  /** The working directory the agent ran in (`ctx.workspace.root`) — what names its project folder. */
  cwd: string;
  /** The file reader. Default: the real `~/.claude/projects` reader. A seam because it is file I/O
   *  a test has to stand in for, exactly as `AgentQuery` is. */
  read?: AgentSessionReader;
  /** The subagent-file reader — same seam, same default rationale. */
  readSidechains?: (providerSessionId: string, cwd?: string) => Promise<NativeSidechainFile[]>;
  /** Told, not thrown: see the header on why a failed capture must not fail the close. */
  onError?: (error: Error) => void;
}

/** A payload value the lines can honestly ride on — a record-shaped object, not text or bytes. */
function recordShaped(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array) && !("getReader" in value)
  );
}

/**
 * The settled record with `nativeLines` folded into its payload.
 *
 * Three payload shapes reach a close and each gets the same answer a reader expects:
 *  - a prompt-op record is `{ value: LlmOutput }` — the lines join the output object;
 *  - a delegated function op settles with a text value and reports its conversation on
 *    `sessionOutcome` — the store prefers the report (`{ value: { messages } }`), so the lines are
 *    folded into THAT shape, which is what actually gets stored;
 *  - anything else has nowhere honest to put them, and is stored untouched rather than wrapped in a
 *    shape nothing reads.
 */
function enriched(settled: Settled, captured: Captured): Settled {
  const result = settled.result;
  const value = result !== undefined && "value" in result ? result.value : undefined;
  if (recordShaped(value)) {
    return { ...settled, result: { ...result, value: { ...value, ...captured } } as unknown as Settled["result"] };
  }
  const messages = settled.sessionOutcome?.messages;
  if (messages !== undefined) {
    return { ...settled, result: { ...(result ?? {}), value: { messages, ...captured } } as unknown as Settled["result"] };
  }
  return settled;
}

/**
 * Wrap a record store so every close of a call that ended in a provider session captures that
 * session's native file into the stored payload.
 *
 * The RESUMED-session cut rides on the record's own `metrics.startMs`: the file spans the whole
 * conversation while this record spans one call, so only lines stamped inside the call are kept —
 * earlier lines belong to the records of the calls that produced them, which captured them at their
 * own closes.
 */
export function withNativeCapture(inner: RecordStore, options: NativeCaptureOptions): RecordStore {
  const read = options.read ?? readNativeSession;
  const readSidechains = options.readSidechains ?? readNativeSidechains;
  return {
    open: (stub) => inner.open(stub),
    // Presence is part of the contract — `bySession` absent MEANS the store cannot read, and a stub
    // that appeared here would claim a capability the inner store does not have.
    ...(inner.bySession !== undefined ? { bySession: (session, upTo) => inner.bySession!.call(inner, session, upTo) } : {}),
    close: async (id, settled) => {
      const providerSessionId = settled.sessionOutcome?.providerSessionId;
      if (providerSessionId === undefined) return inner.close(id, settled);
      const captured: Captured = {};
      try {
        const startMs = settled.metrics?.startMs;
        const cut = startMs !== undefined ? { sinceMs: startMs } : {};
        const native = nativeLinesOf(await read(providerSessionId, options.cwd), cut);
        if (native.length > 0) captured.nativeLines = native;
        // The subagents' files, keyed the way `sidechains` already is. The same cut applies per
        // file: a subagent spawned by an EARLIER call in a resumed session folds to nothing here,
        // because that call's own close captured it.
        const chains: NonNullable<Captured["nativeSidechains"]> = {};
        for (const chain of await readSidechains(providerSessionId, options.cwd)) {
          const lines = nativeLinesOf(chain.lines, { ...cut, sidechain: true });
          if (lines.length === 0) continue;
          chains[chain.toolUseId ?? `agent-${chain.agentId}`] = {
            agentId: chain.agentId,
            ...(chain.meta !== undefined ? { meta: chain.meta } : {}),
            lines,
          };
        }
        if (Object.keys(chains).length > 0) captured.nativeSidechains = chains;
      } catch (e) {
        options.onError?.(e as Error);
        return inner.close(id, settled);
      }
      // An empty capture is stored as NOTHING rather than as `nativeLines: []` — a transport with no
      // native file (codex, a fake) would otherwise stamp every record with an empty claim.
      return inner.close(id, captured.nativeLines === undefined && captured.nativeSidechains === undefined ? settled : enriched(settled, captured));
    },
  };
}
