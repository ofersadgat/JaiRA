/**
 * The lines a TOOLSET is drawn as — one set of rows, wherever a toolset is on screen.
 *
 * They were the composer's, inside `composer.tsx`. Settings → Toolsets draws a toolset "as the
 * composer's Tools card is" (decision 0007 §6) and the state editor's Tools field draws the lines a
 * state writes over one, so the rows moved here and all three call them. A second copy would be a
 * second place for a mode menu to grow a fifth mode, or for the shell's line to stop saying it stands
 * for every unnamed command.
 *
 * Every row is a render function with no opinion about its place. Two things differ between hosts,
 * and both are props rather than forks:
 *
 *  - **how a line leaves.** In the composer a line is TICKED — the card lists every tool, and an
 *    unticked one keeps its row. In a toolset being edited the card lists what the toolset HOLDS, so
 *    a held line starts with a red minus that takes it out (`onRemove`), and what is not held is
 *    reached through the section's last line ({@link AddMenu});
 *  - **whether anything can change.** `readOnly` draws the same rows inert, which is how the
 *    built-in layer reads.
 *
 * The edits themselves are pure functions of the map, in `composerToolset.ts`.
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import {
  PERMISSION_MODES,
  SCRIPT_SUBJECT,
  SHELL_TOOL,
  SMART_FUNCTION,
  isFunctionMode,
  modeFunction,
  type PermissionMode,
  type ToolCategory,
  type ToolChoice,
  type ToolImplementation,
  type Toolset,
  type ToolsetMode,
  type ToolSpec,
} from "@jaira/shared/browser";
import { groupModeOf, groupSentence, groupSummary, type CommandGroup } from "./composerToolset";
import { Icon } from "./icons";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { Schema } from "./schemaForm/types";

export const TOOL_ICONS: Record<string, Parameters<typeof Icon>[0]["name"]> = {
  bash: "terminal",
  read_file: "read",
  write_file: "write",
};

/** What the shell's line says in the Tools card: it is also where every unnamed command lands. */
export const SHELL_HINT = "the shell — and the mode for any command not named below";
export const SCRIPT_HINT = "running a file — ./x.sh, npm run, python x.py, make";

/**
 * What one permission MODE means, and the glyph for it.
 *
 * Drawn as what the agent may DO rather than as a tier: a shut lock asks every time, the same lock
 * open goes ahead, a shield refuses. Somebody scanning a tool row is asking what happens when that
 * tool is reached, and a rank answers a different question. A line that names a FUNCTION wears a
 * star and the function's name — see {@link modeMeta}.
 */
export const MODE_META: Record<PermissionMode, { icon: Parameters<typeof Icon>[0]["name"]; label: string; hint: string }> = {
  ask: { icon: "lock", label: "ask", hint: "stop and ask before each call" },
  allow: { icon: "unlocked", label: "allow", hint: "goes ahead without asking" },
  deny: { icon: "shield", label: "deny", hint: "refused every time" },
};

/** The glyph for a line that names a function — the star the approval draws beside what one decided. */
export const FUNCTION_ICON: Parameters<typeof Icon>[0]["name"] = "star";

/** {@link MODE_META} for any mode: a function reads as its own name, decided per call. */
export function modeMeta(mode: ToolsetMode): { icon: Parameters<typeof Icon>[0]["name"]; label: string; hint: string } {
  if (!isFunctionMode(mode)) return MODE_META[mode];
  return {
    icon: FUNCTION_ICON,
    label: mode.function,
    hint:
      mode.function === SMART_FUNCTION
        ? "a model judges each call, and asks you when it is unsure"
        : `the function ${mode.function} decides each call`,
  };
}

/** The css class a mode's button wears: the word, or `function`. */
const modeClass = (mode: ToolsetMode): string => (isFunctionMode(mode) ? "function" : mode);

/**
 * The red minus that starts a held line in a toolset being edited: out of the toolset.
 *
 * At the FAR LEFT, before the glyph and the name, because it is about the whole line — and a circle
 * of `--bad`, because it is the one control on the row that takes something away.
 */
export function RemoveLine({ subject, onRemove }: { subject: string; onRemove: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className="set-minus"
      title={`remove ${subject}`}
      aria-label={`remove ${subject}`}
      onClick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
    >
      <span aria-hidden="true">−</span>
    </button>
  );
}

/** A popover that closes on an outside click — the shape every dropdown in this menu wants. */
export function useAway<T extends HTMLElement>(open: boolean, close: () => void): React.RefObject<T | null> {
  const box = useRef<T | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
    // `close` is a fresh closure per render and re-subscribing on each would be churn for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return box;
}

/**
 * The mode control: what happens when this thing is called.
 *
 * Shared by a tool row, a category row and the `Other` row, because all three are answering the same
 * question about a different scope — and three spellings of one menu is how they come to offer
 * different sets of modes.
 */
export function ModePicker({
  mode,
  title,
  onMode,
  readOnly,
  startOpen,
}: {
  /** `undefined` reads as `custom`: the things under this do not agree. See {@link categoryModeOf}. */
  mode: ToolsetMode | undefined;
  title: string;
  onMode: (next: ToolsetMode) => void;
  /** The mode is shown and cannot be changed — what ships, read in Settings. */
  readOnly?: boolean | undefined;
  /** Drawn open from the first render, on the menu or on the function form — for a still picture. */
  startOpen?: "menu" | "function" | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(startOpen !== undefined);
  // The fourth row is not a word but a NAME: picking it asks which function, through the schema form
  // every typed input goes through, and a line that already names one opens on its name.
  const [naming, setNaming] = useState(startOpen === "function");
  const box = useAway<HTMLDivElement>(open, () => {
    setOpen(false);
    setNaming(false);
  });
  const meta = mode === undefined ? undefined : modeMeta(mode);
  return (
    <div className="cx-mode-wrap" ref={box}>
      <button
        type="button"
        className={`cx-tool-mode ${mode === undefined ? "cx-mode-custom" : `cx-mode-${modeClass(mode)}`}`}
        aria-expanded={open}
        aria-disabled={readOnly === true ? true : undefined}
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          if (readOnly === true) return;
          setOpen((v) => !v);
          setNaming(false);
        }}
      >
        {meta !== undefined ? (
          <span className="cx-chip-icon">
            <Icon name={meta.icon} />
          </span>
        ) : null}
        <span className={isFunctionMode(mode) ? "ellip mono" : "ellip"}>{meta?.label ?? "custom"}</span>
        <span className="cx-more">›</span>
      </button>
      {open ? (
        <div className="cx-submenu">
          {naming ? (
            <FunctionForm
              initial={modeFunction(mode) ?? SMART_FUNCTION}
              onSet={(reference) => {
                onMode({ function: reference });
                setNaming(false);
                setOpen(false);
              }}
              onCancel={() => setNaming(false)}
            />
          ) : (
            <>
              {PERMISSION_MODES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={value === mode ? "on" : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMode(value);
                    setOpen(false);
                  }}
                >
                  <span className="cx-tick">{value === mode ? "✓" : ""}</span>
                  <span className="cx-chip-icon">
                    <Icon name={MODE_META[value].icon} />
                  </span>
                  <span className="cx-opt-text">
                    <span className="cx-opt-name ellip">{MODE_META[value].label}</span>
                    <span className="cx-opt-hint ellip">{MODE_META[value].hint}</span>
                  </span>
                </button>
              ))}
              <button
                type="button"
                className={isFunctionMode(mode) ? "on" : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  setNaming(true);
                }}
              >
                <span className="cx-tick">{isFunctionMode(mode) ? "✓" : ""}</span>
                <span className="cx-chip-icon">
                  <Icon name={FUNCTION_ICON} />
                </span>
                <span className="cx-opt-text">
                  <span className="cx-opt-name ellip">{isFunctionMode(mode) ? <span className="mono">{mode.function}</span> : "function…"}</span>
                  <span className="cx-opt-hint ellip">a function decides each call, and may ask you — smart, or your own</span>
                </span>
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Which function decides a line — one string, asked through the schema form like every other typed
 * input. `smart` is the one JaiRA ships; anything an expression can call with one argument, or an
 * expression document, is a function here.
 */
export function FunctionForm({
  initial,
  onSet,
  onCancel,
}: {
  initial: string;
  onSet: (reference: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [typed, setTyped] = useState(initial);
  const schema: Schema = {
    type: "object",
    properties: {
      function: {
        type: "string",
        title: "function",
        minLength: 1,
        description: "smart, or a function of your own — a name on the search path, a module symbol, or $BASE/functions/…",
      },
    },
    required: ["function"],
  };
  const reference = typed.trim();
  return (
    <div className="cx-set-line-form cx-function-form" onClick={(e) => e.stopPropagation()}>
      <SchemaForm
        schema={schema}
        value={{ function: typed }}
        onChange={(next) => setTyped(String((next as { function?: unknown } | undefined)?.function ?? ""))}
        ctx={{ path: "", hidePaths: true }}
      />
      <p className="sub">It is handed the call and answers allow or deny; to ask you, it calls approve_tool_call.</p>
      <div className="cx-set-new-foot">
        <button type="button" className="ghost" onClick={onCancel}>
          Back
        </button>
        <button type="button" className="primary" disabled={reference.length === 0} onClick={() => onSet(reference)}>
          Set
        </button>
      </div>
    </div>
  );
}

/**
 * Whose CODE runs this tool — a SEPARATE axis from whether it may run at all.
 *
 * The control this replaces was a single row called "default" that meant both at once: picking it
 * handed the agent its own tools AND gave up the gate, because there was nowhere to say one without
 * the other. Access stays the app's under either choice; what this picks is which implementation
 * executes. `native` gets the agent's built-in — usually better at its job, and the reason to want
 * it. `app` gets ours — the one that writes through the artifact map, so a file lands where the
 * project's destination says rather than where the agent put it.
 *
 * Shown only where there is a choice: a transport with no built-in for this job, or no agent at all,
 * has one answer and a dropdown offering it would be a control that cannot be wrong.
 */
export function ImplPicker({
  value,
  native,
  nativeHint,
  onPick,
  readOnly,
}: {
  value: ToolImplementation;
  /** What the agent calls its own — named in the menu, since that is what its logs will say. */
  native: string;
  /** What the native row says under its name, where the default sentence is not enough. */
  nativeHint?: string | undefined;
  onPick: (next: ToolImplementation) => void;
  readOnly?: boolean | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const box = useAway<HTMLDivElement>(open, () => setOpen(false));
  const options: Array<{ id: ToolImplementation; label: string; hint: string }> = [
    { id: "app", label: "JaiRA", hint: "our implementation, through the artifact map" },
    { id: "native", label: native, hint: nativeHint ?? "the agent's own — still gated by the mode beside it" },
  ];
  const picked = options.find((o) => o.id === value)!;
  return (
    <div className="cx-impl-wrap" ref={box}>
      <button
        type="button"
        className="cx-tool-impl"
        aria-expanded={open}
        aria-disabled={readOnly === true ? true : undefined}
        title={`Implementation: ${picked.hint}`}
        onClick={(e) => {
          e.stopPropagation();
          if (readOnly !== true) setOpen((v) => !v);
        }}
      >
        <span className="ellip">{picked.label}</span>
        <span className="cx-more">›</span>
      </button>
      {open ? (
        <div className="cx-submenu">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={option.id === value ? "on" : undefined}
              onClick={(e) => {
                e.stopPropagation();
                onPick(option.id);
                setOpen(false);
              }}
            >
              <span className="cx-tick">{option.id === value ? "✓" : ""}</span>
              <span className="cx-opt-text">
                <span className="cx-opt-name ellip">{option.label}</span>
                <span className="cx-opt-hint ellip">{option.hint}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One tool: whether it is offered at all, and what happens when it is called.
 *
 * Two controls on one line because they are two different decisions about one thing, and separating
 * them into two lists made you hold a name in your head to cross-reference. Ticking OFFERS the tool —
 * an unticked tool is not declared, so the model is never told it exists. The mode is what the gate
 * does when a tool that IS offered gets called, and it opens a submenu rather than cycling: four
 * values where one is `deny` is not something to arrive at by clicking three times past it.
 *
 * The mode stays live on an unticked row rather than greying out. It is the value the tool would run
 * under if you ticked it, and a control that blanks when you untick loses what you had set.
 *
 * With `held` the row is a line of a toolset being EDITED or READ rather than ticked: no tick, the
 * name is text and not a button, and `onRemove` — when the toolset can be changed — draws the minus.
 */
export function ToolRow({
  tool,
  spec,
  granted,
  mode,
  impl,
  cliRoute,
  onGrant,
  onMode,
  onImpl,
  held,
  note,
  onRemove,
  readOnly,
  modeOpen,
}: {
  tool: ToolChoice;
  /** The vocabulary entry, when this tool has one — what supplies its label and hint. */
  spec?: ToolSpec | undefined;
  granted: boolean;
  mode: ToolsetMode;
  impl: ToolImplementation;
  /** Which agent is answering, if one is — what decides whether the implementation is a choice. */
  cliRoute?: string | undefined;
  onGrant?: (() => void) | undefined;
  onMode: (next: ToolsetMode) => void;
  onImpl: (next: ToolImplementation) => void;
  /** A line of a toolset on the page, not a tick box — see above. */
  held?: boolean | undefined;
  /** Said under the name INSTEAD of the tool's own sentence: "over the toolset, for this state". */
  note?: string | undefined;
  onRemove?: (() => void) | undefined;
  readOnly?: boolean | undefined;
  /** The mode menu drawn open from the first render — for a still picture. */
  modeOpen?: "menu" | "function" | undefined;
}): JSX.Element {
  // What the ANSWERING agent calls its own tool doing this job — off that executor's declaration, by
  // route. Absent ⇒ that agent has no built-in to pick instead, so there is no choice to draw. A
  // toolset on the page has no one agent answering: the choice is drawn wherever ANY agent has a
  // built-in for the job, and the menu says whose.
  const names = Object.entries(tool.natives ?? {});
  const native = cliRoute !== undefined ? tool.natives?.[cliRoute] : held === true && names.length > 0 ? "native" : undefined;
  const nativeHint =
    cliRoute === undefined && names.length > 0 ? `the agent's own — ${names.map(([route, name]) => `${name} on ${route}`).join(", ")}` : undefined;
  // The shell's line is more than a tool's: it is where every command with no line of its own lands.
  // And a tool that is named and not served yet says so, because ticking it hands nobody anything.
  const hint =
    note ?? (tool.name === SHELL_TOOL ? SHELL_HINT : spec?.unserved === true ? `${spec.hint} · not served yet` : (spec?.hint ?? tool.name));
  const words = (
    <>
      <span className="cx-chip-icon">
        <Icon name={TOOL_ICONS[tool.name] ?? "tool"} />
      </span>
      <span className="cx-opt-text">
        <span className="cx-opt-name ellip">{spec?.label ?? tool.name}</span>
        <span className="cx-opt-hint ellip">{hint}</span>
      </span>
    </>
  );
  return (
    <div className={`cx-tool${granted ? " on" : ""}${held === true && onRemove !== undefined ? " set-held" : ""}`}>
      {held === true && onRemove !== undefined ? <RemoveLine subject={spec?.label ?? tool.name} onRemove={onRemove} /> : null}
      {held === true ? (
        <span className="cx-tool-grant" title={hint}>
          {words}
        </span>
      ) : (
        <button type="button" className="cx-tool-grant" title={hint} onClick={onGrant}>
          <span className="cx-tick">{granted ? "✓" : ""}</span>
          {words}
        </button>
      )}
      {native !== undefined ? <ImplPicker value={impl} native={native} nativeHint={nativeHint} onPick={onImpl} readOnly={readOnly} /> : null}
      <ModePicker mode={mode} title={`${tool.name}: ${modeMeta(mode).hint}`} onMode={onMode} readOnly={readOnly} startOpen={modeOpen} />
    </div>
  );
}

/**
 * One category: what is under it, folded, with the setting they share.
 *
 * The row's mode is DERIVED and never stored — it shows what its children say, and setting it writes
 * every child. That is what keeps one map on disk and keeps the menu from growing a precedence chain
 * between a category, a tool and a profile, which would be three places for one answer to come from.
 * When the children disagree the row reads `custom`, which is a statement none of the four modes can
 * make and the reason `categoryModeOf` answers `undefined` rather than picking one.
 */
export function CategoryRow({
  category,
  children,
  granted,
  mode,
  open,
  onOpen,
  onMode,
}: {
  category: ToolCategory;
  /** The tool rows, already built by the caller — this row owns the fold, not the contents. */
  children: ReactNode;
  granted: number;
  total: number;
  mode: ToolsetMode | undefined;
  open: boolean;
  onOpen: () => void;
  /**
   * Set every line under it. Absent ⇒ no button: a toolset on the page lists only what it HOLDS, and
   * a head that re-moded those lines would be a second way to do what each line's own button does.
   */
  onMode?: ((next: ToolsetMode) => void) | undefined;
}): JSX.Element {
  return (
    <div className={`cx-cat${open ? " open" : ""}`}>
      <div className="cx-cat-head">
        <button type="button" className="cx-cat-fold" aria-expanded={open} onClick={onOpen}>
          <span className="cx-more cx-cat-chev">›</span>
          <span className="cx-opt-text">
            <span className="cx-opt-name ellip">{category.label}</span>
            <span className="cx-opt-hint ellip">{category.hint}</span>
          </span>
          {granted > 0 ? <span className="cx-cat-count">{granted}</span> : null}
        </button>
        {onMode !== undefined ? <ModePicker mode={mode} title={`${category.label}: sets every tool under it`} onMode={onMode} /> : null}
      </div>
      {open ? <div className="cx-cat-body">{children}</div> : null}
    </div>
  );
}

/**
 * A line of Execution that is not a tool: a command the toolset names (`git commit`), or `script`.
 *
 * Drawn as a tool's line is — tick, glyph, name, mode — because it IS one line of the same map, and
 * answers to the same four modes. It has no implementation: nobody's code is being chosen, a part of
 * a shell line is being judged. Unticking a command takes its line out of the map, which is the only
 * way a map has of not naming something.
 */
export function SubjectRow({
  subject,
  hint,
  held,
  mode,
  onHeld,
  onMode,
  line,
  onRemove,
  readOnly,
}: {
  subject: string;
  hint?: string;
  held: boolean;
  mode: ToolsetMode;
  onHeld?: (() => void) | undefined;
  onMode: (next: ToolsetMode) => void;
  /** A line of a toolset on the page, not a tick box — see {@link ToolRow}. */
  line?: boolean | undefined;
  onRemove?: (() => void) | undefined;
  readOnly?: boolean | undefined;
}): JSX.Element {
  const script = subject === SCRIPT_SUBJECT;
  const words = (
    <>
      <span className="cx-chip-icon">
        <Icon name={script ? "script" : "terminal"} />
      </span>
      <span className="cx-opt-text">
        <span className="cx-opt-name ellip">{script ? subject : <span className="mono">{subject}</span>}</span>
        <span className="cx-opt-hint ellip">{hint ?? ""}</span>
      </span>
    </>
  );
  return (
    <div className={`cx-tool${held ? " on" : ""}${line === true && onRemove !== undefined ? " set-held" : ""}`}>
      {line === true && onRemove !== undefined ? <RemoveLine subject={subject} onRemove={onRemove} /> : null}
      {line === true ? (
        <span className="cx-tool-grant" title={hint ?? subject}>
          {words}
        </span>
      ) : (
        <button type="button" className="cx-tool-grant" title={hint ?? subject} onClick={onHeld}>
          <span className="cx-tick">{held ? "✓" : ""}</span>
          {words}
        </button>
      )}
      <ModePicker mode={mode} title={`${subject}: ${modeMeta(mode).hint}`} onMode={onMode} readOnly={readOnly} />
    </div>
  );
}

/** One thing a section does not hold yet, as {@link AddMenu} lists it. */
export interface AddOption {
  /** The subject a pick writes: `glob`, `script`, `git push`. */
  subject: string;
  label: string;
  hint?: string | undefined;
  icon?: Parameters<typeof Icon>[0]["name"] | undefined;
  /** The name is a command, so it is set in the data face. */
  mono?: boolean | undefined;
}

/**
 * The last line of a section or a group in a toolset being edited: "add a tool", "add a git
 * subcommand" — which opens the card's own submenu, listing what that section does NOT hold yet.
 *
 * A pick adds the line. Where the thing to add can also be TYPED — a command nobody listed — the
 * menu's last row opens the same one-box form the composer's {@link AddLine} is, in the row's place.
 * With nothing to list and nothing to type, the line is not drawn: every tool of the section is held.
 */
export function AddMenu({
  label,
  options,
  onPick,
  typed,
  startOpen,
}: {
  label: string;
  options: readonly AddOption[];
  onPick: (subject: string) => void;
  /** Offer "another…": what the box asks for, an example, and the add that may refuse what was typed. */
  typed?: { label: string; example: string; onAdd: (typed: string) => string | undefined } | undefined;
  /** Drawn open from the first render — for a still picture. */
  startOpen?: boolean | undefined;
}): JSX.Element | null {
  const [open, setOpen] = useState(startOpen === true);
  const [typing, setTyping] = useState(false);
  const box = useAway<HTMLDivElement>(open, () => setOpen(false));
  if (options.length === 0 && typed === undefined) return null;
  if (typing && typed !== undefined) {
    return <AddLine label={typed.label} example={typed.example} onAdd={typed.onAdd} startOpen onClose={() => setTyping(false)} />;
  }
  return (
    <div className="cx-tool set-add-line">
      <div className="cx-origin-wrap" ref={box}>
        <button
          type="button"
          className="set-add"
          aria-expanded={open}
          onClick={() => {
            // Nothing to list: the line IS the typed form, so one click reaches the box.
            if (options.length === 0) setTyping(true);
            else setOpen((v) => !v);
          }}
        >
          <span className="set-plus" aria-hidden>
            +
          </span>
          <span className="cx-opt-hint">{label}</span>
        </button>
        {open ? (
          <div className="cx-submenu">
            {options.map((option) => (
              <button
                key={option.subject}
                type="button"
                title={option.hint ?? option.label}
                onClick={() => {
                  onPick(option.subject);
                  setOpen(false);
                }}
              >
                <span className="cx-tick" />
                <span className="cx-chip-icon">
                  <Icon name={option.icon ?? "tool"} />
                </span>
                <span className="cx-opt-text">
                  <span className={`cx-opt-name ellip${option.mono === true ? " mono" : ""}`}>{option.label}</span>
                  <span className="cx-opt-hint ellip">{option.hint ?? ""}</span>
                </span>
              </button>
            ))}
            {typed !== undefined ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setTyping(true);
                }}
              >
                <span className="cx-tick" />
                <span className="cx-chip-icon">
                  <Icon name="terminal" />
                </span>
                <span className="cx-opt-text">
                  <span className="cx-opt-name ellip">another…</span>
                  <span className="cx-opt-hint ellip">{`type one, like ${typed.example}`}</span>
                </span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The last line of a group or of Execution: add a subcommand, or a command.
 *
 * One string, asked through the schema form like every other typed input. What comes back from
 * `onAdd` is what was wrong with it, said under the box — a tool's name, `other`, something that
 * does not read as a program — or nothing, and the line closes.
 */
export function AddLine({
  label,
  example,
  onAdd,
  startOpen,
  onClose,
}: {
  label: string;
  example: string;
  onAdd: (typed: string) => string | undefined;
  /** Open on the box from the first render — how {@link AddMenu}'s "another…" arrives here. */
  startOpen?: boolean | undefined;
  /** Told when the box closes, added or cancelled, so a host that swapped this in can swap it out. */
  onClose?: (() => void) | undefined;
}): JSX.Element {
  const [open, setOpenState] = useState(startOpen === true);
  const setOpen = (next: boolean): void => {
    setOpenState(next);
    if (!next) onClose?.();
  };
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const schema: Schema = {
    type: "object",
    properties: { command: { type: "string", title: label, minLength: 1, description: `like ${example}` } },
    required: ["command"],
  };
  const add = (): void => {
    const wrong = onAdd(typed);
    setProblem(wrong ?? null);
    if (wrong !== undefined) return;
    setTyped("");
    setOpen(false);
  };
  return (
    <div className="cx-tool set-add-line">
      {open ? (
        <div className="cx-set-line-form">
          <SchemaForm
            schema={schema}
            value={{ command: typed }}
            onChange={(next) => setTyped(String((next as { command?: unknown } | undefined)?.command ?? ""))}
            ctx={{ path: "", hidePaths: true }}
          />
          {problem !== null ? <p className="sub warn-text">{problem}</p> : null}
          <div className="cx-set-new-foot">
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setOpen(false);
                setProblem(null);
              }}
            >
              Cancel
            </button>
            <button type="button" className="primary" onClick={add}>
              Add
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="set-add" aria-expanded={false} onClick={() => setOpen(true)}>
          <span className="set-plus" aria-hidden>
            +
          </span>
          <span className="cx-opt-hint">{label}</span>
        </button>
      )}
    </div>
  );
}

/**
 * One PROGRAM under Execution: a fold over the subcommands the toolset names.
 *
 * It looks like a section and differs from one in the way that matters: its mode is NOT derived. It
 * is the entry for the bare program (`"git": …`), which stands for any other `git` — so setting it
 * writes that one line and leaves `git status` and `git commit` saying what they said. With no such
 * entry the button shows what any other `git` answers to today, the shell's line, and picking a mode
 * is what writes one.
 */
export function CommandGroupRow({
  group,
  toolset,
  open,
  onOpen,
  onMode,
  children,
  onRemove,
  readOnly,
}: {
  group: CommandGroup;
  toolset: Toolset;
  open: boolean;
  onOpen: () => void;
  onMode: (next: ToolsetMode) => void;
  children: ReactNode;
  /** Take the whole program out — its own line and every subcommand under it. Draws the minus. */
  onRemove?: (() => void) | undefined;
  readOnly?: boolean | undefined;
}): JSX.Element {
  return (
    <div className={`cx-cat cx-sub${open ? " open" : ""}`}>
      <div className="cx-cat-head">
        {onRemove !== undefined ? <RemoveLine subject={group.program} onRemove={onRemove} /> : null}
        <button type="button" className="cx-cat-fold" aria-expanded={open} onClick={onOpen}>
          <span className="cx-more cx-cat-chev">›</span>
          <span className="cx-chip-icon">
            <Icon name="terminal" />
          </span>
          <span className="cx-opt-text">
            <span className="cx-opt-name ellip">
              <span className="mono">{group.program}</span>
            </span>
            <span className="cx-opt-hint ellip">{open ? groupSentence(toolset, group) : groupSummary(toolset, group)}</span>
          </span>
          {group.subs.length > 0 ? <span className="cx-cat-count">{group.subs.length}</span> : null}
        </button>
        <ModePicker
          mode={groupModeOf(toolset, group)}
          title={`${group.program}: any ${group.program} command not named under it`}
          onMode={onMode}
          readOnly={readOnly}
        />
      </div>
      {open ? <div className="cx-cat-body">{children}</div> : null}
    </div>
  );
}
