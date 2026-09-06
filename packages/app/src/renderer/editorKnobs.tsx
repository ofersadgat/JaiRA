/**
 * The knobs that move an editing surface — extracted so they can sit where the surface is CHOSEN.
 *
 * They lived in the Appearance pane's own Editors section, which asked a person to pick one of four
 * implementations by name and then set it. That was the wrong place twice over: nobody opens a
 * settings screen thinking about "the JSON editor", they think about a file; and it left the two
 * halves of one question — what draws this type, and what does that thing look like — in two
 * sections a scroll apart. The File types screen resolves a renderer, a renderer says which surface
 * it IS (`FileRenderer.look`), and these are drawn under it.
 *
 * Nothing here changed in the move. `SizeStep` still steps rather than slides, because a person
 * knows whether they want 12 or 12.5; `EDITOR_KNOBS` still decides which questions a surface can
 * answer, because a switch the surface would ignore is worse than an absent one — an absence is a
 * fact about the editor and a dead switch is a bug you cannot see.
 */
import { type JSX, type ReactNode } from "react";
import {
  EDITOR_KNOBS,
  LINE_HEIGHT,
  TAB_SIZES,
  editorKnobApplies,
  type EditorKind,
  type EditorKnob,
  type EditorLook,
} from "@jaira/shared/browser";
import { Chip, Switch } from "./controls";

/**
 * A size, as a number with a stepper — not a slider.
 *
 * A slider is for a quantity whose exact value does not matter. This one lands on 12 or 12.5 and a
 * person knows which they want, so the control shows the number and moves it by the step the range
 * is quantised to. It is also a third of the width, which is what lets it share a line with the
 * family it applies to.
 */
export function SizeStep({
  value,
  limits,
  by = 0.5,
  unit = "px",
  disabled,
  onChange,
}: {
  value: number;
  limits: { min: number; max: number };
  /**
   * What one press is worth, and what the number is quantised to.
   *
   * A parameter because the same control now sets two different quantities: a font size, where half
   * a pixel is the smallest difference anybody can see, and line spacing, where the unit is a
   * MULTIPLE of that size and a twentieth is a visible step. One control rather than two, because
   * they are the same gesture and a person should not have to learn a second one.
   */
  by?: number;
  unit?: string;
  disabled?: boolean;
  onChange: (size: number) => void;
}): JSX.Element {
  const step = (direction: number): void => {
    // Rounded to the step so a value typed into the box, or arrived at from an older default, joins
    // the grid on the first press instead of carrying its offset forever.
    const next = Math.round((value + direction * by) / by) * by;
    onChange(Math.min(limits.max, Math.max(limits.min, Number(next.toFixed(2)))));
  };
  return (
    <div className={`size-box${disabled === true ? " off" : ""}`}>
      <input
        className="size-n data-num"
        type="number"
        min={limits.min}
        max={limits.max}
        step={by}
        value={value}
        disabled={disabled}
        onChange={(e) => (Number.isFinite(e.target.valueAsNumber) ? onChange(e.target.valueAsNumber) : undefined)}
      />
      <span className="data-faint">{unit}</span>
      <span className="size-step">
        <button title={`larger (max ${limits.max})`} disabled={disabled || value >= limits.max} onClick={() => step(1)}>
          ▲
        </button>
        <button title={`smaller (min ${limits.min})`} disabled={disabled || value <= limits.min} onClick={() => step(-1)}>
          ▼
        </button>
      </span>
    </div>
  );
}

/** A switch, its name, and what it is currently worth — read down the right-hand edge. */
export function ToggleRow({
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
 * What each editor knob is CALLED, and what its two positions mean.
 *
 * The value words are the part worth a table. A switch whose right-hand column reads "on" and "off"
 * is a column repeating the switch back at you; what belongs there is what the app will DO, which is
 * why wrap says `wrapped` against `scrolls sideways` and whitespace says what it draws rather than
 * that it is enabled.
 */
const KNOB_WORDS: Record<EditorKnob, { label: string; on: string; off: string }> = {
  lineNumbers: { label: "Line numbers", on: "numbered", off: "no gutter" },
  wrap: { label: "Wrap long lines", on: "wrapped", off: "scrolls sideways" },
  minimap: { label: "Minimap", on: "down the right edge", off: "hidden" },
  indentGuides: { label: "Indent guides", on: "shown", off: "hidden" },
  currentLine: { label: "Mark the current line", on: "marked", off: "the caret says it" },
  whitespace: { label: "Show spaces and tabs", on: "dots and arrows", off: "hidden" },
  brackets: { label: "Colour bracket pairs", on: "Monaco's three colours", off: "the theme's own" },
  tabSize: { label: "Tab width", on: "", off: "" },
  lineHeight: { label: "Line spacing", on: "", off: "" },
};

/**
 * How one editing surface looks — the knobs it can actually answer, and nothing else.
 *
 * Driven by `EDITOR_KNOBS` rather than by a list written out here, which is what keeps this pane
 * from offering a control the surface underneath would ignore. A minimap switch over the JSON editor
 * would be a switch that does nothing, and a switch that does nothing is worse than an absence: an
 * absence is a fact about the editor, and a dead switch is a bug you cannot see.
 */
export function EditorLookFields({
  kind,
  look,
  busy,
  onChange,
}: {
  kind: EditorKind;
  look: EditorLook;
  busy: boolean;
  onChange: (patch: Partial<EditorLook>) => void;
}): JSX.Element {
  const switches: EditorKnob[] = ["lineNumbers", "wrap", "minimap", "indentGuides", "currentLine", "whitespace", "brackets"];
  return (
    <>
      {switches
        .filter((knob) => editorKnobApplies(kind, knob))
        .map((knob) => {
          const words = KNOB_WORDS[knob];
          const on = look[knob] === true;
          return (
            <ToggleRow
              key={knob}
              on={on}
              label={words.label}
              disabled={busy}
              onChange={(next) => onChange({ [knob]: next })}
              value={<span className="app-secondary">{on ? words.on : words.off}</span>}
            />
          );
        })}
      {editorKnobApplies(kind, "tabSize") ? (
        <div className="ap-toggle">
          {/* Chips rather than a stepper: a tab is 2, 4 or 8 columns wide in every codebase anybody
              has worked in, and a control that can land on 7 is a control that will. */}
          <span className="ap-chip-row">
            {TAB_SIZES.map((size) => (
              <Chip key={size} active={look.tabSize === size} disabled={busy} onClick={() => onChange({ tabSize: size })}>
                {size}
              </Chip>
            ))}
          </span>
          <span className="app-text">{KNOB_WORDS.tabSize.label}</span>
          <span className="ap-toggle-value app-secondary">columns</span>
        </div>
      ) : null}
      {editorKnobApplies(kind, "lineHeight") ? (
        <div className="ap-toggle">
          {/* A multiple of the editor's own size, never a pixel count — so moving the font size moves
              the spacing with it, which is the rule the ten registers already follow one level up. */}
          <span />
          <span className="app-text">{KNOB_WORDS.lineHeight.label}</span>
          <span className="ap-toggle-value">
            <SizeStep
              value={look.lineHeight}
              limits={LINE_HEIGHT}
              by={LINE_HEIGHT.step}
              unit="×"
              disabled={busy}
              onChange={(lineHeight) => onChange({ lineHeight })}
            />
          </span>
        </div>
      ) : null}
    </>
  );
}

