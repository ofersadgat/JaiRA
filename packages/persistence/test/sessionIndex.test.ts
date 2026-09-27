/**
 * A session's rows are read by where a call LANDED (`EFFECTIVE_SESSION`, `EFFECTIVE_SEQ`), and those
 * reads must use an index: without one each was a scan of every record (45–60 ms a probe at 200k rows).
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { EFFECTIVE_SEQ, EFFECTIVE_SESSION } from "../src/sessionStore";

describe("the landed-position index", () => {
  it("serves a session's head and its rows", () => {
    const db = openDb(":memory:");
    try {
      const plan = (sql: string): string =>
        (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("s", 3) as Array<{ detail: string }>).map((r) => r.detail).join("; ");
      expect(plan(`SELECT MAX(${EFFECTIVE_SEQ}) AS m FROM operation_records WHERE ${EFFECTIVE_SESSION} = ? AND ? > 0`)).toMatch(/USING (COVERING )?INDEX op_effective/);
      expect(plan(`SELECT id FROM operation_records WHERE ${EFFECTIVE_SESSION} = ? AND ${EFFECTIVE_SEQ} >= ?`)).toMatch(/USING (COVERING )?INDEX op_effective/);
    } finally {
      db.close();
    }
  });
});
