/**
 * Settings → Tools → Events (decision 0010 §2, mockup B.1): what JaiRA watches for, per remote of the
 * project's own `.git/config`, and JaiRA's own events.
 *
 * A render function over what `eventsModel.ts` says ([[ui-components-are-render-functions]]): every
 * piece of state arrives as a prop, so each state the section can be in is one `renderToStaticMarkup`.
 * The switch on a row is a real on/off — whether the event is watched — and not a layer switch: a
 * change is written to the page's layer (and taken out of the stronger ones by `saveConfig`), and a
 * ↺ beside a row the page's layer states takes it out again.
 */
import { useEffect, useState, type JSX } from "react";
import { EVENT_SPECS, statesPath, type EventsStatusView, type JairaEventsConfig, type PathWrite } from "@jaira/shared/browser";
import { Switch } from "./controls";
import { BrandIcon } from "./icons";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { Schema } from "./schemaForm/types";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  branchesHint,
  eventBranchesPath,
  eventGroupsOf,
  eventStatusLine,
  eventSwitchWrites,
  MISSED_WHILE_CLOSED,
  type ConnectionBadge,
  type EventRowView,
} from "./eventsModel";

/**
 * A connection, as a small pill with the forge's own mark — the rail's source pill (`cx-src`) in the
 * data voice. With no connection it is muted and goes to Connections.
 */
export function ConnectionPill({ badge, onOpenConnections }: { badge: ConnectionBadge; onOpenConnections?: (() => void) | undefined }): JSX.Element {
  const mark = badge.brand !== undefined ? <BrandIcon name={badge.brand} className="src-logo" /> : null;
  if (badge.none) {
    return (
      <button type="button" className="cx-src src-conn src-none ev-pill-link" title={badge.title} onClick={onOpenConnections}>
        {mark}
        {badge.text}
      </button>
    );
  }
  return (
    <span className="cx-src src-conn" title={badge.title}>
      {mark}
      {badge.text}
    </span>
  );
}

const BRANCHES_SCHEMA: Schema = {
  type: "object",
  properties: { branches: { type: "array", items: { type: "string" }, title: "Branches" } },
};

export interface EventsSectionProps {
  /** What `events:status` answered; null while it is being read. */
  status: EventsStatusView | null;
  /** The `events` block in effect — every layer merged. */
  events: JairaEventsConfig;
  /** The page's layer's own document: what its ↺ are drawn from. */
  layerDoc: unknown;
  locked: boolean;
  /** Now, epoch ms — what "2 min ago" is read against. */
  now: number;
  /** Write paths of the page's layer; `undefined` takes one out. */
  onWrite: (writes: PathWrite[]) => void;
  onOpenConnections: () => void;
}

export function EventsSection(props: EventsSectionProps): JSX.Element {
  const { status, events } = props;
  const groups = status === null ? [] : eventGroupsOf(status, events);
  const names = (status?.remotes ?? []).map((remote) => remote.name);
  const cadence = status?.cadenceMs ?? 60_000;

  const row = (view: EventRowView, remote: EventsStatusView["remotes"][number] | undefined): JSX.Element => {
    const spec = EVENT_SPECS[view.name];
    const stated = statesPath(props.layerDoc, view.path);
    const branchesAt = eventBranchesPath(view.name);
    const branches = events[view.name]?.branches;
    return (
      <div key={`${view.remote ?? ""}:${view.name}`} className={`ev-row${view.on ? " ev-on" : ""}${view.unanswered ? " ev-unanswered" : ""}`}>
        <SettingsRow
          name={
            <span className="ev-name">
              {spec.label}
              <code className="ev-id">{view.name}</code>
              {view.badge !== undefined ? <ConnectionPill badge={view.badge} onOpenConnections={props.onOpenConnections} /> : null}
            </span>
          }
          description={spec.hint}
          layer={{ paths: [view.path], stated, disabled: props.locked, onInherit: () => props.onWrite([[view.path, undefined]]) }}
          control={
            <Switch
              on={view.on}
              label={view.unanswered ? `no connection for ${remote?.host ?? "this remote"} — sign in on Connections` : view.on ? `stop watching for ${view.name}` : `watch for ${view.name}`}
              disabled={props.locked || view.unanswered}
              onChange={(next) => props.onWrite(eventSwitchWrites(events, view.name, names, view.remote, next))}
            />
          }
        >
          {view.on ? (
            <div className="ev-body">
              {view.branches ? (
                <SchemaForm
                  schema={BRANCHES_SCHEMA}
                  value={branches !== undefined ? { branches } : {}}
                  onChange={() => undefined}
                  ctx={{
                    path: "",
                    hidePaths: true,
                    disabled: props.locked,
                    isSet: () => statesPath(props.layerDoc, branchesAt),
                    setAt: (_path, value) => {
                      const list = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
                      props.onWrite([[branchesAt, list.length > 0 ? list : undefined]]);
                    },
                    unsetNote: () => "every branch",
                  }}
                />
              ) : null}
              {view.branches ? <p className="cfg-hint ev-hint">{branchesHint(view.name)}</p> : null}
              <p className="cfg-hint ev-status">{eventStatusLine(view, remote, cadence, props.now)}</p>
              {remote?.error !== undefined ? <p className="cfg-hint warn-text ev-status">The last look failed: {remote.error}</p> : null}
            </div>
          ) : null}
        </SettingsRow>
      </div>
    );
  };

  return (
    <SettingsSection
      id="events"
      title="Events"
      info={MISSED_WHILE_CLOSED}
      lead="Things that happen outside JaiRA. An event you turn on is watched for — by polling the forge — and can start a task (Automations, below)."
    >
      {status === null ? <p className="cfg-hint">Reading this project's remotes…</p> : null}
      {status?.problem !== undefined ? <p className="cfg-hint warn-text">The git remotes could not be read — {status.problem}</p> : null}
      {groups.map((group) => [
        <div key={`h:${group.id}`} className="ev-group app-label">
          {group.heading}
        </div>,
        ...group.rows.map((view) => row(view, group.remote)),
      ])}
    </SettingsSection>
  );
}

/** How often the section re-reads what the watcher knows, while it is on screen. */
const STATUS_EVERY_MS = 20_000;

/**
 * The host's half: `events:status` read for `key` (the project, or the shared root) and re-read while
 * the page is open, and a clock for "2 min ago". Nothing here asks a forge — main answers from git
 * and memory.
 */
export function useEventStatus(read: () => Promise<EventsStatusView>, key: string): { status: EventsStatusView | null; now: number } {
  const [status, setStatus] = useState<EventsStatusView | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    setStatus(null);
    const once = (): void => {
      read().then(
        (next) => {
          if (live) setStatus(next);
        },
        (e: unknown) => {
          if (live) setStatus({ remotes: [], tasks: {}, cadenceMs: 60_000, problem: e instanceof Error ? e.message : String(e) });
        },
      );
      setNow(Date.now());
    };
    once();
    const timer = setInterval(once, STATUS_EVERY_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // `read` is rebuilt with every render of the host; `key` is what makes it a different question.
  }, [key]);
  return { status, now };
}
