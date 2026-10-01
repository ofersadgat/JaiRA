import { useMemo, useState, type JSX } from "react";
import type { LayoutChangeEvent } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import { PALETTES, SIZE_LIMITS, surfaceOf, type Appearance, type ConversationLook, type ThemeMode, type WorkNotes, type WorkRows } from "@jaira/shared/browser";
import { DEFAULT_APP_STACK, DEFAULT_DATA_STACK, SHIPPED_APP_FAMILY, SHIPPED_DATA_FAMILY, isMonospace, shownFamilies, stackOf } from "@jaira/ui/appearance";
import { lookOf } from "@jaira/ui/appearanceLayer";
import {
  APPEARANCE_ROWS as ROWS,
  BATCH_CHOICES,
  BATCH_PREVIEW,
  BUCKET_CHOICES,
  MODES,
  SUGGESTED_APP,
  SUGGESTED_DATA,
  TASK_PREVIEW,
  TEXT_PREVIEW,
  USAGE_CHOICES,
  WORK_NOTE_CHOICES,
  WORK_ROW_CHOICES,
  appearanceLayeringOf,
  appearanceRowLayer,
  boardPreviewWords,
  editorThemeChoices,
  settingsLocked,
} from "@jaira/ui/appearanceModel";
import { PALETTE_CARDS } from "@jaira/ui/paletteCardsModel";
import { PILL_WORD, pillKindOf } from "@jaira/ui/pill";
import type { InstanceStatus, TaskStatus } from "@jaira/shared/browser";
import { useShell } from "../../app/shell";
import { FileTypesPane } from "../files/FileTypesPane";
import { Press, Txt, edge, lengthToken } from "../../primitives";
import { useLook, useTokens } from "../../tokens";
import { Column, GraphPaper, graphPaperWeb } from "../Board";
import { Markdown } from "../Markdown";
import { UsageFiguresPreview } from "../usage/Figures";
import { Transcript } from "../panel/SessionTranscript";
import { workPreviewStates } from "@jaira/ui/workPreviewModel";
import { WorkLookContext, type WorkLook } from "@jaira/ui/workSummaryContext";
import { tileChromeOf } from "../TaskCard";
import { Pill } from "../Pill";
import { Segmented, Switch } from "./controls";
import { FamilyStack } from "./FamilyStack";
import { FilesTreeSection } from "./FilesTree";
import { SelectInput, SizeStep } from "./fields";
import { SettingsRow, SettingsSection } from "./SettingsPage";
import { ThemeMini } from "./ThemeMini";

/**
 * Settings → Appearance (`appearancePane.tsx`'s `AppearancePane`, with what `App.tsx` hands it),
 * universal (decision 0015). Its rows, choices and words are `appearanceModel.ts`'s, as the DOM's are;
 * the rules it carries, from `styles.css`:
 *
 *   .mode-tiles          three equal columns, gap 10, padding 12 (the card's one child)
 *   .mode-tile           column, gap 6, padding 7, 1px --line, radius 12, --panel, --dim; hovered a
 *                        --rule ring; chosen an --accent ring doubled by a 1px --accent shadow, --text,
 *                        on --accent at 5% over --panel
 *   .mode-tile > mini    70 tall, 1px --line, radius 8
 *   .mode-tile-name      centred, the body's text (13/12.5, line 1.5) at 500
 *   .theme-grid          columns of at least 196 filling the row, gap 10, padding 12
 *   .theme-card          column, 1px --line, radius 12, clipped, --panel, --text; hovered and chosen
 *                        as a tile (no ground change)
 *   .theme-card > mini   96 tall, a --line under it
 *   .theme-meta          column, gap 2, padding 8 10 10
 *   .theme-name          row, centred, gap 6, 600
 *   .theme-tag           padding 2 5, radius 4, --panel-3, --dim, app 700 at 0.68, line 1, 0.08em, upper
 *   .theme-desc          0.92, line 1.4, --dim
 *   .theme-check         18 round at 7 7 from the top right, --fill-accent, --on-accent 800 at 0.84,
 *                        a 0 1 3 shadow at 25%
 *   .set-font            a font row's control: the stack and its size, 340 wide, gap 8, stretched
 *   .set-inherit         app at 0.96, --dim
 *
 * Its previews are the real pieces: the board's own `Column` and tile chrome, the composer's chip and
 * figure (`usage/Figures.tsx`), the transcript for the work summary, `FileTypesPane` (its code an island)
 * and the Files tree section (`FilesTree.tsx`).
 */
export function AppearancePage(): JSX.Element {
  const { state, actions } = useShell();
  const look = lookOf(state.config);
  const layer = state.configLayer;
  const busy = settingsLocked(state.busy, layer, state.at);
  const layered = appearanceLayeringOf(state.config, layer, busy, (writes, into) => void actions.writeLook(writes, into));
  const rowLayer = (...fields: string[]) => appearanceRowLayer(layered, ...fields);
  const onChange = (patch: Partial<Appearance>): void => void actions.setAppearance(patch, layer);
  const onTheme = (mode: ThemeMode): void => void actions.setTheme(mode, layer);
  const onConversation = (patch: Partial<ConversationLook>): void => void actions.setConversation(patch, layer);
  const appearance = look as unknown as Appearance;
  const surface = surfaceOf(appearance);
  // Which chosen data faces are not monospaced — measured where a canvas can say (web), as the DOM does.
  const proportional = useMemo(() => {
    if (typeof document === "undefined") return new Set<string>();
    const ctx = document.createElement("canvas").getContext("2d");
    return new Set(appearance.dataFamily.filter((f) => !isMonospace(f, ctx)));
  }, [appearance.dataFamily]);
  return (
    <>
      <SettingsSection id="mode" title="Mode" layer={rowLayer("mode")}>
        <ModeTiles mode={look.mode} palette={appearance.palette} busy={busy} onTheme={onTheme} />
      </SettingsSection>

      <SettingsSection id="theme" title="Theme" layer={rowLayer("palette")}>
        {/* Choosing a palette puts the board options back to what it was designed with. */}
        <ThemeCards palette={appearance.palette} mode={look.mode} busy={busy} onPick={(palette) => onChange({ palette, laneColors: null, buckets: null, statusWash: null })} />
      </SettingsSection>

      <SettingsSection id="board" title="Board">
        <SettingsRow {...ROWS.laneColors} layer={rowLayer("laneColors")} control={<Switch on={surface.laneColors} label={ROWS.laneColors.name} disabled={busy} onChange={(laneColors) => onChange({ laneColors })} />} />
        <SettingsRow
          {...ROWS.buckets}
          layer={rowLayer("buckets")}
          control={<Segmented label={ROWS.buckets.name} value={surface.buckets} options={BUCKET_CHOICES} disabled={busy} onChange={(buckets) => onChange({ buckets })} />}
        />
        <SettingsRow {...ROWS.statusWash} layer={rowLayer("statusWash")} control={<Switch on={surface.statusWash} label={ROWS.statusWash.name} disabled={busy} onChange={(statusWash) => onChange({ statusWash })} />} />
        <SettingsRow {...boardPreviewWords(appearance.palette)} full>
          <TaskPreview />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="conversation" title="Conversation">
        <SettingsRow
          {...ROWS.sequentialBatches}
          layer={rowLayer("conversation.sequentialBatches")}
          control={
            <Segmented
              label={ROWS.sequentialBatches.name}
              value={look.conversation.sequentialBatches}
              options={BATCH_CHOICES}
              disabled={busy}
              onChange={(sequentialBatches) => onConversation({ sequentialBatches })}
            />
          }
        />
        <SettingsRow {...ROWS.batchPreview} full>
          <ConversationPreview layout={look.conversation.sequentialBatches} />
        </SettingsRow>
        <SettingsRow
          {...ROWS.usageFigures}
          layer={rowLayer("conversation.usageFigures")}
          control={<Segmented label={ROWS.usageFigures.name} value={look.conversation.usageFigures} options={USAGE_CHOICES} disabled={busy} onChange={(usageFigures) => onConversation({ usageFigures })} />}
        />
        <SettingsRow {...ROWS.usagePreview} full>
          <UsageFiguresPreview mode={look.conversation.usageFigures} />
        </SettingsRow>
        <SettingsRow
          {...ROWS.workPhases}
          layer={rowLayer("conversation.workPhases")}
          control={<Switch on={look.conversation.workPhases} label={ROWS.workPhases.name} disabled={busy} onChange={(workPhases) => onConversation({ workPhases })} />}
        />
        <SettingsRow
          {...ROWS.workRows}
          layer={rowLayer("conversation.workRows")}
          control={
            <Segmented
              label={ROWS.workRows.name}
              value={`${look.conversation.workRows}` as `${WorkRows}`}
              options={WORK_ROW_CHOICES}
              disabled={busy}
              onChange={(rows) => onConversation({ workRows: Number(rows) as WorkRows })}
            />
          }
        />
        <SettingsRow
          {...ROWS.workThinking}
          layer={rowLayer("conversation.workThinking")}
          control={<Switch on={look.conversation.workThinking} label={ROWS.workThinking.name} disabled={busy} onChange={(workThinking) => onConversation({ workThinking })} />}
        />
        <SettingsRow
          {...ROWS.workNotes}
          layer={rowLayer("conversation.workNotes")}
          control={<SelectInput value={look.conversation.workNotes} options={WORK_NOTE_CHOICES} disabled={busy} onChange={(workNotes) => onConversation({ workNotes: workNotes as WorkNotes })} />}
        />
        <SettingsRow {...ROWS.workPreview} full>
          <WorkPreview look={{ phases: look.conversation.workPhases, rows: look.conversation.workRows, thinking: look.conversation.workThinking, notes: look.conversation.workNotes }} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="text" title="Text">
        <SettingsRow
          name={ROWS.appFont.name}
          description={<FontWords words={ROWS.appFont.description} families={appearance.appFamily} voice="app" fallback={DEFAULT_APP_STACK} />}
          layer={rowLayer("appFamily", "sizeApp")}
          control={
            <View flexDirection="row" alignItems="stretch" gap={8} width={340} maxWidth="100%">
              <FamilyStack
                families={appearance.appFamily}
                ours={SHIPPED_APP_FAMILY}
                fallback={DEFAULT_APP_STACK}
                suggested={SUGGESTED_APP}
                voice="app"
                disabled={busy}
                onChange={(appFamily) => onChange({ appFamily })}
              />
              <SizeStep value={appearance.sizeApp} limits={SIZE_LIMITS.sizeApp} disabled={busy} onChange={(sizeApp) => onChange({ sizeApp })} />
            </View>
          }
        />
        <SettingsRow
          name={ROWS.dataFont.name}
          description={<FontWords words={ROWS.dataFont.description} families={appearance.dataFamily} voice="data" fallback={DEFAULT_DATA_STACK} />}
          layer={rowLayer("dataFamily", "sizeData")}
          control={
            <View flexDirection="row" alignItems="stretch" gap={8} width={340} maxWidth="100%">
              <FamilyStack
                families={appearance.dataFamily}
                ours={SHIPPED_DATA_FAMILY}
                fallback={DEFAULT_DATA_STACK}
                suggested={SUGGESTED_DATA}
                voice="data"
                disabled={busy}
                // OURS, and a note rather than a block (§6): it is their app.
                warn={(family) => (proportional.has(family) ? "not monospaced — columns will not line up" : undefined)}
                onChange={(dataFamily) => onChange({ dataFamily })}
              />
              <SizeStep value={appearance.sizeData} limits={SIZE_LIMITS.sizeData} disabled={busy} onChange={(sizeData) => onChange({ sizeData })} />
            </View>
          }
        />
        <SettingsRow
          {...ROWS.editorSize}
          layer={rowLayer("advanced", "sizeEditor")}
          control={
            <>
              {appearance.advanced ? (
                <SizeStep value={appearance.sizeEditor} limits={SIZE_LIMITS.sizeEditor} disabled={busy} onChange={(sizeEditor) => onChange({ sizeEditor })} />
              ) : (
                <Txt spec={{ voice: "app", scale: 0.96, color: "dim" }}>follows the data font</Txt>
              )}
              <Switch on={appearance.advanced} label="Separate editor size" disabled={busy} onChange={(advanced) => onChange({ advanced })} />
            </>
          }
        />
        <SettingsRow
          {...ROWS.editorTheme}
          layer={rowLayer("editorTheme")}
          control={<SelectInput value={appearance.editorTheme} options={editorThemeChoices()} disabled={busy} onChange={(editorTheme) => onChange({ editorTheme })} />}
        />
        <SettingsRow {...ROWS.smoothing} layer={rowLayer("smoothing")} control={<Switch on={appearance.smoothing} label={ROWS.smoothing.name} disabled={busy} onChange={(smoothing) => onChange({ smoothing })} />} />
        <SettingsRow {...ROWS.textPreview} full>
          <TextPreview />
        </SettingsRow>
      </SettingsSection>

      {/* A workspace of its own (a tree beside a stage beside a live Monaco), and a section the
          accordion lists, as the DOM's is. */}
      <SettingsSection id="file-types" title="File types" plain wide layer={rowLayer("renderers", "editors")}>
        {/* `components/files/FileTypesPane.tsx`: the workspace, its preview the real surface (a Monaco island for code). */}
        <FileTypesPane
          renderers={look.renderers}
          editorTheme={appearance.editorTheme}
          editors={look.editors}
          busy={busy}
          onRenderer={(edits) => void actions.setRenderer(edits, layer)}
          onEditor={(kind, patch) => void actions.setEditorLook(kind, patch, layer)}
        />
      </SettingsSection>
      {/* The look of the tree: what it leaves out (`FilesTree.tsx`, over `filesTreeModel.ts`). */}
      {state.config !== null ? (
        <FilesTreeSection
          view={state.config}
          layer={layer}
          project={state.at}
          busy={state.busy || !(layer !== "project" || state.at !== null)}
          onWrite={(into, doc) => void actions.saveTreeLayer(into, doc)}
        />
      ) : null}
    </>
  );
}

/** Light, dark or follow the system — each tile the current palette's board in that mode. */
function ModeTiles({ mode, palette, busy, onTheme }: { mode: ThemeMode; palette: Appearance["palette"]; busy: boolean; onTheme: (mode: ThemeMode) => void }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" gap={10} padding={12} role="group" aria-label="Mode">
      {MODES.map(([label, option]) => {
        const on = mode === option;
        return (
          <Press
            key={option}
            onPress={() => onTheme(option)}
            disabled={busy}
            {...({ "aria-pressed": on } as object)}
            flex={1}
            flexBasis={0}
            minWidth={0}
            gap={6}
            padding={7}
            borderRadius={12}
            {...(busy ? { opacity: 0.5 } : {})}
            box={({ hovered }) => ({
              ...edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, on ? "accent" : hovered && !busy ? "rule" : "line"),
              borderRadius: 12,
              backgroundColor: on ? t.mix(t.v("accent"), 5, t.v("panel")) : t.v("panel"),
              ...(on ? { boxShadow: `0 0 0 1px ${String(t.v("accent"))}` } : {}),
            })}
          >
            <ThemeMini palette={palette} theme={option} height={70} borderRadius={8} {...edge(t, { top: 1, right: 1, bottom: 1, left: 1 })} />
            <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 500, color: on ? "text" : "dim" }} textAlign="center">
              {label}
            </Txt>
          </Press>
        );
      })}
    </View>
  );
}

/** The palettes as cards, each a miniature of the task board in its own colours. */
function ThemeCards({ palette, mode, busy, onPick }: { palette: Appearance["palette"]; mode: ThemeMode; busy: boolean; onPick: (palette: Appearance["palette"]) => void }): JSX.Element {
  const t = useTokens();
  // `repeat(auto-fill, minmax(196px, 1fr))` over the grid's width inside its padding.
  const [width, setWidth] = useState(0);
  const per = Math.max(1, Math.floor((width + 10) / (196 + 10)));
  const rows: Appearance["palette"][][] = [];
  PALETTES.forEach((option, i) => (i % per === 0 ? rows.push([option]) : rows[rows.length - 1]!.push(option)));
  const cellWidth = per > 0 ? (width - 10 * (per - 1)) / per : 0;
  return (
    <View padding={12} gap={10} role="group" aria-label="Theme" onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width - 24)}>
      {width > 0
        ? rows.map((row, r) => (
            <View key={r} flexDirection="row" gap={10} alignItems="stretch">
              {row.map((option) => {
                const card = PALETTE_CARDS[option];
                const on = option === palette;
                return (
                  <Press
                    key={option}
                    onPress={() => onPick(option)}
                    disabled={busy}
                    {...({ "aria-pressed": on } as object)}
                    // The chosen card's ✓ is placed against it (`.theme-card` is `position: relative`).
                    position="relative"
                    width={cellWidth}
                    borderRadius={12}
                    overflow="hidden"
                    {...(busy ? { opacity: 0.5 } : {})}
                    box={({ hovered }) => ({
                      ...edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, on ? "accent" : hovered && !busy ? "rule" : "line"),
                      borderRadius: 12,
                      overflow: "hidden",
                      backgroundColor: t.v("panel"),
                      ...(on ? { boxShadow: `0 0 0 1px ${String(t.v("accent"))}` } : {}),
                    })}
                  >
                    <ThemeMini palette={option} theme={mode} height={96} {...edge(t, { bottom: 1 })} />
                    <View gap={2} paddingTop={8} paddingHorizontal={10} paddingBottom={10}>
                      <View flexDirection="row" alignItems="center" gap={6}>
                        <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600 }}>{card.label}</Txt>
                        {option === PALETTES[0] ? (
                          <View paddingVertical={2} paddingHorizontal={5} borderRadius={4} backgroundColor={t.v("panel-3") as never}>
                            <Txt spec={{ voice: "app", scale: 0.68, weight: 700, lineHeight: 1, ls: 0.08, upper: true, color: "dim" }}>default</Txt>
                          </View>
                        ) : null}
                      </View>
                      {/* The line as the stylesheet writes it (unitless) on web: Blink snaps its product to 1/64. */}
                      <Txt spec={{ voice: "app", scale: 0.92, lineHeight: 1.4, color: "dim" }} {...(isWeb ? { lineHeight: "1.4" } : {})}>
                        {card.note}
                      </Txt>
                    </View>
                    {on ? (
                      <View
                        position="absolute"
                        top={7}
                        right={7}
                        zIndex={1}
                        width={18}
                        height={18}
                        borderRadius={9}
                        alignItems="center"
                        justifyContent="center"
                        backgroundColor={t.v("fill-accent") as never}
                        {...({ boxShadow: "0 1px 3px rgba(0, 0, 0, 0.25)" } as object)}
                      >
                        <Txt spec={{ voice: "app", scale: 0.84, weight: 800, color: "on-accent" }} textAlign="center">
                          ✓
                        </Txt>
                      </View>
                    ) : null}
                  </Press>
                );
              })}
            </View>
          ))
        : null}
    </View>
  );
}

/**
 * What tasks look like — the board's own `Column` and tile chrome (`tileChromeOf`), not a picture of
 * them, so the window's palette and the three board options reach it as they reach the Tasks view. What
 * the tiles say is `appearanceModel.ts`'s `TASK_PREVIEW`, as the DOM's is. The rules:
 *
 *   .set-preview         10 under the words, 1px --line, radius 10, clipped, --bg, takes no pointer
 *   .task-preview .board-body   padding 10; `.columns` a row, gap 10, stretched
 *   .task-preview .column       equal shares of the row (`flex: 1 1 0`), no most
 */
function TaskPreview(): JSX.Element {
  const t = useTokens();
  const look = useLook();
  return (
    <View marginTop={10} borderRadius={10} overflow="hidden" backgroundColor={t.v("bg") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)} pointerEvents="none" aria-hidden>
      {/* `.board-body`, with Blueprint's graph paper as the board's (`Board.tsx`). */}
      <View padding={10} overflow="hidden" flexDirection="row" gap={10} alignItems="stretch" {...((look.palette !== "blueprint" ? {} : isWeb ? graphPaperWeb(t) : { position: "relative" }) as object)}>
        {look.palette === "blueprint" && !isWeb ? <GraphPaper t={t} /> : null}
        {TASK_PREVIEW.map((column, index) => (
          // The column's own box is `flex: 1 0 210px` at most 320; here it takes an equal share.
          <View key={column.name} flex={1} flexBasis={0} minWidth={0} flexDirection="row" alignItems="stretch">
            <Column t={t} look={look} index={index} name={column.name} seq={column.seq} count={column.tiles.length} empty="—">
              {() => column.tiles.map((tile, i) => <PreviewTile key={tile.title} tile={tile} last={i === column.tiles.length - 1} />)}
            </Column>
          </View>
        ))}
      </View>
    </View>
  );
}

/** `board.tsx`'s `Tile`, as the preview draws it: its title and pill, where it stands and its far end. */
function PreviewTile({ tile, last }: { tile: (typeof TASK_PREVIEW)[number]["tiles"][number]; last: boolean }): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const selected = tile.selected === true;
  const pill = pillKindOf(tile.status as TaskStatus | InstanceStatus);
  const { wash, ground, ring, radius, below } = tileChromeOf(t, look, { pill, selected, last, inTray: false });
  // The data voice at a factor of --size-data, line-height 1.5 as the body sets it (as `TaskCard`'s).
  const line = (factor: number): object => ({
    fontFamily: t.v("font-data"),
    fontSize: t.scaled("size-data", factor),
    lineHeight: isWeb ? "1.5" : Number(t.scaled("size-data", factor)) * 1.5,
  });
  const oneLine = isWeb ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : { numberOfLines: 1, ellipsizeMode: "tail" };
  return (
    <View
      position="relative"
      backgroundColor={ground as never}
      {...((ring !== undefined ? { boxShadow: ring } : {}) as object)}
      borderRadius={radius as never}
      paddingTop={7}
      paddingRight={9}
      paddingBottom={6}
      paddingLeft={9}
      marginBottom={below}
    >
      <View flexDirection="row" alignItems="center" gap={6}>
        <Text
          {...(line(0.96) as object)}
          {...(oneLine as object)}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          minWidth={0}
          {...({ letterSpacing: isWeb ? "-0.01em" : Number(t.scaled("size-data", 0.96)) * -0.01 } as object)}
          fontWeight={selected ? "600" : "400"}
          color={(wash === "success" ? t.v("dim") : t.v("text")) as never}
        >
          {tile.title}
        </Text>
        {pill !== null ? <Pill kind={pill} word={PILL_WORD[pill]} title={tile.status} /> : null}
      </View>
      <View flexDirection="row" alignItems="center" gap={6} marginTop={2} overflow="hidden">
        <Text {...(line(0.84) as object)} {...(oneLine as object)} color={t.v("dim") as never} flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0}>
          {tile.meta}
        </Text>
        {tile.far !== undefined ? (
          <Text {...(line(0.84) as object)} {...((isWeb ? { whiteSpace: "nowrap" } : {}) as object)} color={t.v("dim") as never} flexShrink={0}>
            {tile.far}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The work summary's preview (`workPreview.tsx`'s `WorkPreview`): one request's work, three times, each
 * drawn by the transcript itself under the settings being chosen. The moments are
 * `workPreviewModel.ts`'s, as the DOM's are. The rules:
 *
 *   .ws-preview          a `.set-preview` that takes the pointer: a column, gap 12, padding 12
 *   .ws-preview-card     clipped, 1px --line, radius 10, --panel
 *   .ws-preview-head     row, centred, gap 8, at least 30 tall, padding 0 12, a --line under, --panel-2,
 *                        app 600 11.5/12.5 --text; its note pushed right, 400, --dim
 *   .ws-preview-dot      7 round, --accent in a 3px ring of --accent 18% (done: --ok, no ring)
 *   .ws-preview-card > .ts   padding 8 12 10
 */
function WorkPreview({ look }: { look: WorkLook }): JSX.Element {
  const t = useTokens();
  // Timed once, when the preview opens, so the "so far" clocks read as they would in a live turn.
  const [now] = useState(() => Date.now());
  const states = useMemo(() => workPreviewStates(now), [now]);
  const head = { voice: "app", scale: 11.5 / 12.5, weight: 600 } as const;
  return (
    <WorkLookContext.Provider value={look}>
      <View marginTop={10} gap={12} padding={12} overflow="hidden" borderRadius={10} backgroundColor={t.v("bg") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
        {states.map((state, i) => {
          const done = state.label === "Finished";
          return (
            <View key={i} minWidth={0} overflow="hidden" borderRadius={10} backgroundColor={t.v("panel") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
              <View flexDirection="row" alignItems="center" gap={8} minHeight={30} paddingHorizontal={12} backgroundColor={t.v("panel-2") as never} {...(edge(t, { bottom: 1 }) as object)}>
                <View
                  width={7}
                  height={7}
                  borderRadius={999}
                  flexShrink={0}
                  backgroundColor={t.v(done ? "ok" : "accent") as never}
                  {...(done ? {} : ({ boxShadow: `0 0 0 3px ${t.mix(t.v("accent"), 18, "transparent")}` } as object))}
                />
                <Txt spec={head}>{state.label}</Txt>
                <Txt spec={{ ...head, weight: 400, color: "dim" }} marginLeft="auto">
                  {state.note}
                </Txt>
              </View>
              {/* The preview's card holds the transcript at 8 12 10 (its own is 12 16 22). */}
              <Transcript session={null} entries={state.entries} working={state.working} padding={[8, 12, 10, 12]} />
            </View>
          );
        })}
      </View>
    </WorkLookContext.Provider>
  );
}

/** A font row's words: its sentence, and the stack the stylesheet receives (`Resolved`) — one line, cut. */
function FontWords({ words, families, voice, fallback }: { words: string; families: readonly string[]; voice: "app" | "data"; fallback: string }): JSX.Element {
  return (
    <>
      <Txt spec={{ voice: "app", scale: 1.03, lineHeight: 1.45, color: "dim" }}>{words}</Txt>
      <Txt register="data-faint" spec={{ lineHeight: 1.45 }} ellip marginTop={2}>
        → {stackOf(shownFamilies(families, voice), fallback) ?? fallback}
      </Txt>
    </>
  );
}

/**
 * The Text section's preview: a file surface beside a task row (`appearancePane.tsx`'s `Preview`).
 *
 *   .ap-preview          1px --line, radius --card-radius, clipped, 10 under the row's words
 *   .ap-preview-band     app-label on --panel-3, a --line under, padding 5 9
 *   .ap-preview-files    column, flex 1, start, gap 3, padding 7 9, --panel-2; its runs one line each
 *   .ap-preview-task     the same on --bg
 */
function TextPreview(): JSX.Element {
  const t = useTokens();
  const pane = { flex: 1, flexBasis: 0, minWidth: 0, alignItems: "flex-start", gap: 3, paddingVertical: 7, paddingHorizontal: 9, overflow: "hidden" } as const;
  return (
    <View marginTop={10} borderRadius={lengthToken(t, "card-radius", 10)} overflow="hidden" {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
      <View backgroundColor={t.v("panel-3") as never} paddingVertical={5} paddingHorizontal={9} {...(edge(t, { bottom: 1 }) as object)}>
        <Txt register="app-label">{TEXT_PREVIEW.band}</Txt>
      </View>
      <View flexDirection="row">
        <View {...pane} backgroundColor={t.v("panel-2") as never}>
          <Txt register="data-title" ellip maxWidth="100%">
            {TEXT_PREVIEW.file.title}
          </Txt>
          <Txt register="data-text" ellip maxWidth="100%">
            {TEXT_PREVIEW.file.path}
          </Txt>
          <Txt register="data-secondary" ellip maxWidth="100%">
            {TEXT_PREVIEW.file.size}
          </Txt>
        </View>
        <View {...pane} backgroundColor={t.v("bg") as never}>
          <Txt register="data-text" ellip maxWidth="100%">
            {TEXT_PREVIEW.task.title}
          </Txt>
          <Pill kind="running" word={TEXT_PREVIEW.task.word} />
          <Txt register="data-secondary" ellip maxWidth="100%">
            {TEXT_PREVIEW.task.meta}
          </Txt>
        </View>
      </View>
    </View>
  );
}

/**
 * Two elements of one fan-out, in the conversation's own sheet, laid out as chosen
 * (`appearancePane.tsx`'s `ConversationPreview`). The rules, from `styles.css`:
 *
 *   .convo-preview       a `.set-preview` (1px --line, radius 10, --bg, 10 under the words), column,
 *                        gap 10, padding 12
 *   .sb-columns          side by side: equal columns, top-aligned, gap 12
 *   .sb-gutter           row, centred, gap 8, padding 0 4 4: the session (app 11/12.5, --dim, one line)
 *                        and the span (the same, tabular, pushed right, 8 before it)
 *   .sb-sheet            --panel, 1px --line, radius 12, 0 1 3 rgba(15, 20, 30, .06) — dark: 0 1 3 at
 *                        35% black; contrast: 1.5px --rule, a 3 3 0 --rule shadow, radius 4;
 *                        pastel(-rail): radius 16 (as `RunTranscript.tsx`'s `sheetLookOf`)
 *   .sb-body             padding 13 15 15; the message 10 above, 14 below; its markdown at 13.5/12.5,
 *                        line 1.65, padding 2 2 12
 */
function ConversationPreview({ layout }: { layout: "stacked" | "band" }): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const contrast = look.palette === "contrast";
  const sheet = {
    radius: contrast ? 4 : look.palette === "pastel" || look.palette === "pastel-rail" ? 16 : 12,
    width: contrast ? 1.5 : 1,
    edge: contrast ? "rule" : "line",
    shadow: contrast ? `3px 3px 0px ${String(t.v("rule"))}` : look.scheme === "dark" ? "0px 1px 3px rgba(0, 0, 0, 0.35)" : "0px 1px 3px rgba(15, 20, 30, 0.06)",
  };
  const panel = ({ session, file, text }: (typeof BATCH_PREVIEW)[number], grow: boolean): JSX.Element => (
    <View key={file} minWidth={0} {...(grow ? { flex: 1, flexBasis: 0 } : {})}>
      <View flexDirection="row" alignItems="center" gap={8} minWidth={0} paddingHorizontal={4} paddingBottom={4}>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} ellip minWidth={0} flexShrink={1}>
          {session}
        </Txt>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim", tabular: true }} ellip flexShrink={0} marginLeft="auto" paddingLeft={8}>
          each · {file}
        </Txt>
      </View>
      <View
        minWidth={0}
        overflow="hidden"
        borderRadius={sheet.radius}
        backgroundColor={t.v("panel") as never}
        {...(edge(t, { top: sheet.width, right: sheet.width, bottom: sheet.width, left: sheet.width }, sheet.edge) as object)}
        {...({ boxShadow: sheet.shadow } as object)}
      >
        <View paddingTop={13} paddingHorizontal={15} paddingBottom={15}>
          <View marginTop={10} marginBottom={14} minWidth={0}>
            <Markdown text={text} scale={13.5 / 12.5} lineHeight={1.65} trimEnd />
          </View>
        </View>
      </View>
    </View>
  );
  return (
    <View
      marginTop={10}
      gap={10}
      padding={12}
      overflow="hidden"
      borderRadius={10}
      backgroundColor={t.v("bg") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
      pointerEvents="none"
      aria-hidden
    >
      {layout === "band" ? (
        <View flexDirection="row" alignItems="flex-start" gap={12} minWidth={0}>
          {panel(BATCH_PREVIEW[0], true)}
          {panel(BATCH_PREVIEW[1], true)}
        </View>
      ) : (
        <>
          {panel(BATCH_PREVIEW[0], false)}
          {panel(BATCH_PREVIEW[1], false)}
        </>
      )}
    </View>
  );
}
