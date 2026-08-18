/**
 * The typography screen (SHELL.md §6): two voices, two families, two sizes.
 *
 * Four decisions carry it, and each one is a correction of what a font picker usually is.
 *
 *  - **The control is a multi-select, not a text field.** A font stack is an ORDERED LIST — the
 *    second family is what renders a glyph the first lacks — so the chips are numbered and can be
 *    reordered, and the default stack is the last line of the menu, stated and un-removable. That is
 *    what makes "prepend, never replace" visible rather than a rule you have to be told.
 *  - **Size sits on the same line as the family it applies to.** They are one decision about one
 *    voice; on separate rows a person sets the app font and then scrolls past two controls to find
 *    the size of the thing they just set.
 *  - **The preview is a real surface**, built from the same components and the same register classes
 *    as the shell — not a lookalike sample string. A sample cannot show you that your data font is
 *    wider than the column, and the preview is also the one place both voices sit adjacent.
 *  - **The proportional check is a NOTE, not a block.** Two voices can be configured into one, and
 *    measuring says so; it is their app, and a proportional code font is an unusual taste rather
 *    than an error.
 */
import { useMemo, useState, type JSX } from "react";
import { SIZE_LIMITS, type Appearance } from "@jaira/shared/browser";
import { DEFAULT_APP_STACK, DEFAULT_DATA_STACK, isMonospace } from "./appearance";
import { Field, FieldGrid, Level } from "./controls";
import { Pill } from "./pill";

/**
 * Faces worth offering by name.
 *
 * A short list rather than an enumeration of what is installed: there is no way to enumerate system
 * fonts without a permission prompt, and the answer would be four hundred entries long in an order
 * nobody chose. Anything not here is typed in — the field accepts a name and the chip proves whether
 * it resolved, which is the same feedback a longer list would have given.
 */
const SUGGESTED_APP = ["DM Sans", "Inter", "Segoe UI", "Helvetica Neue", "IBM Plex Sans", "Roboto"];
const SUGGESTED_DATA = ["JetBrains Mono", "Cascadia Code", "SF Mono", "Fira Code", "IBM Plex Mono", "Consolas", "Menlo"];

/**
 * One voice's stack, as numbered chips that can be reordered and dropped.
 *
 * The numbers are the point: they say this is a list of ALTERNATIVES tried in order, which is the
 * one thing a comma-separated text box never manages to say. The last line is the default stack, and
 * it has no ✕ — it is stated rather than editable, because it is what stops a missing glyph from
 * becoming tofu.
 */
function FamilyStack({
  families,
  fallback,
  suggested,
  warn,
  onChange,
}: {
  families: readonly string[];
  fallback: string;
  suggested: readonly string[];
  /** Which chosen families failed a check, and what to say about each. */
  warn?: (family: string) => string | undefined;
  onChange: (families: string[]) => void;
}): JSX.Element {
  const [adding, setAdding] = useState("");
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= families.length) return;
    const next = [...families];
    const [held] = next.splice(from, 1);
    next.splice(to, 0, held!);
    onChange(next);
  };
  const add = (name: string): void => {
    const clean = name.trim();
    if (clean.length === 0 || families.includes(clean)) return;
    onChange([...families, clean]);
    setAdding("");
  };
  return (
    <div className="face-stack">
      {families.map((family, i) => {
        const note = warn?.(family);
        return (
          <div key={family} className={`face-chip${note !== undefined ? " warn" : ""}`} title={note}>
            <span className="face-n data-num">{i + 1}</span>
            {/* Set IN the face it names — the only honest preview of a font is the font. */}
            <span className="face-name ellip" style={{ fontFamily: `"${family}", ${fallback}` }}>
              {family}
            </span>
            {note !== undefined ? <span className="face-warn app-secondary">{note}</span> : null}
            <button className="face-move" title="earlier" disabled={i === 0} onClick={() => move(i, i - 1)}>
              ↑
            </button>
            <button className="face-move" title="later" disabled={i === families.length - 1} onClick={() => move(i, i + 1)}>
              ↓
            </button>
            <button className="face-drop" title="remove" onClick={() => onChange(families.filter((f) => f !== family))}>
              ✕
            </button>
          </div>
        );
      })}
      {/* The default stack, always last and never removable. This is "prepend, never replace" as a
          thing you can see rather than a rule you have to know. */}
      <div className="face-chip face-default" title="always tried last, so a missing glyph falls through instead of showing tofu">
        <span className="face-n data-num">{families.length + 1}</span>
        <span className="face-name ellip data-faint">{fallback}</span>
        <span className="face-warn app-secondary">the default</span>
      </div>
      <div className="face-add">
        <input
          className="cfg-input"
          list={`faces-${fallback.length}`}
          value={adding}
          placeholder="Add a family…"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => (e.key === "Enter" ? add(adding) : undefined)}
          onBlur={() => add(adding)}
        />
        <datalist id={`faces-${fallback.length}`}>
          {suggested.filter((f) => !families.includes(f)).map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </div>
    </div>
  );
}

/** A size, as a slider with the number beside it. Bounded by the same limits the parser clamps to. */
function SizeSlider({
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
  return (
    <span className="size-slider">
      <input
        type="range"
        min={limits.min}
        max={limits.max}
        step={0.5}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="data-num">{value}px</span>
    </span>
  );
}

/**
 * The preview: a real sidebar fragment beside a real task row.
 *
 * Real components and real register classes, not a sample string — a sample cannot show you that
 * your data font is too wide for the column it has to sit in. It is also the one place in the app
 * where both voices are guaranteed adjacent, which is where a mismatch between them is visible.
 */
function Preview(): JSX.Element {
  return (
    <div className="face-preview">
      <div className="face-preview-nav">
        <div className="side-row on is-active">
          <span className="side-glyph">▶</span>
          <span className="side-label app-label">Tasks</span>
        </div>
        <div className="side-row">
          <span className="side-glyph">❏</span>
          <span className="side-label app-label">Files</span>
          <span className="data-secondary">prompts/review.md</span>
        </div>
      </div>
      <div className="face-preview-card card">
        <div className="card-head">
          <span className="card-title">tighten the sync lint</span>
          <Pill kind="running" word="running" />
        </div>
        <div className="card-meta">
          <span className="ellip">feature/plan</span>
          <span className="card-status">40s · 3 turns</span>
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
    <div className="pane-body">
      <Level
        title="App voice"
        hint="The words JaiRA chose — the names of rooms, actions and states. They are the same on every machine."
      >
        <FieldGrid>
          <Field label="Family" hint="Tried in order. The default stack is always last, so a missing glyph falls through.">
            <FamilyStack
              families={appearance.appFamily}
              fallback={DEFAULT_APP_STACK}
              suggested={SUGGESTED_APP}
              onChange={(appFamily) => onChange({ appFamily })}
            />
          </Field>
          <Field label="Size" hint="Every app register is a multiple of this, so one move keeps every ratio intact.">
            <SizeSlider
              value={appearance.sizeApp}
              limits={SIZE_LIMITS.sizeApp}
              disabled={busy}
              onChange={(sizeApp) => onChange({ sizeApp })}
            />
          </Field>
        </FieldGrid>
      </Level>

      <Level
        title="Data voice"
        hint="The words something else chose — paths, project names, state ids, task titles, commands, counts."
      >
        <FieldGrid>
          <Field label="Family" hint="Tried in order. A proportional face is allowed; it is only pointed out.">
            <FamilyStack
              families={appearance.dataFamily}
              fallback={DEFAULT_DATA_STACK}
              suggested={SUGGESTED_DATA}
              // OURS, and a note rather than a block (§6): two voices can be configured into one, and
              // a column of counts that no longer lines up is worth saying out loud. It is their app.
              warn={(family) => (proportional.has(family) ? "not monospaced — columns will not line up" : undefined)}
              onChange={(dataFamily) => onChange({ dataFamily })}
            />
          </Field>
          <Field label="Size" hint="Every data register is a multiple of this.">
            <SizeSlider
              value={appearance.sizeData}
              limits={SIZE_LIMITS.sizeData}
              disabled={busy}
              onChange={(sizeData) => onChange({ sizeData })}
            />
          </Field>
          <Field
            label="Separate editor size"
            hint="Off, the editor and the diff panes follow the data voice. On, they get a size of their own."
          >
            <span className="size-slider">
              <input
                type="checkbox"
                checked={appearance.advanced}
                disabled={busy}
                onChange={(e) => onChange({ advanced: e.target.checked })}
              />
              <SizeSlider
                value={appearance.sizeEditor}
                limits={SIZE_LIMITS.sizeEditor}
                disabled={busy || !appearance.advanced}
                onChange={(sizeEditor) => onChange({ sizeEditor })}
              />
            </span>
          </Field>
        </FieldGrid>
      </Level>

      <Level title="Rendering" hint="How glyphs are painted, rather than which ones.">
        <FieldGrid>
          <Field
            label="Grayscale smoothing"
            hint="Off by default: the platform's own rendering is what every other application on this machine uses."
          >
            <input
              type="checkbox"
              checked={appearance.smoothing}
              disabled={busy}
              onChange={(e) => onChange({ smoothing: e.target.checked })}
            />
          </Field>
        </FieldGrid>
      </Level>

      <Level title="Preview" hint="Real surfaces, not a sample — and the one place both voices sit side by side.">
        <Preview />
      </Level>
    </div>
  );
}
