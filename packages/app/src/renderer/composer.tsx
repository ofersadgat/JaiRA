/**
 * The box you type into, and the settings the message will run under.
 *
 * A message sent here is not a comment on the run — it is a prompt operation, executed against the
 * same conversation the state on screen was having. Sending spends money and can reach the
 * repository, so what it will run AS belongs on the composer rather than behind a menu.
 *
 * ## One surface, and one control per question
 *
 * Everything lives inside a single rounded shell: the box, the row of settings under it, and the
 * button that sends. Three stacked panels read as three unrelated controls that happen to sit near
 * each other, and what you are composing is one thing.
 *
 * Each setting opens on its OWN, from its own chip. A single panel holding all of them meant that
 * changing the model made you look at permissions and tools as well, and made the composer jump by a
 * hundred pixels to answer a question about one word.
 *
 * ## Every chip shows what will HAPPEN, not what was written
 *
 * A chip reading "no model" answers a question nobody asked: it is a fact about the workflow FILE,
 * while the person is about to press Enter and wants to know what runs. So the chips carry the
 * EFFECTIVE values — resolved, never blank — and where nothing can be known they name the thing that
 * decides rather than inventing a value.
 *
 * ## Tools are the app's to hand over
 *
 * JaiRA registers the tools and compiles the policy, so it always knows what it is allowing — and a
 * turn sent from here puts each one under that policy with `gateTools`, the same `withPermission`
 * primitive the engine uses. So these are real controls, not a report: ticking `bash` gives this
 * message a shell, gated exactly as the surrounding state's would be.
 *
 * The list is the WHOLE list, never an addition — `tools` merges by replacement, and `[]` is how an
 * inherited tool is dropped. Which is why the boxes start ticked at what the state inherited: an
 * empty box beside an operation carrying `bash` would offer to add a tool the call already has, and
 * would silently disarm it if the person sent without touching anything.
 */
import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import {
  PERMISSION_MODES,
  PERMISSION_PRESETS,
  presetModes,
  presetOf,
  REASONING_EFFORTS,
  type ChatPlanView,
  type ChatSettings,
  type PermissionMode,
  type ReasoningEffort,
  type SettingOrigin,
  type ToolChoice,
} from "@jaira/shared/browser";
import { BrandIcon, Icon } from "./icons";

/** The half before the first slash — who answers. Empty when the id names no route. */
function routeOf(model: string): string {
  const cut = model.indexOf("/");
  return cut > 0 ? model.slice(0, cut) : "";
}

/**
 * Re-point an id at another route, keeping the model it named — when that route actually has it.
 *
 * "The same model somewhere else" is the common move — one subscription runs out, a provider is
 * down — and retyping the model to make it would be the tax on the thing people do most.
 *
 * But it is a LOOKUP, not string surgery. Routes do not share an id shape: `openrouter` ids carry a
 * vendor tier and `anthropic` ids do not, so splicing a prefix turned `openrouter/openai/gpt-5` into
 * `anthropic/openai/gpt-5` — an id no route serves, offered by a picker whose whole job is to only
 * offer things that exist. Matching on the LEAF instead means a re-point either lands on a real row
 * or reports that it cannot, and the caller drills in rather than inventing one.
 */
function repoint(route: string, model: string, models: readonly PickModel[]): string | undefined {
  const leaf = tierOf(model).leaf;
  if (leaf === "") return undefined;
  // The borrowed catalog when the route has one, so moving to `claude-cli` finds Anthropic's rows.
  const from = ROUTE_BORROWS[route] ?? route;
  const found = models.find((m) => tierOf(m.id).route === from && tierOf(m.id).leaf === leaf);
  if (found === undefined) return undefined;
  return ROUTE_BORROWS[route] === undefined ? found.id : `${route}/${found.id.slice(from.length + 1)}`;
}

/** What each thinking level buys, so the word is not the only thing to go on. */
const EFFORT_HINTS: Record<string, string> = {
  low: "quickest, least deliberation",
  medium: "a balance",
  high: "works the problem",
  xhigh: "deepest — slowest and dearest",
};

/** What granting each tool actually lets the model do. */
const TOOL_HINTS: Record<string, string> = {
  bash: "run shell commands, under the policy",
  read_file: "read files in the workspace",
  write_file: "create and change files",
};

const TOOL_ICONS: Record<string, Parameters<typeof Icon>[0]["name"]> = {
  bash: "terminal",
  read_file: "read",
  write_file: "write",
};

/**
 * One option in a picker: a name, the sentence that explains it, and a tick when it is in force.
 *
 * Shared by every picker so they cannot drift into as many shapes. The second line is the point —
 * these are closed sets where the differences are worth a sentence, and a bare word makes you guess
 * what "smart" or "xhigh" buys you.
 */
function Opt({
  on,
  icon,
  name,
  hint,
  title,
  onPick,
}: {
  on: boolean;
  icon?: Parameters<typeof Icon>[0]["name"];
  name: string;
  hint?: string;
  title?: string;
  onPick: () => void;
}): JSX.Element {
  return (
    <button type="button" className={on ? "on" : undefined} title={title ?? hint ?? name} onClick={onPick}>
      {icon !== undefined ? (
        <span className="cx-chip-icon">
          <Icon name={icon} />
        </span>
      ) : null}
      <span className="cx-opt-text">
        <span className="cx-opt-name ellip">{name}</span>
        {hint !== undefined ? <span className="cx-opt-hint ellip">{hint}</span> : null}
      </span>
      {on ? <span className="cx-opt-tick">✓</span> : null}
    </button>
  );
}

/**
 * What one permission MODE means, and the glyph for it.
 *
 * Drawn as what the agent may DO rather than as a tier: a shut lock asks every time, the same lock
 * open goes ahead, a shield refuses, a star is the approver deciding per call. Somebody scanning a
 * tool row is asking what happens when that tool is reached, and a rank answers a different question.
 */
const MODE_META: Record<PermissionMode, { icon: Parameters<typeof Icon>[0]["name"]; label: string; hint: string }> = {
  ask: { icon: "lock", label: "ask", hint: "stop and ask before each call" },
  smart: { icon: "star", label: "auto", hint: "decided per call by the approver" },
  allow: { icon: "unlocked", label: "allow", hint: "goes ahead without asking" },
  deny: { icon: "shield", label: "deny", hint: "refused every time" },
};

/** The mode a tool nothing has spoken for ends up in — the ledger's own last resort. */
const MODE_WHEN_UNSET: PermissionMode = "ask";

/** A model as the picker sees it — the id, and what it can be given and produce. */
interface PickModel {
  id: string;
  input: string[];
  output: string[];
}

/**
 * The tier between route and model, when a route HAS one.
 *
 * `openrouter/openai/gpt-5` names a route, then whose model it is, then the model — three parts, so
 * three columns. `anthropic/claude-sonnet-5` has two. The picker follows the id rather than a list of
 * special cases: a route whose ids carry a second slash grows a middle column, and one whose ids do
 * not goes straight to models. Local and any other aggregating route get it for free.
 */
/**
 * The provider whose models an AGENT route can be asked for.
 *
 * `claude-cli` runs Anthropic's models on a subscription and `codex-cli` passes `-c model=…` through
 * to OpenAI's, so "which model" is a real question for both — they just have no catalog rows of their
 * own, because what they publish is a binary rather than a price list. Borrowing the provider's list
 * is what makes them choosable instead of a dead end reading "picks its own".
 */
const ROUTE_BORROWS: Record<string, string> = {
  "claude-cli": "anthropic",
  "claude-code": "anthropic",
  "codex-cli": "openai",
};

function tierOf(id: string): { route: string; group?: string; leaf: string } {
  const parts = id.split("/");
  const route = parts[0] ?? "";
  if (parts.length >= 3) return { route, group: parts[1]!, leaf: parts.slice(2).join("/") };
  return { route, leaf: parts.slice(1).join("/") };
}

/** Every modality any known model mentions, so the filters are the real vocabulary and not a guess. */
function modalitiesOf(models: readonly PickModel[], side: "input" | "output"): string[] {
  return [...new Set(models.flatMap((m) => m[side]))].sort();
}

/**
 * The glyph for one modality.
 *
 * Icons rather than words because these are the least interesting thing on the row and the most
 * repeated: four words twice over crowds out the columns, which are what the menu is for.
 */
function modalityIcon(mode: string): "read" | "web" | "note" | "think" {
  if (mode === "image") return "read";
  if (mode === "audio") return "web";
  if (mode === "text") return "note";
  return "think";
}

/**
 * One side's modality filter: a button showing what is selected, opening a multi-select.
 *
 * MULTI-select, and the semantics are AND — a model has to do everything ticked. Asking for image and
 * audio input means a model that takes both, which is the only reading that makes ticking two useful;
 * OR would widen the list as you narrow the question.
 *
 * The button shows the ticked glyphs rather than a count, so the filter states itself while closed —
 * a badge reading "2" makes you open it to find out what you asked for.
 */
function ModalityFilter({
  side,
  options,
  value,
  onChange,
}: {
  side: "input" | "output";
  options: readonly string[];
  value: readonly string[];
  onChange: (next: string[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const toggle = (mode: string): void =>
    onChange(value.includes(mode) ? value.filter((m) => m !== mode) : [...value, mode]);

  return (
    <div className="cx-filter" ref={box}>
      <button
        type="button"
        className={`cx-filter-btn${value.length > 0 ? " on" : ""}`}
        aria-expanded={open}
        title={value.length === 0 ? `any ${side}` : `${side}: ${value.join(" + ")}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cx-filter-label">{side === "input" ? "in" : "out"}</span>
        {value.length === 0 ? (
          <span className="cx-filter-any">any</span>
        ) : (
          value.map((mode) => (
            <span key={mode} className="cx-chip-icon">
              <Icon name={modalityIcon(mode)} />
            </span>
          ))
        )}
      </button>
      {open ? (
        <div className="cx-filter-pop">
          {options.map((mode) => (
            <button key={mode} type="button" className={value.includes(mode) ? "on" : undefined} onClick={() => toggle(mode)}>
              <span className="cx-tick">{value.includes(mode) ? "✓" : ""}</span>
              <span className="cx-chip-icon">
                <Icon name={modalityIcon(mode)} />
              </span>
              <span className="ellip">{mode}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Route → (group) → model, drilled into on HOVER — findmyprompt's miller-columns picker.
 *
 * Hovering rather than clicking to drill is the part worth copying. A menu you have to click twice to
 * read is one you stop opening, and a hovered column is a preview of a choice rather than a
 * commitment to it — only a click on a model changes anything.
 *
 * The height is FIXED. A menu that grows and shrinks as you move along the first column makes the
 * thing you are pointing at move, and this one sits above a box someone is typing in.
 */
function RouteCascade({
  routes,
  models,
  current,
  onPick,
}: {
  routes: readonly string[];
  models: readonly PickModel[];
  /** The id in force, so every column can show where the reader already is. */
  current: string;
  onPick: (model: string) => void;
}): JSX.Element {
  const here = tierOf(current);
  const [route, setRoute] = useState<string>(here.route);
  const [group, setGroup] = useState<string | undefined>(here.group);
  const [needs, setNeeds] = useState<{ input: string[]; output: string[] }>({ input: [], output: [] });

  // AND across ticks: a model has to do everything asked for. OR would widen the list as you narrow
  // the question, which is the opposite of what a filter is for.
  const matching = models.filter(
    (m) => needs.input.every((mode) => m.input.includes(mode)) && needs.output.every((mode) => m.output.includes(mode)),
  );
  const borrows = ROUTE_BORROWS[route];
  const inRoute = matching
    .filter((m) => tierOf(m.id).route === (borrows ?? route))
    // Re-prefixed, so picking one names the ROUTE the reader chose rather than the one it was
    // borrowed from — `claude-cli/claude-sonnet-5`, not `anthropic/claude-sonnet-5`.
    .map((m) => (borrows === undefined ? m : { ...m, id: `${route}/${m.id.slice(borrows.length + 1)}` }));
  const groups = [...new Set(inRoute.map((m) => tierOf(m.id).group).filter((g): g is string => g !== undefined))].sort();
  // The hovered group, or the first — so the third column has something in it the moment the second
  // appears. Requiring a second hover to see any model made the column read as broken rather than as
  // waiting, which is exactly how it was reported.
  const shown = group !== undefined && groups.includes(group) ? group : groups[0];
  // A route with groups shows that one's models; a route without goes straight to models.
  const leaves = groups.length === 0 ? inRoute : inRoute.filter((m) => tierOf(m.id).group === shown);

  // Every route the machine can reach, plus any a known model names. A route with no catalog rows —
  // an agent that picks its own weights — still belongs here, because choosing it IS the choice.
  const columns = [...new Set([...routes, ...matching.map((m) => tierOf(m.id).route)])].filter((r) => r !== "").sort();

  const drill = (r: string): void => {
    setRoute(r);
    setGroup(undefined);
  };

  return (
    <>
      <div className="cx-filters cx-filters-row">
        {(["input", "output"] as const).map((side) => (
          <ModalityFilter
            key={side}
            side={side}
            options={modalitiesOf(models, side)}
            value={needs[side]}
            onChange={(next) => setNeeds({ ...needs, [side]: next })}
          />
        ))}
      </div>
      <div className="cx-cascade">
        <div className="cx-col">
          {columns.map((r) => (
            <button
              key={r}
              type="button"
              // TWO states, and they are different questions: `on` is where the pointer is, `live` is
              // where the conversation actually is. Conflating them loses the second the moment you
              // hover anything, which is exactly when you want to compare against it.
              className={`${r === route ? "on" : ""}${r === here.route ? " live" : ""}`.trim() || undefined}
              onMouseEnter={() => drill(r)}
              onFocus={() => drill(r)}
              // Clicking a route takes the same model there when that route HAS it. When it does not,
              // the click is just the drill it already was on hover — the column beside it is now
              // showing what this route offers, which is the honest next step. Picking a route was
              // never a way to name a model the route does not serve.
              onClick={() => {
                const there = repoint(r, current, models);
                if (there !== undefined) onPick(there);
                else drill(r);
              }}
            >
              <span className="cx-chip-icon">
                <BrandIcon name={r} />
              </span>
              <span className="cx-opt-text">
                <span className="cx-opt-name ellip">{r}</span>
              </span>
              <span className="cx-more">›</span>
            </button>
          ))}
        </div>

        {groups.length > 0 ? (
          <div className="cx-col">
            {groups.map((g) => (
              <button
                key={g}
                type="button"
                className={`${g === shown ? "on" : ""}${route === here.route && g === here.group ? " live" : ""}`.trim() || undefined}
                onMouseEnter={() => setGroup(g)}
                onFocus={() => setGroup(g)}
              >
                <span className="cx-chip-icon">
                  <BrandIcon name={g} />
                </span>
                <span className="cx-opt-text">
                  <span className="cx-opt-name ellip">{g}</span>
                </span>
                <span className="cx-more">›</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="cx-col cx-col-last">
          {ROUTE_BORROWS[route] !== undefined ? (
            // A CLI picks its own model unless told otherwise, and letting it is the DEFAULT rather
            // than a failure to choose — pinning one is how you stop tracking whatever it upgrades to.
            <button
              type="button"
              className={current === route || current === `${route}/default` ? "on live" : undefined}
              onClick={() => onPick(`${route}/default`)}
            >
              <span className="cx-tick">{current === `${route}/default` ? "✓" : ""}</span>
              <span className="cx-opt-text">
                <span className="cx-opt-name ellip">default</span>
                <span className="cx-opt-hint ellip">whatever the CLI picks</span>
              </span>
            </button>
          ) : null}
          {leaves.length === 0 && ROUTE_BORROWS[route] === undefined ? (
            <span className="cx-hint">
              {"this route picks its own model"}
            </span>
          ) : (
            leaves.map((m) => (
              <button key={m.id} type="button" className={m.id === current ? "on live" : undefined} onClick={() => onPick(m.id)}>
                <span className="cx-tick">{m.id === current ? "✓" : ""}</span>
                <span className="cx-opt-text">
                  <span className="cx-opt-name ellip">{tierOf(m.id).leaf}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </>
  );
}

/** Where a value came from — what a chip's popover says under its title. */
function Origin({ origin, from }: { origin: SettingOrigin; from?: string }): JSX.Element {
  if (origin === "override") return <span className="cx-origin cx-own">your choice for this message</span>;
  if (origin === "unset") return <span className="cx-origin cx-unset">nothing here sets it</span>;
  return <span className="cx-origin">{from === undefined ? "inherited" : `inherited from ${from}`}</span>;
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
 */
function ToolRow({
  tool,
  granted,
  mode,
  onGrant,
  onMode,
}: {
  tool: ToolChoice;
  granted: boolean;
  mode: PermissionMode;
  onGrant: () => void;
  onMode: (next: PermissionMode) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const meta = MODE_META[mode];
  return (
    <div className={`cx-tool${granted ? " on" : ""}`} ref={box}>
      <button type="button" className="cx-tool-grant" title={TOOL_HINTS[tool.name] ?? tool.name} onClick={onGrant}>
        <span className="cx-tick">{granted ? "✓" : ""}</span>
        <span className="cx-chip-icon">
          <Icon name={TOOL_ICONS[tool.name] ?? "tool"} />
        </span>
        <span className="cx-opt-text">
          <span className="cx-opt-name ellip">{tool.name}</span>
          <span className="cx-opt-hint ellip">{TOOL_HINTS[tool.name] ?? (tool.readOnly ? "reads only" : "can change things")}</span>
        </span>
      </button>
      <button
        type="button"
        className={`cx-tool-mode cx-mode-${mode}`}
        aria-expanded={open}
        title={`${tool.name}: ${meta.hint}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cx-chip-icon">
          <Icon name={meta.icon} />
        </span>
        <span className="ellip">{meta.label}</span>
        <span className="cx-more">›</span>
      </button>
      {open ? (
        <div className="cx-submenu">
          {PERMISSION_MODES.map((value) => (
            <button
              key={value}
              type="button"
              className={value === mode ? "on" : undefined}
              onClick={() => {
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
        </div>
      ) : null}
    </div>
  );
}

/**
 * One setting: a chip that says what will happen, and a popover that changes it.
 *
 * Closes on an outside click and on Escape, because it sits above a box someone is typing in, and a
 * panel that stays open until you find its button again is in the way.
 */
function Chip({
  icon,
  brand,
  label,
  value,
  origin,
  from,
  onReset,
  children,
}: {
  icon?: "model" | "shield" | "think" | "tool";
  /** A company to draw the mark of, when the chip is about one. Wins over {@link icon}. */
  brand?: string;
  label: string;
  /** The EFFECTIVE value, already resolved. Never blank — see the module header. */
  value: string;
  origin: SettingOrigin;
  from?: string;
  /** Offered only for an override: going back to what the workflow says is a real thing to want. */
  onReset?: () => void;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const esc = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="cx-chip-wrap" ref={box}>
      <button
        type="button"
        className={`cx-chip${open ? " on" : ""}${origin === "override" ? " own" : ""}`}
        aria-expanded={open}
        title={`${label}: ${value}`}
        onClick={() => setOpen((v) => !v)}
      >
        {brand !== undefined ? (
          <span className="cx-chip-icon">
            <BrandIcon name={brand} />
          </span>
        ) : icon !== undefined ? (
          <span className="cx-chip-icon">
            <Icon name={icon} />
          </span>
        ) : null}
        <span className="ellip">{value}</span>
      </button>
      {open ? (
        <div className="cx-pop">
          <div className="cx-pop-head">
            <span className="cx-pop-title">{label}</span>
            <Origin origin={origin} from={from} />
            {onReset !== undefined && origin === "override" ? (
              <button type="button" className="cx-reset" onClick={onReset}>
                reset
              </button>
            ) : null}
          </div>
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function Composer({
  plan,
  busy,
  overrides,
  onOverrides,
  onSend,
  disabled,
}: {
  /** What the message would run under right now — inherited, with any overrides already folded in. */
  plan: ChatPlanView | null;
  /** A turn is in flight. The box stays readable; only sending is refused. */
  busy?: boolean;
  overrides: ChatSettings;
  onOverrides: (next: ChatSettings) => void;
  onSend: (message: string) => void;
  /** Why sending is impossible at all — no conversation to continue, say. */
  disabled?: string;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const settings = plan?.settings ?? {};
  const origin = plan?.origin ?? {
    model: "unset" as const,
    reasoning: "unset" as const,
    tools: "unset" as const,
    permissions: "unset" as const,
  };
  const tools = settings.tools ?? [];
  // What this project can gate, and the modes in force over them. The map is what reaches the
  // executor; the preset is only what to CALL it, and `undefined` there means the modes are nobody's
  // preset — which is what `custom` says on the chip.
  const offered = plan?.available.tools ?? [];
  const modes = settings.permissions?.tools ?? {};
  const preset = presetOf(modes, offered);
  // Never blank. A control with nothing in it cannot be read as "this is what will happen", which is
  // the only question this row exists to answer.
  const effective = plan?.effective ?? { reasoning: "…", permissions: "…" };
  // Which CLI is answering, if one is — it changes what "default" means for both model and tools.
  const cliRoute = ROUTE_BORROWS[routeOf(effective.model ?? "")] !== undefined ? routeOf(effective.model ?? "") : undefined;
  // What the box edits: the override if there is one, else the resolved value it would replace.
  const current = settings.model ?? effective.model ?? "";

  const send = (): void => {
    const message = draft.trim();
    if (message === "" || busy === true || disabled !== undefined) return;
    onSend(message);
    setDraft("");
  };

  // Enter sends and Shift+Enter breaks the line, which is what every chat client does — and a prompt
  // is frequently several lines, so the modifier belongs on the newline rather than on the send.
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const set = (patch: ChatSettings): void => onOverrides({ ...overrides, ...patch });
  const clear = (key: keyof ChatSettings): void => {
    const next = { ...overrides };
    delete next[key];
    onOverrides(next);
  };

  return (
    <div className="cx">
      {/* A padded RING rather than a border, so focus brightens it without the contents shifting. */}
      <div className="cx-frame">
        <div className="cx-shell">
          <textarea
            className="cx-text"
            value={draft}
            rows={2}
            placeholder={disabled ?? "Ask for more changes…"}
            disabled={disabled !== undefined}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
          />

          <div className="cx-foot">
            <Chip
              brand={routeOf(effective.model ?? "")}
              label="Model"
              value={effective.model ?? "no model configured"}
              origin={origin.model}
              from={plan?.from}
              onReset={() => clear("model")}
            >
              <RouteCascade
                routes={plan?.available.routes ?? []}
                models={plan?.available.models ?? []}
                current={current}
                onPick={(model) => set({ model })}
              />
            </Chip>

            <Chip
              icon="think"
              label="Thinking"
              value={effective.reasoning}
              origin={origin.reasoning}
              from={plan?.from}
              onReset={() => clear("reasoning")}
            >
              <div className="cx-opts">
                {REASONING_EFFORTS.map((effort) => (
                  <Opt
                    key={effort}
                    on={settings.reasoning?.effort === effort}
                    icon="think"
                    name={effort}
                    hint={EFFORT_HINTS[effort]}
                    onPick={() => set({ reasoning: { effort: effort as ReasoningEffort } })}
                  />
                ))}
              </div>
              <p className="cx-hint">A model that tops out lower clamps rather than refusing.</p>
            </Chip>

            <Chip
              icon="shield"
              label="Permissions"
              value={effective.permissions}
              origin={origin.permissions}
              from={plan?.from}
              onReset={() => clear("permissions")}
            >
              <div className="cx-opts">
                {PERMISSION_PRESETS.map((choice) => (
                  <Opt
                    key={choice.id}
                    on={preset?.id === choice.id}
                    icon={MODE_META[choice.modeFor({ name: "", readOnly: false })].icon}
                    name={choice.label}
                    hint={choice.hint}
                    // Spent on the click: it writes a mode for every tool and then has no further
                    // say. What runs is the map, which is the list under the Tools chip — so the
                    // reader can see what a preset did and change any part of it.
                    onPick={() => set({ permissions: { ...settings.permissions, tools: presetModes(choice, offered) } })}
                  />
                ))}
              </div>
              <p className="cx-hint">
                {preset === undefined
                  ? "These modes match no preset — set per tool under Tools."
                  : "A starting point. Change any tool's mode under Tools and this becomes custom."}
              </p>
            </Chip>

            <Chip
              icon="tool"
              label="Tools"
              // An empty list means two different things and the chip has to say which. On a CLI
              // route it is the DEFAULT — leave the agent its own tools — and reading "no tools"
              // beside a ticked "default" row was the chip contradicting the list under it.
              value={
                tools.length === 0
                  ? cliRoute !== undefined
                    ? "default tools"
                    : "no tools"
                  : tools.length === 1
                    ? tools[0]!
                    : `${tools.length} tools`
              }
              origin={origin.tools}
              from={plan?.from}
              onReset={() => clear("tools")}
            >
              <div className="cx-opts">
                {cliRoute !== undefined ? (
                  // A delegated CLI arrives with its own tools and enforces them through its own
                  // permission callback. Declaring NONE here is what leaves it to them — a different
                  // thing from a call with no tools, and the only way to say it.
                  <Opt
                    on={tools.length === 0}
                    name="default"
                    hint={`${cliRoute}'s own tools, gated by the CLI`}
                    onPick={() => set({ tools: [] })}
                  />
                ) : null}
                {offered.map((tool) => (
                  <ToolRow
                    key={tool.name}
                    tool={tool}
                    granted={tools.includes(tool.name)}
                    mode={modes[tool.name] ?? MODE_WHEN_UNSET}
                    // The WHOLE list every time — see the module header on replacement.
                    onGrant={() =>
                      set({ tools: tools.includes(tool.name) ? tools.filter((t) => t !== tool.name) : [...tools, tool.name] })
                    }
                    onMode={(next) =>
                      set({ permissions: { ...settings.permissions, tools: { ...modes, [tool.name]: next } } })
                    }
                  />
                ))}
              </div>
              <p className="cx-hint">
                {offered.length === 0
                  ? "This project registers no tools."
                  : "Ticking a tool offers it; the mode beside it is what happens when it is called."}
              </p>
            </Chip>

            {plan !== null && plan.unresolved.length > 0 ? (
              <span className="cx-warn ellip">
                {plan.unresolved.map((u) => u.field).join(", ")} {plan.unresolved.length === 1 ? "is" : "are"} an expression here
              </span>
            ) : null}

            <span className="grow" />

            {/* Three different things wear one button, and the box alone cannot say which. */}
            {plan?.live === "steerable" || plan?.live === "busy" ? (
              <span className={`cx-live${plan.live === "busy" ? " cx-live-wait" : ""}`}>
                <span className="ts-pulse" aria-hidden>
                  <span />
                  <span />
                  <span />
                </span>
                {plan.live === "steerable" ? "joins this turn" : "waits for this turn"}
              </span>
            ) : null}

            <button
              type="button"
              className="cx-send"
              aria-label="Send"
              title="Enter to send, Shift+Enter for a new line"
              disabled={draft.trim() === "" || busy === true || disabled !== undefined}
              onClick={send}
            >
              <Icon name="send" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
