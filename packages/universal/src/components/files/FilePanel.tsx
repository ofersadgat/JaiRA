import { useState, type JSX } from "react";
import { ScrollView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { FileSource } from "@jaira/shared/browser";
import { HALF_GLYPHS, HALF_WORDS, filePanelOf, nextHalf, type FileSelection } from "@jaira/ui/filesModel";
import type { FileSurfaceContext } from "@jaira/ui/fileTypes";
import { PANE, paneDefault, type HalfMode } from "@jaira/ui/uiState";
import { PLAIN_SCROLLER, Press, Txt, edge, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { DirectoryPanel } from "./DirectoryPanel";
import { Splitter } from "./Splitter";
import { SURFACES } from "./surfaces";

/** How tall the viewer opens, and what a double-press on the divider restores. */
const VIEWER_HEIGHT = paneDefault(PANE.filesViewer);

/**
 * The open file — what it IS above, what it SAYS below — or a folder's listing, or nothing yet. Which
 * renderer draws each half, where the lower half stands and what each half is mounted with is
 * `filePanelOf` (`filesModel.ts`), resolved against the registry of surfaces (`surfaces.tsx`). How it
 * looks:
 *
 *   the column            --bg, clipped
 *   the viewer            `viewerHeight` tall (320 to start), at least 80, may shrink, scrolls; with the
 *                         lower half folded it takes the rest instead
 *   the divider           6 tall, a 2px --line across its middle; gone while the lower half is folded
 *   the lower half        the rest (flex 1 1 0), at least 140, a column, gap 8, padding 10 15 14, a
 *                         --line above, --panel, clipped; whole (no viewer, or `full`) no line;
 *                         shut only its bar: padding 6 15, gap 0
 *   its bar               row, centred, gap 7, padding 3 6, -2 -6 0 outside, radius 6; hovered --panel-2
 *   the bar's caret       app 10/12.5, --dim.   Its label  app 12/12.5, 600, --dim, uppercase, 0.07em
 *   the unsaved dot       app 8/12.5, line 1, --accent
 *   an empty note         --dim, 8 above and below, a paragraph's margins
 */
export function FilePanel({
  doc,
  dir,
  busy,
  context,
  viewerHeight,
  onViewerHeight,
  half = "half",
  onHalf,
  onSave,
}: {
  doc: FileSource | null;
  dir?: FileSelection | null;
  busy: boolean;
  context: FileSurfaceContext;
  viewerHeight: number;
  onViewerHeight: (height: number) => void;
  half?: HalfMode;
  onHalf?: ((half: HalfMode) => void) | undefined;
  onSave: (text: string) => void;
}): JSX.Element {
  const t = useTokens();
  const [extent, setExtent] = useState(0);
  const column = { flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column", overflow: "hidden", backgroundColor: t.v("bg") } as const;
  if (doc === null) {
    if (dir != null) {
      return (
        <View {...(column as object)}>
          <DirectoryPanel
            layer={dir.layer}
            path={dir.path}
            tree={context.tree}
            onOpenDir={context.onOpenDir ?? ((): void => {})}
            onOpenFile={context.onOpenFile ?? ((): void => {})}
            onOpenState={context.onDrill}
          />
        </View>
      );
    }
    return (
      <View {...(column as object)}>
        <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 13 / 12.5) as number}>
          Select a file in the tree.
        </Txt>
      </View>
    );
  }

  const { View: Viewer, Edit, at, shut, viewProps, editProps } = filePanelOf({ doc, busy, onSave, context }, half, SURFACES);
  const whole = Viewer === null || at === "full";
  const next = nextHalf(at);
  return (
    <View {...(column as object)} onLayout={(e) => setExtent(e.nativeEvent.layout.height)}>
      {Viewer !== null && at !== "full" ? (
        <>
          <ScrollView
            {...(scrollbarProps(t) as object)}
            // `PLAIN_SCROLLER`: the viewer is no stacking context — what the page paints after it (the
            // editor's head, the inbox strip) shares a layer with its scrollbar, greyscale.
            style={{ ...(shut ? { flexGrow: 1, flexShrink: 1 } : { height: viewerHeight, flexGrow: 0, flexShrink: 1 }), minHeight: 80, ...PLAIN_SCROLLER } as never}
            contentContainerStyle={{ flexGrow: 1, flexDirection: "column", ...PLAIN_SCROLLER } as never}
          >
            <Viewer {...viewProps} />
          </ScrollView>
          {shut ? null : <Splitter orientation="horizontal" label="Resize the viewer" value={viewerHeight} reset={VIEWER_HEIGHT} min={80} max={1600} reserve={200} extent={extent} onChange={onViewerHeight} />}
        </>
      ) : null}
      <View
        flexDirection="column"
        overflow="hidden"
        backgroundColor={t.v("panel") as never}
        {...(shut
          ? { flexGrow: 0, flexShrink: 0, paddingVertical: 6, paddingHorizontal: 15 }
          : { flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 140, gap: 8, paddingTop: 10, paddingHorizontal: 15, paddingBottom: 14 })}
        {...(edge(t, { top: whole ? 0 : 1 }) as object)}
      >
        {Viewer !== null ? (
          <Press
            onPress={() => onHalf?.(next)}
            disabled={onHalf === undefined}
            title={`${HALF_WORDS[at]} — click for ${HALF_WORDS[next]}`}
            label={`${HALF_WORDS[at]} — click for ${HALF_WORDS[next]}`}
            flexShrink={0}
            marginTop={-2}
            // `width: 100%` with -6 on the left: the bar keeps the half's width, shifted out by 6.
            marginLeft={-6}
            marginRight={6}
            flexDirection="row"
            alignItems="center"
            gap={7}
            paddingVertical={3}
            paddingHorizontal={6}
            borderRadius={6}
            box={({ hovered }) => ({ backgroundColor: hovered && onHalf !== undefined ? t.v("panel-2") : "transparent" })}
          >
            <Txt spec={{ voice: "app", scale: 10 / 12.5, color: "dim" }} flexShrink={0}>
              {HALF_GLYPHS[at]}
            </Txt>
            <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: "dim", upper: true, ls: 0.07 }} flexShrink={0}>
              {doc.stateId !== undefined ? "Configuration" : "Source"}
            </Txt>
            <View flex={1} minWidth={0} />
            {shut && context.drafts?.[`${doc.layer}:${doc.path}`] !== undefined ? (
              <Txt spec={{ voice: "app", scale: 8 / 12.5, color: "accent", lineHeight: 1 }} flexShrink={0} {...((isWeb ? { title: "unsaved edits" } : {}) as object)}>
                ●
              </Txt>
            ) : null}
          </Press>
        ) : null}
        {shut ? null : Edit ? (
          <Edit {...editProps} />
        ) : (
          <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 13 / 12.5) as number}>
            Nothing here can edit {doc.mime}.
          </Txt>
        )}
      </View>
    </View>
  );
}
