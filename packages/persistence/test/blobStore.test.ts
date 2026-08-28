/**
 * The Ref layer (RECORDS.md §8): a record's big leaves are stored once, by content hash.
 *
 * Deduplicating INSIDE a record is what the entry format did. This is the other half — the same
 * bytes appearing in the NEXT record, which is the ordinary case: a loop re-reading one file on
 * every pass, a resumed session re-reading its own context.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject, openProject, type Project } from "../src/project";
import { BLOB_THRESHOLD, collectBlobs, dehydrate, hydrate, release, sha256 } from "../src/blobStore";

let dir: string;
let project: Project;

/** A string comfortably over the threshold, and the same one every time it is asked for. */
const BIG = "x".repeat(BLOB_THRESHOLD * 2);
const OTHER = "y".repeat(BLOB_THRESHOLD * 2);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-blobs-"));
  initProject(dir);
  project = openProject(dir);
});
afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

const rows = (): Array<{ hash: string; refs: number; bytes: number }> =>
  project.db.prepare(`SELECT hash, refs, bytes FROM blobs`).all() as never;

describe("dehydrate / hydrate", () => {
  it("replaces a big leaf with a reference and puts it back unchanged", () => {
    const value = { entries: [{ content: BIG }], small: "kept inline" };
    const stored = dehydrate(project.db, value as never) as { entries: Array<{ content: unknown }>; small: string };
    expect(stored.entries[0]!.content).toEqual({ $blob: sha256(BIG) });
    // A short string is left alone: a reference is ~76 bytes, so below that it is a second copy
    // with extra steps rather than a saving.
    expect(stored.small).toBe("kept inline");
    expect(hydrate(project.db, stored as never)).toEqual(value);
  });

  it("stores the bytes ONCE across records, and counts the records naming them", () => {
    // The case the layer exists for: one file read by two passes of a loop.
    dehydrate(project.db, { a: BIG } as never);
    dehydrate(project.db, { b: BIG } as never);
    expect(rows()).toEqual([{ hash: sha256(BIG), refs: 2, bytes: BIG.length }]);
  });

  it("counts a value repeated INSIDE one record once — releasing it once has to be enough", () => {
    dehydrate(project.db, { a: BIG, b: BIG, c: [BIG] } as never);
    expect(rows()[0]!.refs).toBe(1);
  });

  it("hydrates a whole record in ONE query, however many references it holds", () => {
    const value = dehydrate(project.db, { a: BIG, b: OTHER, c: [BIG, OTHER] } as never);
    let queries = 0;
    const counting = new Proxy(project.db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            queries += 1;
            return (target as never as { prepare: (s: string) => unknown }).prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(hydrate(counting as never, value)).toEqual({ a: BIG, b: OTHER, c: [BIG, OTHER] });
    // §8's second open question, answered: one read for the record, not one per reference. A layer
    // that costs N queries to undo N copies has not saved anything.
    expect(queries).toBe(1);
  });

  it("leaves a reference alone when its bytes are gone, rather than emptying the value", () => {
    const value = dehydrate(project.db, { a: BIG } as never);
    project.db.prepare(`DELETE FROM blobs`).run();
    // A missing blob is a fact worth seeing. Silently answering `null` would make a pruned record
    // look like one that said nothing.
    expect(hydrate(project.db, value)).toEqual({ a: { $blob: sha256(BIG) } });
  });
});

describe("release and collect", () => {
  it("keeps bytes a second record still names, and drops them when the last one goes", () => {
    const first = dehydrate(project.db, { a: BIG } as never);
    const second = dehydrate(project.db, { b: BIG } as never);

    release(project.db, first);
    expect(collectBlobs(project.db)).toBe(0); // still named by `second`
    expect(hydrate(project.db, second)).toEqual({ b: BIG });

    release(project.db, second);
    expect(collectBlobs(project.db)).toBe(1);
    expect(rows()).toEqual([]);
  });

  it("counts a repeated leaf once on the way out too, so a release cannot over-decrement", () => {
    const value = dehydrate(project.db, { a: BIG, b: BIG } as never);
    release(project.db, value);
    expect(collectBlobs(project.db)).toBe(1);
  });
});
