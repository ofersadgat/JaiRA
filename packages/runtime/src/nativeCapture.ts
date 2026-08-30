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
 * the agent-function path (`SessionOutcome` only) alike. The captured lines are MERGED INTO the
 * payload's `entries` — annotating the turns they belong to, never stored beside them as a second
 * encoding of the same conversation, which is what `nativeLines` on the record used to be.
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
import { entriesOfMessages, renderToolResult } from "@declarative-ai/llm";

type Settled = Parameters<RecordStore["finish"]>[1];

/** The captured delta: the main file's kept lines, and each subagent file's, keyed like `sidechains`. */
export interface Captured {
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
 *    `sessionOutcome` — those turns become entries here, so the lines fold into the same one array
 *    every other record carries rather than into a second shape only this path would write;
 *  - anything else has nowhere honest to put them, and is stored untouched rather than wrapped in a
 *    shape nothing reads.
 */
function enriched(settled: Settled, captured: Captured): Settled {
  const result = settled.result;
  const value = result !== undefined && "value" in result ? result.value : undefined;
  if (recordShaped(value)) {
    // MERGED into the entries, not stored beside them. The captured file and the streamed log were
    // two encodings of one conversation with no key to join on, so the reader paired them by role
    // and order on every read and said so. Pairing once, here, where both halves are in hand, is
    // what makes the record one array — and the 62% of a capture that was `toolUseResult` restating
    // a tool result the entries already held stops being stored twice.
    return {
      ...settled,
      result: { ...result, value: foldIntoEntries(value, captured) } as unknown as Settled["result"],
    };
  }
  const messages = settled.sessionOutcome?.messages;
  if (messages !== undefined) {
    // Converted BEFORE the fold, so this branch and the one above produce the same thing: a record
    // whose conversation is `entries`. Storing `{ messages }` here made this the one path that
    // wrote a second encoding, and a reader that stopped speaking it would find the record empty.
    const entries = entriesOfMessages(messages as never, { provider: "unknown", at: new Date(0).toISOString() });
    return {
      ...settled,
      result: {
        ...(result ?? {}),
        value: foldIntoEntries({ entries: entries as unknown as JsonValue }, captured),
      } as unknown as Settled["result"],
    };
  }
  return settled;
}

/**
 * Read one provider session's native files — the main conversation and each subagent's.
 *
 * Extracted from the close decorator because RECOVERY needs exactly the same read: a call the
 * process died inside never reached a close, but its file is on disk and its handle is on the
 * record (streamed there while it ran). The two callers differ only in when they ask.
 *
 * `sinceMs` is the resumed-session cut: the file spans a whole conversation while a record spans
 * one call, so only lines stamped inside the call are kept — earlier ones belong to the records
 * that captured them at their own closes.
 */
export async function captureNativeSession(
  providerSessionId: string,
  options: { cwd: string; sinceMs?: number; read?: AgentSessionReader; readSidechains?: NativeCaptureOptions["readSidechains"] },
): Promise<Captured> {
  const read = options.read ?? readNativeSession;
  const readSidechains = options.readSidechains ?? readNativeSidechains;
  const captured: Captured = {};
  const cut = options.sinceMs !== undefined ? { sinceMs: options.sinceMs } : {};
  const native = nativeLinesOf(await read(providerSessionId, options.cwd), cut);
  if (native.length > 0) captured.nativeLines = native;
  // The subagents' files, keyed the way `sidechains` already is. The same cut applies per file: a
  // subagent spawned by an EARLIER call in a resumed session folds to nothing here, because that
  // call's own close captured it.
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
  return captured;
}

/** True when a capture found nothing — stored as NOTHING rather than as an empty claim. */
export function isEmptyCapture(captured: Captured): boolean {
  return captured.nativeLines === undefined && captured.nativeSidechains === undefined;
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
  return {
    append: (stub) => inner.append(stub),
    // Passed through when the inner store has one — presence is part of the contract, same as
    // `bySession`: a stub here would claim this store can hold a partial when the inner cannot.
    ...(inner.update !== undefined ? { update: (at, partial) => inner.update!.call(inner, at, partial) } : {}),
    // Presence is part of the contract — `bySession` absent MEANS the store cannot read, and a stub
    // that appeared here would claim a capability the inner store does not have.
    ...(inner.bySession !== undefined ? { bySession: (session, upTo) => inner.bySession!.call(inner, session, upTo) } : {}),
    finish: async (ref, settled) => {
      const providerSessionId = settled.sessionOutcome?.providerSessionId;
      if (providerSessionId === undefined) return inner.finish(ref, settled);
      let captured: Captured;
      try {
        captured = await captureNativeSession(providerSessionId, {
          cwd: options.cwd,
          ...(settled.metrics?.startMs !== undefined ? { sinceMs: settled.metrics.startMs } : {}),
          ...(options.read !== undefined ? { read: options.read } : {}),
          ...(options.readSidechains !== undefined ? { readSidechains: options.readSidechains } : {}),
        });
      } catch (e) {
        options.onError?.(e as Error);
        return inner.finish(ref, settled);
      }
      // An empty capture is stored as NOTHING rather than as `nativeLines: []` — a transport with no
      // native file (codex, a fake) would otherwise stamp every record with an empty claim.
      return inner.finish(ref, isEmptyCapture(captured) ? settled : enriched(settled, captured));
    },
  };
}

// --- folding the captured file into the entries ------------------------------

/** The per-line facts that are the RECORD's, not an entry's — one value each across a whole file. */
const RECORD_INVARIANTS = ["sessionId", "cwd", "version", "gitBranch", "entrypoint", "userType"] as const;

/** The line types the agent writes that are not messages, and are not worth an entry of their own. */
const DROPPED_LINE_TYPES = new Set(["last-prompt"]);

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Merge a captured session file into the payload's entries.
 *
 * Three things come out of the file that the stream never carried, and each lands where it belongs:
 *
 *  - **`toolUseResult`** — the agent's structured record of a tool execution — onto the
 *    `tool_result` block it answers, as `data`. Where a registered renderer reproduces the rendered
 *    text from it, the text is dropped: measured across one run, 82 of 83 file reads round-tripped
 *    byte for byte, and that alone was 0.95 MB.
 *  - **threading** (`uuid`, `parentUuid`) and the per-line timestamp, onto the entry itself.
 *  - **non-message lines** — context injections, queued operations, the agent's own title — as
 *    `kind: "event"` entries at their woven position. Without a place for them they are simply lost;
 *    the transcript renders two of the three and names the conversation from the third.
 *
 * Paired by ROLE AND ORDER, which is the rule the reader used and the reason this now happens once:
 * the file holds message lines the stream never carried (the prompt itself), so index arithmetic
 * against the turns is off by one the moment a run begins.
 */
export function foldIntoEntries(value: Record<string, unknown>, captured: Captured): Record<string, unknown> {
  const entries = Array.isArray(value["entries"]) ? [...(value["entries"] as Record<string, unknown>[])] : [];
  const chains = captured.nativeSidechains ?? {};
  if ((captured.nativeLines ?? []).length === 0 && Object.keys(chains).length === 0) return value;

  const invariants: Record<string, unknown> = {};
  const folded: Record<string, unknown>[] = [];

  // The MAIN chain: entries with no `sidechain` marker.
  foldChain(entries, captured.nativeLines ?? [], undefined, invariants, folded);

  // Each SUBAGENT's own file, against the entries the stream already tagged with the call that
  // spawned it. This is where §5's two key spaces close: the streamed turns are keyed by the tool
  // call and the captured file by the agent id, and the fold is the one place that holds both — so
  // it writes them onto one marker, `{ id: <agent>, parentToolUseId: <call> }`, and the pair stops
  // being something a reader has to re-derive.
  for (const [key, chain] of Object.entries(chains)) {
    const marker = { id: chain.agentId, parentToolUseId: key };
    const mine = entries.filter((e) => isRecord(e["sidechain"]) && (e["sidechain"] as { id?: unknown }).id === key);
    for (const entry of mine) entry["sidechain"] = { ...marker };
    foldChain(mine, chain.lines, marker, invariants, folded);
    // The agent's own sidecar — why the subagent existed — has no message to hang on, so it is an
    // event of the chain it describes rather than a map on the side.
    folded.push({
      kind: "event",
      provider: "anthropic",
      timestamp: "",
      sidechain: { ...marker },
      event: { type: "sidechain", data: { agentId: chain.agentId, ...(chain.meta !== undefined ? { meta: chain.meta } : {}) } },
    });
  }

  const out: Record<string, unknown> = { ...value };
  // THE MARKER a recovery reads. The fold used to be recognizable by the `nativeLines` field it
  // left behind; there is no such field now, and without something saying so a re-open would
  // re-read the agent's files for a record that already has them. It is a fact about the record
  // either way — when its transport's own log was folded in — so it is recorded as one.
  out["capturedAt"] = new Date().toISOString();
  if (entries.length > 0 || folded.length > 0) out["entries"] = [...entries, ...folded];
  if (Object.keys(invariants).length > 0) out["session"] = { ...(isRecord(value["session"]) ? value["session"] : {}), ...invariants };
  // Neither capture survives as its own field: everything they carried is above, and keeping them
  // would restore the duplication this fold exists to remove.
  return out;
}

/**
 * Walk one file's lines against the entries of one chain.
 *
 * Message lines ANNOTATE — threading, clock, the structured tool result — and everything else
 * becomes an event at its woven position. A subagent's file marks its own message lines
 * `isSidechain: true`, which is the transport saying the same thing `marker` does; inside its own
 * chain those lines are the messages, so the test is against the chain being walked rather than
 * against the flag.
 */
function foldChain(
  entries: Record<string, unknown>[],
  lines: readonly { line: unknown }[],
  marker: { id: string; parentToolUseId: string } | undefined,
  invariants: Record<string, unknown>,
  folded: Record<string, unknown>[],
): void {
  let cursor = 0;
  for (const { line } of lines) {
    if (!isRecord(line)) continue;
    for (const key of RECORD_INVARIANTS) {
      if (invariants[key] === undefined && line[key] !== undefined) invariants[key] = line[key];
    }
    const type = typeof line["type"] === "string" ? (line["type"] as string) : "";
    const inThisChain = marker !== undefined ? line["isSidechain"] === true : line["isSidechain"] !== true;
    const isMessageLine = (type === "user" || type === "assistant") && inThisChain;
    if (!isMessageLine) {
      if (DROPPED_LINE_TYPES.has(type) || (type !== "user" && type !== "assistant" && !inThisChain && marker !== undefined)) continue;
      folded.push({ ...eventEntryOf(line, type), ...(marker !== undefined ? { sidechain: { ...marker } } : {}) });
      continue;
    }
    // A user line pairs only when it carries a tool result: the PROMPT user line is input, never
    // rode the stream back, and pairing it would shift every annotation after it by one.
    if (type === "user" && line["toolUseResult"] === undefined) continue;
    const entry = nextEntryOfRole(entries, cursor, type);
    if (entry === undefined) continue;
    cursor = entry.at + 1;
    annotate(entry.entry, line);
  }
}

/** The next main-chain message entry of `role` at or after `from`. */
function nextEntryOfRole(
  entries: Record<string, unknown>[],
  from: number,
  role: string,
): { entry: Record<string, unknown>; at: number } | undefined {
  for (let i = from; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry["kind"] === "message" && entry["sidechain"] === undefined && entry["role"] === role) return { entry, at: i };
  }
  return undefined;
}

/** Copy a line's threading, its clock and its structured tool result onto the entry it belongs to. */
function annotate(entry: Record<string, unknown>, line: Record<string, unknown>): void {
  if (typeof line["uuid"] === "string") entry["uuid"] = line["uuid"];
  if (typeof line["parentUuid"] === "string") entry["parentUuid"] = line["parentUuid"];
  if (typeof line["timestamp"] === "string") entry["timestamp"] = line["timestamp"];
  const result = line["toolUseResult"];
  if (result === undefined) return;
  const content = entry["content"];
  if (!Array.isArray(content)) return;
  for (const block of content as Record<string, unknown>[]) {
    if (!isRecord(block) || block["type"] !== "tool_result") continue;
    block["data"] = result;
    // The rendered text goes only where a renderer puts it back exactly. Unregistered shapes keep
    // theirs: a new tool or an unrecognized variant costs bytes, never fidelity.
    const rendered = renderToolResult(result as never);
    const shown = typeof block["content"] === "string" ? (block["content"] as string) : undefined;
    if (rendered !== undefined && shown !== undefined && rendered === shown) delete block["content"];
    return;
  }
}

/** A non-message line as an entry. Its own type is kept — the vocabulary is the agent's, and grows. */
function eventEntryOf(line: Record<string, unknown>, type: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(line)) {
    if (key === "type" || RECORD_INVARIANTS.includes(key as (typeof RECORD_INVARIANTS)[number])) continue;
    data[key] = v;
  }
  return {
    kind: "event",
    provider: "anthropic",
    ...(typeof line["timestamp"] === "string" ? { timestamp: line["timestamp"] } : { timestamp: "" }),
    ...(typeof line["uuid"] === "string" ? { uuid: line["uuid"] } : {}),
    event: { type, ...(Object.keys(data).length > 0 ? { data } : {}) },
  };
}
