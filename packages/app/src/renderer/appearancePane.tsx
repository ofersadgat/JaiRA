/**
 * Settings → Appearance: how JaiRA looks (SHELL.md §6) — a LAYERED page since 2026-09-23, like every
 * other: the look is the `appearance` block of the settings, stated by the shared root, a project, or
 * "Just you" over both, and each row has the switch that says whether the layer being edited states it.
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
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import {
  PALETTES,
  PALETTE_SURFACE,
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
} from "@jaira/shared/browser";
import { FileTypesPane } from "./fileTypesPane";
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
import { SelectInput, Switch, shortValue } from "./controls";
import { EDITOR_THEMES, EDITOR_THEME_APP } from "./editorThemes";
import { Pill } from "./pill";
import { Column, Tile } from "./board";
import { PALETTE_CARDS, ThemeMini } from "./paletteCards";
import { Segmented, SettingsRow, SettingsSection, type RowLayer } from "./settingsLayout";
import { UsageFiguresPreview } from "./usageMeters";

/**
 * Faces worth offering by name.
 *
 * A short list rather than an enumeration of what is installed: there is no way to enumerate system
 * fonts without a permission prompt, and the answer would be four hundred entries long in an order
 * nobody chose. What CAN be answered is whether a named one is here — measured, the same way the
 * proportional check is — so the menu says `installed` beside the ones that will actually render and
 * greys the rest rather than pretending the list is the machine's.
 *
 * Anything not here is typed in: the menu's last row takes a name, and the chip proves whether it
 * resolved, which is the same feedback a longer list would have given.
 */
const SUGGESTED_APP = ["DM Sans", "Inter", "Segoe UI", "Helvetica Neue", "IBM Plex Sans", "Roboto"];
const SUGGESTED_DATA = ["JetBrains Mono", "Cascadia Code", "SF Mono", "Fira Code", "IBM Plex Mono", "Consolas", "Menlo"];

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
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // A click anywhere else closes it. The menu is a transient choice, not a mode, and leaving it open
  // over the field below is what makes a popover feel stuck.
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  // Always against the CHOSEN list, never against what is shown: adding the first family has to
  // produce a stack of one, not a stack of ours plus theirs.
  const toggle = (family: string): void => {
    onChange(families.includes(family) ? families.filter((f) => f !== family) : [...families, family]);
  };
  const shown = shownFamilies(families, voice);
  const chosen = families.length > 0;
  return (
    <div className="face-box" ref={box}>
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
      {open ? (
        <FaceMenu families={families} ours={ours} fallback={fallback} suggested={suggested} voice={voice} onToggle={toggle} />
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
    <div className="face-menu">
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
    </div>
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
      <div className="ap-preview-band app-label">Files</div>
      <div className="ap-preview-panes">
        <div className="ap-preview-files">
          <span className="data-title">declarative-ai</span>
          <span className="data-text">prompts/review.md</span>
          <span className="data-secondary">4.2 kB</span>
        </div>
        <div className="ap-preview-task">
          <span className="data-text">tighten the sync lint</span>
          <Pill kind="running" word="running" />
          <span className="data-secondary">40s · 3 turns</span>
        </div>
      </div>
    </div>
  );
}

const noop = (): void => undefined;

const MODES: ReadonlyArray<readonly [label: string, mode: ThemeMode]> = [
  ["Light", "light"],
  ["Dark", "dark"],
  ["System", "system"],
];

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
  return (
    <div className="set-preview task-preview" aria-hidden="true">
      <div className="board-body">
        <div className="columns">
          <Column name="draft" seq={1} count={2} empty="—">
            <Tile status="running" title="Rewind a run" selected onSelect={noop} meta={<><span className="ellip">feature/ux/draft</span><span className="card-status">2 m</span></>} />
            <Tile status="completed" title="Ship each kinds" onSelect={noop} meta={<><span className="ellip">feature/ux/draft</span><span className="card-status">1 h ago</span></>} />
          </Column>
          <Column name="critique" seq={2} count={2} empty="—">
            <Tile status="waiting_for_user" title="Fork from any point" onSelect={noop} meta={<><span className="ellip">feature/ux/critique</span><span className="card-status">gate</span></>} />
            <Tile status="failed" title="Bridge race" onSelect={noop} meta={<><span className="ellip">exit 1</span><span className="card-status">6 m ago</span></>} />
          </Column>
          <Column name="verify" seq={3} count={1} empty="—">
            <Tile status="queued" title="Pause and stop" onSelect={noop} meta={<span className="ellip">queued</span>} />
          </Column>
        </div>
      </div>
    </div>
  );
}

/** Two elements of one fan-out, in the conversation's own sheet markup, laid out as chosen. */
function ConversationPreview({ layout }: { layout: SequentialBatchLayout }): JSX.Element {
  const panel = (file: string, text: string): JSX.Element => (
    <div className="sb-panel" key={file}>
      <div className="sb-gutter">
        <span className="sb-session mono ellip">reviewer</span>
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
  const first = panel("auth.ts", "The token is refreshed after it is read, so a request can go out with a stale one.");
  const second = panel("session.ts", "Nothing to change: the lock is taken before the session is written.");
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

const BUCKET_CHOICES: ReadonlyArray<readonly [string, BucketStyle]> = [
  ["Box", "box"],
  ["Line", "line"],
];

const USAGE_CHOICES: ReadonlyArray<readonly [string, UsageFigures]> = [
  ["Off", "off"],
  ["Number", "number"],
  ["Ring", "ring"],
  ["Both", "both"],
];

const BATCH_CHOICES: ReadonlyArray<readonly [string, SequentialBatchLayout]> = [
  ["One after another", "stacked"],
  ["Side by side", "band"],
];

/**
 * How the Appearance rows sit in the layers — handed in by the caller, which knows the layer being
 * edited and how to write it. Absent draws the rows as plain controls, with no switch.
 */
export interface AppearanceLayering {
  /** Whether the layer being edited states a path (`appearance.palette`, …). */
  stated: (path: string) => boolean;
  /** Switch rows on (pin what they show into the layer) or off (take them out, so they inherit). */
  pin: (paths: readonly string[], on: boolean) => void;
  /** Nothing on the page may be changed — a write in flight, or a layer that cannot be written. */
  locked: boolean;
}

/** A value of the look in the words its row uses — for the "instead of … from …" line. */
function lookWords(value: unknown, path: string): string {
  const field = path.replace(/^appearance\./, "");
  const own = "the palette's own";
  switch (field) {
    case "mode":
      return MODES.find(([, mode]) => mode === value)?.[0].toLowerCase() ?? shortValue(value, path);
    case "palette":
      return PALETTE_CARDS[value as Appearance["palette"]]?.label ?? shortValue(value, path);
    case "laneColors":
    case "statusWash":
      return value === null || value === undefined ? own : value === true ? "on" : "off";
    case "buckets":
      return value === null || value === undefined ? own : value === "line" ? "a line" : "a box";
    case "conversation.sequentialBatches":
      return BATCH_CHOICES.find(([, layout]) => layout === value)?.[0].toLowerCase() ?? shortValue(value, path);
    case "conversation.usageFigures":
      return USAGE_CHOICES.find(([, figures]) => figures === value)?.[0].toLowerCase() ?? shortValue(value, path);
    case "appFamily":
    case "dataFamily":
      return Array.isArray(value) && value.length > 0 ? value.join(", ") : "JaiRA's own face";
    case "sizeApp":
    case "sizeData":
    case "sizeEditor":
      return typeof value === "number" ? `${value} px` : shortValue(value, path);
    case "advanced":
      return value === true ? "a size of its own" : "following the data font";
    case "editorTheme":
      return value === EDITOR_THEME_APP ? "following the window" : (EDITOR_THEMES.find((theme) => theme.id === value)?.label ?? shortValue(value, path));
    default:
      return shortValue(value, path);
  }
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
  const own = PALETTE_SURFACE[appearance.palette];
  const card = PALETTE_CARDS[appearance.palette];
  const backTo = (what: string): string => `Back to ${card.label}'s own: ${what}`;
  // One row's place in the layers, from the `appearance.*` fields it writes.
  const layer = (...fields: string[]): RowLayer | undefined => {
    if (layered === undefined) return undefined;
    const paths = fields.map((field) => `appearance.${field}`);
    return {
      paths,
      on: paths.some((path) => layered.stated(path)),
      onChange: (on) => layered.pin(paths, on),
      disabled: layered.locked,
      format: lookWords,
    };
  };

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
          name="Lane colours"
          description="Tint each column its own colour, so a step of the workflow is recognisable at a glance."
          layer={layer("laneColors")}
          reset={appearance.laneColors !== null ? { label: backTo(own.laneColors ? "on" : "off"), onReset: () => onChange({ laneColors: null }), disabled: busy } : undefined}
          control={<Switch on={surface.laneColors} label="Lane colours" disabled={busy} onChange={(laneColors) => onChange({ laneColors })} />}
        />
        <SettingsRow
          name="Columns"
          description="A box around each column's cards, or a rule under its heading."
          layer={layer("buckets")}
          reset={appearance.buckets !== null ? { label: backTo(own.buckets), onReset: () => onChange({ buckets: null }), disabled: busy } : undefined}
          control={<Segmented label="Columns" value={surface.buckets} options={BUCKET_CHOICES} disabled={busy} onChange={(buckets) => onChange({ buckets })} />}
        />
        <SettingsRow
          name="Status wash"
          description="Colour a whole card by what it is doing — running, waiting or failed. Finished cards fade."
          layer={layer("statusWash")}
          reset={appearance.statusWash !== null ? { label: backTo(own.statusWash ? "on" : "off"), onReset: () => onChange({ statusWash: null }), disabled: busy } : undefined}
          control={<Switch on={surface.statusWash} label="Status wash" disabled={busy} onChange={(statusWash) => onChange({ statusWash })} />}
        />
        <SettingsRow name="Preview" description={`What tasks look like in ${card.label}, with the options above.`} full>
          <TaskPreview />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="conversation" title="Conversation">
        <SettingsRow
          name="Batches that ran in turn"
          description="A fan-out whose elements ran one after another: down the page in the order they ran, or side by side as a band."
          info="A band is two columns, or tabs from three elements up — the way elements that ran at the same time are always drawn."
          layer={layer("conversation.sequentialBatches")}
          reset={conversation.sequentialBatches !== "stacked" ? { label: "Back to one after another", onReset: () => onConversation({ sequentialBatches: "stacked" }), disabled: busy } : undefined}
          control={
            <Segmented
              label="Batches that ran in turn"
              value={conversation.sequentialBatches}
              options={BATCH_CHOICES}
              disabled={busy}
              onChange={(sequentialBatches) => onConversation({ sequentialBatches })}
            />
          }
        />
        <SettingsRow name="Preview" description="Two elements of one batch, as a run's conversation will draw them." full>
          <ConversationPreview layout={conversation.sequentialBatches} />
        </SettingsRow>
        <SettingsRow
          name="Usage figures"
          description="How much of an account is used, after the model chip and in Connections: as a number, a ring, both, or not at all."
          info="A subscription shows the percent of its tightest window; an API key whose provider reports its credit, what is spent; any other key, what the conversation cost. The ring draws the same share, so either one alone says it. The conversation's own ring, at the composer's right, is not this setting."
          layer={layer("conversation.usageFigures")}
          reset={conversation.usageFigures !== "number" ? { label: "Back to the number", onReset: () => onConversation({ usageFigures: "number" }), disabled: busy } : undefined}
          control={
            <Segmented
              label="Usage figures"
              value={conversation.usageFigures}
              options={USAGE_CHOICES}
              disabled={busy}
              onChange={(usageFigures) => onConversation({ usageFigures })}
            />
          }
        />
        <SettingsRow name="Preview" description="The composer on a subscription, on a key whose provider reports its credit, and on a key whose provider does not." full>
          <UsageFiguresPreview mode={conversation.usageFigures} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="text" title="Text">
        <SettingsRow
          name="App font"
          description={
            <>
              JaiRA's own words: the names of rooms, actions and states.
              <span className="set-stack data-faint">
                <Resolved families={appearance.appFamily} voice="app" fallback={DEFAULT_APP_STACK} />
              </span>
            </>
          }
          layer={layer("appFamily", "sizeApp")}
          reset={
            appearance.appFamily.length > 0 || appearance.sizeApp !== SIZE_LIMITS.sizeApp.default
              ? { label: `Back to ${SHIPPED_APP_FAMILY}, ${SIZE_LIMITS.sizeApp.default} px`, onReset: () => onChange({ appFamily: [], sizeApp: SIZE_LIMITS.sizeApp.default }), disabled: busy }
              : undefined
          }
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
          name="Data font"
          description={
            <>
              Everything else: paths, task titles, commands, counts.
              <span className="set-stack data-faint">
                <Resolved families={appearance.dataFamily} voice="data" fallback={DEFAULT_DATA_STACK} />
              </span>
            </>
          }
          layer={layer("dataFamily", "sizeData")}
          reset={
            appearance.dataFamily.length > 0 || appearance.sizeData !== SIZE_LIMITS.sizeData.default
              ? { label: `Back to ${SHIPPED_DATA_FAMILY}, ${SIZE_LIMITS.sizeData.default} px`, onReset: () => onChange({ dataFamily: [], sizeData: SIZE_LIMITS.sizeData.default }), disabled: busy }
              : undefined
          }
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
          name="Editor size"
          description="Editors follow the data font until you give them a size of their own."
          layer={layer("advanced", "sizeEditor")}
          reset={appearance.advanced ? { label: "Back to following the data font", onReset: () => onChange({ advanced: false }), disabled: busy } : undefined}
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
          name="Editor palette"
          description="What every editor is painted in, where a file type has not been given one of its own."
          info="One answer for every editing surface: Monaco paints every editor on the page from one theme, so two palettes side by side would read as a fault. A file type can still be given its own under File types."
          layer={layer("editorTheme")}
          control={
            <SelectInput
              value={appearance.editorTheme}
              options={[["Follows the window", EDITOR_THEME_APP], ...EDITOR_THEMES.map((theme): [string, string] => [theme.label, theme.id])]}
              disabled={busy}
              onChange={(editorTheme) => onChange({ editorTheme })}
            />
          }
        />
        <SettingsRow
          name="Smooth text"
          description="Grayscale antialiasing, instead of the platform's own rendering."
          layer={layer("smoothing")}
          control={<Switch on={appearance.smoothing} label="Smooth text" disabled={busy} onChange={(smoothing) => onChange({ smoothing })} />}
        />
        <SettingsRow name="Preview" description="Both voices side by side, as a file row and a task row draw them." full>
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
