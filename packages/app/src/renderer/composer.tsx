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
 *
 * ## Permissions and Tools are two views of one TOOLSET
 *
 * What a message may do is one map from a subject to a mode (decision 0007). The Permissions card
 * picks a whole one — its rows are the toolsets of a BUCKET, a folder of them on the layered search
 * path — and the Tools card changes a line of it. Either way what is sent is the whole map, as
 * `ChatSettings.toolset`; the list, the block and the implementations map are only what a state's
 * own declaration still arrives as, and `toolsetOfSettings` reads both into the one shape drawn here.
 *
 * A label is a MATCH, never a memory. The Permissions chip reads a toolset's name while the map is
 * exactly that toolset's, and `custom` the moment a line differs; nothing records where a map began.
 * Every edit is a pure function in `composerToolset.ts`, which is where the tests are.
 */
import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import {
  declaresTools,
  declOfToolset,
  DEFAULT_TOOLSET_BUCKET,
  heldTools,
  holdsTool,
  matchToolset,
  MODE_WHEN_UNSET,
  parseToolset,
  PERMISSION_MODES,
  REASONING_EFFORTS,
  SCRIPT_SUBJECT,
  SHELL_TOOL,
  toolsetBuckets,
  toolsetGlyph,
  toolsetHint,
  toolsetsOfBucket,
  toolsetLabel,
  toolsetNameProblem,
  toolsetOfSettings,
  TOOLSET_LAYER_LABELS,
  type ChatPlanView,
  type ChatSettings,
  type PermissionMode,
  type ReasoningEffort,
  type SaveToolsetRequest,
  type SettingOrigin,
  type ToolCategory,
  type ToolChoice,
  type ToolImplementation,
  type Toolset,
  type ToolsetBucket,
  type ToolsetChoice,
  type ToolSpec,
  type WritableLayer,
  TOOL_CATEGORIES,
  TOOL_SPEC_BY_NAME,
} from "@jaira/shared/browser";
import {
  commandGroupsOf,
  commandSubjectOf,
  groupModeOf,
  groupSentence,
  groupSummary,
  sectionCountOf,
  sectionModeOf,
  toolImplementationOf,
  toolModeOf,
  withCommand,
  withOther,
  withoutSubject,
  withSectionMode,
  withSubject,
  withSubjectMode,
  withToolHeld,
  withToolImplementation,
  type CommandGroup,
  type Parked,
} from "./composerToolset";
import { BrandIcon, Icon } from "./icons";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { Schema } from "./schemaForm/types";

/**
 * A file going with the message — dropped on the composer, picked from its clip, or `@`-mentioned.
 *
 * `text` is the file's content when it could be read as text, `note` is why it could not. Both are
 * absent from a file that is empty, which is a fact worth sending rather than an error.
 */
export interface ComposerFile {
  /** What it is called — a bare filename from a drop, a project-relative path from a mention. */
  name: string;
  text?: string;
  /** Why this file is a name and not a content — "3.4 MB, too large to inline", "not text". */
  note?: string;
}

/** As big a file as goes in a message. Past it the name and the size are the honest content. */
const FILE_MAX = 200_000;

/**
 * One dropped file, read.
 *
 * Read in the RENDERER through the File API rather than by path through main: a drop hands over the
 * bytes, so asking main to open the path again would be a second read of a file we already have,
 * through a channel that would then have to be allowed to read anywhere on the disk.
 *
 * Binary files are named, not decoded. `File.text()` on a PNG succeeds and produces replacement
 * characters, and sending sixty kilobytes of those to a model is worse than saying "it is a PNG".
 */
async function fileOf(file: File): Promise<ComposerFile> {
  if (file.size > FILE_MAX) return { name: file.name, note: `${Math.round(file.size / 1024)} KB — too large to include` };
  const text = await file.text();
  // A NUL byte is the oldest and most reliable "this is not text" test there is, and it costs one
  // scan of a file we have already read.
  if (text.includes("\u0000")) return { name: file.name, note: `${file.type || "binary"} — not text` };
  return { name: file.name, text };
}

/**
 * The message as it is actually sent: what was typed, then each file under a heading.
 *
 * Fenced, with the name on the fence, because the alternative is a model guessing where a pasted
 * file starts and stops. The typed text comes FIRST — it is the instruction, and burying it under
 * four attachments is how an instruction gets skimmed past.
 */
function withFiles(text: string, files: readonly ComposerFile[]): string {
  if (files.length === 0) return text;
  const blocks = files.map((file) =>
    file.text === undefined
      ? `Attached: ${file.name} (${file.note ?? "not included"})`
      : `Attached: ${file.name}\n\`\`\`\n${file.text}\n\`\`\``,
  );
  return [text, ...blocks].filter((part) => part !== "").join("\n\n");
}

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

/** What the shell's line says in the Tools card: it is also where every unnamed command lands. */
const SHELL_HINT = "the shell — and the mode for any command not named below";
const SCRIPT_HINT = "running a file — ./x.sh, npm run, python x.py, make";

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
/** A popover that closes on an outside click — the shape every dropdown in this menu wants. */
function useAway<T extends HTMLElement>(open: boolean, close: () => void): React.RefObject<T | null> {
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
function ModePicker({
  mode,
  title,
  onMode,
}: {
  /** `undefined` reads as `custom`: the things under this do not agree. See {@link categoryModeOf}. */
  mode: PermissionMode | undefined;
  title: string;
  onMode: (next: PermissionMode) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const box = useAway<HTMLDivElement>(open, () => setOpen(false));
  const meta = mode === undefined ? undefined : MODE_META[mode];
  return (
    <div className="cx-mode-wrap" ref={box}>
      <button
        type="button"
        className={`cx-tool-mode ${mode === undefined ? "cx-mode-custom" : `cx-mode-${mode}`}`}
        aria-expanded={open}
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {meta !== undefined ? (
          <span className="cx-chip-icon">
            <Icon name={meta.icon} />
          </span>
        ) : null}
        <span className="ellip">{meta?.label ?? "custom"}</span>
        <span className="cx-more">›</span>
      </button>
      {open ? (
        <div className="cx-submenu">
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
        </div>
      ) : null}
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
function ImplPicker({
  value,
  native,
  onPick,
}: {
  value: ToolImplementation;
  /** What the agent calls its own — named in the menu, since that is what its logs will say. */
  native: string;
  onPick: (next: ToolImplementation) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const box = useAway<HTMLDivElement>(open, () => setOpen(false));
  const options: Array<{ id: ToolImplementation; label: string; hint: string }> = [
    { id: "app", label: "JaiRA", hint: "our implementation, through the artifact map" },
    { id: "native", label: native, hint: "the agent's own — still gated by the mode beside it" },
  ];
  const picked = options.find((o) => o.id === value)!;
  return (
    <div className="cx-impl-wrap" ref={box}>
      <button
        type="button"
        className="cx-tool-impl"
        aria-expanded={open}
        title={`Implementation: ${picked.hint}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
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

function ToolRow({
  tool,
  spec,
  granted,
  mode,
  impl,
  cliRoute,
  onGrant,
  onMode,
  onImpl,
}: {
  tool: ToolChoice;
  /** The vocabulary entry, when this tool has one — what supplies its label and hint. */
  spec?: ToolSpec | undefined;
  granted: boolean;
  mode: PermissionMode;
  impl: ToolImplementation;
  /** Which agent is answering, if one is — what decides whether the implementation is a choice. */
  cliRoute?: string | undefined;
  onGrant: () => void;
  onMode: (next: PermissionMode) => void;
  onImpl: (next: ToolImplementation) => void;
}): JSX.Element {
  // What the ANSWERING agent calls its own tool doing this job — off that executor's declaration, by
  // route. Absent ⇒ that agent has no built-in to pick instead, so there is no choice to draw.
  const native = cliRoute !== undefined ? tool.natives?.[cliRoute] : undefined;
  // The shell's line is more than a tool's: it is where every command with no line of its own lands.
  // And a tool that is named and not served yet says so, because ticking it hands nobody anything.
  const hint =
    tool.name === SHELL_TOOL ? SHELL_HINT : spec?.unserved === true ? `${spec.hint} · not served yet` : (spec?.hint ?? tool.name);
  return (
    <div className={`cx-tool${granted ? " on" : ""}`}>
      <button type="button" className="cx-tool-grant" title={hint} onClick={onGrant}>
        <span className="cx-tick">{granted ? "✓" : ""}</span>
        <span className="cx-chip-icon">
          <Icon name={TOOL_ICONS[tool.name] ?? "tool"} />
        </span>
        <span className="cx-opt-text">
          <span className="cx-opt-name ellip">{spec?.label ?? tool.name}</span>
          <span className="cx-opt-hint ellip">{hint}</span>
        </span>
      </button>
      {native !== undefined ? <ImplPicker value={impl} native={native} onPick={onImpl} /> : null}
      <ModePicker mode={mode} title={`${tool.name}: ${MODE_META[mode].hint}`} onMode={onMode} />
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
function CategoryRow({
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
  mode: PermissionMode | undefined;
  open: boolean;
  onOpen: () => void;
  onMode: (next: PermissionMode) => void;
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
        <ModePicker mode={mode} title={`${category.label}: sets every tool under it`} onMode={onMode} />
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
function SubjectRow({
  subject,
  hint,
  held,
  mode,
  onHeld,
  onMode,
}: {
  subject: string;
  hint?: string;
  held: boolean;
  mode: PermissionMode;
  onHeld: () => void;
  onMode: (next: PermissionMode) => void;
}): JSX.Element {
  const script = subject === SCRIPT_SUBJECT;
  return (
    <div className={`cx-tool${held ? " on" : ""}`}>
      <button type="button" className="cx-tool-grant" title={hint ?? subject} onClick={onHeld}>
        <span className="cx-tick">{held ? "✓" : ""}</span>
        <span className="cx-chip-icon">
          <Icon name={script ? "script" : "terminal"} />
        </span>
        <span className="cx-opt-text">
          <span className="cx-opt-name ellip">{script ? subject : <span className="mono">{subject}</span>}</span>
          <span className="cx-opt-hint ellip">{hint ?? ""}</span>
        </span>
      </button>
      <ModePicker mode={mode} title={`${subject}: ${MODE_META[mode].hint}`} onMode={onMode} />
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
function AddLine({ label, example, onAdd }: { label: string; example: string; onAdd: (typed: string) => string | undefined }): JSX.Element {
  const [open, setOpen] = useState(false);
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
function CommandGroupRow({
  group,
  toolset,
  open,
  onOpen,
  onMode,
  children,
}: {
  group: CommandGroup;
  toolset: Toolset;
  open: boolean;
  onOpen: () => void;
  onMode: (next: PermissionMode) => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`cx-cat cx-sub${open ? " open" : ""}`}>
      <div className="cx-cat-head">
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
        <ModePicker mode={groupModeOf(toolset, group)} title={`${group.program}: any ${group.program} command not named under it`} onMode={onMode} />
      </div>
      {open ? <div className="cx-cat-body">{children}</div> : null}
    </div>
  );
}

/**
 * Where the Permissions head said where the value came from, it now says which BUCKET the rows are —
 * and opens the hierarchy of them: each bucket, what it holds, and the layer that defines it.
 *
 * The card's own `cx-submenu`, so it floats over the rows rather than moving them. A bucket inside
 * another is indented under it; a folder that only holds buckets is listed so the indent has
 * something to hang from, and picking it shows no rows, which is what it has.
 */
function BucketPicker({
  buckets,
  bucket,
  onPick,
  startOpen,
}: {
  buckets: readonly ToolsetBucket[];
  bucket: string;
  onPick: (path: string) => void;
  startOpen?: boolean | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(startOpen === true);
  const box = useAway<HTMLDivElement>(open, () => setOpen(false));
  return (
    <div className="cx-origin-wrap" ref={box}>
      <button type="button" className="cx-origin cx-origin-pick cx-bucket" aria-expanded={open} title="Which bucket of toolsets these rows are" onClick={() => setOpen((v) => !v)}>
        <span className="cx-chip-icon">
          <Icon name="folder" />
        </span>
        {bucket}
        <span className="cx-more">›</span>
      </button>
      {open ? (
        <div className="cx-submenu">
          {buckets.map((row) => (
            <button
              key={row.path}
              type="button"
              className={row.path === bucket ? "on" : undefined}
              style={{ paddingLeft: 7 + 16 * row.depth }}
              onClick={() => {
                onPick(row.path);
                setOpen(false);
              }}
            >
              <span className="cx-tick">{row.path === bucket ? "✓" : ""}</span>
              <span className="cx-chip-icon">
                <Icon name="folder" />
              </span>
              <span className="cx-opt-text">
                <span className="cx-opt-name ellip">
                  {row.name} <span className="cx-src">{TOOLSET_LAYER_LABELS[row.layer]}</span>
                </span>
                <span className="cx-opt-hint ellip">{row.hint}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Where a kept toolset goes, as the form words it. */
const KEEP_WHERE: Readonly<Record<WritableLayer, string>> = { project: "in this project", base: "for all projects" };

/**
 * `+` — keep the map on the cards as a NEW toolset in this bucket.
 *
 * Dim while there is nothing to keep: the map already IS one of the bucket's toolsets, or it holds
 * nothing. A name and where it goes, asked through the schema form; the write is the host's
 * (`toolset:save`), which refuses what ships, a name a reference could not carry, and an id the
 * layer already holds — and whatever it refuses with is said here rather than swallowed.
 */
function KeepToolset({
  bucket,
  ready,
  layers,
  onKeep,
  startOpen,
}: {
  bucket: string;
  ready: boolean;
  layers: readonly WritableLayer[];
  onKeep: (name: string, layer: WritableLayer) => Promise<void>;
  startOpen?: boolean | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(startOpen === true);
  const [draft, setDraft] = useState<{ name?: string; where?: string }>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const box = useAway<HTMLDivElement>(open, () => setOpen(false));
  const where = layers.map((layer) => KEEP_WHERE[layer]);
  const schema: Schema = {
    type: "object",
    properties: {
      name: { type: "string", title: "name", minLength: 1 },
      where: { type: "string", title: "where", enum: where, default: where[0] },
    },
    required: ["name", "where"],
  };
  const add = (): void => {
    const name = (draft.name ?? "").trim();
    const layer = layers.find((candidate) => KEEP_WHERE[candidate] === (draft.where ?? where[0]));
    const wrong = toolsetNameProblem(name) ?? (layer === undefined ? "pick where it goes" : undefined);
    if (wrong !== undefined || layer === undefined) {
      setProblem(wrong ?? null);
      return;
    }
    setSaving(true);
    setProblem(null);
    void onKeep(name, layer).then(
      () => {
        setSaving(false);
        setDraft({});
        setOpen(false);
      },
      (e: unknown) => {
        setSaving(false);
        setProblem(e instanceof Error ? e.message : String(e));
      },
    );
  };
  return (
    <div className="cx-origin-wrap" ref={box}>
      <button
        type="button"
        className={`cx-set-add${ready ? " ready" : ""}`}
        aria-expanded={open}
        disabled={!ready}
        title={ready ? `Keep these tools and modes as a new toolset in ${bucket}` : "These tools and modes are already a toolset here"}
        onClick={() => setOpen((v) => !v)}
      >
        +
      </button>
      {open && ready ? (
        <div className="cx-submenu cx-set-new">
          <span className="cx-opt-hint">
            Keep these tools and modes as a toolset in <b>{bucket}</b>
          </span>
          <SchemaForm
            schema={schema}
            value={{ where: where[0], ...draft }}
            onChange={(next) => setDraft((next ?? {}) as { name?: string; where?: string })}
            ctx={{ path: "", hidePaths: true, disabled: saving }}
          />
          {problem !== null ? <p className="sub warn-text">{problem}</p> : null}
          <div className="cx-set-new-foot">
            <span className="grow" />
            <button type="button" className="primary" disabled={saving} onClick={add}>
              Add
            </button>
          </div>
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
  lead,
  trail,
  startOpen,
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
  /**
   * What the head says between the title and the origin, and between the origin and `reset` — the
   * Permissions card's bucket picker and its `+`. The CALLER's, because the chip does not know what
   * a bucket is; it only knows its head is one row.
   */
  lead?: ReactNode;
  trail?: ReactNode;
  /** Draw the card open from the first render — see {@link ComposerOpen}. */
  startOpen?: boolean;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(startOpen === true);
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
            {lead}
            <Origin origin={origin} from={from} />
            {trail}
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

/**
 * What is drawn OPEN from the first render.
 *
 * Every card, picker and fold here opens on a click, which is right for a person and leaves nothing
 * for a still picture to show: a server render has no clicks. This is how a catalog mockup, a static
 * shot or a test draws the state it is about — the Permissions card with its bucket picker down, the
 * Tools card with Execution and `git` unfolded — through the real component rather than a copy of
 * its markup. It sets where the state STARTS and nothing else; every control still works.
 */
export interface ComposerOpen {
  card?: "Thinking" | "Permissions" | "Tools";
  /** The Permissions head's bucket picker. */
  buckets?: boolean;
  /** The Permissions head's `+` form. */
  keep?: boolean;
  /** Folds of the Tools card: a category id (`execution`), or `program:<name>` for a command group. */
  folds?: readonly string[];
}

export function Composer({
  plan,
  busy,
  joinable,
  overrides,
  onOverrides,
  onSend,
  onStop,
  disabled,
  placeholder,
  value,
  onValue,
  mentions,
  readMention,
  onSaveToolset,
  saveLayers,
  startOpen,
}: {
  /** What is drawn open from the first render — for a still picture. See {@link ComposerOpen}. */
  startOpen?: ComposerOpen | undefined;
  /** What the message would run under right now — inherited, with any overrides already folded in. */
  plan: ChatPlanView | null;
  /** A turn is in flight — what turns the button into a stop. */
  busy?: boolean;
  /**
   * A message may be sent WHILE one is in flight — it joins the turn or queues behind it.
   *
   * Off by default, because the two hosts that must refuse are real: the box that STARTS a
   * conversation would create a second one, and a panel over a state that holds no conversation has
   * nowhere to put the message. A host that has a thread to send into passes this, and then `busy`
   * means only "there is something to stop" — which is what the plan's `steerable`/`busy` line has
   * been promising above this button while the button refused.
   */
  joinable?: boolean;
  overrides: ChatSettings;
  onOverrides: (next: ChatSettings) => void;
  onSend: (message: string) => void;
  /**
   * Stop the turn in flight. Absent ⇒ the button stays a send button and greys while busy, which is
   * the honest shape where nothing can be stopped — a transcript beside a board has no handle on the
   * run it is reading.
   */
  onStop?: (() => void) | undefined;
  /** Why sending is impossible at all — no conversation to continue, say. */
  disabled?: string;
  /** What the empty box says. Defaults to the run-panel wording, which is where this started. */
  placeholder?: string;
  /**
   * The draft, when the HOST owns it — what makes "edit this message" possible: the text of a
   * message already sent is put in the box from outside, and the box is not the thing that decides
   * what is in it. Absent ⇒ the composer keeps its own, which is what every other host wants.
   */
  value?: string;
  onValue?: (next: string) => void;
  /**
   * Project paths matching a query — what `@` completes against. Absent ⇒ `@` is an ordinary
   * character, which is correct for a composer with no project behind it.
   */
  mentions?: ((query: string) => Promise<string[]>) | undefined;
  /**
   * One mentioned file's text, for inlining. Absent ⇒ a mention stays a path, which is still useful
   * to a conversation whose agent can read it and useless to one that cannot — so a host that has
   * this should pass it.
   */
  readMention?: ((path: string) => Promise<string>) | undefined;
  /**
   * Keep the map on the cards as a new toolset file — the Permissions card's `+`. The HOST's, because
   * it is a write and the composer holds no channel of its own; absent ⇒ `+` stays dim, which is the
   * honest shape for a composer with nothing behind it.
   */
  onSaveToolset?: ((request: Omit<SaveToolsetRequest, "project">) => Promise<unknown>) | undefined;
  /** Where `+` may write. A conversation with no project open has only "for all projects". */
  saveLayers?: readonly WritableLayer[] | undefined;
}): JSX.Element {
  const [own, setOwn] = useState("");
  const draft = value ?? own;
  const setDraft = (next: string): void => (onValue !== undefined ? onValue(next) : setOwn(next));
  /**
   * What is going with the message: dropped files, and mentioned ones.
   *
   * Held here rather than by the host because they are part of the DRAFT — they are cleared by the
   * same send that clears the box, and a host holding them would have to be told about that.
   */
  const [files, setFiles] = useState<ComposerFile[]>([]);
  /** The `@` completion: what is being typed after it, where it started, and what matched. */
  const [mention, setMention] = useState<{ at: number; query: string; paths: string[] } | null>(null);
  const [dropping, setDropping] = useState(false);
  /**
   * Which categories are unfolded. Local, and starting shut: the menu's job when it opens is to say
   * WHAT the groups are and what each is set to, which the folded rows already do — unfolding all of
   * them puts eight tool rows in front of somebody who came to check one word.
   */
  const [openCats, setOpenCats] = useState<ReadonlySet<string>>(new Set(startOpen?.folds ?? []));
  /** Which bucket the Permissions rows are, once the person has picked one. Else the plan's. */
  const [picked, setPicked] = useState<string | undefined>(undefined);
  /** What an unticked tool would run under if ticked again — see {@link Parked}. Never sent. */
  const [parked, setParked] = useState<Parked>({});
  const settings = plan?.settings ?? {};
  const origin = plan?.origin ?? {
    model: "unset" as const,
    reasoning: "unset" as const,
    tools: "unset" as const,
    permissions: "unset" as const,
    implementations: "unset" as const,
    toolset: "unset" as const,
  };
  // What this project can hold a line for, and THE MAP in force over it: one toolset, read from
  // wherever the settings keep it — the map an earlier edit here wrote, or the list, block and
  // implementations a state's own declaration arrives as. The map is what reaches the executor; a
  // toolset's name is only what to CALL it, and no match means the map is nobody's — `custom`.
  const offered = plan?.available.tools ?? [];
  const registered = offered.map((tool) => tool.name);
  const map = toolsetOfSettings(settings).toolset;
  const tools = heldTools(map);
  const toolsets: readonly ToolsetChoice[] = plan?.available.toolsets ?? [];
  const buckets = toolsetBuckets(toolsets);
  const openedOn = plan?.available.bucket ?? DEFAULT_TOOLSET_BUCKET;
  const bucket = picked !== undefined && buckets.some((row) => row.path === picked) ? picked : openedOn;
  const rows = toolsetsOfBucket(toolsets, bucket);
  const matched = matchToolset(map, toolsets, bucket, registered);
  // Never blank. A control with nothing in it cannot be read as "this is what will happen", which is
  // the only question this row exists to answer.
  const effective = plan?.effective ?? { reasoning: "…", permissions: "…" };
  // Which CLI is answering, if one is — it changes what "default" means for both model and tools.
  const cliRoute = ROUTE_BORROWS[routeOf(effective.model ?? "")] !== undefined ? routeOf(effective.model ?? "") : undefined;
  // What the box edits: the override if there is one, else the resolved value it would replace.
  const current = settings.model ?? effective.model ?? "";

  /** Whether Enter does anything right now — see {@link joinable} for the two hosts that say no. */
  const canSend = disabled === undefined && (busy !== true || joinable === true);

  const send = (): void => {
    const message = withFiles(draft.trim(), files);
    if (message === "" || !canSend) return;
    onSend(message);
    setDraft("");
    setFiles([]);
    setMention(null);
  };

  /** Take files in — from a drop, or from the picker. Both arrive as the same `File` objects. */
  const take = (list: FileList | null): void => {
    if (list === null) return;
    void Promise.all([...list].map(fileOf)).then((taken) => setFiles((was) => [...was, ...taken]));
  };

  /**
   * Watch the box for an `@`, and offer paths under the caret.
   *
   * Only an `@` at the start of a WORD opens the picker, so an email address in a pasted paragraph
   * does not — and only while the run of characters after it has no space in it, which is what makes
   * the list close by itself when the person carries on writing a sentence.
   */
  const track = (text: string, caret: number): void => {
    if (mentions === undefined) return;
    const before = text.slice(0, caret);
    const at = before.lastIndexOf("@");
    const opens = at === 0 || (at > 0 && /\s/.test(before[at - 1] ?? ""));
    const query = before.slice(at + 1);
    if (at === -1 || !opens || /\s/.test(query)) {
      setMention(null);
      return;
    }
    setMention({ at, query, paths: [] });
    void mentions(query).then((paths) =>
      // Still the same query: an answer for a prefix the person has already typed past would replace
      // the list under their cursor with older results.
      setMention((now) => (now !== null && now.at === at && now.query === query ? { ...now, paths } : now)),
    );
  };

  /** Put a path in the box where the `@` was, and attach the file it names. */
  const pick = (path: string): void => {
    if (mention === null) return;
    setDraft(`${draft.slice(0, mention.at)}@${path} ${draft.slice(mention.at + 1 + mention.query.length)}`);
    setMention(null);
    if (readMention === undefined) return;
    void readMention(path).then(
      (text) => setFiles((was) => (was.some((f) => f.name === path) ? was : [...was, { name: path, text }])),
      (e: unknown) => setFiles((was) => [...was, { name: path, note: e instanceof Error ? e.message : "could not be read" }]),
    );
  };

  // Enter sends and Shift+Enter breaks the line, which is what every chat client does — and a prompt
  // is frequently several lines, so the modifier belongs on the newline rather than on the send.
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // The completion list eats the keys that are ITS keys while it is open, and nothing else — so
    // Escape closes it rather than the panel behind it, and Enter takes the highlighted path rather
    // than sending a message with half a mention in it.
    if (mention !== null && mention.paths.length > 0) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        pick(mention.paths[0]!);
        return;
      }
    }
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

  /**
   * Send the WHOLE map. Every edit on either card ends here: a toolset is one statement, so there is
   * no writing half of one, and what is written is a map whichever form the state's own declaration
   * arrived in (`declOfToolset`).
   */
  const write = (next: Toolset, nextParked: Parked = parked): void => {
    setParked(nextParked);
    set({ toolset: declOfToolset(next) });
  };
  /** Both cards reset together, because they are one setting: back to what the state declares. */
  const resetToolset = (): void => {
    const next = { ...overrides };
    delete next.toolset;
    delete next.tools;
    delete next.permissions;
    delete next.implementations;
    setParked({});
    // …and to the bucket that declaration opens on: the rows are part of what was chosen here.
    setPicked(undefined);
    onOverrides(next);
  };
  // One origin for both cards, for the same reason: a map chosen here is the person's choice on
  // both, and otherwise each says where its half of the state's declaration came from.
  const chosen = origin.toolset === "override";
  const permissionsOrigin: SettingOrigin = chosen ? "override" : origin.permissions;
  const toolsOrigin: SettingOrigin = chosen ? "override" : origin.tools;
  const toggleCat = (id: string): void =>
    setOpenCats((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    // The disabled state is a fact about the WHOLE composer, not about the box you type in. Marked
    // here so the shell greys as one surface — see `.cx.off` in the stylesheet for what went wrong
    // when only the textarea knew.
    <div
      className={`cx${disabled !== undefined ? " off" : ""}${dropping ? " cx-drop" : ""}`}
      // The WHOLE composer is the drop target, not the box inside it: a file aimed at a two-line
      // textarea is a file dropped on the page behind it, which Electron answers by navigating the
      // window to that file. `onDragOver` must preventDefault or the drop never fires at all.
      onDragOver={(e) => {
        if (disabled !== undefined) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        if (disabled !== undefined) return;
        e.preventDefault();
        setDropping(false);
        take(e.dataTransfer.files);
      }}
    >
      {/* A padded RING rather than a border, so focus brightens it without the contents shifting. */}
      <div className="cx-frame">
        <div className="cx-shell">
          {files.length > 0 ? (
            <div className="cx-files">
              {files.map((file, i) => (
                <span key={`${file.name}:${i}`} className="cx-file" title={file.note ?? `${(file.text ?? "").length} characters`}>
                  <Icon name="clip" />
                  <span className="ellip">{file.name}</span>
                  {file.note !== undefined ? <span className="sub">{file.note}</span> : null}
                  <button className="ghost" aria-label={`Remove ${file.name}`} onClick={() => setFiles(files.filter((_, at) => at !== i))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <textarea
            className="cx-text"
            value={draft}
            rows={2}
            placeholder={disabled ?? placeholder ?? "Ask for more changes…"}
            disabled={disabled !== undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              track(e.target.value, e.target.selectionStart);
            }}
            onKeyDown={onKey}
          />

          {mention !== null && mention.paths.length > 0 ? (
            <div className="cx-mentions">
              {mention.paths.slice(0, 8).map((path) => (
                <button key={path} className="cx-mention ellip" onClick={() => pick(path)}>
                  {path}
                </button>
              ))}
            </div>
          ) : null}

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
              startOpen={startOpen?.card === "Thinking"}
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
              // A MATCH, never a memory: the toolset's name while the map is exactly that toolset's,
              // `custom` the moment a line differs. A call that declares no tools has no map to
              // match, and says what decides instead — main words that, from the compiled policy.
              value={plan === null || tools.length === 0 ? effective.permissions : matched !== undefined ? toolsetLabel(matched) : "custom"}
              origin={permissionsOrigin}
              from={plan?.from}
              onReset={resetToolset}
              startOpen={startOpen?.card === "Permissions"}
              lead={<BucketPicker buckets={buckets} bucket={bucket} onPick={setPicked} startOpen={startOpen?.buckets} />}
              trail={
                <KeepToolset
                  bucket={bucket}
                  startOpen={startOpen?.keep}
                  // Dim while the map already IS one of this bucket's toolsets, while it holds nothing,
                  // and where the host gave this composer nowhere to write.
                  ready={onSaveToolset !== undefined && matched === undefined && Object.keys(map.entries).length > 0}
                  layers={saveLayers ?? ["project", "base"]}
                  onKeep={async (name, layer) => {
                    await onSaveToolset?.({ bucket, name, layer, toolset: declOfToolset(map) });
                    // The map is now a toolset of this bucket, and only a fresh plan lists it. The
                    // hosts re-ask whenever the overrides change, so they are handed the SAME
                    // overrides as a new object: keeping a name must not change what runs.
                    onOverrides({ ...overrides });
                  }}
                />
              }
            >
              <div className="cx-opts">
                {rows.map((choice) => {
                  const toolset = parseToolset(choice.decl).toolset;
                  return (
                    <Opt
                      key={choice.id}
                      on={matched?.id === choice.id}
                      icon={MODE_META[toolsetGlyph(choice)].icon}
                      name={toolsetLabel(choice)}
                      hint={toolsetHint(choice)}
                      // Its ticks, implementations and modes, written onto the Tools card whole. What
                      // runs is the map, which is the list under the Tools chip — so the reader can
                      // see what a toolset did and change any part of it.
                      onPick={() => write(toolset, {})}
                    />
                  );
                })}
              </div>
              <p className="cx-hint">
                {rows.length === 0
                  ? `No toolsets in ${bucket} yet. + keeps the tools and modes under Tools as the first.`
                  : matched === undefined && tools.length > 0
                    ? `These tools and modes match no toolset in ${bucket} — + keeps them as a new one.`
                    : "A toolset: which tools are offered, and what happens when each is called. Change any of it under Tools and this becomes custom."}
              </p>
            </Chip>

            <Chip
              icon="tool"
              label="Tools"
              // An empty list means two different things and the chip has to say which. On a CLI
              // route with nothing declared it is the DEFAULT — leave the agent its own tools — and
              // reading "no tools" there was the chip contradicting what would run.
              value={
                tools.length === 0
                  ? cliRoute !== undefined && !declaresTools(settings)
                    ? "default tools"
                    : "no tools"
                  : tools.length === 1
                    ? tools[0]!
                    : `${tools.length} tools`
              }
              origin={toolsOrigin}
              from={plan?.from}
              onReset={resetToolset}
              startOpen={startOpen?.card === "Tools"}
            >
              <div className="cx-cats">
                {TOOL_CATEGORIES.map((category) => {
                  const inCategory = offered.filter((tool) => TOOL_SPEC_BY_NAME.get(tool.name)?.category === category.id);
                  if (inCategory.length === 0) {
                    // Drawn empty rather than dropped. A category with nothing in it is a fact about
                    // this project — no MCP server is connected — and a heading that disappears
                    // leaves the reader wondering whether they are looking at the whole list.
                    return (
                      <div key={category.id} className="cx-cat cx-cat-empty">
                        <div className="cx-cat-head">
                          <span className="cx-opt-text">
                            <span className="cx-opt-name ellip">{category.label}</span>
                            <span className="cx-opt-hint ellip">nothing here</span>
                          </span>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <CategoryRow
                      key={category.id}
                      category={category}
                      granted={sectionCountOf(map, category.id)}
                      total={inCategory.length}
                      mode={sectionModeOf(map, parked, category.id)}
                      open={openCats.has(category.id)}
                      onOpen={() => toggleCat(category.id)}
                      // Cascades: setting a section writes every line under it, which is what makes
                      // the row's own value derivable next render.
                      onMode={(next) => {
                        const cascaded = withSectionMode(map, parked, category.id, next);
                        write(cascaded.toolset, cascaded.parked);
                      }}
                    >
                      {inCategory.map((tool) => (
                        <ToolRow
                          key={tool.name}
                          tool={tool}
                          spec={TOOL_SPEC_BY_NAME.get(tool.name)}
                          granted={holdsTool(map, tool.name)}
                          mode={toolModeOf(map, parked, tool.name)}
                          impl={toolImplementationOf(map, parked, tool.name)}
                          cliRoute={cliRoute}
                          // The WHOLE map every time — see the module header on replacement.
                          onGrant={() => write(withToolHeld(map, parked, tool.name, !holdsTool(map, tool.name)))}
                          // A line the map does not hold has nowhere in it to keep a mode, so what an
                          // unticked row is set to waits beside the map until the row is ticked.
                          onMode={(next) =>
                            holdsTool(map, tool.name)
                              ? write(withSubjectMode(map, tool.name, next))
                              : setParked({ ...parked, [tool.name]: { ...parked[tool.name], mode: next } })
                          }
                          onImpl={(next) =>
                            holdsTool(map, tool.name)
                              ? write(withToolImplementation(map, tool.name, next))
                              : setParked({ ...parked, [tool.name]: { ...parked[tool.name], implementation: next } })
                          }
                        />
                      ))}
                      {category.id === "execution" ? (
                        // What Execution holds beyond the shell (decision 0007 §4–§5): the commands the
                        // toolset names, grouped under their program, then `script`, then the line
                        // that adds a command. A shell line is taken apart, and each part answers to
                        // its own line here.
                        <>
                          {commandGroupsOf(map).map((group) => (
                            <CommandGroupRow
                              key={group.program}
                              group={group}
                              toolset={map}
                              open={openCats.has(`program:${group.program}`)}
                              onOpen={() => toggleCat(`program:${group.program}`)}
                              onMode={(next) => write(withSubject(map, group.program, next))}
                            >
                              {group.subs.map((sub) => (
                                <SubjectRow
                                  key={sub.subject}
                                  subject={sub.subject}
                                  held
                                  mode={sub.mode}
                                  onHeld={() => write(withoutSubject(map, sub.subject))}
                                  onMode={(next) => write(withSubjectMode(map, sub.subject, next))}
                                />
                              ))}
                              <AddLine
                                label={`add a ${group.program} subcommand`}
                                example="push"
                                onAdd={(typed) => {
                                  const named = commandSubjectOf(typed, group.program);
                                  if ("problem" in named) return named.problem;
                                  write(withCommand(map, named.subject));
                                  return undefined;
                                }}
                              />
                            </CommandGroupRow>
                          ))}
                          <SubjectRow
                            subject={SCRIPT_SUBJECT}
                            hint={SCRIPT_HINT}
                            held={Object.hasOwn(map.entries, SCRIPT_SUBJECT)}
                            mode={map.entries[SCRIPT_SUBJECT]?.mode ?? parked[SCRIPT_SUBJECT]?.mode ?? MODE_WHEN_UNSET}
                            onHeld={() =>
                              write(
                                Object.hasOwn(map.entries, SCRIPT_SUBJECT)
                                  ? withoutSubject(map, SCRIPT_SUBJECT)
                                  : withSubject(map, SCRIPT_SUBJECT, parked[SCRIPT_SUBJECT]?.mode ?? MODE_WHEN_UNSET),
                              )
                            }
                            onMode={(next) =>
                              Object.hasOwn(map.entries, SCRIPT_SUBJECT)
                                ? write(withSubjectMode(map, SCRIPT_SUBJECT, next))
                                : setParked({ ...parked, [SCRIPT_SUBJECT]: { mode: next } })
                            }
                          />
                          <AddLine
                            label="add a command"
                            example="git status"
                            onAdd={(typed) => {
                              const named = commandSubjectOf(typed);
                              if ("problem" in named) return named.problem;
                              write(withCommand(map, named.subject));
                              // Open the group it landed in, so the line that was just added is on screen.
                              setOpenCats((was) => new Set([...was, `program:${named.subject.split(" ")[0]!}`]));
                              return undefined;
                            }}
                          />
                        </>
                      ) : null}
                    </CategoryRow>
                  );
                })}

                {/* The catch-all, and NOT the same thing as a default — see `PermissionsDecl.other`.
                    This is what answers for a name that turns up at run time and is in no table: an
                    agent's built-in nobody modelled, a tool from someone else's MCP server. Before it
                    existed those resolved to whatever "unset" meant, which is how twenty ungoverned
                    reads went by under a read-only profile. */}
                <div className="cx-cat cx-cat-other">
                  <div className="cx-cat-head">
                    <span className="cx-opt-text">
                      <span className="cx-opt-name ellip">Other</span>
                      <span className="cx-opt-hint ellip">anything not listed above — an agent's own tools with no equal here included</span>
                    </span>
                    <ModePicker
                      mode={map.other ?? MODE_WHEN_UNSET}
                      title="Anything this project has no name for"
                      onMode={(next) => write(withOther(map, next))}
                    />
                  </div>
                </div>
              </div>
              <p className="cx-hint">
                {offered.length === 0
                  ? "This project registers no tools."
                  : "Ticking a tool offers it; the mode beside it is what happens when it is called. A shell line is taken apart, and each part answers to its own line here."}
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

            {/* The paperclip, next to the send button rather than in the row of settings: what goes
                WITH the message belongs beside the message, and the chips above are about how it
                runs. Hidden where there is no picker to open — a composer with nothing behind it. */}
            <label className="cx-clip" title="Attach files">
              <Icon name="clip" />
              <input
                type="file"
                multiple
                disabled={disabled !== undefined}
                onChange={(e) => {
                  take(e.target.files);
                  // Cleared so attaching the SAME file twice in a row still fires a change event.
                  e.target.value = "";
                }}
              />
            </label>

            {/* Two verbs, and how many buttons they need depends on what is true.

                While a turn is in flight there is something to STOP, and a greyed send button beside
                a spinner is a control that says "wait" where a control that says "stop" belongs. But
                in a conversation there is also still something to SAY — the message joins the turn —
                so both are offered, and the stop sits first because it is about what is already
                happening. Where nothing can be sent (see {@link joinable}) the stop stands alone,
                which is the shape this used to have in every case. */}
            {busy === true && onStop !== undefined ? (
              <button type="button" className="cx-send cx-stop" aria-label="Stop" title="Stop this turn" onClick={onStop}>
                <span className="cx-stop-mark" />
              </button>
            ) : null}
            {busy === true && onStop !== undefined && !canSend ? null : (
              <button
                type="button"
                className="cx-send"
                aria-label="Send"
                title={
                  busy === true
                    ? "Enter to send — this joins the turn in flight"
                    : "Enter to send, Shift+Enter for a new line"
                }
                // Attachments alone are a message. A dropped file with no covering note is a
                // perfectly ordinary thing to send, and the button used to refuse what Enter allowed.
                disabled={(draft.trim() === "" && files.length === 0) || !canSend}
                onClick={send}
              >
                <Icon name="send" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
