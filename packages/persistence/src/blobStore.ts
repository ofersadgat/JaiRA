/**
 * Big leaves, stored once by content hash — the Ref layer (RECORDS.md §8).
 *
 * A record is `{ input, output }` and both halves are JSON. Deduplicating inside one record got the
 * conversation stored once; this is what stops the SAME bytes being stored again in the next record.
 * Measured on one run of the `feature` workflow, one 67 KB file appeared verbatim in several passes
 * of a loop, and every resumed session re-read context it had already recorded.
 *
 * ## What is a leaf
 *
 * A STRING over {@link BLOB_THRESHOLD}, and nothing else. Not objects, not arrays: a container's
 * bytes are mostly its structure, structure is what differs between records, and hashing it would
 * spend a hash to store a near-unique value. The repetition is in the leaves — a file's contents, a
 * rendered tool result, a long prompt — and those are strings.
 *
 * The threshold exists because a hash is 64 characters. Below it the reference costs more than the
 * value, which is not a saving, it is a second copy with extra steps.
 *
 * ## The shape a reference takes
 *
 * `{ "$blob": "<sha-256>" }`, in the leaf's place. It is deliberately an object rather than a magic
 * string prefix: a stored string can begin with anything, and a sentinel prefix is a rule the data
 * can violate. An object with one reserved key cannot be produced by a JSON string, so hydration has
 * no ambiguity to resolve and no escape hatch to get wrong.
 *
 * ## Hydration is BATCHED, always
 *
 * §8's second open question. Resolving refs one at a time makes reading a record N queries, which
 * is how a dedup layer becomes slower than the duplication it removed. {@link hydrate} collects
 * every hash in one walk and reads them in one statement, so a record costs two queries whatever it
 * holds.
 */
import { createHash } from "node:crypto";
import type { JsonValue } from "@declarative-ai/json";
import type { JairaDb } from "./db";

/**
 * The size a string has to reach before it is worth referencing.
 *
 * A reference is ~76 bytes serialized (`{"$blob":"<64 hex>"}`), so anything near that saves nothing
 * on its first use and costs a row. 1 KB is comfortably above the noise and below every value this
 * exists for — the smallest real file read in the measured run was 1,060 bytes.
 */
export const BLOB_THRESHOLD = 1024;

/** The reserved key. One key, one meaning, and no string can imitate it. */
const BLOB_KEY = "$blob";

interface BlobRef {
  [BLOB_KEY]: string;
}

const isBlobRef = (v: unknown): v is BlobRef =>
  v !== null && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, unknown>)[BLOB_KEY] === "string";

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Replace every big string leaf with a reference, and write the bytes once.
 *
 * `refs` counts the RECORDS naming a blob, not the occurrences: a value repeated twice inside one
 * record is one reference from that record's point of view, and releasing it once has to be enough.
 * Counting occurrences instead would leave a blob pinned by a record that no longer exists.
 */
export function dehydrate(db: JairaDb, value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined) return undefined;
  const fresh = new Map<string, string>();
  const named = new Set<string>();
  const walk = (v: JsonValue): JsonValue => {
    if (typeof v === "string") {
      if (v.length < BLOB_THRESHOLD) return v;
      const hash = sha256(v);
      if (!named.has(hash)) {
        named.add(hash);
        fresh.set(hash, v);
      }
      return { [BLOB_KEY]: hash } as unknown as JsonValue;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, JsonValue> = {};
      for (const [k, child] of Object.entries(v)) out[k] = walk(child as JsonValue);
      return out;
    }
    return v;
  };
  const out = walk(value);
  if (fresh.size === 0) return out;
  const insert = db.prepare(
    `INSERT INTO blobs (hash, content, bytes, refs, created_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(hash) DO UPDATE SET refs = refs + 1`,
  );
  const now = Date.now();
  for (const [hash, content] of fresh) insert.run(hash, content, content.length, now);
  return out;
}

/**
 * Put the referenced bytes back.
 *
 * ONE query for the whole record, whatever it holds — see the header. A hash with no row is left as
 * the reference it is rather than becoming `null`: a missing blob is a fact worth seeing in the
 * value, and silently emptying it would make a pruned record look like one that said nothing.
 */
export function hydrate(db: JairaDb, value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined) return undefined;
  const wanted = new Set<string>();
  const collect = (v: JsonValue): void => {
    if (isBlobRef(v)) {
      wanted.add(v[BLOB_KEY]);
      return;
    }
    if (Array.isArray(v)) {
      for (const child of v) collect(child as JsonValue);
      return;
    }
    if (v !== null && typeof v === "object") for (const child of Object.values(v)) collect(child as JsonValue);
  };
  collect(value);
  if (wanted.size === 0) return value;
  const hashes = [...wanted];
  const rows = db
    .prepare(`SELECT hash, content FROM blobs WHERE hash IN (${hashes.map(() => "?").join(",")})`)
    .all(...hashes) as Array<{ hash: string; content: string }>;
  const byHash = new Map(rows.map((r) => [r.hash, r.content]));
  const put = (v: JsonValue): JsonValue => {
    if (isBlobRef(v)) return byHash.get(v[BLOB_KEY]) ?? (v as unknown as JsonValue);
    if (Array.isArray(v)) return v.map(put);
    if (v !== null && typeof v === "object") {
      const out: Record<string, JsonValue> = {};
      for (const [k, child] of Object.entries(v)) out[k] = put(child as JsonValue);
      return out;
    }
    return v;
  };
  return put(value);
}

/**
 * Let go of every blob a value referenced — one decrement per record, matching {@link dehydrate}.
 *
 * Called where a record is deleted. The bytes are not removed here: a blob at zero is garbage, and
 * garbage is collected on a schedule ({@link collectBlobs}) rather than in the middle of a delete
 * that may be one of thousands.
 */
export function release(db: JairaDb, value: JsonValue | undefined): void {
  if (value === undefined) return;
  const seen = new Set<string>();
  const walk = (v: JsonValue): void => {
    if (isBlobRef(v)) {
      seen.add(v[BLOB_KEY]);
      return;
    }
    if (Array.isArray(v)) {
      for (const child of v) walk(child as JsonValue);
      return;
    }
    if (v !== null && typeof v === "object") for (const child of Object.values(v)) walk(child as JsonValue);
  };
  walk(value);
  if (seen.size === 0) return;
  const drop = db.prepare(`UPDATE blobs SET refs = refs - 1 WHERE hash = ?`);
  for (const hash of seen) drop.run(hash);
}

/** Delete the bytes nothing names any more. Returns how many rows went. */
export function collectBlobs(db: JairaDb): number {
  return db.prepare(`DELETE FROM blobs WHERE refs <= 0`).run().changes;
}
