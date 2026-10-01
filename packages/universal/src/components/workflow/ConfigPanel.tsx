import type { JSX } from "react";
import { View } from "@tamagui/core";
import type { EffectiveState, ExecutorInfo, FileTree } from "@jaira/shared/browser";
import { copyWordsOf, readingTitleOf, useEffectiveState } from "@jaira/ui/configPanelModel";
import type { ConfigPanelServices } from "@jaira/ui/configPanelModel";
import { useEventsTaskAutomations, type EventsTaskAutomationsProps } from "@jaira/ui/eventsTaskModel";
import { ReadOnlyContext, RunReadingContext } from "@jaira/ui/reading";
import { Press, Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { Icon } from "../panel/Icon";
import { AutomationsSection } from "../settings/AutomationsSection";
import { Empty, LinkButton } from "./controls";
import { WorkflowEditor } from "./WorkflowEditor";

/**
 * One state's configuration as a run had it — the same workflow editor, as a READING (nothing that
 * would change anything is drawn, and the bindings have the run's values under them), with the line
 * that says which copy of the file it is. The read it makes for itself and what that line says are
 * `configPanelModel.ts`'s. Also the panel's config card ({@link ConfigCard}) and the events task's
 * Automations. How it looks:
 *
 *   the card                  column, gap 10; its actions a row, centred, gap 8
 *   the reading               column, the rest, gap 8, padding 10 12 12
 *   its top line              row, centred, gap 8: the id (app 11/12.5 --dim), which copy (a note,
 *                             --warn when the workflow moved), `open ↗` (a link button)
 */
export function ConfigPanel({
  read,
  tree,
  executors,
  onOpenState,
  services,
}: {
  read: () => Promise<EffectiveState | null>;
  tree?: FileTree | null;
  executors?: ExecutorInfo[];
  onOpenState?: ((stateId: string) => void) | undefined;
  services?: ConfigPanelServices | undefined;
}): JSX.Element {
  const found = useEffectiveState(read);
  if (found === null) return <Empty>Reading the state…</Empty>;
  if (found === "missing") return <Empty>That state&apos;s configuration could not be read.</Empty>;
  return (
    <ConfigReading
      state={found}
      tree={tree ?? null}
      executors={executors ?? []}
      {...(onOpenState !== undefined ? { onOpenState } : {})}
      {...(services !== undefined ? { services } : {})}
    />
  );
}

export function ConfigReading({
  state,
  tree = null,
  executors = [],
  onOpenState,
  services,
}: {
  state: EffectiveState;
  tree?: FileTree | null;
  executors?: ExecutorInfo[];
  onOpenState?: ((stateId: string) => void) | undefined;
  services?: ConfigPanelServices | undefined;
}): JSX.Element {
  return (
    <View flexDirection="column" gap={8} flexGrow={1} flexShrink={1} flexBasis="auto" minHeight={0} paddingTop={10} paddingHorizontal={12} paddingBottom={12}>
      <View flexDirection="row" alignItems="center" gap={8} minWidth={0} flexShrink={0}>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} numberOfLines={1} flexShrink={1} minWidth={0} {...({ title: readingTitleOf(state) } as object)}>
          {state.stateId}
        </Txt>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: state.from === "moved" ? "warn" : "dim" }} numberOfLines={1} flexShrink={1} minWidth={0} {...({ title: state.snapshotHash } as object)}>
          {copyWordsOf(state)}
        </Txt>
        {onOpenState !== undefined ? (
          <LinkButton title="open its file" onPress={() => onOpenState(state.stateId)}>
            open ↗
          </LinkButton>
        ) : null}
      </View>
      {state.source === undefined ? (
        <Empty>
          The workflow that ran has no state called <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }}>{state.stateId}</Txt>.
        </Empty>
      ) : (
        <ReadOnlyContext.Provider value={true}>
          <RunReadingContext.Provider value={state.values ?? null}>
            <WorkflowEditor source={state.source} tree={tree} executors={executors} busy={false} fill={false} onSave={() => undefined} {...(services ?? {})} />
          </RunReadingContext.Provider>
        </ReadOnlyContext.Provider>
      )}
    </View>
  );
}

/** The side panel's config card: "Open in the Files view", over the configuration a run resolved against. */
export function ConfigCard({
  read,
  stateId,
  tree,
  executors,
  services,
  onOpenState,
}: {
  read: () => Promise<EffectiveState | null>;
  stateId: string;
  tree: FileTree | null;
  executors: ExecutorInfo[];
  services?: ConfigPanelServices | undefined;
  onOpenState: (stateId: string) => void;
}): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="column" gap={10}>
      <View flexDirection="row" alignItems="center" gap={8}>
        <Press onPress={() => onOpenState(stateId)} title="Edit it in the Files view — a built-in is copied to Shared first" flexDirection="row" alignItems="center" gap={5} flexShrink={0}>
          {({ hovered }) => (
            <>
              <Icon name="adopt" size={11} color={String(t.v("accent"))} />
              <Txt spec={{ voice: "data", scale: 11 / 12, color: "accent" }} numberOfLines={1} {...(hovered ? { textDecorationLine: "underline" } : {})}>
                Open in the Files view
              </Txt>
            </>
          )}
        </Press>
      </View>
      <ConfigPanel read={read} tree={tree} executors={executors} onOpenState={onOpenState} {...(services !== undefined ? { services } : {})} />
    </View>
  );
}

/** The events task's Automations: Settings' Automations editor, on the task's layer. */
export function EventsTaskAutomations(props: EventsTaskAutomationsProps): JSX.Element {
  return <AutomationsFor key={props.project} {...props} />;
}
function AutomationsFor(props: EventsTaskAutomationsProps): JSX.Element {
  return <AutomationsSection {...useEventsTaskAutomations(props)} />;
}
