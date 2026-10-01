import { useMemo, useRef, useState, type JSX } from "react";
import { Platform, TextInput, View as RNView, useWindowDimensions } from "react-native";
import { View } from "@tamagui/core";
import { isInstalled, shownFamilies } from "@jaira/ui/appearance";
import { PLAIN_SCROLLER, ENTER_KEEPS_FOCUS, Press, Txt, edge, font, lengthToken, placeholderColor } from "../../primitives";
import { useLook, useTokens } from "../../tokens";
import { MenuLayer } from "../MenuLayer";

/**
 * One voice's font stack as numbered chips in one box, tried left to right, and the menu that adds to
 * it (`FaceMenu`). What is shown is `shownFamilies`' (the shipped face, as "ours", while nothing is
 * chosen). How it looks:
 *
 *   the box              row, wraps, centred, gap 5, padding 4 5, 1px --line (--accent while open),
 *                        radius --control-radius, --panel
 *   a chip               row, centred, gap 6, padding 2 4 2 6, radius --control-radius-sm,
 *                        --fill-ghost-hover (--tint-warn with a warning); "ours": transparent in a dashed
 *                        --line
 *   its number           data-num: its place in the stack
 *   its name             app-text or data-text, set in the family it names, one line
 *   its "ours"           app-secondary, 2 right
 *   its ✕                17 square, radius 4, --dim at 0.8 on a line of 1; hovered --text on
 *                        --fill-ghost-selected
 *   "+ add…"             app-secondary, padding 2 6, radius --control-radius-sm; hovered --text on
 *                        --fill-ghost-hover
 *   the menu             under the box, as wide (at least 230), padding 4, 1px --line, radius
 *                        --control-radius, --panel, --lift; its head app-label 5 8 4; rows 4 8, gap 8,
 *                        radius --control-radius-sm (hovered --fill-ghost-hover, chosen --tint-accent);
 *                        the tick 12 wide, --accent at 0.88; the note app-secondary, pushed right
 */
export function FamilyStack({
  families,
  ours,
  fallback,
  suggested,
  voice,
  warn,
  disabled = false,
  onChange,
}: {
  families: readonly string[];
  ours: string;
  fallback: string;
  suggested: readonly string[];
  voice: "app" | "data";
  warn?: ((family: string) => string | undefined) | undefined;
  disabled?: boolean | undefined;
  onChange: (families: string[]) => void;
}): JSX.Element {
  const t = useTokens();
  const anchor = useRef<RNView | null>(null);
  const [at, setAt] = useState<{ x: number; y: number; width: number } | null>(null);
  const toggle = (family: string): void => onChange(families.includes(family) ? families.filter((f) => f !== family) : [...families, family]);
  const shown = shownFamilies(families, voice);
  const chosen = families.length > 0;
  const radius = lengthToken(t, "control-radius", 7);
  const radiusSm = lengthToken(t, "control-radius-sm", 6);
  const open = (): void => {
    if (at !== null) return setAt(null);
    anchor.current?.measureInWindow((x, y, width, height) => setAt({ x, y: y + height + 3, width }));
  };
  return (
    <RNView ref={anchor} collapsable={false} style={{ flex: 1, minWidth: 0, ...PLAIN_SCROLLER } as never}>
      <View
        flexGrow={1}
        flexDirection="row"
        flexWrap="wrap"
        alignItems="center"
        gap={5}
        minWidth={0}
        paddingVertical={4}
        paddingHorizontal={5}
        borderRadius={radius}
        backgroundColor={t.v("panel") as never}
        {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, at !== null ? "accent" : "line") as object)}
      >
        {shown.map((family, i) => {
          const note = warn?.(family);
          return (
            <View
              key={family}
              flexDirection="row"
              alignItems="center"
              gap={6}
              minWidth={0}
              maxWidth="100%"
              paddingTop={2}
              paddingRight={4}
              paddingBottom={2}
              paddingLeft={6}
              borderRadius={radiusSm}
              {...(chosen
                ? { backgroundColor: t.v(note !== undefined ? "tint-warn" : "fill-ghost-hover") }
                : { backgroundColor: "transparent", ...edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, "line", "dashed") })}
              {...({ title: note ?? (chosen ? undefined : "JaiRA's own — choosing a family replaces it") } as object)}
            >
              <Txt register="data-num" flexShrink={0}>
                {i + 1}
              </Txt>
              <FaceName family={family} fallback={fallback} voice={voice} />
              {chosen ? (
                <Press
                  onPress={() => toggle(family)}
                  disabled={disabled}
                  title={`remove ${family}`}
                  label={`remove ${family}`}
                  width={17}
                  height={17}
                  flexShrink={0}
                  alignItems="center"
                  justifyContent="center"
                  borderRadius={4}
                  box={({ hovered }) => ({ backgroundColor: hovered && !disabled ? t.v("fill-ghost-selected") : "transparent" })}
                >
                  {({ hovered }) => (
                    <Txt spec={{ voice: "app", scale: 0.8, lineHeight: 1, color: hovered && !disabled ? "text" : "dim" }} textAlign="center">
                      ✕
                    </Txt>
                  )}
                </Press>
              ) : (
                <Txt register="app-secondary" flexShrink={0} paddingRight={2}>
                  ours
                </Txt>
              )}
            </View>
          );
        })}
        <Press
          onPress={open}
          disabled={disabled}
          {...({ "aria-expanded": at !== null } as object)}
          label="add a family"
          paddingVertical={2}
          paddingHorizontal={6}
          borderRadius={radiusSm}
          alignItems="center"
          justifyContent="center"
          {...(disabled ? { opacity: 0.5 } : {})}
          box={({ hovered }) => ({ backgroundColor: hovered && !disabled ? t.v("fill-ghost-hover") : "transparent" })}
        >
          {({ hovered }) => (
            <Txt register="app-secondary" spec={{ color: hovered && !disabled ? "text" : "dim" }} numberOfLines={1}>
              + add…
            </Txt>
          )}
        </Press>
      </View>
      {at !== null ? (
        <FaceMenu at={at} families={families} ours={ours} fallback={fallback} suggested={suggested} voice={voice} onToggle={toggle} onClose={() => setAt(null)} />
      ) : null}
    </RNView>
  );
}

/** A face's name, set in that face where the platform can (web); a phone has only the faces it bundles. */
function FaceName({ family, fallback, voice, ellip = true }: { family: string; fallback: string; voice: "app" | "data"; ellip?: boolean }): JSX.Element {
  return (
    <Txt register={voice === "app" ? "app-text" : "data-text"} {...(Platform.OS === "web" ? { fontFamily: `"${family}", ${fallback}` } : {})} ellip={ellip} minWidth={0} flexShrink={1}>
      {family}
    </Txt>
  );
}

/** What can go in the box — a menu under it, over what is below. */
function FaceMenu({
  at,
  families,
  ours,
  fallback,
  suggested,
  voice,
  onToggle,
  onClose,
}: {
  at: { x: number; y: number; width: number };
  families: readonly string[];
  ours: string;
  fallback: string;
  suggested: readonly string[];
  voice: "app" | "data";
  onToggle: (family: string) => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const win = useWindowDimensions();
  const [typed, setTyped] = useState("");
  // Measured where the platform can: whether a named face is on this machine is a browser's question.
  const here = useMemo(() => new Set(suggested.filter((f) => (typeof document === "undefined" ? true : isInstalled(f)))), [suggested]);
  const rows = [...new Set([...families, ...suggested])];
  const add = (): void => {
    const clean = typed.trim();
    if (clean.length > 0 && !families.includes(clean)) onToggle(clean);
    setTyped("");
  };
  const width = Math.max(230, at.width);
  const radiusSm = lengthToken(t, "control-radius-sm", 6);
  const sep = <View height={1} backgroundColor={t.v("line") as never} marginVertical={4} marginHorizontal={6} />;
  return (
    <MenuLayer onClose={onClose}>
      <View
        position="absolute"
        left={Math.max(4, Math.min(at.x, win.width - width - 4))}
        top={at.y}
        width={width}
        padding={4}
        borderRadius={lengthToken(t, "control-radius", 7)}
        backgroundColor={t.v("panel") as never}
        {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
        {...({ boxShadow: t.v("lift") } as object)}
      >
        <Txt register="app-label" paddingTop={5} paddingHorizontal={8} paddingBottom={4}>
          {voice === "app" ? "sans" : "mono"} faces
        </Txt>
        <View maxHeight={210} overflow="scroll">
          {rows.map((family) => {
            const on = families.includes(family);
            return (
              <Press
                key={family}
                onPress={() => onToggle(family)}
                label={family}
                flexDirection="row"
                alignItems="center"
                justifyContent="flex-start"
                gap={8}
                paddingVertical={4}
                paddingHorizontal={8}
                borderRadius={radiusSm}
                box={({ hovered }) => ({ backgroundColor: on ? t.v("tint-accent") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
              >
                <Txt spec={{ voice: "app", scale: 0.88, color: "accent" }} width={12} flexShrink={0}>
                  {on ? "✓" : ""}
                </Txt>
                <FaceName family={family} fallback={fallback} voice={voice} />
                {family === ours && families.length === 0 ? (
                  <Txt register="app-secondary" marginLeft="auto" paddingLeft={8} flexShrink={0}>
                    ours, in use
                  </Txt>
                ) : here.has(family) ? null : (
                  <Txt register="app-secondary" marginLeft="auto" paddingLeft={8} flexShrink={0}>
                    not on this machine
                  </Txt>
                )}
              </Press>
            );
          })}
        </View>
        {sep}
        <View flexDirection="row" alignItems="center" gap={8} paddingVertical={4} paddingHorizontal={8}>
          <View width={12} flexShrink={0} />
          <TextInput {...(ENTER_KEEPS_FOCUS as object)}
            value={typed}
            placeholder="another family…"
            placeholderTextColor={placeholderColor("light") /* Chromium draws a placeholder #757575 under dark too, measured */}
            onChangeText={setTyped}
            onSubmitEditing={add}
            onBlur={add}
            style={
              {
                ...(font(t, { voice: "app", scale: 13 / 12.5 }) as object),
                flex: 1,
                minWidth: 0,
                paddingVertical: 5,
                paddingHorizontal: 9,
                borderWidth: 1,
                borderStyle: "solid",
                borderColor: t.v("line"),
                borderRadius: lengthToken(t, "control-radius", 7),
                backgroundColor: t.v("bg"),
              } as never
            }
          />
        </View>
        {sep}
        <View flexDirection="row" alignItems="center" gap={8} paddingVertical={4} paddingHorizontal={8} {...({ title: fallback } as object)}>
          <View width={12} flexShrink={0} />
          <Txt register="app-secondary">always ends with the default stack</Txt>
        </View>
      </View>
    </MenuLayer>
  );
}
