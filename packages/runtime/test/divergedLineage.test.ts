/**
 * ONE lineage when a call reports a remote it was not given.
 *
 * `resolve` hands over the handle a conversation currently sits on and assumes the call will append
 * to it. Whether that handle is usable is not a fact the store has — a different provider, a remote
 * that compacted itself server-side, an adapter that branched on its own — so the assumption is
 * corrected by what comes back rather than guarded against up front.
 *
 * TWO things respond to that correction, and they must agree on WHERE the record now lives:
 *
 *  - `SqliteSessionStore.correctLineage`, from `update`/`finish`, moves the record onto a branch cut
 *    at the position it was claimed at. Always available; needs nothing from the provider.
 *  - `checkDivergence`, in `withSessionPosition`, calls `SessionStore.resync` — which MINTS a separate
 *    conversation seeded with a provider re-read, and reports it on `metrics.sessionRef`.
 *
 * Answering with two different conversations puts the record on one and points every later reader at
 * the other. This is driven through the real `PromptExecutor` and a real store rather than a stub,
 * because that is what the two hand-rolled probes that came before it could not do: neither reached
 * `finish`, so neither mechanism ran and the interaction stayed unobserved.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withRecord, withSessionPosition } from "@declarative-ai/exec";
import { createPromptExecutor, type CallRunner } from "@declarative-ai/promptop";
import type { LlmCallDefinition } from "@declarative-ai/llm";
import { SqliteSessionStore, openDb, type JairaDb } from "@jaira/persistence";

let dir: string;
let db: JairaDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-diverged-"));
  db = openDb(join(dir, "jaira.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A runner that answers every call claiming it ran in `handle`, whatever it was asked to resume. */
function runnerReporting(handle: string): { runner: CallRunner; seen: LlmCallDefinition[] } {
  const seen: LlmCallDefinition[] = [];
  const runner: CallRunner = async (def) => {
    seen.push(def);
    return {
      value: {
        value: { answer: "ok" },
        finishReason: "stop",
        providerSessionId: handle,
        entries: [{ kind: "message", role: "assistant", provider: "test", timestamp: "t", content: [{ type: "text", text: "ok" }] }],
      },
      metrics: { durationMs: 0, costUsd: 0, costSource: "unknown" },
    } as never;
  };
  return { runner, seen };
}

const op = {
  kind: "prompt",
  user: "say something",
  config: { model: "test/model" },
  input: {},
  output: { name: "answer", kind: "text", schema: { type: "string" } },
} as never;

describe("a call that reports a remote it was not given", () => {
  it("leaves the record in exactly one lineage, and points later readers at that one", async () => {
    const store = new SqliteSessionStore(db, { taskId: "t-div" });

    // The trunk, sitting on P1.
    const first = store.resolve({ ref: "chat" });
    // The PAIR: a handle whose owner is unnamed is not a resume identity and the store keeps none
    // (Identity and Resume §03). `test` is what `providerOf("test/model")` reads off the op below,
    // so the seeded trunk sits on the same provider the call about to run does.
    store.finish(store.append({ id: "seed", source: undefined as never, session: first.at, startMs: 1 }), {
      sessionOutcome: { messages: [{ role: "assistant", content: "one" }] as never, providerSessionId: "P1", provider: "test" },
    });

    // A call handed P1 that comes back saying it ran in P2.
    const { runner } = runnerReporting("P2");
    const stack = withSessionPosition(
      { sessions: store as never },
      withRecord({ records: store as never }, createPromptExecutor({ runner }) as never),
    ) as never;
    const at = store.resolve({ ref: "chat" });
    expect(at.providerSessionId).toBe("P1");
    const result = await (stack as { start: (o: unknown, c: unknown) => { result: Promise<unknown> } }).start(op, { session: at }).result;

    // The call settled — without this the rest asserts nothing, which is how the stub probes fooled me.
    const records = db
      .prepare(`SELECT id AS record_id, status, provider_session_id FROM operation_records ORDER BY rowid`)
      .all() as Array<{ record_id: string; status: string; provider_session_id: string | null }>;
    expect(records.map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(records[1]!.provider_session_id).toBe("P2");

    // ONE new lineage, not two: the branch the record moved to, and no separately minted resync.
    const derived = db.prepare(`SELECT id, parent, cursor FROM sessions WHERE parent IS NOT NULL OR id LIKE '%~%'`).all() as Array<{
      id: string;
      parent: string | null;
      cursor: number;
    }>;
    expect(derived).toHaveLength(1);

    // …and the record POINTS at it — divergence is a fact on the record (`landed_session_id`) now,
    // not a moved position row, and readers take landed-when-present.
    const where = db
      .prepare(`SELECT landed_session_id FROM operation_records WHERE id = ?`)
      .get(records[1]!.record_id) as { landed_session_id: string | null } | undefined;
    expect(where?.landed_session_id).toBe(derived[0]!.id);

    // …and what the call reports as its ending position names that same lineage, so whatever continues
    // from here continues where the turn actually is.
    const ref = (result as { metrics?: { sessionRef?: string } }).metrics?.sessionRef;
    expect(ref).toBeDefined();
    expect(ref!.startsWith(derived[0]!.id.replace("t-div/1/", ""))).toBe(true);
  });
});
