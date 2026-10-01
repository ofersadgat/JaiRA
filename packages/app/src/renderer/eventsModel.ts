/**
 * Settings → Tools → Events, as data (decision 0010 §2): which rows the section draws, what each
 * switch writes, and the line under an event that is on. Pure — `EventsSection`
 * (`packages/universal/src/components/settings/EventsSection.tsx`) draws it and the tests read it
 * without a DOM.
 *
 * ## Which rows
 *
 * The remotes are the project's own `.git/config` (`events:status`); nothing about where is typed.
 * Each remote is a group of the `git.*` events, headed by the remote and the repository it points at,
 * with the connection its host picked as a badge on every row. Then one group of JaiRA's own events
 * (`task.*`).
 *
 * The shared root is usually no repository, so on Shared there are no remotes: the `git.*` events are
 * then one group, "every project's remotes", whose switches say what every project watches its own
 * remotes for — which is what a Shared setting means.
 *
 * ## What a switch writes
 *
 * Event names hold dots, so every path here is a KEY LIST (`["events", "git.push", "enabled"]`).
 *
 *  - One remote, or none (Shared): `events.<name>.enabled`. Where some layer turned the remote's own
 *    switch the other way (`remotes.<remote>`), that is written too, so the row shows what was picked.
 *  - Several remotes: each row is that remote's own switch, `events.<name>.remotes.<remote>` — the
 *    catalog is listed once per remote because an event belongs to the connection that produces it,
 *    and turning `git.push` on for `origin` must not turn it on for `mirror`.
 *
 * The branch globs (`events.<name>.branches`) are one list per event, whichever remote's row edits
 * it: the setting has no per-remote branches.
 */
import {
  EVENT_NAMES,
  EVENT_SPECS,
  isEventEnabled,
  type EventActivity,
  type EventName,
  type ConfigView,
  type EventRemoteView,
  type EventsStatusView,
  type JairaEventsConfig,
  type PathWrite,
} from "@jaira/shared/browser";
import { agoLabel } from "./remoteStrip";

/** The `events` block in effect — every layer merged — or none while settings are unread. */
export function eventsConfigOf(config: ConfigView | null): JairaEventsConfig {
  const effective = config?.effective;
  const events = effective !== null && typeof effective === "object" && !Array.isArray(effective) ? (effective as Record<string, unknown>)["events"] : undefined;
  return events !== null && typeof events === "object" && !Array.isArray(events) ? (events as JairaEventsConfig) : {};
}

/** The `git.*` events, in the order Settings lists them. */
export const GIT_EVENTS: readonly EventName[] = EVENT_NAMES.filter((name) => EVENT_SPECS[name].group === "git");
/** JaiRA's own events. */
export const TASK_EVENTS: readonly EventName[] = EVENT_NAMES.filter((name) => EVENT_SPECS[name].group === "task");

/** The place in a settings document an event's switch writes, for one remote of `remotes` (see the module note). */
export function eventSwitchPath(name: EventName, remotes: readonly string[], remote: string | undefined): readonly string[] {
  if (EVENT_SPECS[name].group === "git" && remote !== undefined && remotes.length > 1) return ["events", name, "remotes", remote];
  return ["events", name, "enabled"];
}

/** Where an event's branch globs live — one list per event. */
export const eventBranchesPath = (name: EventName): readonly string[] => ["events", name, "branches"];

/**
 * The writes that turn one row's switch to `on`: its own path, and — for the only remote — its
 * remote's switch where the layers in effect turned it the other way (it would cover `enabled`).
 */
export function eventSwitchWrites(
  events: JairaEventsConfig,
  name: EventName,
  remotes: readonly string[],
  remote: string | undefined,
  on: boolean,
): PathWrite[] {
  const path = eventSwitchPath(name, remotes, remote);
  const writes: PathWrite[] = [[path, on]];
  if (path[2] === "enabled" && remote !== undefined) {
    const override = events[name]?.remotes?.[remote];
    if (override !== undefined && override !== on) writes.push([["events", name, "remotes", remote], on]);
  }
  return writes;
}

/** A remote's connection, as the badge says it: `github · ofersadgat`, or `gitlab.com · no connection`. */
export interface ConnectionBadge {
  /** What the badge reads. */
  text: string;
  /** The forge whose mark it wears — `github`, `gitlab` — or none (JaiRA's own events, an unknown host). */
  brand?: string;
  /** No connection answers for the remote's host: muted, and it goes to Connections. */
  none: boolean;
  /** The tooltip. */
  title: string;
}

export function connectionBadgeOf(remote: EventRemoteView): ConnectionBadge {
  const brand = remote.provider;
  if (remote.connection === undefined) {
    return {
      text: "no connection · sign in on Connections",
      ...(brand !== undefined ? { brand } : {}),
      none: true,
      title: `No signed-in connection for ${remote.host} — sign in on Connections`,
    };
  }
  const who = remote.connection.account;
  return {
    text: who !== undefined ? `${remote.connection.name} · ${who}` : remote.connection.name,
    ...(brand !== undefined ? { brand } : {}),
    none: false,
    title: `Produced by ${remote.connection.name} · ${remote.host}${who !== undefined ? `, signed in as ${who}` : ""} — the remote ${remote.name}`,
  };
}

/** JaiRA's own events wear this. */
export const JAIRA_BADGE: ConnectionBadge = { text: "JaiRA", none: false, title: "Produced by JaiRA itself" };

/** One row: an event, for one remote (or JaiRA). */
export interface EventRowView {
  name: EventName;
  /** The remote it is for; absent for a task event, and for a git event on Shared (every project's). */
  remote?: string;
  /** Whether it is watched, as the layers in effect say. */
  on: boolean;
  /** Nothing can make it arrive: its remote has no connection. The switch is off and disabled. */
  unanswered: boolean;
  /** What the switch writes, and what a ↺ takes out. */
  path: readonly string[];
  /** The event takes branch globs. */
  branches: boolean;
  badge: ConnectionBadge | undefined;
  /** What has arrived of it. */
  activity?: EventActivity;
}

/** One group: a remote, every project's remotes, or JaiRA. */
export interface EventGroupView {
  id: string;
  /** `origin → github.com/owner/repo · from .git/config`. */
  heading: string;
  remote?: EventRemoteView;
  rows: EventRowView[];
}

/** The groups the section draws, in order: each remote (or every project's), then JaiRA's own. */
export function eventGroupsOf(status: EventsStatusView | null, events: JairaEventsConfig): EventGroupView[] {
  const remotes = status?.remotes ?? [];
  const names = remotes.map((remote) => remote.name);
  const groups: EventGroupView[] = [];
  if (remotes.length === 0) {
    groups.push({
      id: "git",
      heading: "Git · every project's remotes, from its own .git/config",
      rows: GIT_EVENTS.map((name) => ({
        name,
        on: isEventEnabled({ events }, name),
        unanswered: false,
        path: eventSwitchPath(name, [], undefined),
        branches: EVENT_SPECS[name].branches !== undefined,
        badge: undefined,
      })),
    });
  }
  for (const remote of remotes) {
    const badge = connectionBadgeOf(remote);
    groups.push({
      id: `remote:${remote.name}`,
      heading: `${remote.name} → ${remote.host}/${remote.repository} · from .git/config`,
      remote,
      rows: GIT_EVENTS.map((name) => {
        const activity = remote.events[name];
        return {
          name,
          remote: remote.name,
          on: remote.watchable && isEventEnabled({ events }, name, remote.name),
          unanswered: !remote.watchable,
          path: eventSwitchPath(name, names, remote.name),
          branches: EVENT_SPECS[name].branches !== undefined,
          badge,
          ...(activity !== undefined ? { activity } : {}),
        };
      }),
    });
  }
  groups.push({
    id: "jaira",
    heading: "JaiRA · tasks in this project",
    rows: TASK_EVENTS.map((name) => {
      const activity = status?.tasks[name];
      return {
        name,
        on: isEventEnabled({ events }, name),
        unanswered: false,
        path: eventSwitchPath(name, names, undefined),
        branches: false,
        badge: JAIRA_BADGE,
        ...(activity !== undefined ? { activity } : {}),
      };
    }),
  });
  return groups;
}

/**
 * The line under an event that is on: how it is watched, and what has arrived —
 * "checked every 60 s while JaiRA is open · last seen 2 min ago · 3 today".
 */
export function eventStatusLine(row: EventRowView, remote: EventRemoteView | undefined, cadenceMs: number, now: number): string {
  const parts: string[] = [];
  if (EVENT_SPECS[row.name].group === "git") {
    if (remote === undefined) parts.push("watched on each project's remotes that have a connection");
    else {
      parts.push(`checked every ${Math.round(cadenceMs / 1000)} s while JaiRA is open`);
      if (remote.checkedAt !== undefined) parts.push(`last checked ${agoLabel(remote.checkedAt, now)}`);
    }
  } else parts.push("raised as tasks end, while JaiRA is open");
  parts.push(row.activity?.lastSeenAt !== undefined ? `last seen ${agoLabel(row.activity.lastSeenAt, now)}` : "none seen yet");
  if (row.activity !== undefined && row.activity.lastSeenAt !== undefined) parts.push(`${row.activity.today} today`);
  return parts.join(" · ");
}

/** The ⓘ of the section: the latest-state rule (decision 0010 §2). */
export const MISSED_WHILE_CLOSED =
  "Missed while JaiRA was closed? On the next start each merge request and branch is compared with what was last seen, and at most one event fires for the difference — no fast-forward through the missed history. Opened while closed → merge request opened. Opened and closed while closed → nothing. Last seen open, now merged → merge request merged. A branch's head moved → one push, from the old head to the new. A task started by an event reads the forge live.";

/** The hint under a branch list, by what the event's branches match. */
export function branchesHint(name: EventName): string {
  const field = EVENT_SPECS[name].branches;
  const what = field === "target_branch" ? "the branch it asks to merge into" : field === "ref" ? "the branch the checks ran for" : "the branch pushed to";
  return `Globs for ${what} — main, release/*. Empty watches every branch; one list for every remote.`;
}
