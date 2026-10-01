import type { JSX, ReactNode } from "react";
import { View, isWeb } from "@tamagui/core";
import type { HealthItem, HealthPage } from "@jaira/shared/browser";
import { PILL_GLYPH } from "@jaira/ui/pillModel";
import { healthFixLabel, healthGroups, healthTally, sinceWords } from "@jaira/ui/updatesModel";
import { dismissAllHealth, dismissHealth } from "@jaira/ui/updatesStore";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { Press, Txt, edge, lengthToken, padToken, useHover } from "../../primitives";
import { TokenScope, useTokens } from "../../tokens";
import { MenuLayer } from "../MenuLayer";
import { Float } from "./Float";

/**
 * Everything that needs attention, grouped by page — the card the sidebar's Settings and Logs pills
 * open (`HealthPop`, mounted by `SidebarRegion.tsx`), beside them (to the right, end-aligned). A group's
 * name goes to its page; each row has its fix and an × that shows under the pointer; Dismiss all empties
 * it. The float carries the tokens of the place it was opened from: the sidebar's (`TokenScope`). How it
 * looks:
 *
 *   the card             column, gap 4, 400 wide (at most the window less 16), padding 6, 1px --line,
 *                        radius 10, --panel, --lift
 *   its head             row, centred, gap 10, padding 2 4 6 8, a --line under; app 11/12.5, --dim; the
 *                        title --text 600, the tally pushed right, then Dismiss all (a small `ghost`)
 *   empty                padding 8, --dim (the body's 13/12.5)
 *   a group              column, gap 2, padding 2 0
 *   its name             padding 4 8 2, no ground or edge, app 11/12.5, --dim; hovered --text, underlined
 *   a row                the mark | the words, taking the room | the fix | the ×; centred, gap 8,
 *                        padding 4 4 4 8, radius 6; hovered --fill-ghost-hover
 *   the mark             the pill's glyph alone: 18 wide, centred, padding 1 3, data 0.78 at 600,
 *                        line-height 1, in --bad or --warn
 *   the words            what: app 12/12.5, --text, one line; since when: app 11/12.5, --dim
 *   a small button       padding --control-pad-sm, radius --control-radius-sm, app 11/12.5; a plain
 *                        button's --panel-2 ground and --line edge (hovered --panel-3, --rule)
 *   the ×                20 square, radius 5, app 0.96, line 1, --dim; hidden until its row is under
 *                        the pointer
 */
export function HealthCard({ items, onFix, onOpenPage }: { items: readonly HealthItem[]; onFix: (item: HealthItem) => void; onOpenPage: (page: HealthPage) => void }): JSX.Element {
  const t = useTokens();
  const groups = healthGroups(items);
  return (
    <>
      <View flexDirection="row" alignItems="center" gap={10} paddingTop={2} paddingRight={4} paddingBottom={6} paddingLeft={8} {...(edge(t, { bottom: 1 }) as object)}>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600 }}>Needs attention</Txt>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} marginLeft="auto">
          {items.length > 0 ? healthTally(items) : "nothing"}
        </Txt>
        {items.length > 0 ? (
          <SmallButton ghost onPress={dismissAllHealth}>
            Dismiss all
          </SmallButton>
        ) : null}
      </View>
      {groups.length === 0 ? (
        <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} padding={8}>
          Nothing needs attention.
        </Txt>
      ) : null}
      {groups.map((group) => (
        <View key={group.page} flexDirection="column" gap={2} paddingVertical={2}>
          <Press onPress={() => onOpenPage(group.page)} title={`Open ${group.label}`} alignSelf="flex-start" paddingTop={4} paddingHorizontal={8} paddingBottom={2}>
            {({ hovered }) => (
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: hovered ? "text" : "dim" }} {...(hovered ? { textDecorationLine: "underline" } : {})}>
                {group.label}
              </Txt>
            )}
          </Press>
          {group.items.map((item) => (
            <Row key={item.id} item={item} onFix={onFix} />
          ))}
        </View>
      ))}
    </>
  );
}

/** A log count is CLEARED by dismissing it; a problem is hidden until it clears and happens again. */
const dismissWords = (item: HealthItem): string => (item.id.startsWith("log:") ? "Dismiss: clears the count" : "Dismiss: hide until it happens again");

/** A row: the mark, what and since when, the fix, and the × while it is under the pointer. */
function Row({ item, onFix }: { item: HealthItem; onFix: (item: HealthItem) => void }): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  return (
    <View
      {...hover}
      flexDirection="row"
      alignItems="center"
      gap={8}
      paddingTop={4}
      paddingRight={4}
      paddingBottom={4}
      paddingLeft={8}
      borderRadius={6}
      backgroundColor={(hovered ? t.v("fill-ghost-hover") : "transparent") as never}
    >
      <Mark item={item} />
      <View flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} flexDirection="column" {...((isWeb ? { title: `${item.title}: ${item.detail}` } : {}) as object)}>
        {/* Three text nodes, as the JSX writes them: Chromium shapes each apart. */}
        <Txt spec={{ voice: "app", scale: 12 / 12.5 }} ellip>
          {item.title}: {item.detail}
        </Txt>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{sinceWords(item)}</Txt>
      </View>
      {item.action !== undefined ? (
        <SmallButton title={item.fix} onPress={() => onFix(item)}>
          {healthFixLabel(item.action)}
        </SmallButton>
      ) : null}
      <Press
        onPress={() => dismissHealth(item.id)}
        title={dismissWords(item)}
        label={dismissWords(item)}
        width={20}
        height={20}
        flexShrink={0}
        alignItems="center"
        justifyContent="center"
        borderRadius={5}
        opacity={hovered ? 1 : 0}
      >
        <Txt spec={{ voice: "app", scale: 0.96, color: "dim", lineHeight: 1 }} textAlign="center">
          ×
        </Txt>
      </Press>
    </View>
  );
}

/** A row's mark: the pill's glyph alone, in the item's colour. */
function Mark({ item }: { item: HealthItem }): JSX.Element {
  const t = useTokens();
  return (
    <View
      width={18}
      flexShrink={0}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      paddingVertical={1}
      paddingHorizontal={3}
      {...((isWeb ? { role: "img", "aria-label": item.level } : {}) as object)}
    >
      <Txt
        spec={{ voice: "data", scale: 0.78, weight: 600, lineHeight: 1, color: item.level === "error" ? "bad" : "warn" }}
        flexShrink={0}
        {...((isWeb ? { whiteSpace: "nowrap" } : {}) as object)}
      >
        {PILL_GLYPH[item.level]}
      </Txt>
    </View>
  );
}

/** A small button (plain, or `ghost`): the card's Dismiss all and each row's fix. */
function SmallButton({ ghost = false, title, onPress, children }: { ghost?: boolean; title?: string | undefined; onPress: () => void; children: ReactNode }): JSX.Element {
  const t = useTokens();
  const [padV, padH] = padToken(t, "control-pad-sm", [2, 8]);
  return (
    <Press
      onPress={onPress}
      {...(title !== undefined ? { title } : {})}
      flexShrink={0}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      gap={5}
      paddingVertical={padV}
      paddingHorizontal={padH}
      borderWidth={1}
      borderStyle="solid"
      borderRadius={lengthToken(t, "control-radius-sm", 6)}
      box={({ hovered }) =>
        ghost
          ? { backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent", borderColor: t.v(hovered ? "rule" : "line") }
          : { backgroundColor: t.v(hovered ? "panel-3" : "panel-2"), borderColor: t.v(hovered ? "rule" : "line") }
      }
    >
      <Txt spec={{ voice: "app", scale: 11 / 12.5 }} {...((isWeb ? { whiteSpace: "nowrap" } : {}) as object)}>
        {children}
      </Txt>
    </Press>
  );
}

/**
 * The card where it stands: a float beside the pills that opened it (right of them, its bottom on
 * theirs), over everything, closed by a press outside or Escape. On a phone, where there is no element
 * to place it against, it stands at the foot of the window's left edge, where the Settings row is.
 */
export function HealthPop({
  anchor,
  items,
  onFix,
  onOpenPage,
  onClose,
}: {
  anchor: FloatRect | null;
  items: readonly HealthItem[];
  onFix: (item: HealthItem) => void;
  onOpenPage: (page: HealthPage) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <MenuLayer onClose={onClose}>
      <TokenScope scope="sidebar">
        <Card anchor={anchor}>
          <HealthCard items={items} onFix={onFix} onOpenPage={onOpenPage} />
        </Card>
      </TokenScope>
    </MenuLayer>
  );
}

function Card({ anchor, children }: { anchor: FloatRect | null; children: ReactNode }): JSX.Element {
  const t = useTokens();
  const box = {
    width: 400,
    maxWidth: isWeb ? "calc(100vw - 16px)" : "95%",
    flexDirection: "column",
    gap: 4,
    padding: 6,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: t.v("line"),
    borderRadius: 10,
    backgroundColor: t.v("panel"),
    boxShadow: t.v("lift"),
    role: "dialog",
    "aria-label": "Everything that needs attention",
  };
  if (anchor === null) {
    return (
      <View position="absolute" left={8} bottom={8} {...(box as object)}>
        {children}
      </View>
    );
  }
  return (
    <Float anchor={anchor} side="right" align="end" {...box}>
      {children}
    </Float>
  );
}
