import { Fragment, type JSX } from "react";
import { Text, View, isWeb } from "@tamagui/core";
import { hueOf, type AnswerMenu, type HintPiece, type Reach } from "@jaira/ui/approvalModel";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { Press, Txt, edge, font, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { colorOf } from "../Sidebar";
import { MenuLayer } from "../MenuLayer";
import { Float } from "./Float";

/**
 * The approval's answer menu: what the answer covers — a segmented choice per distinct set of widths
 * among the asking parts, each by its part's colour — then how far it reaches, the default ticked, then
 * why something is not offered. Below its split button, start-aligned, over everything. How it looks:
 *
 *   the card               column, gap 1, padding 4, 1px --line, radius 9, --panel, a 0 10 28 shadow at
 *                          28% black; 390 to 460 wide (at most 86% of the window)
 *   what it covers         column, gap 4, padding 4 7 6; its label set as a hint; a row per choice
 *                          (centred, gap 7): the swatch (9, radius 3) when there are several, then
 *                          the segmented choice — 1px --line, radius --control-radius, --panel, clipped;
 *                          its buttons share the width, centred, padding 4 9, app 11/12.5 at 500 (650 on;
 *                          the widths in the same face as the words round them), --dim, a --line
 *                          between; on: --accent at 13%, --text
 *   a rule                 1 tall, 3 4 margins, --line
 *   a reach                a row from the top left, gap 8, padding 5 7, radius 7, --dim; hovered --text
 *                          at 7% and --text; the default: --accent at 13% and --text
 *   its tick               10 wide, --ok, app 11/12.5;  its words a column, gap 1
 *   its name               app 12/12.5 at 500, line 1.25;  a hint app 10.5/12.5, line 1.3, --tok-hint
 *   a note                 padding 4 7 5, app 10.5/12.5, line 1.4, --tok-hint
 */
export function AnswerMenuCard({
  anchor,
  menu,
  onChoose,
  onReach,
  onClose,
  testIdOf,
}: {
  anchor: FloatRect | null;
  menu: AnswerMenu;
  onChoose: (key: string, width: string) => void;
  onReach: (reach: Reach) => void;
  onClose: () => void;
  testIdOf?: (reach: Reach) => string;
}): JSX.Element {
  const t = useTokens();
  const box = {
    minWidth: 390,
    maxWidth: isWeb ? "min(460px, 86vw)" : 460,
    flexDirection: "column",
    gap: 1,
    padding: 4,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: t.v("line"),
    borderRadius: 9,
    backgroundColor: t.v("panel"),
    boxShadow: "0 10px 28px rgba(0, 0, 0, 0.28)",
    role: "menu",
  };
  const body = (
    <>
      {menu.what.length > 0 ? (
        <>
          <View flexDirection="column" gap={4} paddingTop={4} paddingHorizontal={7} paddingBottom={6}>
            <Txt spec={HINT}>{menu.whatLabel}</Txt>
            {menu.what.map((choice) => (
              <View key={choice.key} flexDirection="row" alignItems="center" gap={7}>
                {menu.what.length > 1 ? <View width={9} height={9} borderRadius={3} backgroundColor={colorOf(t, hueOf(choice.part)) as never} flexShrink={0} /> : null}
                <View
                  flexGrow={1}
                  flexShrink={1}
                  flexDirection="row"
                  overflow="hidden"
                  borderWidth={1}
                  borderStyle="solid"
                  borderColor={t.v("line") as never}
                  borderRadius={lengthToken(t, "control-radius", 7) as never}
                  backgroundColor={t.v("panel") as never}
                  role="radiogroup"
                  aria-label={menu.whatLabel}
                >
                  {choice.options.map((option, i) => {
                    const on = choice.chosen === option.width;
                    const spec = { voice: "app", scale: 11 / 12.5, weight: on ? 650 : 500, color: on ? "text" : "dim" } as const;
                    return (
                      <Press
                        key={option.width}
                        onPress={() => onChoose(choice.key, option.width)}
                        flexGrow={1}
                        flexShrink={1}
                        // `flex: 1 1 0` on a button whose own edge counts: the one with the rule to its left
                        // starts that rule wider (1px, as Chromium lays it out at this density).
                        flexBasis={i > 0 ? hairline() : 0}
                        flexDirection="row"
                        alignItems="center"
                        justifyContent="center"
                        gap={4}
                        paddingVertical={4}
                        paddingHorizontal={9}
                        {...(i > 0 ? edge(t, { left: 1 }) : {})}
                        box={({ hovered }) => ({ backgroundColor: on ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
                        {...((isWeb ? { role: "radio", "aria-checked": on } : {}) as object)}
                      >
                        {/* The button is a flex row (gap 4): each run of words is an item of its own, its
                            edge spaces gone — "every", the width, "command". */}
                        {(option.program ? ["every", option.width, "command"] : option.server !== undefined ? ["every", option.server, "tool"] : [option.width]).map((words, k) => (
                          <Txt key={k} spec={spec} {...((isWeb ? { whiteSpace: "nowrap" } : {}) as object)}>
                            {words}
                          </Txt>
                        ))}
                      </Press>
                    );
                  })}
                </View>
              </View>
            ))}
          </View>
          <Rule />
        </>
      ) : null}
      {menu.reach.map((item, at) => (
        <Fragment key={item.reach}>
          {item.reach.startsWith("add:") && menu.reach[at - 1]?.reach.startsWith("add:") !== true ? <Rule /> : null}
          <Press
            onPress={() => onReach(item.reach)}
            {...(testIdOf !== undefined ? { testID: testIdOf(item.reach) } : {})}
            flexDirection="row"
            alignItems="flex-start"
            gap={8}
            paddingVertical={5}
            paddingHorizontal={7}
            borderRadius={7}
            {...((isWeb ? { role: "menuitem" } : {}) as object)}
            box={({ hovered }) => ({ backgroundColor: item.isDefault ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
          >
            {({ hovered }) => (
              <>
                <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "ok" }} width={10} flexShrink={0}>
                  {item.isDefault ? "✓" : ""}
                </Txt>
                <View flexDirection="column" gap={1} minWidth={0} flexShrink={1}>
                  <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 500, lineHeight: 1.25, color: item.isDefault || hovered ? "text" : "dim" }} ellip>
                    {item.name}
                  </Txt>
                  <Txt spec={HINT} {...((isWeb ? { style: { overflowWrap: "anywhere" } } : {}) as object)}>
                    <Hint hint={item.hint} spec={HINT} />
                  </Txt>
                </View>
              </>
            )}
          </Press>
        </Fragment>
      ))}
      {menu.notes.length > 0 ? (
        <>
          <Rule />
          {menu.notes.map((note) => (
            <Txt key={note} spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.4, color: "tok-hint" }} paddingTop={4} paddingHorizontal={7} paddingBottom={5}>
              {note}
            </Txt>
          ))}
        </>
      ) : null}
    </>
  );
  return (
    <MenuLayer onClose={onClose}>
      {anchor === null ? (
        <View position="absolute" left={8} right={8} bottom={8} {...(box as object)}>
          {body}
        </View>
      ) : (
        <Float anchor={anchor} side="below" align="start" {...box}>
          {body}
        </Float>
      )}
    </MenuLayer>
  );
}

const HINT = { voice: "app", scale: 10.5 / 12.5, lineHeight: 1.3, color: "tok-hint" } as const;

/** The rule between the menu's parts: a --line, 1 tall, 3 above and below, 4 in. */
function Rule(): JSX.Element {
  const t = useTokens();
  return <View height={1} marginVertical={3} marginHorizontal={4} backgroundColor={t.v("line") as never} />;
}

/** A hint is words, and the text that will be written set in bold. */
export function Hint({ hint, spec }: { hint: readonly HintPiece[]; spec: Record<string, unknown> }): JSX.Element {
  const t = useTokens();
  return (
    <>
      {hint.map((piece, at) =>
        typeof piece === "string" ? (
          <Fragment key={at}>{piece}</Fragment>
        ) : (
          // Bold in the hint's own face, not the data face.
          <Text key={at} {...(font(t, { voice: "app", scale: (spec["scale"] as number) ?? 1, lineHeight: (spec["lineHeight"] as number) ?? 1.5, weight: 700, color: spec["color"] as string }) as object)}>
            {piece.code}
          </Text>
        ),
      )}
    </>
  );
}

/** A 1px edge as Chromium lays it out: whole device pixels, at least one. */
function hairline(): number {
  const dpr = typeof window !== "undefined" && typeof window.devicePixelRatio === "number" ? window.devicePixelRatio : 1;
  return Math.max(1, Math.floor(dpr)) / dpr;
}
