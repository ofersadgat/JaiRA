/**
 * The model catalog as this machine last learned it — the `models` table (decision 0009).
 *
 * A refresh asks each route what it serves (OpenRouter, Anthropic's list, the `claude` and `codex`
 * binaries, a local server, a GGUF's header) and writes the rows it changed here; startup loads them
 * over the snapshot declarative-ai ships, so a model learned once is known from then on without a
 * release. Only the BASE root's database holds it, like the module approvals beside it.
 *
 * Nothing here decides what a row means: it is `ModelInfoInterface` JSON in, the same JSON out.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelInfoInterface } from "@declarative-ai/llm";
import { openDb, type JairaDb } from "./db";

export interface ModelStore {
  /** Every row saved, oldest refresh first — so a later one wins when they are loaded in order. */
  load(): ModelInfoInterface[];
  /** Insert or replace rows, stamped with `at`. */
  save(rows: readonly ModelInfoInterface[], at?: number): void;
  close(): void;
}

/** A store over an open database — the table is part of the one schema, so any JaiRA database has it. */
export function modelStoreOver(db: JairaDb): Omit<ModelStore, "close"> {
  const put = db.prepare(
    `INSERT INTO models (key, route, row, source, refreshed_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET route = excluded.route, row = excluded.row, source = excluded.source, refreshed_at = excluded.refreshed_at`,
  );
  return {
    load() {
      const rows = db.prepare(`SELECT row FROM models ORDER BY refreshed_at, key`).all() as Array<{ row: string }>;
      const out: ModelInfoInterface[] = [];
      for (const { row } of rows) {
        try {
          out.push(JSON.parse(row) as ModelInfoInterface);
        } catch {
          // A row that will not parse is a model the next refresh writes again; it is never a reason
          // for the catalog — and every run that reads it — to fail to load.
        }
      }
      return out;
    },
    save(rows, at = Date.now()) {
      const write = db.transaction((batch: readonly ModelInfoInterface[]) => {
        for (const row of batch) put.run(`${row.route}/${row.model}`, row.route, JSON.stringify(row), row.source ?? null, at);
      });
      write(rows);
    },
  };
}

/**
 * The store in the base root's database at `dbFile`.
 *
 * `create: false` answers `undefined` for a root that does not exist yet rather than creating it:
 * READING the catalog at startup must not be what gives a fresh machine a `~/.jaira` it never asked for.
 * The refresh asks with `create: true` once it has something to keep.
 */
export function modelStoreAt(dbFile: string, opts: { create?: boolean } = {}): ModelStore | undefined {
  if (opts.create !== true && !existsSync(dbFile)) return undefined;
  mkdirSync(dirname(dbFile), { recursive: true });
  const db = openDb(dbFile);
  return { ...modelStoreOver(db), close: () => db.close() };
}
