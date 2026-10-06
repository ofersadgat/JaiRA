/**
 * Where each of a device's windows stood (decision 0018 §9, `windowStates.ts`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb, type JairaDb } from "../src/db";
import { keepWindowState, lastWindowState } from "../src/windowStates";

let dir: string;
let db: JairaDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-windows-"));
  db = openDb(join(dir, "jaira.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it("answers the state of the device's most recently used window, and nothing of another device's", () => {
  keepWindowState(db, "desk", "w1", { at: "/a" }, 10);
  keepWindowState(db, "desk", "w2", { at: "/b" }, 20);
  keepWindowState(db, "phone", "p1", { at: "/c" }, 30);
  expect(lastWindowState(db, "desk")).toEqual({ at: "/b" });
  keepWindowState(db, "desk", "w1", { at: "/a2" }, 40);
  expect(lastWindowState(db, "desk")).toEqual({ at: "/a2" });
  expect(lastWindowState(db, "nobody")).toBeNull();
});

it("keeps a device's newest windows only", () => {
  for (let i = 0; i < 5; i++) keepWindowState(db, "desk", `w${i}`, { i }, i, 3);
  expect((db.prepare(`SELECT window FROM window_states WHERE device = 'desk' ORDER BY used_at`).all() as Array<{ window: string }>).map((r) => r.window)).toEqual(["w2", "w3", "w4"]);
});
