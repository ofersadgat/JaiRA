/**
 * A composer's unsent words, kept by the engine that owns the conversation (decision 0018 §9).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb, type JairaDb } from "../src/db";
import { draftOf, keepDraft } from "../src/drafts";
import { changesSince } from "../src/sync";

let dir: string;
let db: JairaDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-drafts-"));
  db = openDb(join(dir, "jaira.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("keeps the latest words under the composer's key, stamped when they arrived", () => {
  keepDraft(db, "chat:t-a", "t-a", "half a thought", 10);
  keepDraft(db, "chat:t-a", "t-a", "half a thought, finished", 20);
  expect(draftOf(db, "chat:t-a")).toEqual({ text: "half a thought, finished", at: 20 });
  expect(draftOf(db, "chat:t-b")).toBeNull();
});

it("forgets an emptied draft, and the change log says so — for the task's other devices", () => {
  keepDraft(db, "chat:t-a", "t-a", "words", 10);
  keepDraft(db, "chat:t-a", "t-a", "", 20);
  expect(draftOf(db, "chat:t-a")).toBeNull();
  expect(changesSince(db, 0, { collections: ["draft"] })).toEqual([{ collection: "draft", id: "chat:t-a", taskId: "t-a", at: expect.any(Number), deleted: true }]);
});

it("keeps a draft that belongs to no task yet", () => {
  keepDraft(db, "chat:new:/w/a", null, "a new conversation", 10);
  expect(draftOf(db, "chat:new:/w/a")?.text).toBe("a new conversation");
});
