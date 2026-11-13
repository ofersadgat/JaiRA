import { useEffect, type JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import { isSplit, openHereLine, openInPane, paneOfPlace, taskPaneEntryOf, zoneAt, type DropZone, type Place } from "@jaira/ui/splitModel";
import { TipLayer } from "../components/floats/TipLayer";
import { Icon, type IconName } from "../components/panel/Icon";
import { colourOr } from "../components/panel/SidePanel";
import { Txt } from "../primitives";
import { useTokens } from "../tokens";
import { placeEntry } from "./places";
import { dragFrom, setDropper, usePlaceDrag } from "./placeDrag";
import { usePhone } from "./phone";
import { paneTitles, splitView } from "./viewState";

const ZONE: Record<Place, { icon: IconName; label: string }> = {
  main: { icon: "placeMain", label: "Main view" },
  split: { icon: "placeSplit", label: "Split" },
  panel: { icon: "placePanel", label: "Side panel" },
};

/**
 * The drop zones while something is dragged (decision 0025, boards 08 and 09; `placeDrag.ts`): over the
 * room, in the layer tips are drawn in (`TipLayer`, in `<body>`), a sheet over the whole window taking
 * the pointer while it goes on. Two kinds:
 *
 *   an artifact     (board 08) the three places as zones; a drop MOVES it there (`placeEntry`)
 *   a sidebar row   (board 09) split, each pane is a zone and only the one under the pointer is drawn,
 *                   "Open here"; a drop puts the row on THAT pane's path, either pane, ‹ returning to
 *                   what it showed (`openInPane`). Not split, the three places, as an artifact's
 *
 * How it looks:
 *
 *   a place zone    its box inset 6, radius 10, 1.5px dashed --accent at 60%; its middle a pill: the
 *                   place's glyph 16 and its name (app, 600), --panel, 1px --line, radius 8, padding 6 12;
 *                   under the pointer the ground --tint-accent, the border solid --accent, the pill's
 *                   ink --accent
 *   "Open here"     the pane's box inset 8, radius 10, 2px dashed --accent over --tint-accent; centred,
 *                   gap 6, "Open here" (app × 14/12.5, 600, --accent) over "This pane goes on to …;
 *                   ‹ Back returns to …" (app × 12/12.5, --dim)
 *   the ghost       beside the pointer (12 right, 14 down): what is dragged, in a pill of its own,
 *                   --panel, --lift, at most 260
 */
export function DropZones(): JSX.Element | null {
  const t = useTokens();
  const drag = usePlaceDrag();
  const split = splitView.use();
  const titles = paneTitles.use();
  const phone = usePhone();
  useEffect(() => {
    setDropper((place, entry, kind) => {
      const now = splitView.get();
      // A row on a pane of a split: that pane goes on to it.
      if (kind === "pane" && isSplit(now) && place !== "panel") splitView.set(openInPane(now, paneOfPlace(place), entry));
      else placeEntry(place, entry, phone);
    });
    return () => setDropper(null);
  }, [phone]);
  // A row of the sidebar's Chat or Tasks list, picked up by what it says it is (`data-drag-task`).
  useEffect(() => {
    if (!isWeb || phone || typeof document === "undefined") return undefined;
    return dragFrom(document.body, (target) => {
      const row = target.closest("[data-drag-task]");
      const taskId = row?.getAttribute("data-drag-task");
      if (row === null || taskId === null || taskId === undefined) return null;
      const project = row.getAttribute("data-drag-project") ?? "";
      return { entry: taskPaneEntryOf(taskId, project === "" ? undefined : project), label: row.getAttribute("data-drag-label") ?? taskId, kind: "pane" };
    });
  }, [phone]);
  if (drag === null) return null;
  const hot = zoneAt(drag.zones, drag.x, drag.y);
  const panes = drag.kind === "pane" && isSplit(split);
  const openHere = (zone: DropZone): JSX.Element => (
    <View
      key={zone.place}
      position="absolute"
      left={zone.rect.left + 8}
      top={zone.rect.top + 8}
      width={zone.rect.width - 16}
      height={zone.rect.height - 16}
      borderRadius={10}
      alignItems="center"
      justifyContent="center"
      gap={6}
      paddingHorizontal={16}
      backgroundColor={colourOr(t, "tint-accent", "panel-2") as never}
      {...({ border: `2px dashed ${String(t.v("accent"))}` } as object)}
    >
      <Txt spec={{ voice: "app", scale: 14 / 12.5, weight: 600, color: "accent" }}>Open here</Txt>
      <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }} textAlign="center">
        {openHereLine(drag.label, titles[paneOfPlace(zone.place)] ?? null)}
      </Txt>
    </View>
  );
  const placeZone = (zone: DropZone): JSX.Element => {
    const on = hot?.place === zone.place;
    const { icon, label } = ZONE[zone.place];
    return (
      <View
        key={zone.place}
        position="absolute"
        left={zone.rect.left + 6}
        top={zone.rect.top + 6}
        width={zone.rect.width - 12}
        height={zone.rect.height - 12}
        borderRadius={10}
        alignItems="center"
        justifyContent="center"
        backgroundColor={(on ? colourOr(t, "tint-accent", "panel-2") : "transparent") as never}
        {...({ border: `1.5px ${on ? "solid" : "dashed"} ${on ? String(t.v("accent")) : t.mix(t.v("accent"), 60, "transparent")}` } as object)}
      >
        <View flexDirection="row" alignItems="center" gap={8} paddingVertical={6} paddingHorizontal={12} borderRadius={8} backgroundColor={t.v("panel") as never} {...({ border: `1px solid ${String(t.v("line"))}` } as object)}>
          <Icon name={icon} size={16} color={String(on ? t.v("accent") : t.v("dim"))} />
          <Txt spec={{ voice: "app", scale: 1, weight: 600, color: on ? "accent" : "text" }} numberOfLines={1}>
            {label}
          </Txt>
        </View>
      </View>
    );
  };
  return (
    <TipLayer>
      {/* Over the whole window while the drag goes on, taking the pointer: a page running in its frame
          under it would otherwise take the moves and the release. */}
      <View position="absolute" top={0} right={0} bottom={0} left={0} pointerEvents="auto" {...({ cursor: "grabbing" } as object)} />
      {panes ? (hot !== undefined ? openHere(hot) : null) : drag.zones.map(placeZone)}
      <View position="absolute" left={drag.x + 12} top={drag.y + 14} maxWidth={260} paddingVertical={4} paddingHorizontal={10} borderRadius={7} backgroundColor={t.v("panel") as never} {...({ boxShadow: t.v("lift"), border: `1px solid ${String(t.v("line"))}` } as object)}>
        <Txt spec={{ voice: "app", scale: 0.95, weight: 500 }} numberOfLines={1}>
          {drag.label}
        </Txt>
      </View>
    </TipLayer>
  );
}
