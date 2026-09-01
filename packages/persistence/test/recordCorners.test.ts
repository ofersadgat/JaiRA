/**
 * Records under the entry format and the Ref layer, driven by FUNCTION ops through the real store.
 *
 * The unit tests either side of this one check the pieces: `blobStore.test.ts` that a big leaf is
 * stored once, `entry.ts`'s own suite that a projection is faithful. What is left is the seam — a
 * record written by a run and read back by a viewer — where a value that survives dehydration but
 * not hydration, or a projection that reads the stored shape instead of the live one, shows up as
 * an empty conversation rather than an error.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { testHome } from "@jaira/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject, openProject, type Project } from "../src/project";
import { SqliteSessionStore, messagesOfRecord } from "../src/sessionStore";
import { BLOB_THRESHOLD, collectBlobs, sha256 } from "../src/blobStore";
import type { JsonValue } from "@declarative-ai/json";

let dir: string;
let project: Project;

const BIG = "x".repeat(BLOB_THRESHOLD * 2);
const OTHER = "y".repeat(BLOB_THRESHOLD * 2);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-records-"));
  initProject(dir, testHome());
  project = openProject(dir, { baseDir: testHome() });
});
afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

const store = () => new SqliteSessionStore(project.db, { taskId: "t1" });

/** One entry as an agent produces it — provider parts VERBATIM, which is the format's whole rule. */
const message = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  kind: "message",
  role,
  provider: "anthropic",
  timestamp: "2026-08-27T00:00:00.000Z",
  content,
  ...extra,
});

/** The stub a FUNCTION op writes — the one shape every record starts as. */
const stub = (id: string) => ({ id, source: { kind: "function", functionRef: "work" } as never, startMs: 1 });

/** Open a record, close it with this payload, and read it back the way a viewer would. */
function roundTrip(value: Record<string, unknown>): { read: JsonValue | undefined; blobs: number } {
  const s = store();
  s.finish(s.append(stub("r1")), { result: { value } as never, metrics: { startMs: 1, durationMs: 1 } as never });
  const back = s.record("r1");
  const blobs = (project.db.prepare(`SELECT count(*) c FROM blobs`).get() as { c: number }).c;
  return { read: back?.result, blobs };
}

describe("a record round-trips through the Ref layer unchanged", () => {
  it("gives back exactly what was stored, references and all", () => {
    const value = {
      entries: [message("assistant", [{ type: "text", text: BIG }])],
      finishReason: "stop",
    };
    const { read, blobs } = roundTrip(value);
    expect(blobs).toBe(1);
    expect(read).toEqual({ value });
  });

  it("stores ONE row for a value two records share", () => {
    const s = store();
    for (const rid of ["r1", "r2"]) {
      s.finish(s.append(stub(rid)), { result: { value: { entries: [message("user", BIG)] } } as never, metrics: { startMs: 1, durationMs: 1 } as never });
    }
    const rows = project.db.prepare(`SELECT hash, refs FROM blobs`).all() as Array<{ hash: string; refs: number }>;
    // The case the layer exists for: the same file read by two passes of a loop.
    expect(rows).toEqual([{ hash: sha256(BIG), refs: 2 }]);
    expect(messagesOfRecord(s.record("r2")?.result)).toEqual([{ role: "user", content: BIG }]);
  });

  it("keeps a bare-string content a bare string — the wire gets what the provider sent", () => {
    const { read } = roundTrip({ entries: [message("user", "just text")] });
    const entries = (read as { value: { entries: Array<{ content: unknown }> } }).value.entries;
    expect(entries[0]!.content).toBe("just text");
  });

  it("leaves a SHORT string inline, so a reference never costs more than the value", () => {
    const { blobs } = roundTrip({ entries: [message("assistant", [{ type: "text", text: "short" }])] });
    expect(blobs).toBe(0);
  });
});

describe("the wire history a record answers with", () => {
  it("derives messages from entries, and leaves a subagent's turns out of them", () => {
    const value = {
      entries: [
        message("assistant", [{ type: "text", text: "main thread" }]),
        message("assistant", [{ type: "text", text: "the subagent" }], {
          sidechain: { id: "agent-1", parentToolUseId: "toolu_1" },
        }),
        message("user", [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }]),
      ],
    };
    const { read } = roundTrip(value);
    // Folding a subagent in is how a record comes to claim the conversation said what it did not.
    expect(messagesOfRecord(read)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "main thread" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }] },
    ]);
  });

  it("skips EVENT entries — a context injection is not a turn", () => {
    const value = {
      entries: [
        { kind: "event", provider: "anthropic", timestamp: "t", event: { type: "attachment" } },
        message("assistant", [{ type: "text", text: "hello" }]),
      ],
    };
    expect(messagesOfRecord(roundTrip(value).read)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("skips the PARTIAL entry — a turn nobody finished must not go back on the wire", () => {
    // The conversation is one array that grows as fragments arrive, so the turn in flight is an
    // entry like any other. What separates it is a flag ON it, and this read is where that flag
    // earns its keep: these messages are what a resume sends back to the provider, and half an
    // assistant turn is not an exchange that happened. The viewer still shows it — `turnsOf` reads
    // the same array and keeps it.
    const value = {
      entries: [
        message("user", [{ type: "text", text: "the question" }]),
        message("assistant", [{ type: "text", text: "a finished answer" }]),
        { ...message("assistant", [{ type: "text", text: "half a sen" }]), partial: true },
      ],
    };
    expect(messagesOfRecord(roundTrip(value).read)).toEqual([
      { role: "user", content: [{ type: "text", text: "the question" }] },
      { role: "assistant", content: [{ type: "text", text: "a finished answer" }] },
    ]);
  });

  it("answers with NOTHING for a payload that is not a conversation", () => {
    // A scripted value or a bare function result has no turns, and inventing some would be worse
    // than saying so.
    expect(messagesOfRecord(roundTrip({ value: "just an answer" }).read)).toEqual([]);
  });

  it("hydrates before projecting, so a referenced turn is not a reference in the transcript", () => {
    const value = { entries: [message("assistant", [{ type: "text", text: OTHER }])] };
    const messages = messagesOfRecord(roundTrip(value).read) as Array<{ content: Array<{ text: string }> }>;
    expect(messages[0]!.content[0]!.text).toBe(OTHER);
  });
});

describe("releasing what a record referenced", () => {
  it("keeps bytes a second record still names, and collects them when it does not", () => {
    const s = store();
    for (const rid of ["r1", "r2"]) {
      s.finish(s.append(stub(rid)), { result: { value: { entries: [message("user", BIG)] } } as never, metrics: { startMs: 1, durationMs: 1 } as never });
    }
    // Nothing has been released, so nothing is garbage.
    expect(collectBlobs(project.db)).toBe(0);
    expect((project.db.prepare(`SELECT refs FROM blobs`).get() as { refs: number }).refs).toBe(2);
  });
});
