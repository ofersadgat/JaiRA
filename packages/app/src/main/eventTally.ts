/**
 * What has ARRIVED of each event, per project — what Settings → Tools → Events says under a switched-on
 * event ("last seen 2 min ago · 3 today"). Counted where an event is delivered, whichever produced it:
 * the repository watcher for `git.*`, a task ending for `task.*`.
 *
 * In memory: the count is about this run of JaiRA, which is what "today" and "last seen" are read
 * against, and a restart that forgets it loses nothing a run depends on.
 */
import type { EventActivity, EventName, JairaEvent } from "@jaira/shared";

/** The local calendar day of an epoch ms — what "today" counts within. */
const dayOf = (at: number): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

interface Tally {
  lastSeenAt: number;
  day: string;
  today: number;
}

/** A `git.*` event's remote; `undefined` for JaiRA's own. */
const remoteOf = (event: JairaEvent): string | undefined => {
  const remote = (event.payload as { remote?: unknown }).remote;
  return typeof remote === "string" ? remote : undefined;
};

export class EventTally {
  private readonly tallies = new Map<string, Tally>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private static key(project: string, remote: string | undefined, name: EventName): string {
    return JSON.stringify([project, remote ?? null, name]);
  }

  /** One event arrived for a project. */
  record(project: string, event: JairaEvent): void {
    const at = this.now();
    const key = EventTally.key(project, remoteOf(event), event.name);
    const day = dayOf(at);
    const held = this.tallies.get(key);
    this.tallies.set(key, { lastSeenAt: at, day, today: held !== undefined && held.day === day ? held.today + 1 : 1 });
  }

  /** What has arrived of one event — from one remote, or (with none) of JaiRA's own. */
  activity(project: string, remote: string | undefined, name: EventName): EventActivity | undefined {
    const held = this.tallies.get(EventTally.key(project, remote, name));
    if (held === undefined) return undefined;
    return { lastSeenAt: held.lastSeenAt, today: held.day === dayOf(this.now()) ? held.today : 0 };
  }
}
