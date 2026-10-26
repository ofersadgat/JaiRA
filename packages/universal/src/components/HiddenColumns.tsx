import { useRef, useState, type JSX } from "react";
import { View as RNView } from "react-native";
import { ContextMenu, type MenuAt } from "./Menu";
import { PLAIN_SCROLLER, Press, Txt } from "../primitives";
import { useTokens } from "../tokens";

/**
 * The board's hidden columns (decision 0021): "N hidden" in the Tasks title bar, beside New task, while
 * the board under the bar hides any — and the one place hiding is undone. Pressed, it lists the board's
 * columns under "Columns on this board", each ticked while it is shown; a press shows or hides one,
 * "Show all" shows every one. It changes nothing but this window.
 *
 *   the button   New task's box with no ground and no ring: app voice 13 on --dim, --text hovered,
 *                --panel-2 ground hovered or open; one line
 */
export function HiddenColumns({
  columns,
  hidden,
  onToggle,
  onShowAll,
}: {
  columns: ReadonlyArray<{ stateId: string; label?: string | undefined }>;
  hidden: ReadonlySet<string>;
  onToggle: (stateId: string) => void;
  onShowAll: () => void;
}): JSX.Element | null {
  const t = useTokens();
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const at = useRef<RNView>(null);
  const count = columns.filter((column) => hidden.has(column.stateId)).length;
  if (count === 0) return null;
  const items = (): MenuAt["items"] => [
    ...columns.map((column) => ({ label: column.label ?? column.stateId, checked: !hidden.has(column.stateId), onSelect: () => onToggle(column.stateId) })),
    { label: "Show all", separator: true, onSelect: onShowAll },
  ];
  return (
    <RNView ref={at} collapsable={false} style={{ flexShrink: 0, ...PLAIN_SCROLLER } as never}>
      <Press
        onPress={() => at.current?.measureInWindow((x, y, _w, h) => setMenu(menu !== null ? null : { x, y: y + h + 2, title: "Columns on this board", items: items() }))}
        label={`${count} hidden`}
        title="Columns hidden from this board — press to show them"
        {...({ "aria-haspopup": "menu" } as object)}
        flexDirection="row"
        alignItems="center"
        paddingVertical={3}
        paddingHorizontal={10}
        borderRadius={t.v("control-radius") as never}
        borderWidth={1}
        borderStyle="solid"
        box={({ hovered }) => ({ backgroundColor: hovered || menu !== null ? t.v("panel-2") : "transparent", borderColor: "transparent" })}
      >
        {({ hovered }) => (
          <Txt spec={{ voice: "app", scale: 13 / 12.5, color: hovered ? "text" : "dim" }} whiteSpace="nowrap">
            {count} hidden
          </Txt>
        )}
      </Press>
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </RNView>
  );
}
