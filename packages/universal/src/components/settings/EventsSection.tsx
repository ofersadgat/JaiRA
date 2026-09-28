import type { JSX } from "react";
import { View } from "@tamagui/core";
import { EVENT_SPECS, statesPath, type EventsStatusView, type JairaEventsConfig, type PathWrite } from "@jaira/shared/browser";
import { MISSED_WHILE_CLOSED, branchesHint, eventBranchesPath, eventGroupsOf, eventStatusLine, eventSwitchWrites, type ConnectionBadge, type EventRowView } from "@jaira/ui/eventsModel";
import type { Schema } from "@jaira/ui/schemaForm/types";
import { Press, Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { SchemaForm } from "../form/SchemaForm";
import { BrandIcon, Hint } from "./bits";
import { Switch } from "./controls";
import { SettingsRow, SettingsSection } from "./SettingsPage";

/**
 * `eventsPane.tsx`'s `EventsSection` and `ConnectionPill`, universal (decision 0015): what JaiRA watches
 * for, per remote of the project's own `.git/config`, and JaiRA's own events. What each row says and
 * what a switch writes are `eventsModel.ts`'s. The rules it adds (scoped to `[data-part="events"]`):
 *
 *   .ev-group            padding 9 16 6, --panel-2 70% into --panel, data 600 at 11/12 (no case change)
 *   .ev-name             row, centred, wraps; `.ev-id` data 11/12 --dim at 400, 8 after
 *   .src-conn            row, centred, gap 4, 8 after, padding 0 7 0 5, round, --panel-2, --dim, data 500 at
 *                        9.5/12.5 on 1.5; its mark 11; with no connection ringed 1px --line inside, --tok-hint
 *   .ev-unanswered       the name and sentence --dim
 *   .ev-body             column, gap 6, 10 above, padding 8 12 10, 1px --line, radius 10, --bg
 */
export function ConnectionPill({ badge, onOpenConnections, first = false }: { badge: ConnectionBadge; onOpenConnections?: (() => void) | undefined; first?: boolean }): JSX.Element {
  const t = useTokens();
  const words = (
    <>
      {badge.brand !== undefined ? (
        <View width={11} height={11} flexShrink={0} {...(badge.none ? { opacity: 0.5, style: { filter: "grayscale(1)" } } : {})}>
          <BrandIcon name={badge.brand} size={11} />
        </View>
      ) : null}
      <Txt spec={{ voice: "data", scale: (9.5 / 12.5) * (12.5 / 12), weight: 500, color: badge.none ? "tok-hint" : "dim" }} numberOfLines={1}>
        {badge.text}
      </Txt>
    </>
  );
  const box = { flexDirection: "row", alignItems: "center", gap: 4, marginLeft: first ? 0 : 8, paddingLeft: 5, paddingRight: 7, borderRadius: 999, flexShrink: 0 } as const;
  if (badge.none) {
    return (
      <Press onPress={onOpenConnections} title={badge.title} {...box} box={({ hovered }) => ({ backgroundColor: "transparent", boxShadow: `inset 0 0 0 1px ${String(t.v(hovered ? "rule" : "line"))}` })}>
        {words}
      </Press>
    );
  }
  return (
    <View {...box} backgroundColor={t.v("panel-2") as never} {...({ title: badge.title } as object)}>
      {words}
    </View>
  );
}

const BRANCHES_SCHEMA: Schema = { type: "object", properties: { branches: { type: "array", items: { type: "string" }, title: "Branches" } } };

export function EventsSection({
  status,
  events,
  layerDoc,
  locked,
  now,
  onWrite,
  onOpenConnections,
}: {
  status: EventsStatusView | null;
  events: JairaEventsConfig;
  layerDoc: unknown;
  locked: boolean;
  now: number;
  onWrite: (writes: PathWrite[]) => void;
  onOpenConnections: () => void;
}): JSX.Element {
  const t = useTokens();
  const groups = status === null ? [] : eventGroupsOf(status, events);
  const names = (status?.remotes ?? []).map((remote) => remote.name);
  const cadence = status?.cadenceMs ?? 60_000;
  const row = (view: EventRowView, remote: EventsStatusView["remotes"][number] | undefined): JSX.Element => {
    const spec = EVENT_SPECS[view.name];
    const stated = statesPath(layerDoc, view.path);
    const branchesAt = eventBranchesPath(view.name);
    const branches = events[view.name]?.branches;
    const dim = view.unanswered ? "dim" : "text";
    return (
      <SettingsRow
        key={`${view.remote ?? ""}:${view.name}`}
        name={
          <View flexDirection="row" alignItems="center" flexWrap="wrap" rowGap={2}>
            <Txt spec={{ voice: "app", scale: 1.1, weight: 550, lineHeight: 1.3, color: dim }}>{spec.label}</Txt>
            <Txt spec={{ voice: "data", scale: 11 / 12, lineHeight: 1.3, color: "dim" }} marginLeft={8}>
              {view.name}
            </Txt>
            {view.badge !== undefined ? <ConnectionPill badge={view.badge} onOpenConnections={onOpenConnections} /> : null}
          </View>
        }
        description={view.unanswered ? <Txt spec={{ voice: "app", scale: 1.03, lineHeight: 1.45, color: "dim" }}>{spec.hint}</Txt> : spec.hint}
        layer={{ paths: [view.path], stated, disabled: locked, onInherit: () => onWrite([[view.path, undefined]]) }}
        control={
          <Switch
            on={view.on}
            label={view.unanswered ? `no connection for ${remote?.host ?? "this remote"} — sign in on Connections` : view.on ? `stop watching for ${view.name}` : `watch for ${view.name}`}
            disabled={locked || view.unanswered}
            onChange={(next) => onWrite(eventSwitchWrites(events, view.name, names, view.remote, next))}
          />
        }
      >
        {view.on ? (
          <View flexDirection="column" gap={6} marginTop={10} paddingTop={8} paddingHorizontal={12} paddingBottom={10} borderRadius={10} backgroundColor={t.v("bg") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
            {view.branches ? (
              <SchemaForm
                schema={BRANCHES_SCHEMA}
                value={branches !== undefined ? { branches } : {}}
                onChange={() => undefined}
                ctx={{
                  path: "",
                  hidePaths: true,
                  disabled: locked,
                  isSet: () => statesPath(layerDoc, branchesAt),
                  setAt: (_path, value) => {
                    const list = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
                    onWrite([[branchesAt, list.length > 0 ? list : undefined]]);
                  },
                  unsetNote: () => "every branch",
                }}
              />
            ) : null}
            {view.branches ? <Hint>{branchesHint(view.name)}</Hint> : null}
            <Hint>{eventStatusLine(view, remote, cadence, now)}</Hint>
            {remote?.error !== undefined ? <Hint color="warn">{`The last look failed: ${remote.error}`}</Hint> : null}
          </View>
        ) : null}
      </SettingsRow>
    );
  };
  const children: JSX.Element[] = [];
  if (status === null) children.push(<Hint key="reading" card>Reading this project's remotes…</Hint>);
  if (status?.problem !== undefined) children.push(<Hint key="problem" card color="warn">{`The git remotes could not be read — ${status.problem}`}</Hint>);
  groups.forEach((group, g) => {
    children.push(<EventGroup key={`h:${group.id}`} heading={group.heading} first={g === 0 && children.length === 0} />);
    for (const view of group.rows) children.push(row(view, group.remote));
  });
  return (
    <SettingsSection
      id="events"
      title="Events"
      info={MISSED_WHILE_CLOSED}
      lead="Things that happen outside JaiRA. An event you turn on is watched for — by polling the forge — and can start a task (Automations, below)."
    >
      {children}
    </SettingsSection>
  );
}

/** `.ev-group`: a group's heading, a band across the card (rounded at its top when first). */
export function EventGroup({ heading, first }: { heading: string; first: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <View paddingTop={9} paddingHorizontal={16} paddingBottom={6} backgroundColor={t.mix(t.v("panel-2"), 70, t.v("panel")) as never} {...(first ? { borderTopLeftRadius: 11, borderTopRightRadius: 11 } : {})}>
      <Txt spec={{ voice: "data", scale: 11 / 12, weight: 600, color: "dim" }}>{heading}</Txt>
    </View>
  );
}
