/**
 * Where each of a device's windows stood — the window's own data, of which the engine keeps a copy
 * (decision 0018 §9): written as the window moves, read when a window opens with nothing of its own,
 * which then stands where the device's most recently used window did. Per device and window, never
 * synced: one device's place is not another's.
 */
import type { JairaDb } from "./db";

export const WINDOW_STATES_SQL = `
CREATE TABLE IF NOT EXISTS window_states (
  device     TEXT NOT NULL,
  window     TEXT NOT NULL,
  state_json TEXT NOT NULL,
  used_at    INTEGER NOT NULL,
  PRIMARY KEY (device, window)
);
CREATE INDEX IF NOT EXISTS window_states_used ON window_states(device, used_at);
`;

/**
 * A device's layout — its panes, folds and read marks (the settings document's `ui`), the device's own
 * (decision 0018 §9): every window of the device draws from it, and another device keeps its own.
 */
export const DEVICE_LAYOUTS_SQL = `
CREATE TABLE IF NOT EXISTS device_layouts (
  device     TEXT PRIMARY KEY,
  ui_json    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** Keep a device's layout, as of now. */
export function keepDeviceLayout(db: JairaDb, device: string, ui: unknown, nowMs = Date.now()): void {
  db.prepare(
    `INSERT INTO device_layouts (device, ui_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (device) DO UPDATE SET ui_json = excluded.ui_json, updated_at = excluded.updated_at`,
  ).run(device, JSON.stringify(ui), nowMs);
}

/** A device's layout, if it has kept one. */
export function deviceLayout(db: JairaDb, device: string): unknown {
  const row = db.prepare(`SELECT ui_json FROM device_layouts WHERE device = ?`).get(device) as { ui_json: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.ui_json) as unknown);
}

/** Keep a window's state, as of now. A device keeps its newest windows only. */
export function keepWindowState(db: JairaDb, device: string, window: string, state: unknown, nowMs = Date.now(), keep = 20): void {
  db.prepare(
    `INSERT INTO window_states (device, window, state_json, used_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (device, window) DO UPDATE SET state_json = excluded.state_json, used_at = excluded.used_at`,
  ).run(device, window, JSON.stringify(state), nowMs);
  db.prepare(
    `DELETE FROM window_states WHERE device = ? AND window NOT IN (SELECT window FROM window_states WHERE device = ? ORDER BY used_at DESC LIMIT ?)`,
  ).run(device, device, keep);
}

/** The state of the device's most recently used window, if it has one. */
export function lastWindowState(db: JairaDb, device: string): unknown {
  const row = db.prepare(`SELECT state_json FROM window_states WHERE device = ? ORDER BY used_at DESC LIMIT 1`).get(device) as { state_json: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.state_json) as unknown);
}
