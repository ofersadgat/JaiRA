import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { PanResponder, Pressable, ScrollView, View as RNView, type LayoutChangeEvent } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { useValuePanel } from "@jaira/ui/valuePanel";
import { useCanHover } from "../canHover";
import { Press, Txt, scrollbarProps, useHover } from "../primitives";
import { onTouchElsewhere } from "../touchElsewhere";
import { useTokens } from "../tokens";
import { Range } from "./form/Range";
import { Img, naturalSizeOf } from "./Img";
import { SCALE_MAX, SCALE_MIN, choiceOf, dragScale, fitScale, openingScale, percentOf, stepScale, usePictureSize, type Natural } from "./pictureSize";
import { useViewCarry } from "./viewCarry";

/**
 * A picture the person can size (the person's pick, 2026-11-14: round 2's board 4). At rest it is the
 * picture alone, as `Picture` draws it: no wider than its column, no taller than 420, never above 1:1.
 * With the pointer over it (under a finger: pressed; a press elsewhere puts them away):
 *
 *   the chip     top right, 8 in: its size ("26% ⌄"), data 11.5/12, --panel, 1px --line, round, padding
 *                3 9. The pointer on it (or a press) opens it into the bar
 *   the bar      in the chip's place: − · a slider 10% to 200% · + · the % · Fit · 1:1 · ⤢ (the side panel)
 *   the corner   bottom right, a 14 (a finger: 24) --accent square, 7 out, ringed in --bg: dragged, the
 *                picture follows it, held at Fit and 1:1 for 8 px; the chip says the % and the size in
 *                --accent meanwhile
 *
 * Wider than its column (above Fit) it scrolls sideways in its box. The size is kept while the
 * conversation is open and dropped when it is left (`pictureSize.ts`).
 *
 * `alone`: it stands on its own (the side panel, the main view, a split — its value view `pinned`), where
 * it opens at Fit rather than at rest (2026-11-22). An item of a shown set opens at the size the person
 * last chose on the set (`viewCarry.ts`), and a size chosen here is that choice from now on.
 */
export function SizedPicture({ src, alt, alone = false }: { src: string; alt?: string; alone?: boolean }): JSX.Element {
  const carry = useViewCarry();
  const t = useTokens();
  const hovers = useCanHover();
  const panel = useValuePanel();
  const [natural, setNatural] = useState<Natural | null>(null);
  const [room, setRoom] = useState<number | null>(null);
  const [given, setGiven] = usePictureSize(src);
  const [hovered, hoverBind] = useHover();
  const [shown, setShown] = useState(false);
  const [barOpen, setBarOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let live = true;
    naturalSizeOf(
      src,
      (width, height) => live && setNatural({ width, height }),
      () => live && setNatural(null),
    );
    return () => {
      live = false;
    };
  }, [src]);
  // The pointer gone, the bar folds back into the chip.
  useEffect(() => {
    if (hovers && !hovered && !dragging) setBarOpen(false);
  }, [hovers, hovered, dragging]);
  // Under a finger: a touch on this picture is heard here first; one anywhere else puts the controls away.
  const mine = useRef(false);
  useEffect(
    () =>
      onTouchElsewhere(() => {
        if (mine.current) mine.current = false;
        else {
          setShown(false);
          setBarOpen(false);
        }
      }),
    [],
  );

  const scale = natural === null || room === null ? 0 : openingScale(natural, room, given, carry?.get().picture, alone);
  /** A size the person gave: kept for this picture, and carried to the set's next one as what they chose. */
  const give = (next: number): void => {
    setGiven(next);
    if (carry !== null && natural !== null && room !== null) carry.set({ picture: choiceOf(next, natural, room) });
  };
  const width = natural === null ? 0 : natural.width * scale;
  const height = natural === null ? 0 : natural.height * scale;

  // The corner's drag, read through a ref: the responder is made once, and a drag outlives its render.
  const live = useRef({ natural, room, width, setGiven: give });
  live.current = { natural, room, width, setGiven: give };
  const from = useRef(0);
  const corner = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          from.current = live.current.width;
          release.current?.();
          release.current = holdPointer();
          setDragging(true);
        },
        onPanResponderMove: (_e, g) => {
          const { natural: n, room: r, setGiven: set } = live.current;
          if (n !== null && r !== null) set(dragScale(from.current, g.dx, n, r));
        },
        onPanResponderRelease: () => end(),
        onPanResponderTerminate: () => end(),
      }),
    [],
  );
  const release = useRef<(() => void) | null>(null);
  const end = (): void => {
    release.current?.();
    release.current = null;
    setDragging(false);
  };
  // Unmounted mid-drag: the page's text and cursor are given back.
  useEffect(() => () => release.current?.(), []);

  if (natural === null || room === null) return <View onLayout={(e: LayoutChangeEvent) => setRoom(e.nativeEvent.layout.width)} />;

  const image = <Img src={src} alt={alt ?? ""} style={{ width, height, borderRadius: 6, backgroundColor: t.v("panel-2") }} />;
  const picture =
    width > room + 0.5 ? (
      <ScrollView horizontal {...(scrollbarProps(t) as object)} style={{ width: room } as never}>
        {image}
      </ScrollView>
    ) : (
      image
    );
  const controls = hovers ? hovered || dragging : shown || dragging;
  const grip = hovers ? 14 : 24;
  const set = (next: number): void => give(Math.min(SCALE_MAX, Math.max(SCALE_MIN, next)));

  return (
    <View onLayout={(e: LayoutChangeEvent) => setRoom(e.nativeEvent.layout.width)} minWidth={0}>
      <RNView onTouchStart={() => (mine.current = true)} style={{ position: "relative", width: Math.min(width, room), alignSelf: "flex-start" }}>
        <View {...(hoverBind as object)}>
          {hovers ? (
            picture
          ) : (
            <Pressable onPress={() => setShown((was) => !was)} accessibilityLabel="Show the picture's size controls">
              {picture}
            </Pressable>
          )}
          {controls ? (
            <View position="absolute" top={8} right={8} zIndex={2}>
              {barOpen && !dragging ? (
                <Bar>
                  <BarButton label="Smaller" onPress={() => set(stepScale(scale, -1))}>
                    −
                  </BarButton>
                  <Range min={SCALE_MIN} max={SCALE_MAX} step={0.01} value={scale} onChange={set} label="Picture size" width={hovers ? 110 : 130} />
                  <BarButton label="Larger" onPress={() => set(stepScale(scale, 1))}>
                    +
                  </BarButton>
                  <Txt spec={{ voice: "data", scale: 11.5 / 12 }} minWidth={34} textAlign="center">
                    {percentOf(scale)}
                  </Txt>
                  <BarButton label="Fit the column" onPress={() => set(fitScale(natural, room))}>
                    Fit
                  </BarButton>
                  <BarButton label="Actual size" onPress={() => set(1)}>
                    1:1
                  </BarButton>
                  {panel !== null ? (
                    <BarButton label="Open in the side panel" onPress={() => panel.open({ title: alt !== undefined && alt !== "" ? alt : "Picture", value: { src }, hint: { mime: "image/png" } })}>
                      ⤢
                    </BarButton>
                  ) : null}
                </Bar>
              ) : (
                <RNView {...((isWeb && hovers ? { onMouseEnter: () => setBarOpen(true) } : {}) as object)}>
                  <Press
                    onPress={() => setBarOpen(true)}
                    label={`Picture size ${percentOf(scale)}: open its controls`}
                    flexDirection="row"
                    alignItems="center"
                    gap={6}
                    paddingVertical={3}
                    paddingHorizontal={9}
                    borderRadius={999}
                    borderWidth={1}
                    borderStyle="solid"
                    borderColor={t.v(dragging ? "accent" : "line") as never}
                    backgroundColor={t.v("panel") as never}
                  >
                    <Txt spec={{ voice: "data", scale: 11.5 / 12, color: dragging ? "accent" : "text" }} flexShrink={0} {...NOWRAP}>
                      {percentOf(scale)}
                    </Txt>
                    <Txt spec={{ voice: "data", scale: 11.5 / 12, color: "dim" }} flexShrink={0} {...NOWRAP}>{dragging ? `${Math.round(width)}×${Math.round(height)}` : "⌄"}</Txt>
                  </Press>
                </RNView>
              )}
            </View>
          ) : null}
          {controls ? (
            <RNView
              {...corner.panHandlers}
              accessibilityLabel="Drag to resize the picture"
              style={
                {
                  position: "absolute",
                  right: -grip / 2,
                  bottom: -grip / 2,
                  width: grip,
                  height: grip,
                  borderRadius: grip / 3.5,
                  backgroundColor: t.v("accent"),
                  borderWidth: 3,
                  borderColor: t.v("bg"),
                  zIndex: 2,
                  ...(isWeb ? { cursor: "nwse-resize", touchAction: "none", userSelect: "none" } : {}),
                } as never
              }
            />
          ) : null}
        </View>
      </RNView>
    </View>
  );
}

/**
 * While the corner is dragged on web: no text is selected as the pointer crosses it, no frame takes the
 * pointer, and the cursor stays the corner's wherever it is (as `Splitter.tsx`'s divider).
 */
function holdPointer(): () => void {
  if (!isWeb || typeof document === "undefined") return () => undefined;
  const style = document.createElement("style");
  style.textContent = "iframe, webview { pointer-events: none !important; } * { cursor: nwse-resize !important; user-select: none !important; }";
  document.head.appendChild(style);
  return () => style.remove();
}

/** One line: a box placed against the picture's right edge shrinks to fit, and its words would wrap. */
const NOWRAP: Record<string, unknown> = isWeb ? { whiteSpace: "nowrap" } : { numberOfLines: 1 };

/** The bar: a row, centred, gap 6, padding 4 6, --panel, 1px --line, radius 8. */
function Bar({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" alignItems="center" gap={6} paddingVertical={4} paddingHorizontal={6} borderRadius={8} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} backgroundColor={t.v("panel") as never}>
      {children}
    </View>
  );
}

/** One of the bar's buttons: data 11.5/12, padding 2 6, radius 4, --panel-2 under the pointer. */
function BarButton({ label, onPress, children }: { label: string; onPress: () => void; children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <Press onPress={onPress} label={label} title={label} paddingVertical={2} paddingHorizontal={6} borderRadius={4} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("panel-2") : "transparent" })}>
      <Txt spec={{ voice: "data", scale: 11.5 / 12 }} {...NOWRAP}>
        {children}
      </Txt>
    </Press>
  );
}
