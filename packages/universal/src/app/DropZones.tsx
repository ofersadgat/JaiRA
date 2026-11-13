import { useEffect, type JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import { taskPaneEntryOf, zoneAt, type Place } from "@jaira/ui/splitModel";
import { TipLayer } from "../components/floats/TipLayer";
import { Icon, type IconName } from "../components/panel/Icon";
import { colourOr } from "../components/panel/SidePanel";
import { Txt } from "../primitives";
import { useTokens } from "../tokens";
import { placeEntry } from "./places";
import { dragFrom, setDropper, usePlaceDrag } from "./placeDrag";
import { usePhone } from "./phone";
import { useToMain } from "./SplitPane";

const ZONE: Record<Place, { icon: IconName; label: string }> = {
  main: { icon: "placeMain", label: "Main view" },
  split: { icon: "placeSplit", label: "Split" },
  panel: { icon: "placePanel", label: "Side panel" },
};

/**
 * The drop zones while something is dragged to a place (decision 0025, boards 08 and 09;
 * `placeDrag.ts`): over the room, in the layer tips are drawn in (`TipLayer`, in `<body>`, taking no
 * pointer — the drag reads the pointer itself). A drop does what the zone says: an artifact moves there
 * (`placeEntry`), a row from the sidebar opens there — the main view as a press would, the right pane
 * on its path, the panel on its stack. How it looks:
 *
 *   a zone        its box inset 6, radius 10, 1.5px dashed --accent at 60%; its middle a pill: the
 *                 place's glyph 16 and its name (app, 600), --panel, 1px --line, radius 8, padding 6 12
 *   under it      the ground --tint-accent, the border solid --accent, the pill's ink --accent
 *   the ghost     beside the pointer (12 right, 14 down): what is dragged, in a pill of its own, --panel,
 *                 --lift, at most 260
 */
export function DropZones(): JSX.Element | null {
  const t = useTokens();
  const drag = usePlaceDrag();
  const toMain = useToMain();
  const phone = usePhone();
  useEffect(() => {
    setDropper((place, entry) => placeEntry(place, entry, toMain, phone));
    return () => setDropper(null);
  }, [toMain, phone]);
  // A row of the sidebar's Chat or Tasks list, picked up by what it says it is (`data-drag-task`).
  useEffect(() => {
    if (!isWeb || phone || typeof document === "undefined") return undefined;
    return dragFrom(document.body, (target) => {
      const row = target.closest("[data-drag-task]");
      const taskId = row?.getAttribute("data-drag-task");
      if (row === null || taskId === null || taskId === undefined) return null;
      const project = row.getAttribute("data-drag-project") ?? "";
      return { entry: taskPaneEntryOf(taskId, project === "" ? undefined : project), label: row.getAttribute("data-drag-label") ?? taskId };
    });
  }, [phone]);
  if (drag === null) return null;
  const hot = zoneAt(drag.zones, drag.x, drag.y);
  return (
    <TipLayer>
      {/* Over the whole window while the drag goes on, taking the pointer: a page running in its frame
          under it would otherwise take the moves and the release. */}
      <View position="absolute" top={0} right={0} bottom={0} left={0} pointerEvents="auto" {...({ cursor: "grabbing" } as object)} />
      {drag.zones.map((zone) => {
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
      })}
      <View position="absolute" left={drag.x + 12} top={drag.y + 14} maxWidth={260} paddingVertical={4} paddingHorizontal={10} borderRadius={7} backgroundColor={t.v("panel") as never} {...({ boxShadow: t.v("lift"), border: `1px solid ${String(t.v("line"))}` } as object)}>
        <Txt spec={{ voice: "app", scale: 0.95, weight: 500 }} numberOfLines={1}>
          {drag.label}
        </Txt>
      </View>
    </TipLayer>
  );
}
