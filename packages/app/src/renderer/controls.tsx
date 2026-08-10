/**
 * The configuration vocabulary the settings screens are built from.
 *
 * Modelled on findmyprompt's `searchConfig/controls.tsx`, and deliberately so: that surface had
 * already answered the questions this one was getting wrong. Four of its ideas carry the weight —
 *
 *  - **A field is a label, the KEY it writes, a hint, and a control — stacked tight.** The key
 *    matters: a settings screen that hides which config field it is setting leaves you unable to
 *    connect it to the file, the docs, or an error message that names it. So `param` is always shown.
 *  - **Fields flow into a responsive GRID.** One control per line turns eight settings into a wall.
 *  - **Empty means UNSET, never zero.** A numeric box left blank inherits; it does not write `0`.
 *    `NumInput` holds a draft string while typing so `0.` survives long enough to become `0.5`.
 *  - **Rare settings live behind a `Disclosure`.** The common path stays short.
 *
 * Styled with classes rather than the inline styles it came from, because that is this app's
 * convention and its two themes are variable-driven — an inline `#fff` is a light-mode assumption
 * that dark mode cannot override.
 */
import { useState, type JSX, type ReactNode } from "react";

/**
 * One setting: what it is called, what it writes, what it means, and the control.
 *
 * `param` is the config path this writes (`models.default`, `routes.local.baseURL`), rendered as a
 * small monospace tag beside the label. It is not decoration — it is the only thing connecting a
 * pretty label to the `config.json` a user may also be editing by hand, and to the error message
 * the parser produces when the value is wrong.
 *
 * `set` marks a value THIS layer states, as opposed to one it inherits. Without it a form cannot
 * distinguish "the shared root says sonnet" from "this project pins sonnet", which are different
 * facts with different consequences for saving.
 */
export function Field({
  label,
  param,
  hint,
  set = false,
  children,
}: {
  label: string;
  param?: string;
  hint?: ReactNode;
  set?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="cfg-field">
      <span className="cfg-field-head">
        <span className="cfg-label">{label}</span>
        {param ? <code className="cfg-param">{param}</code> : null}
        {set ? <span className="cfg-set" title="set in the layer you are editing">set here</span> : null}
      </span>
      {hint ? <span className="cfg-hint">{hint}</span> : null}
      <div className="cfg-control">{children}</div>
    </div>
  );
}

/**
 * A responsive multi-column grid of {@link Field}s.
 *
 * `auto-fit` rather than a fixed column count: the settings drawer is resizable, and a form that
 * committed to two columns would either overflow when narrowed or waste half a wide window.
 */
export function FieldGrid({ children, min = 210 }: { children: ReactNode; min?: number }): JSX.Element {
  return (
    <div className="cfg-grid" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))` }}>
      {children}
    </div>
  );
}

/**
 * One level of the configuration's TYPE hierarchy.
 *
 * A `codex-cli` provider is a provider, which is an agent provider, which is a CLI agent, which is
 * codex — and each of those levels contributes its own settings. Rendering them as one flat list of
 * boxes loses exactly the information that makes the form learnable: which settings every provider
 * has, which come from being a CLI, and which are codex's alone. So each level is its own band, and
 * the nesting is visible.
 */
export function Level({
  title,
  hint,
  depth = 0,
  children,
}: {
  title: string;
  hint?: ReactNode;
  depth?: number;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="cfg-level" data-depth={depth}>
      <div className="cfg-level-head">
        <span className="cfg-level-title">{title}</span>
        {hint ? <span className="cfg-hint">{hint}</span> : null}
      </div>
      <div className="cfg-level-body">{children}</div>
    </section>
  );
}

/** A collapsed-by-default well for the settings most projects never touch. */
export function Disclosure({
  summary,
  desc,
  children,
  defaultOpen = false,
}: {
  summary: string;
  desc?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`cfg-disclosure${open ? " open" : ""}`}>
      <button type="button" className="cfg-disclosure-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="cfg-caret" aria-hidden="true">
          ▶
        </span>
        <span className="cfg-disclosure-title">{summary}</span>
        {desc ? <span className="cfg-hint">· {desc}</span> : null}
      </button>
      {open ? <div className="cfg-disclosure-body">{children}</div> : null}
    </div>
  );
}

/**
 * A numeric input reporting `number | undefined` — empty means UNSET, and inherits.
 *
 * The draft string is the whole trick, and it is findmyprompt's: bound straight to `String(value)`,
 * typing `0.` becomes `Number("0.")` = 0 and re-renders as `"0"`, swallowing the decimal point on
 * every keystroke — a fractional temperature could never be typed at all. The raw text is held until
 * blur, then resyncs to the canonical number.
 */
export function NumInput({
  value,
  onChange,
  placeholder = "—",
  disabled,
}: {
  value: number | undefined;
  onChange: (n: number | undefined) => void;
  placeholder?: string;
  disabled?: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === undefined ? "" : String(value));
  return (
    <input
      className="cfg-input num"
      value={shown}
      disabled={disabled}
      inputMode="decimal"
      placeholder={placeholder}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        onChange(e.target.value.trim() === "" || !Number.isFinite(n) ? undefined : n);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

/** A plain text box. Its own component only so every control in a form is reached the same way. */
export function TextInput({
  value,
  onChange,
  placeholder,
  disabled,
  mono = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
}): JSX.Element {
  return (
    <input
      className={`cfg-input${mono ? " mono" : ""}`}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** A multi-line box — argv, environment, a JSON block, a list of patterns. */
export function TextArea({
  value,
  onChange,
  placeholder,
  disabled,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
}): JSX.Element {
  return (
    <textarea
      className="cfg-input mono"
      value={value}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** A closed set of choices. The empty value is always "inherit", and always first. */
export function SelectInput({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: Array<[label: string, value: string]>;
  onChange: (v: string) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <select className="cfg-input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map(([label, val]) => (
        <option key={val} value={val}>
          {label}
        </option>
      ))}
    </select>
  );
}

/** A pill that is also a choice — the preset shortcuts. */
export function Chip({
  active,
  onClick,
  disabled,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`cfg-chip${active ? " on" : ""}`}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * What a thing's state IS, in one word and one colour.
 *
 * Four states, not two, and that is the point. A checkbox can only say on or off, so an unavailable
 * provider rendered as a ticked box — which is how this screen came to claim four working providers
 * on a machine configured for none. "Enabled" is an intention; "available" is an observation; they
 * disagree constantly and the UI has to be able to say so.
 */
export type ProviderState = "available" | "unavailable" | "unconfigured" | "off" | "unchecked";

const STATE_WORDS: Record<ProviderState, string> = {
  available: "ready",
  unavailable: "not working",
  unconfigured: "not set up",
  off: "turned off",
  unchecked: "not checked",
};

export function StatusPill({ state }: { state: ProviderState }): JSX.Element {
  return (
    <span className={`cfg-status ${state}`}>
      <span className="cfg-dot" aria-hidden="true" />
      {STATE_WORDS[state]}
    </span>
  );
}
