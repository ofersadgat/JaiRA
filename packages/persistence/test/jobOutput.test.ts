/**
 * What a child process printed, bounded and batched.
 *
 * The bound is not tidiness: an agent installing dependencies can print megabytes, and a database
 * that keeps all of it is a denial of service on the app that opens it. Head-and-tail rather than a
 * plain ring, because the two things worth having are the FIRST error and the LAST line — a ring
 * keeps only the second and a truncating cap only the first.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type JairaDb } from "../src/db";
import { JobOutputSink, jobOutput } from "../src/jobOutput";

let dir: string;
let db: JairaDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-joboutput-"));
  db = openDb(join(dir, "jaira.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const sink = (keepBytes = 32): JobOutputSink => new JobOutputSink(db, { keepBytes, flushMs: 5, now: () => 1 });

describe("JobOutputSink", () => {
  it("writes nothing until it is flushed", () => {
    const s = sink();
    s.write(1, "stderr", "hello");

    // Per-chunk INSERTs on a synchronous handle in the main process is a stutter in the UI for
    // output nobody is reading yet, so a chunk is buffered and the write is batched.
    expect(jobOutput(db, { jobId: 1 })).toEqual([]);
    s.flush();
    expect(jobOutput(db, { jobId: 1 }).map((c) => c.chunk)).toEqual(["hello"]);
  });

  it("keeps both ends and counts what it dropped between them", () => {
    const s = sink(10);
    s.write(1, "stdout", "A".repeat(10)); // fills the head
    s.write(1, "stdout", "M".repeat(50)); // rolls through the tail
    s.write(1, "stdout", "Z".repeat(10)); // the last thing said
    s.flush();

    const chunks = jobOutput(db, { jobId: 1 });
    expect(chunks[0]?.chunk).toBe("A".repeat(10));
    expect(chunks[1]?.chunk).toBe("Z".repeat(10));
    // The gap is COUNTED rather than hidden: a reader who cannot see it misreads the tail as the whole.
    expect(chunks[1]?.dropped).toBe(50);
  });

  it("replaces the tail on a re-flush rather than appending it twice", () => {
    const s = sink(10);
    s.write(1, "stderr", "one");
    s.flush();
    s.write(1, "stderr", "two");
    s.flush();

    // A live tail read twice would otherwise show its last window twice over.
    expect(jobOutput(db, { jobId: 1 }).map((c) => c.chunk)).toEqual(["onetwo"]);
  });

  it("keeps the two streams apart", () => {
    const s = sink();
    s.write(7, "stdout", "out");
    s.write(7, "stderr", "err");
    s.flush();

    expect(jobOutput(db, { jobId: 7, stream: "stderr" }).map((c) => c.chunk)).toEqual(["err"]);
    expect(jobOutput(db, { jobId: 7, stream: "stdout" }).map((c) => c.chunk)).toEqual(["out"]);
  });

  it("flushes and forgets a job when it ends", () => {
    const s = sink();
    s.write(2, "stderr", "last words");
    s.end(2);

    expect(jobOutput(db, { jobId: 2 }).map((c) => c.chunk)).toEqual(["last words"]);
    // Forgotten, so a later flush cannot resurrect a finished process's buffer.
    s.flush();
    expect(jobOutput(db, { jobId: 2 })).toHaveLength(1);
  });
});
