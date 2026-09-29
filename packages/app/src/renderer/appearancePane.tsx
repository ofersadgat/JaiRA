/**
 * Settings → Appearance: how JaiRA looks (SHELL.md §6) — a LAYERED page since 2026-09-23, like every
 * other: the look is the `appearance` block of the settings, stated by the shared root, a project, or
 * "Just you" over both. Every control shows the look in effect and changes it; a ↺ beside a row the
 * page's layer states takes that out again (the person's rule, 2026-09-25 — no on/off switch).
 *
 * Built from `settingsLayout.tsx` — the row-and-card shape the person picked from t3code on
 * 2026-09-23 — as six sections, each one a place the sidebar's accordion can jump to, and the Files
 * tree after them (the caller's):
 *
 *  - **Mode** — light, dark, or follow the system, as three tiles drawn in the current theme.
 *  - **Theme** — the palettes as cards, each a miniature task board in its own colours
 *    (`paletteCards.tsx`), so a person chooses by looking rather than by name.
 *  - **Board** — lane colours, columns as box or line, status wash; and a PREVIEW of real board
 *    components under them, in whatever the window is now painted in, which follows each switch.
 *  - **Conversation** — how a fan-out batch that ran one element after another is laid out, with a
 *    preview of the choice. It was a tab of its own holding this one setting; it is a way things
 *    LOOK, so it lives with the rest of them.
 *  - **Text** — the two voices' faces and sizes, the editor's own size and smoothing, and the preview
 *    both voices sit side by side in.
 *  - **File types** — what opens a file and what that thing looks like, the workspace it always was.
 *
 * Three decisions from the typography screen this grew out of still stand, and are why the font rows
 * are what they are:
 *
 *  - **The family control is a multi-select, not a text field.** A font stack is an ORDERED LIST —
 *    the second family is what renders a glyph the first lacks — so the chips are numbered and sit in
 *    one box in the order they are tried, and the default stack is the last line of the menu.
 *  - **The preview is a real surface**, built from the same components and register classes as the
 *    shell. A sample string cannot show that a data font is wider than the column.
 *  - **The proportional check is a NOTE, not a block.** It is their app.
 */
import { useMemo, useState, type JSX, type ReactNode } from "react";
import {
  PALETTES,
  SIZE_LIMITS,
  surfaceOf,
  type Appearance,
  type BucketStyle,
  type ConversationLook,
  type EditorKind,
  type EditorLook,
  type JairaTheme,
  type RendererChoices,
  type RendererEdit,
  type SequentialBatchLayout,
  type UsageFigures,
  type ThemeMode,
  type WorkNotes,
  type WorkRows,
} from "@jaira/shared/browser";
import { FileTypesPane } from "./fileTypesPane";
import { Popover, usePopover } from "./popover";
import { SizeStep } from "./editorKnobs";
import {
  DEFAULT_APP_STACK,
  DEFAULT_DATA_STACK,
  SHIPPED_APP_FAMILY,
  SHIPPED_DATA_FAMILY,
  isInstalled,
  isMonospace,
  shownFamilies,
  stackOf,
  useSystemDark,
} from "./appearance";
import { SelectInput, Switch } from "./controls";
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
  appearanceRowLayer,
  boardPreviewWords,
  editorThemeChoices,
  type AppearanceLayering,
} from "./appearanceModel";
import { Pill } from "./pill";
import { Column, Tile } from "./board";
import { PALETTE_CARDS, ThemeMini } from "./paletteCards";
import { Segmented, SettingsRow, SettingsSection } from "./settingsLayout";

export type { AppearanceLayering } from "./appearanceModel";
import { UsageFiguresPreview } from "./usageMeters";
import { WorkPreview } from "./workPreview";

/**
 * One voice's stack: numbered chips in one box, tried left to right.
 *
 * The numbers are the point — they say this is a list of ALTERNATIVES in order, which is the one
 * thing a comma-separated text box never manages to say. Horizontal rather than a column of rows,
 * because the reading is "this, then this, then ours", and a stack of full-width rows reads as three
 * separate settings.
 *
 * Two lists, and the difference between them is what makes this screen answerable. `families` is
 * what a PERSON has chosen, which is what every edit writes and which is empty for almost everybody.
 * `ours` is the face JaiRA ships and is currently rendering (see `shownFamilies`), and with nothing
 * chosen it is drawn as the stack — marked as ours, and with no ✕, because there is no choice there
 * to take back. An empty box was the alternative, and an empty box under a heading called "App text"
 * cannot say what the app is set in.
 */
function FamilyStack({
  families,
  ours,
  fallback,
  suggested,
  voice,
  warn,
  disabled,
  onChange,
}: {
  families: readonly string[];
  /** The shipped face, shown when nothing is chosen — `SHIPPED_APP_FAMILY` and its data twin. */
  ours: string;
  fallback: string;
  suggested: readonly string[];
  /** Which voice's register the chips are SET in — the only honest preview of a font is the font. */
  voice: "app" | "data";
  /** Which chosen families failed a check, and what to say about each. */
  warn?: (family: string) => string | undefined;
  disabled?: boolean;
  onChange: (families: string[]) => void;
}): JSX.Element {
  // A click anywhere else closes it. The menu is a transient choice, not a mode, and leaving it open
  // over the field below is what makes a popover feel stuck.
  const pop = usePopover();
  const { open, setOpen } = pop;

  // Always against the CHOSEN list, never against what is shown: adding the first family has to
  // produce a stack of one, not a stack of ours plus theirs.
  const toggle = (family: string): void => {
    onChange(families.includes(family) ? families.filter((f) => f !== family) : [...families, family]);
  };
  const shown = shownFamilies(families, voice);
  const chosen = families.length > 0;
  return (
    <div className="face-box" ref={pop.anchor}>
      <div className={`face-stack${open ? " open" : ""}`}>
        {shown.map((family, i) => {
          const note = warn?.(family);
          return (
            <span
              key={family}
              className={`face-chip${note !== undefined ? " warn" : ""}${chosen ? "" : " is-ours"}`}
              title={note ?? (chosen ? undefined : "JaiRA's own — choosing a family replaces it")}
            >
              <span className="face-n data-num">{i + 1}</span>
              <span className={`face-name ${voice === "app" ? "app-text" : "data-text"}`} style={{ fontFamily: `"${family}", ${fallback}` }}>
                {family}
              </span>
              {chosen ? (
                <button className="face-drop" title={`remove ${family}`} disabled={disabled} onClick={() => toggle(family)}>
                  ✕
                </button>
              ) : (
                <span className="face-ours app-secondary">ours</span>
              )}
            </span>
          );
        })}
        <button className="face-add app-secondary" disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}>
          + add…
        </button>
      </div>
      {/* It OVERLAYS what is below rather than pushing it down: a menu that reflows the page moves the
          control you opened it from out from under the pointer. */}
      {open ? (
        <Popover at={pop} side="below" align="start" gap={3} matchWidth className="face-menu">
          <FaceMenu families={families} ours={ours} fallback={fallback} suggested={suggested} voice={voice} onToggle={toggle} />
        </Popover>
      ) : null}
    </div>
  );
}

/**
 * What can go in the box, and the line that says what is always after it.
 *
 * The last row is the default stack, stated and un-removable — "prepend, never replace" as something
 * you can see rather than a rule you have to know.
 */
function FaceMenu({
  families,
  ours,
  fallback,
  suggested,
  voice,
  onToggle,
}: {
  families: readonly string[];
  /** The shipped face — ticked as no row is, because it is on without having been chosen. */
  ours: string;
  fallback: string;
  suggested: readonly string[];
  voice: "app" | "data";
  onToggle: (family: string) => void;
}): JSX.Element {
  const [typed, setTyped] = useState("");
  // Measured once per open: the answer changes when a font is installed, which is not a thing that
  // happens while a menu is on screen.
  const here = useMemo(() => new Set(suggested.filter((f) => isInstalled(f))), [suggested]);
  // What is CHOSEN heads the list, in stack order, and the rest of the offer follows. A menu whose
  // ticked rows are scattered through it makes you read all of it to find out what is on. Anything
  // already chosen belongs here whether or not it was ever suggested, or dropping a typed-in family
  // would leave no way to put it back.
  const rows = [...new Set([...families, ...suggested])];
  const add = (): void => {
    const clean = typed.trim();
    if (clean.length > 0 && !families.includes(clean)) onToggle(clean);
    setTyped("");
  };
  return (
    <>
      {/* What the list IS, which is not what it was called: these are the faces worth offering by
          name, and whether each one is on this machine is said on the row itself. A head that read
          "installed" over rows saying "not on this machine" was the menu contradicting itself. */}
      <div className="face-menu-head app-label">{voice === "app" ? "sans" : "mono"} faces</div>
      <div className="face-menu-list">
        {rows.map((family) => (
          <button
            key={family}
            className={`face-menu-row${families.includes(family) ? " on" : ""}`}
            onClick={() => onToggle(family)}
          >
            <span className="face-tick">{families.includes(family) ? "✓" : ""}</span>
            <span
              className={`face-menu-name ellip ${voice === "app" ? "app-text" : "data-text"}`}
              style={{ fontFamily: `"${family}", ${fallback}` }}
            >
              {family}
            </span>
            {/* Absent rather than "missing": a face that is not here still resolves through the
                stack, so the honest report is that this row will not change anything, not that it is
                broken. `ours` says the opposite — that row is what is rendering right now. */}
            {family === ours && families.length === 0 ? (
              <span className="face-elsewhere app-secondary">ours, in use</span>
            ) : here.has(family) ? null : (
              <span className="face-elsewhere app-secondary">not on this machine</span>
            )}
          </button>
        ))}
      </div>
      <div className="face-menu-sep" />
      <div className="face-menu-row">
        <span className="face-tick" />
        <input
          className="cfg-input"
          value={typed}
          placeholder="another family…"
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => (e.key === "Enter" ? add() : undefined)}
          onBlur={add}
        />
      </div>
      {/* OUTSIDE the scrolling list, so it cannot be scrolled away. It is the line that makes
          "prepend, never replace" visible, and a rule you have to scroll to find is a rule you have
          to be told. */}
      <div className="face-menu-sep" />
      <div className="face-menu-row is-note" title={fallback}>
        <span className="face-tick" />
        <span className="app-secondary">always ends with the default stack</span>
      </div>
    </>
  );
}

/**
 * The preview: a file surface beside a task row.
 *
 * Real register classes and the real {@link Pill}, not a sample string — a sample cannot show you
 * that your data font is too wide for the column it has to sit in. It is also the one place in the
 * app where both voices are guaranteed adjacent, which is where a mismatch between them is visible.
 */
function Preview(): JSX.Element {
  return (
    <div className="ap-preview">
      <div className="ap-preview-band app-label">{TEXT_PREVIEW.band}</div>
      <div className="ap-preview-panes">
        <div className="ap-preview-files">
          <span className="data-title">{TEXT_PREVIEW.file.title}</span>
          <span className="data-text">{TEXT_PREVIEW.file.path}</span>
          <span className="data-secondary">{TEXT_PREVIEW.file.size}</span>
        </div>
        <div className="ap-preview-task">
          <span className="data-text">{TEXT_PREVIEW.task.title}</span>
          <Pill kind="running" word={TEXT_PREVIEW.task.word} />
          <span className="data-secondary">{TEXT_PREVIEW.task.meta}</span>
        </div>
      </div>
    </div>
  );
}

const noop = (): void => undefined;

/** Light, dark or follow the system — each tile the current palette's board in that mode. */
function ModeTiles({ mode, palette, busy, onTheme }: { mode: ThemeMode; palette: Appearance["palette"]; busy: boolean; onTheme: (mode: ThemeMode) => void }): JSX.Element {
  return (
    <div className="mode-tiles" role="group" aria-label="Mode">
      {MODES.map(([label, option]) => (
        <button key={option} type="button" className="mode-tile" aria-pressed={mode === option} disabled={busy} onClick={() => onTheme(option)}>
          <ThemeMini palette={palette} theme={option} />
          <span className="mode-tile-name">{label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The palettes as cards, each a miniature of the task board in its own colours — drawn in the mode
 * the person chose, so on `system` every card is split light | dark.
 */
function ThemeCards({ palette, mode, busy, onPick }: { palette: Appearance["palette"]; mode: ThemeMode; busy: boolean; onPick: (palette: Appearance["palette"]) => void }): JSX.Element {
  return (
    <div className="theme-grid" role="group" aria-label="Theme">
      {PALETTES.map((option) => {
        const card = PALETTE_CARDS[option];
        const on = option === palette;
        return (
          <button key={option} type="button" className="theme-card" aria-pressed={on} disabled={busy} onClick={() => onPick(option)}>
            {on ? (
              <span className="theme-check" aria-hidden="true">
                ✓
              </span>
            ) : null}
            <ThemeMini palette={option} theme={mode} />
            <span className="theme-meta">
              <span className="theme-name">
                {card.label}
                {option === PALETTES[0] ? <span className="theme-tag">default</span> : null}
              </span>
              <span className="theme-desc">{card.note}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * What tasks look like — the board's own `Column` and `Tile`, not a picture of them, so the window's
 * palette and all three board options reach it exactly as they reach the Tasks view.
 */
function TaskPreview(): JSX.Element {
  // What the tiles say is `appearanceModel.ts`'s, shared with the universal copy (decision 0015).
  return (
    <div className="set-preview task-preview" aria-hidden="true">
      <div className="board-body">
        <div className="columns">
          {TASK_PREVIEW.map((column) => (
            <Column key={column.name} name={column.name} seq={column.seq} count={column.tiles.length} empty="—">
              {column.tiles.map((tile) => (
                <Tile
                  key={tile.title}
                  status={tile.status}
                  title={tile.title}
                  {...(tile.selected === true ? { selected: true } : {})}
                  onSelect={noop}
                  meta={
                    tile.far !== undefined ? (
                      <>
                        <span className="ellip">{tile.meta}</span>
                        <span className="card-status">{tile.far}</span>
                      </>
                    ) : (
                      <span className="ellip">{tile.meta}</span>
                    )
                  }
                />
              ))}
            </Column>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Two elements of one fan-out, in the conversation's own sheet markup, laid out as chosen. */
function ConversationPreview({ layout }: { layout: SequentialBatchLayout }): JSX.Element {
  const panel = ({ session, file, text }: (typeof BATCH_PREVIEW)[number]): JSX.Element => (
    <div className="sb-panel" key={file}>
      <div className="sb-gutter">
        <span className="sb-session mono ellip">{session}</span>
        <span className="sb-span ellip">each · {file}</span>
      </div>
      <section className="sb-sheet">
        <div className="sb-body">
          <div className="ts-msg ts-msg-assistant">
            <div className="markdown">
              <p>{text}</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
  const first = panel(BATCH_PREVIEW[0]);
  const second = panel(BATCH_PREVIEW[1]);
  return (
    <div className="set-preview convo-preview" aria-hidden="true">
      {layout === "band" ? (
        <div className="sb-band concurrent columns">
          <div className="sb-columns">
            {first}
            {second}
          </div>
        </div>
      ) : (
        <>
          <div className="sb-band">{first}</div>
          <div className="sb-band">{second}</div>
        </>
      )}
    </div>
  );
}

/**
 * Settings → Appearance, as the sections of its page (the page itself — its title, whose settings
 * these are, the layer switch — is the caller's, like every other page's).
 *
 * Every value here is the EFFECTIVE look of the address the window stands on, and every change is
 * written to the layer the page's switch shows. With `layered`, each row — the Mode tiles, the Theme
 * cards, the Board options, the Conversation layout, the Text rows, File types — has the switch every
 * layered row has: on, this layer states it and the control edits it; off, the control shows what it
 * inherits and cannot be changed. The controls themselves are what they were.
 *
 * `children` are the sections after File types — the Files tree, which is a look of the tree.
 */
export function AppearancePane({
  appearance,
  theme,
  conversation,
  editors,
  renderers,
  busy,
  layered,
  onChange,
  onTheme,
  onConversation,
  onEditor,
  onRenderer,
  children,
}: {
  appearance: Appearance;
  /** Light, dark or system — the window's mode, which lives beside the palette it paints. */
  theme: ThemeMode;
  /** How a run's conversation is laid out — see {@link ConversationLook}. */
  conversation: ConversationLook;
  /**
   * How each editing surface looks, and the renderer choices — both optional TOGETHER with their
   * callbacks, which is how a caller with no store behind it draws this pane without File types.
   */
  editors?: Record<EditorKind, EditorLook> | undefined;
  renderers?: RendererChoices | undefined;
  busy: boolean;
  layered?: AppearanceLayering | undefined;
  onChange: (patch: Partial<Appearance>) => void;
  onTheme: (mode: ThemeMode) => void;
  onConversation: (patch: Partial<ConversationLook>) => void;
  onEditor?: ((kind: EditorKind, patch: Partial<EditorLook>) => void) | undefined;
  onRenderer?: ((edits: readonly RendererEdit[]) => void) | undefined;
  children?: ReactNode;
}): JSX.Element {
  // Measured once per stack rather than per render: reading a canvas metric is cheap but not free,
  // and the answer only changes when the list does.
  const proportional = useMemo(() => {
    const ctx = document.createElement("canvas").getContext("2d");
    return new Set(appearance.dataFamily.filter((f) => !isMonospace(f, ctx)));
  }, [appearance.dataFamily]);
  const systemDark = useSystemDark();
  const shown: JairaTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  const surface = surfaceOf(appearance);
  // One row's place in the layers, from the `appearance.*` fields it writes.
  const layer = (...fields: string[]) => appearanceRowLayer(layered, ...fields);

  return (
    <>
      <SettingsSection id="mode" title="Mode" layer={layer("mode")}>
        <ModeTiles mode={theme} palette={appearance.palette} busy={busy} onTheme={onTheme} />
      </SettingsSection>

      <SettingsSection id="theme" title="Theme" layer={layer("palette")}>
        {/* Choosing a palette puts the board options back to what it was designed with, so it arrives
            looking the way it was picked. */}
        <ThemeCards
          palette={appearance.palette}
          mode={theme}
          busy={busy}
          onPick={(palette) => onChange({ palette, laneColors: null, buckets: null, statusWash: null })}
        />
      </SettingsSection>

      <SettingsSection id="board" title="Board">
        <SettingsRow
          {...ROWS.laneColors}
          layer={layer("laneColors")}
          control={<Switch on={surface.laneColors} label={ROWS.laneColors.name} disabled={busy} onChange={(laneColors) => onChange({ laneColors })} />}
        />
        <SettingsRow
          {...ROWS.buckets}
          layer={layer("buckets")}
          control={<Segmented label={ROWS.buckets.name} value={surface.buckets} options={BUCKET_CHOICES} disabled={busy} onChange={(buckets) => onChange({ buckets })} />}
        />
        <SettingsRow
          {...ROWS.statusWash}
          layer={layer("statusWash")}
          control={<Switch on={surface.statusWash} label={ROWS.statusWash.name} disabled={busy} onChange={(statusWash) => onChange({ statusWash })} />}
        />
        <SettingsRow {...boardPreviewWords(appearance.palette)} full>
          <TaskPreview />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="conversation" title="Conversation">
        <SettingsRow
          {...ROWS.sequentialBatches}
          layer={layer("conversation.sequentialBatches")}
          control={
            <Segmented
              label={ROWS.sequentialBatches.name}
              value={conversation.sequentialBatches}
              options={BATCH_CHOICES}
              disabled={busy}
              onChange={(sequentialBatches) => onConversation({ sequentialBatches })}
            />
          }
        />
        <SettingsRow {...ROWS.batchPreview} full>
          <ConversationPreview layout={conversation.sequentialBatches} />
        </SettingsRow>
        <SettingsRow
          {...ROWS.usageFigures}
          layer={layer("conversation.usageFigures")}
          control={
            <Segmented
              label={ROWS.usageFigures.name}
              value={conversation.usageFigures}
              options={USAGE_CHOICES}
              disabled={busy}
              onChange={(usageFigures) => onConversation({ usageFigures })}
            />
          }
        />
        <SettingsRow {...ROWS.usagePreview} full>
          <UsageFiguresPreview mode={conversation.usageFigures} />
        </SettingsRow>
        <SettingsRow
          {...ROWS.workPhases}
          layer={layer("conversation.workPhases")}
          control={<Switch on={conversation.workPhases} label={ROWS.workPhases.name} disabled={busy} onChange={(workPhases) => onConversation({ workPhases })} />}
        />
        <SettingsRow
          {...ROWS.workRows}
          layer={layer("conversation.workRows")}
          control={
            <Segmented
              label={ROWS.workRows.name}
              value={`${conversation.workRows}`}
              options={WORK_ROW_CHOICES}
              disabled={busy}
              onChange={(rows) => onConversation({ workRows: Number(rows) as WorkRows })}
            />
          }
        />
        <SettingsRow
          {...ROWS.workThinking}
          layer={layer("conversation.workThinking")}
          control={<Switch on={conversation.workThinking} label={ROWS.workThinking.name} disabled={busy} onChange={(workThinking) => onConversation({ workThinking })} />}
        />
        <SettingsRow
          {...ROWS.workNotes}
          layer={layer("conversation.workNotes")}
          control={
            <SelectInput
              value={conversation.workNotes}
              options={WORK_NOTE_CHOICES}
              disabled={busy}
              onChange={(workNotes) => onConversation({ workNotes: workNotes as WorkNotes })}
            />
          }
        />
        <SettingsRow {...ROWS.workPreview} full>
          <WorkPreview look={{ phases: conversation.workPhases, rows: conversation.workRows, thinking: conversation.workThinking, notes: conversation.workNotes }} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="text" title="Text">
        <SettingsRow
          name={ROWS.appFont.name}
          description={
            <>
              {ROWS.appFont.description}
              <span className="set-stack data-faint">
                <Resolved families={appearance.appFamily} voice="app" fallback={DEFAULT_APP_STACK} />
              </span>
            </>
          }
          layer={layer("appFamily", "sizeApp")}
          control={
            <div className="set-font">
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
            </div>
          }
        />
        <SettingsRow
          name={ROWS.dataFont.name}
          description={
            <>
              {ROWS.dataFont.description}
              <span className="set-stack data-faint">
                <Resolved families={appearance.dataFamily} voice="data" fallback={DEFAULT_DATA_STACK} />
              </span>
            </>
          }
          layer={layer("dataFamily", "sizeData")}
          control={
            <div className="set-font">
              <FamilyStack
                families={appearance.dataFamily}
                ours={SHIPPED_DATA_FAMILY}
                fallback={DEFAULT_DATA_STACK}
                suggested={SUGGESTED_DATA}
                voice="data"
                disabled={busy}
                // OURS, and a note rather than a block (§6): two voices can be configured into one, and
                // a column of counts that no longer lines up is worth saying out loud. It is their app.
                warn={(family) => (proportional.has(family) ? "not monospaced — columns will not line up" : undefined)}
                onChange={(dataFamily) => onChange({ dataFamily })}
              />
              <SizeStep value={appearance.sizeData} limits={SIZE_LIMITS.sizeData} disabled={busy} onChange={(sizeData) => onChange({ sizeData })} />
            </div>
          }
        />
        <SettingsRow
          {...ROWS.editorSize}
          layer={layer("advanced", "sizeEditor")}
          control={
            <>
              {appearance.advanced ? (
                <SizeStep value={appearance.sizeEditor} limits={SIZE_LIMITS.sizeEditor} disabled={busy} onChange={(sizeEditor) => onChange({ sizeEditor })} />
              ) : (
                <span className="set-inherit">follows the data font</span>
              )}
              <Switch on={appearance.advanced} label="Separate editor size" disabled={busy} onChange={(advanced) => onChange({ advanced })} />
            </>
          }
        />
        <SettingsRow
          {...ROWS.editorTheme}
          layer={layer("editorTheme")}
          control={
            <SelectInput
              value={appearance.editorTheme}
              options={editorThemeChoices()}
              disabled={busy}
              onChange={(editorTheme) => onChange({ editorTheme })}
            />
          }
        />
        <SettingsRow
          {...ROWS.smoothing}
          layer={layer("smoothing")}
          control={<Switch on={appearance.smoothing} label={ROWS.smoothing.name} disabled={busy} onChange={(smoothing) => onChange({ smoothing })} />}
        />
        <SettingsRow {...ROWS.textPreview} full>
          <Preview />
        </SettingsRow>
      </SettingsSection>

      {renderers !== undefined && onRenderer !== undefined && editors !== undefined && onEditor !== undefined ? (
        // A workspace rather than a list of settings — a tree beside a stage beside a live editor — so
        // it takes the page's full width and draws its own surfaces instead of sitting in a card. One
        // setting as far as the layers go: what opens each type and how each editor looks.
        <SettingsSection id="file-types" title="File types" plain wide layer={layer("renderers", "editors")}>
          <FileTypesPane renderers={renderers} editorTheme={appearance.editorTheme} editors={editors} busy={busy} onRenderer={onRenderer} onEditor={onEditor} />
        </SettingsSection>
      ) : null}

      {children}
    </>
  );
}

/**
 * The stack as the stylesheet will receive it — the one line that proves what "prepend" did.
 *
 * Built from what is SHOWN rather than from what is stored, for the same reason the chips are: with
 * nothing chosen the property is removed and the stylesheet's own value stands, and that value
 * leads with the shipped face. Printing the bare fallback there stated a stack the window is not
 * set in, one line under a chip that had just named the face it is.
 */
function Resolved({
  families,
  voice,
  fallback,
}: {
  families: readonly string[];
  voice: "app" | "data";
  fallback: string;
}): JSX.Element {
  return <>→ {stackOf(shownFamilies(families, voice), fallback) ?? fallback}</>;
}
