/**
 * The events task's configuration, in its side panel: the same Automations editor Settings → Tools
 * draws (the person, 2026-09-25: "if you click on the events task, the context panel should have an
 * automations configuration panel … that mirrors the one you see in the settings page").
 *
 * The same component, not a second drawing of it — `AutomationsPane` over the events workflow's
 * copies — on the layer the task belongs to: a project's events task edits that project's
 * automations (Shared's lines shown under them, edited by copy as they are on a project's Settings
 * page), Shared's events task edits Shared's. The page's layer switch has no counterpart here: a
 * task is one layer's.
 *
 * It reads for itself what Settings reads from the store at the page's layer — the settings in
 * effect and the watcher's word on the remotes — because the panel can show a task of a project the
 * window is not standing on.
 */
import type { JSX } from "react";
import { AutomationsPane } from "./automationsPane";
import { useEventsTaskAutomations, type EventsTaskAutomationsProps } from "./eventsTaskModel";

export type { EventsTaskAutomationsProps };

export function EventsTaskAutomations(props: EventsTaskAutomationsProps): JSX.Element {
  // What it reads and how it writes are `eventsTaskModel.ts`'s, the hook the universal copy runs too.
  return <AutomationsPane key={props.project} {...useEventsTaskAutomations(props)} />;
}
