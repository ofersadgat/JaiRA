import { useRef, useState, type JSX, type ReactNode } from "react";
import { View as RNView } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import { isAllCrumb, type Crumb } from "@jaira/ui/crumbModel";
import { PLAIN_SCROLLER, font, Press, Txt, edge } from "../primitives";
import { useTokens, type Tokens } from "../tokens";
import { ContextMenu, type MenuAt } from "./Menu";
import { colorOf } from "./Sidebar";

/**
 * An address — each crumb after the chevron that joins it to the level on its left, then the view's
 * annotations and controls. The crumbs are built by `crumbModel.ts`. How it looks:
 *
 *   the bar                  row, centred, gap 3, padding 7 12, min-width 0; in the title bar no ground
 *                            and no rule, and 0 1 auto; over a board group --panel with a --line above
 *                            and under it
 *   a crumb and its chevron  row, centred, gap 2
 *   the chevron              "›" in --dim, in the body's font (13, line 1.5)
 *   … with a menu            a button: line 1, padding 1 3, a transparent 1px ring, radius 4; 2 right when
 *                            first; hovered: --panel-2, --line ring, --text; open ("⌄"): the same in
 *                            --accent, but --text under the pointer
 *   a crumb                  padding 2 5, radius 5, no ground; one line, cut with "…"; data voice at
 *                            12.5/12, at most 220 wide, line 1.5 (the body's)
 *   the last crumb           --text, 600
 *   a folder                 --dim (also when last); hovered --text on --panel-2
 *   a state                  --accent (also when last); hovered --panel-2
 *   a run                    app voice at 12/12.5, at most 190, --text (also when last), after a "▸ "
 *                            in its font and --dim (inline where the crumb is text; 5 before the name in
 *                            a button); last: --panel-2 ground, radius 5; hovered (a button) --panel-3
 *   a project                row, centred, gap 4, data voice at 0.96, -0.01em, at most 240, --text,
 *                            500 — also when last — its hue at 18% as ground, radius 4, a 5px dot of the
 *                            hue first; hovered: the hue at 30%
 *   "All projects"           app voice at 0.96, 600, no spacing, no ground, no dot; hovered --panel-2
 *   a pending crumb          italic, --dim — but a run that is last keeps --text
 *   the slack                between the path and what follows it
 *   the tools                row, centred, gap 6, flex none
 */
export function CrumbBar({
  crumbs,
  trailing,
  tools,
  place = "title",
}: {
  crumbs: readonly Crumb[];
  /** Read-only annotations after the path: a label, an error count. Not controls. */
  trailing?: ReactNode;
  /** Controls: a mode toggle, a New button. */
  tools?: ReactNode;
  /**
   * Where the bar stands: the window's title bar (no ground, no rule: the title bar has both), or a board
   * group's header down the Tasks column (--panel, a --line above and below).
   */
  place?: "title" | "section";
}): JSX.Element {
  const t = useTokens();
  // Which chevron is open, so the same press closes it and the glyph can turn to face down.
  const [menu, setMenu] = useState<(MenuAt & { at: number }) | null>(null);
  return (
    <View
      flexDirection="row"
      alignItems="center"
      gap={3}
      paddingVertical={7}
      paddingHorizontal={12}
      minWidth={0}
      {...(place === "title"
        ? { flexGrow: 0, flexShrink: 1 }
        : { flexShrink: 0, backgroundColor: t.v("panel"), ...edge(t, { top: 1, bottom: 1 }) })}
    >
      {crumbs.map((crumb, i) => (
        <View key={`${i}:${crumb.kind}:${crumb.text}`} flexDirection="row" alignItems="center" gap={2} flexShrink={1} minWidth={0}>
          {crumb.options === undefined ? (
            // The root has nothing to its left, so its chevron would be a separator between the bar and
            // the window. It keeps the menu and loses the glyph.
            i === 0 ? null : (
              <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} flexShrink={0}>
                ›
              </Txt>
            )
          ) : (
            <Chevron
              open={menu?.at === i}
              first={i === 0}
              onPress={(x, y) => setMenu(menu?.at === i ? null : { at: i, x, y, items: crumb.options! })}
            />
          )}
          <CrumbButton crumb={crumb} last={i === crumbs.length - 1} t={t} />
        </View>
      ))}
      <View flexGrow={1} flexShrink={1} minWidth={0} />
      {trailing}
      {tools !== undefined ? (
        <View flexDirection="row" alignItems="center" gap={6} flexShrink={0}>
          {tools}
        </View>
      ) : null}
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </View>
  );
}

/** The join between two levels, as a button that drops down what else is at this one. */
function Chevron({ open, first, onPress }: { open: boolean; first: boolean; onPress: (x: number, y: number) => void }): JSX.Element {
  const t = useTokens();
  // The menu opens under the chevron's left edge, 2 below it: measured where it stands in the window
  // when pressed.
  const at = useRef<RNView>(null);
  return (
    <RNView ref={at} collapsable={false} style={{ flexShrink: 0, ...PLAIN_SCROLLER, ...(first ? { marginRight: 2 } : {}) } as never}>
      <Press
        title="what else is at this level"
        label="what else is at this level"
        {...({ "aria-haspopup": "menu" } as object)}
        onPress={() => at.current?.measureInWindow((x, y, _w, h) => onPress(x, y + h + 2))}
        paddingVertical={1}
        paddingHorizontal={3}
        borderRadius={4}
        borderWidth={1}
        borderStyle="solid"
        box={({ hovered }) => ({
          backgroundColor: open || hovered ? t.v("panel-2") : "transparent",
          borderColor: open || hovered ? t.v("line") : "transparent",
        })}
      >
        {({ hovered }) => (
          <Txt spec={{ voice: "app", scale: 13 / 12.5, color: hovered ? "text" : open ? "accent" : "dim", lineHeight: 1 }} textAlign="center">
            {open ? "⌄" : "›"}
          </Txt>
        )}
      </Press>
    </RNView>
  );
}

/** One crumb: a button when it goes somewhere, else text — where you are, or a level with nowhere to go. */
function CrumbButton({ crumb, last, t }: { crumb: Crumb; last: boolean; t: Tokens }): JSX.Element {
  const all = isAllCrumb(crumb);
  const project = crumb.kind === "project";
  const run = crumb.kind === "run";
  const pending = crumb.pending === true;
  const hue = crumb.hue === undefined ? t.v("p0") : colorOf(t, crumb.hue);
  // A phone has no `white-space: nowrap`: a text is laid out no wider than its box, and wraps. The
  // project crumb's name is measured on one line apart (`natural`) and given that width, so a long path
  // overflows the button on both sides and is clipped there, as on web.
  const [natural, setNatural] = useState<number | null>(null);
  const spec = {
    voice: all || run ? "app" : "data",
    scale: all ? 0.96 : run ? 12 / 12.5 : project ? 0.96 : 12.5 / 12,
    weight: all ? 600 : project ? 500 : last ? 600 : 400,
    ...(project && !all ? { ls: -0.01 } : {}),
    ...(pending ? { italic: true } : {}),
    color: pending && !(run && last) ? "dim" : crumb.kind === "folder" ? "dim" : crumb.kind === "state" ? "accent" : "text",
  } as const;
  const ground = (hovered: boolean): string | number => {
    if (project && !all) return t.mix(hue, hovered ? 30 : 18, "transparent");
    if (hovered) return t.v(run ? "panel-3" : "panel-2");
    return run && last ? t.v("panel-2") : "transparent";
  };
  const box = {
    flexDirection: "row",
    alignItems: "center",
    ...(project && !all ? { gap: 4 } : {}),
    paddingVertical: 2,
    paddingHorizontal: 5,
    borderRadius: project ? 4 : 5,
    maxWidth: project ? 240 : run ? 190 : 220,
    // A project crumb's button centres its name: one longer than its 240px overflows BOTH sides and is
    // clipped there — no ellipsis.
    ...(project && crumb.go !== undefined ? { justifyContent: "center" as const } : {}),
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
  } as const;
  // The run's "▸ " is in the crumb's own font but --dim. Where the crumb is text it is inline, one line
  // with the name; in a button it is an item of the button's row, where a trailing space would be
  // dropped at the end of its line, so it stands 5 before the name instead.
  const mark = { ...spec, color: "dim" } as const;
  const words = (hovered: boolean, button: boolean): JSX.Element => (
    <>
      {project && !all ? <View width={5} height={5} borderRadius={999} flexShrink={0} backgroundColor={hue as never} /> : null}
      {run && button ? (
        <Txt spec={mark} flexShrink={0} marginRight={5}>
          ▸
        </Txt>
      ) : null}
      <Txt
        spec={{ ...spec, ...(hovered && crumb.kind === "folder" ? { color: "text" } : {}) }}
        {...(project && button ? { flexShrink: 0, ...(isWeb ? { whiteSpace: "nowrap" } : { numberOfLines: 1, ...(natural !== null ? { width: natural } : {}) }) } : { ellip: true, flexShrink: 1, minWidth: 0 })}
      >
        {run && !button ? <Text {...(font(t, mark) as object)}>{"▸ "}</Text> : null}
        {crumb.text}
      </Txt>
      {project && button && !isWeb ? (
        <View position="absolute" left={0} top={0} width={4000} flexDirection="row" opacity={0} pointerEvents="none">
          <Txt spec={spec} numberOfLines={1} onLayout={(e: { nativeEvent: { layout: { width: number } } }) => setNatural(Math.ceil(e.nativeEvent.layout.width))}>
            {crumb.text}
          </Txt>
        </View>
      ) : null}
    </>
  );
  if (crumb.go === undefined) {
    return (
      <View {...box} backgroundColor={ground(false) as never} {...({ title: crumb.title } as object)}>
        {words(false, false)}
      </View>
    );
  }
  return (
    <Press
      onPress={() => crumb.go?.()}
      title={crumb.title ?? (run ? "back to this run" : "open this state")}
      label={crumb.text}
      {...box}
      box={({ hovered }) => ({ backgroundColor: ground(hovered) })}
    >
      {({ hovered }) => words(hovered, true)}
    </Press>
  );
}
