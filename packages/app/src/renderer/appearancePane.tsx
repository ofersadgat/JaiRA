/**
 * The typography screen (SHELL.md §6): two voices, two families, two sizes.
 *
 * Four decisions carry it, and each one is a correction of what a font picker usually is.
 *
 *  - **The control is a multi-select, not a text field.** A font stack is an ORDERED LIST — the
 *    second family is what renders a glyph the first lacks — so the chips are numbered and sit in
 *    one box in the order they are tried, and the default stack is the last line of the menu, stated
 *    and un-removable. That is what makes "prepend, never replace" visible rather than a rule you
 *    have to be told.
 *  - **Size sits on the same line as the family it applies to.** They are one decision about one
 *    voice; on separate rows a person sets the app font and then scrolls past two controls to find
 *    the size of the thing they just set.
 *  - **The preview is a real surface**, built from the same components and the same register classes
 *    as the shell — not a lookalike sample string. A sample cannot show you that your data font is
 *    wider than the column, and the preview is also the one place both voices sit adjacent.
 *  - **The proportional check is a NOTE, not a block.** Two voices can be configured into one, and
 *    measuring says so; it is their app, and a proportional code font is an unusual taste rather
 *    than an error.
 *
 * It does NOT use the `Level` / `Field` chrome the other settings sections are built from, and that
 * is the point rather than an oversight. That chrome is a statement on the left and its control on
 * the right, which is the right shape for a form of forty independent settings whose names are the
 * only thing distinguishing them. This screen has SIX, they are two pairs and two switches, and
 * every one of them is about type — so the labels are one word, the controls are the width of the
 * pane, and what a person needs beside the control is the preview, not a paragraph.
 */
import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { SIZE_LIMITS, type Appearance } from "@jaira/shared/browser";
import {
  DEFAULT_APP_STACK,
  DEFAULT_DATA_STACK,
  SHIPPED_APP_FAMILY,
  SHIPPED_DATA_FAMILY,
  isInstalled,
  isMonospace,
  shownFamilies,
  stackOf,
} from "./appearance";
import { Switch } from "./controls";
import { Pill } from "./pill";

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
 * A size, as a number with a stepper — not a slider.
 *
 * A slider is for a quantity whose exact value does not matter. This one lands on 12 or 12.5 and a
 * person knows which they want, so the control shows the number and moves it by the step the range
 * is quantised to. It is also a third of the width, which is what lets it share a line with the
 * family it applies to.
 */
function SizeStep({
  value,
  limits,
  disabled,
  onChange,
}: {
  value: number;
  limits: { min: number; max: number };
  disabled?: boolean;
  onChange: (size: number) => void;
}): JSX.Element {
  const step = (by: number): void => {
    const next = Math.round((value + by) * 2) / 2;
    onChange(Math.min(limits.max, Math.max(limits.min, next)));
  };
  return (
    <div className={`size-box${disabled === true ? " off" : ""}`}>
      <input
        className="size-n data-num"
        type="number"
        min={limits.min}
        max={limits.max}
        step={0.5}
        value={value}
        disabled={disabled}
        onChange={(e) => (Number.isFinite(e.target.valueAsNumber) ? onChange(e.target.valueAsNumber) : undefined)}
      />
      <span className="data-faint">px</span>
      <span className="size-step">
        <button title={`larger (max ${limits.max})`} disabled={disabled || value >= limits.max} onClick={() => step(0.5)}>
          ▲
        </button>
        <button title={`smaller (min ${limits.min})`} disabled={disabled || value <= limits.min} onClick={() => step(-0.5)}>
          ▼
        </button>
      </span>
    </div>
  );
}

/** A one-word heading over one control — this screen's whole label vocabulary. */
function VoiceField({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }): JSX.Element {
  return (
    <div className="ap-field">
      <span className="app-label">{label}</span>
      <div className="ap-line">{children}</div>
      {note !== undefined ? <span className="ap-note data-faint">{note}</span> : null}
    </div>
  );
}

/** A switch, its name, and what it is currently worth — read down the right-hand edge. */
function ToggleRow({
  on,
  label,
  value,
  disabled,
  onChange,
}: {
  on: boolean;
  label: string;
  value: ReactNode;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <div className="ap-toggle">
      <Switch on={on} label={label} disabled={disabled} onChange={onChange} />
      <span className="app-text">{label}</span>
      <span className="ap-toggle-value">{value}</span>
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

export function AppearancePane({
  appearance,
  busy,
  onChange,
}: {
  appearance: Appearance;
  busy: boolean;
  onChange: (patch: Partial<Appearance>) => void;
}): JSX.Element {
  // Measured once per stack rather than per render: reading a canvas metric is cheap but not free,
  // and the answer only changes when the list does.
  const proportional = useMemo(() => {
    const ctx = document.createElement("canvas").getContext("2d");
    return new Set(appearance.dataFamily.filter((f) => !isMonospace(f, ctx)));
  }, [appearance.dataFamily]);

  return (
    <div className="cfg-pane ap">
      {/* This section's own head. A non-layered section gets no `settings-head` from the chrome —
          there is no shared-versus-project switch to draw above it — so the one thing that header
          would have said, WHOSE settings these are, is said here. */}
      <div className="ap-head">
        <span className="app-title">Appearance</span>
        <span className="app-secondary">every project on this machine</span>
      </div>

      {/* "App text", not "app voice". The voices are what the STYLESHEET calls them and what §3
          argues about; on the screen where a person picks a font, the thing they are picking is the
          text of the app and the text of their data. A label naming an internal distinction makes
          somebody work out which of two abstractions their font is about. */}
      <VoiceField label="app text" note={<Resolved families={appearance.appFamily} voice="app" fallback={DEFAULT_APP_STACK} />}>
        <FamilyStack
          families={appearance.appFamily}
          ours={SHIPPED_APP_FAMILY}
          fallback={DEFAULT_APP_STACK}
          suggested={SUGGESTED_APP}
          voice="app"
          disabled={busy}
          onChange={(appFamily) => onChange({ appFamily })}
        />
        <SizeStep
          value={appearance.sizeApp}
          limits={SIZE_LIMITS.sizeApp}
          disabled={busy}
          onChange={(sizeApp) => onChange({ sizeApp })}
        />
      </VoiceField>

      <VoiceField label="data text" note={<Resolved families={appearance.dataFamily} voice="data" fallback={DEFAULT_DATA_STACK} />}>
        <FamilyStack
          families={appearance.dataFamily}
          ours={SHIPPED_DATA_FAMILY}
          fallback={DEFAULT_DATA_STACK}
          suggested={SUGGESTED_DATA}
          voice="data"
          disabled={busy}
          // OURS, and a note rather than a block (§6): two voices can be configured into one, and a
          // column of counts that no longer lines up is worth saying out loud. It is their app.
          warn={(family) => (proportional.has(family) ? "not monospaced — columns will not line up" : undefined)}
          onChange={(dataFamily) => onChange({ dataFamily })}
        />
        <SizeStep
          value={appearance.sizeData}
          limits={SIZE_LIMITS.sizeData}
          disabled={busy}
          onChange={(sizeData) => onChange({ sizeData })}
        />
      </VoiceField>

      <div className="ap-divider" />

      <ToggleRow
        on={appearance.advanced}
        label="Separate editor size"
        disabled={busy}
        onChange={(advanced) => onChange({ advanced })}
        // OFF, the editor follows the data text — so the value on the right is the data size, and
        // it says so rather than showing a number the switch is not currently spending.
        value={
          appearance.advanced ? (
            <SizeStep
              value={appearance.sizeEditor}
              limits={SIZE_LIMITS.sizeEditor}
              disabled={busy}
              onChange={(sizeEditor) => onChange({ sizeEditor })}
            />
          ) : (
            <span className="app-secondary">follows the data text</span>
          )
        }
      />
      <ToggleRow
        on={appearance.smoothing}
        label="Smooth text"
        disabled={busy}
        onChange={(smoothing) => onChange({ smoothing })}
        value={<span className="app-secondary">{appearance.smoothing ? "grayscale" : "the platform's own"}</span>}
      />

      <div className="ap-divider" />

      <span className="app-label">preview</span>
      <Preview />
    </div>
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
