/**
 * How a script asked one of its calls to be drawn — its `renderUI` role (decision 0033 §4) — as the
 * call's record is opened, so a reader of the records can tell a call made aside from the turns of the
 * conversation without loading the workflow.
 *
 * `role: "aside"` is the script's own word for work beside the conversation: reading it back, checking
 * a message for a correction, starting a review of it. A conversation's clock (`lastMessageTimes`) and
 * its children's (`newestUnderOf`) leave those calls out, so work the person never asked to read does
 * not mark a conversation they have read unread (2026-11-27: "this is the third time that the same bug
 * has happened where I restart the client and every task is marked as unseen" — four hours idle, every
 * conversation started its review, and each `start_task` moved its clock past the read mark).
 */
import type { JairaDb } from "./db";
import { pinnedSnapshot } from "./snapshots";

/** Where a record keeps its call's role: `request.present.role`, as `renderUI` spells it. */
export const RECORD_ROLE_PATH = "$.present.role";

/** The role that is not news: a call `renderUI` drew aside. */
export const ASIDE_ROLE = "aside";

/**
 * The role the call running in `instanceId` was given, from the state it entered as the task's pinned
 * snapshot declares it (`present.role`), or `undefined`.
 *
 * In a script's `"calls"` mode every call is a state of its own and the compiler writes its `renderUI`
 * config on that state; the engine journals the call's `instance.entered` before it dispatches, so the
 * state is known by the time its record is opened. In the coarser modes a call is no state of its own and
 * its config arrives only as it settles (`script.call.settled`): those calls carry no role here.
 *
 * A conversation that took a newer version of its program at a wait (decision 0029 §3) enters that
 * version's calls under its versioned id (`session@v208bc22f1975/call_5`); the run's `version.adopted`
 * names the snapshot the version was pinned as, and the state is read there under its own id
 * (`session/call_5`), as `withRunVersions` lays it in for a resume.
 *
 * Read newest first from the task's own events, where the entry just written is: a few rows, not the
 * journal. Quiet on anything missing — no entry, no pin, a snapshot that cannot be read — since a call
 * with no role is counted as it always was.
 */
export function callRoleOf(db: JairaDb, snapshotsDir: string, taskId: string, instanceId: string): string | undefined {
  const entered = db
    .prepare(
      `SELECT json_extract(payload_json, '$.stateId') AS state FROM state_machine_events
        WHERE task_id = ? AND instance_id = ? AND type = 'instance.entered' ORDER BY seq DESC LIMIT 1`,
    )
    .get(taskId, instanceId) as { state: string | null } | undefined;
  if (typeof entered?.state !== "string") return undefined;
  const where = versionedState(db, taskId, entered.state) ?? pinnedState(db, taskId, entered.state);
  if (where === undefined) return undefined;
  try {
    const present = (pinnedSnapshot(snapshotsDir, where.snapshot).states[where.state] as { present?: { role?: unknown } } | undefined)?.present;
    return typeof present?.role === "string" ? present.role : undefined;
  } catch {
    return undefined;
  }
}

/** A state of the task's own pin, as it is named there. */
function pinnedState(db: JairaDb, taskId: string, state: string): { snapshot: string; state: string } | undefined {
  const pin = db.prepare(`SELECT snapshot_hash FROM task_runtime WHERE task_id = ?`).get(taskId) as { snapshot_hash: string | null } | undefined;
  return typeof pin?.snapshot_hash === "string" ? { snapshot: pin.snapshot_hash, state } : undefined;
}

/**
 * A state of a version the run took (`<base>@v<hash>/…`): the snapshot its `version.adopted` pinned, and
 * the state's id there — the base's. `undefined` for a state of no version, or of one the journal does not
 * name.
 */
function versionedState(db: JairaDb, taskId: string, state: string): { snapshot: string; state: string } | undefined {
  if (!state.includes("@v")) return undefined;
  const adopted = db
    .prepare(`SELECT payload_json FROM state_machine_events WHERE task_id = ? AND type = 'version.adopted' ORDER BY seq DESC`)
    .all(taskId) as Array<{ payload_json: string }>;
  for (const row of adopted) {
    const event = JSON.parse(row.payload_json) as { stateId?: unknown; version?: unknown; snapshot?: unknown };
    if (typeof event.stateId !== "string" || typeof event.version !== "string" || typeof event.snapshot !== "string") continue;
    if (state !== event.version && !state.startsWith(`${event.version}/`)) continue;
    return { snapshot: event.snapshot, state: event.stateId + state.slice(event.version.length) };
  }
  return undefined;
}
