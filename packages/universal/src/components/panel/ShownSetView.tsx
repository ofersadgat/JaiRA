import { useState, type JSX } from "react";
import { ScrollView } from "react-native";
import { View } from "@tamagui/core";
import { SET_VIEWS, SET_VIEW_MODE, type SetView, type ShownSet } from "@jaira/ui/panelStack";
import { shownKindOf, shownMimeOf, type PublishedRef } from "@jaira/ui/transcriptRows";
import type { PinnedValue } from "@jaira/ui/valuePanel";
import { modeOf } from "@jaira/ui/uiState";
import { Press, Txt, edge, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { surfaceOf } from "../../app/places";
import { useShellOrNull } from "../../app/shell";
import { ContextMenu, MENU_WIDTH, type MenuAt } from "../Menu";
import { anchorRectOf } from "../floats/anchor";
import { Picture } from "../Picture";
import { Icon, type IconName } from "./Icon";
import { PreviewCard } from "./PreviewCard";
import { ShownFilesView, isPicture, useShownSrc } from "./ShownFiles";
import { SpIcon } from "./SidePanel";

/**
 * A shown set in the side panel (the person, 2026-11-22): the set itself, a level of the path drawn as
 * the call's gallery, and one of its items on top of it, with the others beside it in one of three
 * views — "I like 4 as the default, but having a view dropdown that lets you switch to 3 or 1. 3 should
 * have the names under the preview." How it looks:
 *
 *   the set            the call's gallery (`ShownFilesView`), scrolling in the panel's body
 *   the view menu      in the head, after the titles: 26 tall, padding 0 5, radius --control-radius-sm,
 *                      the view's icon 15 and a ▾ 8, --dim (hovered --fill-ghost-hover, --text); it
 *                      opens a menu, "Show the set as": Tabs, Thumbnails beside it, A stepper
 *   tabs (default)     a strip over the item: row, gap 2, padding 0 8, a --line under, scrolling
 *                      across; a tab is the panel's own (padding 8 8 7, 2px under, --accent when it is
 *                      the one shown): its number in a pill (at least 16, padding 0 5, radius 8, 600
 *                      10px/16px data; --panel-2 --dim, the shown one --tint-accent --accent) and its
 *                      name, 500 app × 0.98, --dim (--text shown or hovered), at most 200
 *   thumbnails         a column down the left: 116 wide, --panel-2, a --line on its right, padding 8,
 *                      gap 10, scrolling; each a picture 64 tall in a --panel frame, radius 5, 1px --line
 *                      (the shown one --accent, ringed --tint-accent) — or, for what is not a picture, its
 *                      glyph 20 over its kind (data 9.5, uppercase: page, document, design, code, table…)
 *                      — and its name under it, data 10.5,
 *                      two lines, --dim (the shown one --accent)
 *   a stepper          a bar over the item: row, gap 10, padding 5 8, a --line under; ‹ n / N › in a
 *                      1px --line box, radius 7, the count data 500 11.5, tabular (at either end its
 *                      arrow is dim: the set does not wrap), then the call's caption, app 12 --dim, ellipsed
 *
 * Whichever view, ← → Home End step and Escape goes up to the set (`SidePanel.tsx`).
 */

/** Which view the person chose for sets, kept in `ui.modes`; tabs until they choose. */
export function useSetView(): [SetView, (view: SetView) => void] {
  const shell = useShellOrNull();
  const ui = shell?.state.settings.ui;
  const view = ui !== undefined ? modeOf(ui, SET_VIEW_MODE, SET_VIEWS, "tabs") : "tabs";
  return [view, (next) => shell?.actions.setMode(SET_VIEW_MODE, next)];
}

const VIEW: Record<SetView, { label: string; icon: IconName }> = {
  tabs: { label: "Tabs", icon: "tabs" },
  rail: { label: "Thumbnails beside it", icon: "columns" },
  stepper: { label: "A stepper", icon: "arrow" },
};

/** What an item that is not a picture shows in its thumbnail: its glyph and its kind, as its card names them (`PublishedView`). */
function faceOf(item: PublishedRef): { glyph: string; word: string } {
  if (item.kind === "page") return { glyph: "▥", word: "page" };
  if (item.kind === "markdown") return { glyph: "¶", word: "document" };
  if (item.kind === "canvas") return { glyph: "◫", word: "design" };
  return shownKindOf(shownMimeOf(item.entry, undefined));
}

const nameOf = (item: PublishedRef): string => item.title ?? item.entry.split("/").pop() ?? item.entry;

/** The set as a level of the path: the call's caption and its gallery, as the conversation drew them. */
export function ShownSetLevel({ set }: { set: ShownSet }): JSX.Element {
  const first = set.items[0];
  return (
    <ShownFilesView
      shown={{ ...(set.caption !== undefined ? { caption: set.caption } : {}), items: [...set.items], refused: [] }}
      artifacts={first === undefined ? undefined : surfaceOf(first.taskId, set.project)}
    />
  );
}

/**
 * The head's control for an item of a set: the view menu. The stepper is not in the head, though the
 * mock had it there: the head shares its row with the window's own buttons, and a stepper beside them
 * left the item's name no room (the shown-set rig's picture, 2026-11-22). It is a bar under the head.
 */
export function SetHeadControl({ set }: { set: ShownSet }): JSX.Element {
  const t = useTokens();
  const [view, setView] = useSetView();
  const [menu, setMenu] = useState<MenuAt | null>(null);
  return (
    <>
      <Press
        onPress={(e) => {
          const box = anchorRectOf(e.currentTarget);
          const at = box === null ? { x: e.nativeEvent.pageX - MENU_WIDTH, y: e.nativeEvent.pageY + 12 } : { x: box.right - MENU_WIDTH, y: box.bottom + 3 };
          setMenu({
            ...at,
            title: "Show the set as",
            items: SET_VIEWS.map((one) => ({ label: VIEW[one].label, checked: one === view, onSelect: () => setView(one) })),
          });
        }}
        title={`${set.label}, shown as ${VIEW[view].label.toLowerCase()} — change the view`}
        label="Change how the set is shown"
        {...({ "aria-haspopup": "menu", "aria-expanded": menu !== null } as object)}
        flexDirection="row"
        alignItems="center"
        gap={3}
        height={26}
        paddingHorizontal={5}
        flexShrink={0}
        borderRadius={6}
        box={({ hovered }) => (hovered || menu !== null ? { backgroundColor: t.v("fill-ghost-hover") } : {})}
      >
        {({ hovered }) => {
          const color = String(hovered || menu !== null ? t.v("text") : t.v("dim"));
          return (
            <>
              <Icon name={VIEW[view].icon} size={15} color={color} />
              <Txt spec={{ voice: "app", scale: 1, color: hovered || menu !== null ? "text" : "dim" }} fontSize={8}>
                ▾
              </Txt>
            </>
          );
        }}
      </Press>
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </>
  );
}

/** The item on top of its set, with the others beside it in the chosen view. */
export function SetItemBody({ item, set, index, onStep }: { item: PinnedValue; set: ShownSet; index: number; onStep: (index: number) => void }): JSX.Element {
  const [view] = useSetView();
  const card = <PreviewCard item={item} />;
  if (view === "tabs") {
    return (
      <View flex={1} minHeight={0} flexDirection="column">
        <SetTabs set={set} index={index} onStep={onStep} />
        {card}
      </View>
    );
  }
  if (view === "rail") {
    return (
      <View flex={1} minHeight={0} flexDirection="row">
        <SetRail set={set} index={index} onStep={onStep} />
        <View flex={1} minWidth={0} minHeight={0}>
          {card}
        </View>
      </View>
    );
  }
  return (
    <View flex={1} minHeight={0} flexDirection="column">
      <SetStepper set={set} index={index} onStep={onStep} />
      {card}
    </View>
  );
}

function SetStepper({ set, index, onStep }: { set: ShownSet; index: number; onStep: (index: number) => void }): JSX.Element {
  const t = useTokens();
  const last = set.items.length - 1;
  return (
    <View flexDirection="row" alignItems="center" gap={10} paddingVertical={5} paddingHorizontal={8} flexShrink={0} {...(edge(t, { bottom: 1 }) as object)}>
      <View flexDirection="row" alignItems="center" height={28} borderRadius={7} flexShrink={0} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
        <SpIcon icon="back" label={index > 0 ? `Previous: ${nameOf(set.items[index - 1]!)} (←)` : "Previous"} disabled={index <= 0} onPress={() => onStep(index - 1)} />
        <Txt spec={{ voice: "data", scale: 11.5 / 12.5, weight: 500 }} paddingHorizontal={4} minWidth={38} textAlign="center" style={{ fontVariant: ["tabular-nums"] }}>
          {`${index + 1} / ${set.items.length}`}
        </Txt>
        <SpIcon icon="back" flip label={index < last ? `Next: ${nameOf(set.items[index + 1]!)} (→)` : "Next"} disabled={index >= last} onPress={() => onStep(index + 1)} />
      </View>
      {set.caption !== undefined ? (
        <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }} numberOfLines={1} flexShrink={1} minWidth={0}>
          {set.caption}
        </Txt>
      ) : null}
    </View>
  );
}

function SetTabs({ set, index, onStep }: { set: ShownSet; index: number; onStep: (index: number) => void }): JSX.Element {
  const t = useTokens();
  return (
    <View flexShrink={0} {...(edge(t, { bottom: 1 }) as object)}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} {...(scrollbarProps(t) as object)} contentContainerStyle={{ paddingHorizontal: 8, gap: 2 }}>
        <View role="tablist" flexDirection="row" alignItems="stretch" gap={2}>
          {set.items.map((item, i) => {
            const on = i === index;
            const name = nameOf(item);
            return (
              <Press
                key={item.id}
                onPress={() => onStep(i)}
                title={name}
                label={name}
                role="tab"
                aria-selected={on}
                flexDirection="row"
                alignItems="center"
                gap={6}
                paddingTop={8}
                paddingHorizontal={8}
                paddingBottom={7}
                marginBottom={-1}
                flexShrink={0}
                {...(edge(t, { bottom: 2 }, on ? String(t.v("accent")) : "rgba(0, 0, 0, 0)") as object)}
              >
                {({ hovered }) => (
                  <>
                    <Txt
                      spec={{ voice: "data", scale: 10 / 12.5, weight: 600, color: on ? "accent" : "dim", lineHeight: { px: 16 } }}
                      minWidth={16}
                      paddingHorizontal={5}
                      borderRadius={8}
                      textAlign="center"
                      backgroundColor={t.v(on ? "tint-accent" : "panel-2") as never}
                    >
                      {i + 1}
                    </Txt>
                    <Txt spec={{ voice: "app", scale: 0.98, weight: 500, color: on || hovered ? "text" : "dim", lineHeight: 1.2 }} numberOfLines={1} maxWidth={200}>
                      {name}
                    </Txt>
                  </>
                )}
              </Press>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

function SetRail({ set, index, onStep }: { set: ShownSet; index: number; onStep: (index: number) => void }): JSX.Element {
  const t = useTokens();
  return (
    <View width={116} flexShrink={0} backgroundColor={t.v("panel-2") as never} {...(edge(t, { right: 1 }) as object)}>
      <ScrollView {...(scrollbarProps(t) as object)} contentContainerStyle={{ padding: 8, gap: 10 }}>
        {set.items.map((item, i) => (
          <RailItem key={item.id} item={item} project={set.project} on={i === index} onPress={() => onStep(i)} />
        ))}
      </ScrollView>
    </View>
  );
}

function RailItem({ item, project, on, onPress }: { item: PublishedRef; project: string | undefined; on: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  const picture = isPicture(item);
  const src = useShownSrc(item, picture ? project : undefined);
  const name = nameOf(item);
  return (
    <Press onPress={onPress} title={name} label={name} aria-selected={on} gap={4} minWidth={0}>
      {({ hovered }) => (
        <>
          <View
            height={64}
            borderRadius={5}
            overflow="hidden"
            justifyContent="center"
            backgroundColor={t.v("panel") as never}
            {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, on ? String(t.v("accent")) : undefined) as object)}
            {...(on ? ({ boxShadow: `0 0 0 2px ${String(t.v("tint-accent"))}` } as object) : {})}
            opacity={on || hovered ? 1 : 0.8}
          >
            {picture && src !== null ? (
              <Picture src={src} alt={name} maxHeight={62} box={{ alignSelf: "center" }} />
            ) : !picture ? (
              <View alignItems="center" gap={2}>
                <Txt spec={{ voice: "app", scale: 1, color: on ? "accent" : "dim" }} fontSize={20} lineHeight={24}>
                  {faceOf(item).glyph}
                </Txt>
                <Txt spec={{ voice: "data", scale: 9.5 / 12.5, color: "dim", upper: true, ls: 0.06 }}>{faceOf(item).word}</Txt>
              </View>
            ) : null}
          </View>
          <Txt spec={{ voice: "data", scale: 10.5 / 12.5, color: on ? "accent" : hovered ? "text" : "dim", lineHeight: 1.3 }} numberOfLines={2}>
            {name}
          </Txt>
        </>
      )}
    </Press>
  );
}
