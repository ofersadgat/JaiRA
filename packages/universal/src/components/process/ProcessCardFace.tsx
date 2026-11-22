import { useMemo, type JSX, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { View, isWeb } from "@tamagui/core";
import type { BoardCard, ProcessTaskFacts } from "@jaira/shared/browser";
import { PLACES } from "@jaira/ui/splitModel";
import { taskPaneEntryOf } from "@jaira/ui/splitModel";
import { fromLabelOf, shortAge } from "@jaira/ui/processTaskModel";
import { Txt, useHover } from "../../primitives";
import { useTokens } from "../../tokens";
import { moveEntry, useEntryPlaces, usePlacesHere } from "../../app/places";
import { usePhone } from "../../app/phone";
import { MachineChip } from "../MachineChip";
import { PlaceButtons } from "../panel/PlaceButtons";
import { ExitChip, FromLine, OriginChip, PortChip, ProcessBadge, ProcessGlyph, useProcessIndexHere } from "./ProcessBits";

/**
 * A process task's card on a board (decision 0032, "The view", round 2's boards 6 and 7): an ordinary
 * task card — the tile, selected and hovered as one — whose head is the process glyph, its name and its
 * state badge, whose meta line is its machine and where it came from, and whose foot is `↰ from` the
 * task that started it and how long it has been in its state. In the `Process` workflow's own lanes
 * (`inLane`) the lane says the state, so the badge gives way to the ports or the exit. Hovered, it offers
 * the three places (`PlaceButtons`), over its top right. How it looks:
 *
 *   the head       row, centred, gap 6: the glyph (16), the name (data 0.96, one line), the badge
 *   the meta line  row, centred, gap 6, 2 above: machine chip, the port or exit chip (in a lane), origin
 *   told           `Claude was told` (data 0.84, --dim), 3 above, when the agent was told it ended
 *   the foot       row, gap 6, 4 above: the from line (`FromLine`), its age pushed right (data 0.84 --dim)
 *   the places     absolute, top 5 right 6, on hover (web), the card's click stopping at them
 */
export function ProcessCardFace({
  card,
  inLane,
  onParent,
}: {
  card: BoardCard & { process: ProcessTaskFacts };
  inLane: boolean;
  /** The from line pressed: the parent, opened. */
  onParent?: ((taskId: string, e: ReactMouseEvent | undefined) => void) | undefined;
}): JSX.Element {
  const t = useTokens();
  const index = useProcessIndexHere();
  const [hovered, hover] = useHover();
  const facts = card.process;
  const since = card.endedAt ?? card.updatedAt;
  const parent = facts.parentTaskId;
  return (
    <View {...(hover as object)} position="relative">
      <View flexDirection="row" alignItems="center" gap={6}>
        <ProcessGlyph />
        <Txt spec={{ voice: "data", scale: 0.96, color: "text" }} ellip flex={1} minWidth={0} {...((isWeb ? { title: `${card.title} · pid ${facts.pid}` } : {}) as object)}>
          {card.title}
        </Txt>
        {inLane ? null : <ProcessBadge facts={facts} title={facts.state} />}
      </View>
      <View flexDirection="row" alignItems="center" gap={6} marginTop={3} overflow="hidden">
        <MachineChip label={facts.machine} voice={String(t.v("font-data"))} />
        {inLane ? facts.state === "listening" ? <PortChip ports={facts.ports} /> : <ExitChip facts={facts} /> : null}
        <OriginChip origin={facts.origin} why={facts.why} />
      </View>
      {facts.told === true ? (
        <Txt spec={{ voice: "data", scale: 0.84, color: "dim" }} marginTop={3} ellip>
          Claude was told
        </Txt>
      ) : null}
      <View flexDirection="row" alignItems="center" gap={6} marginTop={4} minWidth={0}>
        <View flex={1} minWidth={0} flexDirection="row">
          <FromLine words={fromLabelOf(facts, index.titleOf)} onGo={parent !== undefined && onParent !== undefined ? () => onParent(parent, undefined) : undefined} />
        </View>
        <Txt spec={{ voice: "data", scale: 0.84, color: "dim" }} flexShrink={0} {...((isWeb ? { title: new Date(since).toLocaleString() } : {}) as object)}>
          {shortAge(Date.now() - since)}
        </Txt>
      </View>
      {hovered && isWeb ? (
        <Over>
          <ProcessPlaces taskId={card.taskId} project={card.project} />
        </Over>
      ) : null}
    </View>
  );
}

/** Over the card's top right, the click stopping there: a press on a place is not a press on the card. */
function Over({ children }: { children: ReactNode }): JSX.Element {
  const stop = isWeb ? { onClick: (e: ReactMouseEvent) => e.stopPropagation(), onDoubleClick: (e: ReactMouseEvent) => e.stopPropagation() } : {};
  return (
    <View position="absolute" top={-2} right={-3} {...(stop as object)}>
      {children}
    </View>
  );
}

/**
 * The three places for a process task (decision 0025's, reused as they are): its task view in the main
 * view, a split or the side panel, lit where it stands — a pane's task entry, whose face is the process
 * (`faces.tsx`).
 */
export function ProcessPlaces({ taskId, project }: { taskId: string; project?: string | undefined }): JSX.Element {
  const entry = useMemo(() => taskPaneEntryOf(taskId, project), [taskId, project]);
  const lit = useEntryPlaces(entry.key);
  const phone = usePhone();
  const here = usePlacesHere(phone);
  const offered = PLACES.filter((place) => place === "main" || here[place] || lit.includes(place));
  return <PlaceButtons offered={offered} lit={lit} onPlace={(place) => moveEntry(place, entry, lit, phone)} />;
}
