/**
 * The Files tree section: what the tree leaves out, rule by rule, with what each rule does HERE.
 *
 * It replaces the Files page's chips (`filesPane.tsx`), and the reason is the question those could
 * not answer. A chip said `**\/build` was a rule; it could not say that in this repository the rule
 * hid six folders, every one a workflow state's snapshot that `.jaira/system` already hid — which is
 * how a default nobody needed stayed a default. So every line here carries its count and its first
 * matches, from one walk of the root (`files:hiddenReport`), and a pattern being typed is previewed
 * the same way before it is added.
 *
 * Four decisions shape it:
 *
 *  - **The layers concatenate, so the list is drawn whole.** Built-in rules first, in their groups
 *    (JaiRA's own files, Secrets, …), then what each layer adds — "Added in Shared", "Added in this
 *    project", "Added just for you". That is the order the rules are applied in, and last match wins.
 *  - **A rule you did not write is switched off, not deleted.** Its switch appends `!pattern` to the
 *    layer being edited, and the line says so — struck through, "off here, so this project shows it
 *    (writes !pattern)". The `!` is then drawn on the line it undoes rather than as a second rule of
 *    the layer's own, because it IS that line's state. A rule of a layer read AFTER the one being
 *    edited cannot be undone from here, and its switch says which layer to edit instead.
 *  - **The layer's own list has the set / not set switch** every setting has: off, the layer adds
 *    nothing and every rule it wrote goes. A layer is never written an empty list — it would read the
 *    same as no list, and a migration once read `[]` as *show everything*.
 *  - **"Why is a path hidden?"** is asked of main (`files:whyHidden`) and answered top-down, the way
 *    the walk decides: a file inside `dist/` is hidden by the rule that hid the folder.
 *
 * Drawn by {@link FilesTreeView}, a render function over a report, so a server render (a test, a
 * catalog figure) needs no main process; {@link FilesTreeSection} is the part that asks.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import type { JsonValue } from "@declarative-ai/json";
import {
  HIDDEN_PATH_GROUPS,
  HIDDEN_RULE_LAYERS,
  SYSTEM_DIR_NAME,
  JAIRA_DIR_NAME,
  hiddenGroupOf,
  whyHiddenPath,
  type ConfigLayer,
  type ConfigView,
  type HiddenReport,
  type HiddenRuleLayer,
  type HiddenRuleReport,
  type HiddenVerdict,
} from "@jaira/shared/browser";
import { Field, FieldGrid, Switch } from "./controls";
import { SettingsSection } from "./settingsLayout";
import { invoke } from "./store";

/** The person's own layer ("Just you", `personal-settings.json`), where Show system/ is written. */
const PERSONAL: ConfigLayer = "you";

/** The two spellings of JaiRA's own directory — the shared root's, and a checkout's. */
const SYSTEM_DIRS = [SYSTEM_DIR_NAME, `${JAIRA_DIR_NAME}/${SYSTEM_DIR_NAME}`];

/** How each layer is named on a line, as a group, and in a sentence. */
const LAYER_WORDS: Record<HiddenRuleLayer, { origin: string; group: string; says: string }> = {
  "built in": { origin: "built in", group: "Built in", says: "JaiRA" },
  base: { origin: "shared", group: "Added in Shared", says: "Shared" },
  project: { origin: "this project", group: "Added in this project", says: "this project" },
  you: { origin: "just you", group: "Added just for you", says: "you alone" },
};

/** Weakest first — a rule of a layer AFTER the one being edited cannot be undone from it. */
const RANK: readonly HiddenRuleLayer[] = ["built in", ...HIDDEN_RULE_LAYERS];

/** One layer's document, whichever layer. */
function docOf(view: ConfigView, layer: ConfigLayer): JsonValue | null {
  return view[layer] ?? null;
}

/** `files.hidden` as ONE layer states it, or `null` when that layer says nothing. */
export function hiddenIn(doc: JsonValue | null): string[] | null {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const files = (doc as Record<string, JsonValue>)["files"];
  if (files === undefined || files === null || typeof files !== "object" || Array.isArray(files)) return null;
  const hidden = (files as Record<string, JsonValue>)["hidden"];
  return Array.isArray(hidden) ? hidden.filter((p): p is string => typeof p === "string") : null;
}

/**
 * The layer's whole document with its list replaced. An empty list removes the key — and `files`
 * with it when nothing else is in there — rather than writing `[]`; see the header.
 */
export function withHidden(doc: JsonValue | null, list: readonly string[]): JsonValue {
  const next = doc !== null && typeof doc === "object" && !Array.isArray(doc) ? { ...(doc as Record<string, JsonValue>) } : {};
  const files = next["files"];
  const block = files !== undefined && files !== null && typeof files === "object" && !Array.isArray(files) ? { ...(files as Record<string, JsonValue>) } : {};
  if (list.length > 0) block["hidden"] = [...list];
  else delete block["hidden"];
  if (Object.keys(block).length > 0) next["files"] = block;
  else delete next["files"];
  return next;
}

/** The rule that undoes `pattern`: `!p` for `p`, and `p` for `!p`. */
const negationOf = (pattern: string): string => (pattern.startsWith("!") ? pattern.slice(1) : `!${pattern}`);

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "8 folders", "3 files", "2 folders and 1 file" — or `null` for nothing. */
function amountOf(hides: { files: number; folders: number }): string | null {
  const parts = [hides.folders > 0 ? plural(hides.folders, "folder") : "", hides.files > 0 ? plural(hides.files, "file") : ""].filter((s) => s.length > 0);
  return parts.length > 0 ? parts.join(" and ") : null;
}

const totalOf = (hides: { files: number; folders: number }): number => hides.files + hides.folders;

/** The first matches, and how many more: `a, b, +6`. */
function samplesOf(rule: HiddenRuleReport): string {
  const more = totalOf(rule.hides) - rule.samples.length;
  return [...rule.samples, ...(more > 0 ? [`+${more}`] : [])].join(", ");
}

/**
 * What is worth saying about a rule beyond its count — the warning hook. Two things today:
 *
 *  - it hides nothing a person can see, and every match it has is inside a folder JaiRA's own group
 *    already hides (the `**\/build` case);
 *  - it is a `!` that puts back nothing, because the folder it names is inside one an earlier rule
 *    hides — a hidden folder takes its contents with it, and the walk never goes in.
 */
export function ruleNotes(rule: HiddenRuleReport, index: number, rules: readonly HiddenRuleReport[]): string[] {
  const notes: string[] = [];
  const decided = totalOf(rule.hides);
  if (decided === 0 && rule.inside !== undefined && rule.inside.count > 0) {
    const where = rule.inside.folders.join(", ");
    notes.push(`every match is inside ${where}, which is already hidden`);
  }
  if (decided === 0 && rule.pattern.startsWith("!")) {
    // The literal head of the pattern — up to its first wildcard — is a folder it can only reach
    // through; if an earlier rule hides one of ITS ancestors, nothing under it is ever shown.
    const literal = rule.pattern.slice(1).split(/[*?[{]/)[0]!.replace(/\/+$/, "");
    if (literal.length > 0) {
      const verdict = whyHiddenPath(literal, rules.slice(0, index));
      if (verdict.hidden && verdict.via !== undefined) {
        notes.push(`puts back nothing: ${verdict.via} is hidden by ${verdict.rule}, and a hidden folder takes its contents with it`);
      }
    }
  }
  return notes;
}

/** One fold of the list: a default group, or what one layer adds. */
interface RuleGroup {
  id: string;
  name: string;
  lines: Array<{ rule: HiddenRuleReport; index: number }>;
}

const rankOf = (layer: HiddenRuleLayer): number => RANK.indexOf(layer);

/**
 * Is this rule a SWITCH of an earlier line rather than a rule of its own — a later layer's `!p`
 * undoing a weaker layer's `p`, or its `p` putting that back on after something in between undid it?
 */
export function isSwitchOf(rules: readonly HiddenRuleReport[], index: number): boolean {
  const rule = rules[index]!;
  if (rule.layer === "built in") return false;
  const undo = negationOf(rule.pattern);
  return rules.slice(0, index).some((earlier, at) => {
    if (rankOf(earlier.layer) >= rankOf(rule.layer)) return false;
    if (earlier.pattern === undo) return true;
    // The same pattern again: a switch only when something between them had undone it.
    return earlier.pattern === rule.pattern && rules.slice(at + 1, index).some((between) => between.pattern === undo);
  });
}

/**
 * Who has the last word on a line's pattern: the rule itself, or the last layer after it that states
 * it again or undoes it. `on` is whether that word keeps the rule in effect. `except` leaves one
 * layer's words out — what the line would be without the layer being edited.
 */
export function lastWordOn(rules: readonly HiddenRuleReport[], index: number, except?: HiddenRuleLayer): { on: boolean; by: HiddenRuleLayer } {
  const rule = rules[index]!;
  const undo = negationOf(rule.pattern);
  let word = { on: true, by: rule.layer };
  rules.forEach((later, at) => {
    if (at <= index || later.layer === except || rankOf(later.layer) <= rankOf(rule.layer)) return;
    if (later.pattern === undo) word = { on: false, by: later.layer };
    else if (later.pattern === rule.pattern) word = { on: true, by: later.layer };
  });
  return word;
}

/**
 * The groups, in the order the rules apply: the default groups, then each layer's additions. A
 * layer's rule that switches an earlier line ({@link isSwitchOf}) is not a line of its own — it is
 * drawn as that line's switch.
 */
export function groupRules(rules: readonly HiddenRuleReport[]): RuleGroup[] {
  const groups: RuleGroup[] = HIDDEN_PATH_GROUPS.map((group) => ({ id: group.id, name: group.name, lines: [] }));
  rules.forEach((rule, index) => {
    if (rule.layer === "built in") {
      const id = hiddenGroupOf(rule.pattern)?.id;
      groups.find((group) => group.id === id)?.lines.push({ rule, index });
      return;
    }
    if (isSwitchOf(rules, index)) return;
    let group = groups.find((g) => g.id === rule.layer);
    if (group === undefined) groups.push((group = { id: rule.layer, name: LAYER_WORDS[rule.layer].group, lines: [] }));
    group.lines.push({ rule, index });
  });
  return groups.filter((group) => group.lines.length > 0);
}

/** How many of a group's lines a layer has switched off. */
const offIn = (group: RuleGroup, rules: readonly HiddenRuleReport[]): number => group.lines.filter(({ index }) => !lastWordOn(rules, index).on).length;

/**
 * A group's head: "5 rules · hides 8 folders", with what its `!` rules put back and how many of its
 * lines are switched off after.
 */
function groupSummary(group: RuleGroup, rules: readonly HiddenRuleReport[], capped: boolean): string {
  const off = offIn(group, rules);
  const sum = (put: boolean): { files: number; folders: number } =>
    group.lines
      .filter(({ rule }) => rule.pattern.startsWith("!") === put)
      .reduce((acc, { rule }) => ({ files: acc.files + rule.hides.files, folders: acc.folders + rule.hides.folders }), { files: 0, folders: 0 });
  const least = capped ? "at least " : "";
  const hides = amountOf(sum(false));
  const back = amountOf(sum(true));
  return [
    plural(group.lines.length, "rule"),
    hides !== null ? `hides ${least}${hides}` : back === null ? "hides nothing here" : "",
    back !== null ? `puts back ${least}${back}` : "",
    off > 0 ? `${off} off` : "",
  ]
    .filter((s) => s.length > 0)
    .join(" · ");
}

/** The sentence under "Why is a path hidden?". */
export function whySentence(verdict: HiddenVerdict): JSX.Element {
  const origin = verdict.layer !== undefined ? LAYER_WORDS[verdict.layer].origin : "";
  if (!verdict.hidden) {
    if (verdict.rule === undefined) return <>not hidden</>;
    return (
      <>
        not hidden: <code className="hid-code">{verdict.rule}</code>, {origin}, puts it back
      </>
    );
  }
  const group = verdict.layer === "built in" && verdict.rule !== undefined ? hiddenGroupOf(verdict.rule)?.name : undefined;
  return (
    <>
      hidden by <code className="hid-code">{verdict.rule}</code>, {origin}
      {group !== undefined ? `, in ${group}` : ""}
      {verdict.via !== undefined ? (
        <>
          : its folder <code className="hid-code">{verdict.via}</code> matches
        </>
      ) : null}
    </>
  );
}

/** The add line's preview: "would hide 3 folders: a, b, +1". */
export function previewSentence(extra: HiddenRuleReport, capped: boolean): string {
  const amount = amountOf(extra.hides);
  const verb = extra.pattern.startsWith("!") ? "would put back" : "would hide";
  if (amount === null) return `${verb} nothing here`;
  return `${verb} ${capped ? "at least " : ""}${amount}: ${samplesOf(extra)}`;
}

/** A pattern in the data voice, its `!` in the ok colour. */
function Pattern({ pattern }: { pattern: string }): JSX.Element {
  return pattern.startsWith("!") ? (
    <span className="hid-pattern data-text">
      <span className="hid-bang">!</span>
      {pattern.slice(1)}
    </span>
  ) : (
    <span className="hid-pattern data-text">{pattern}</span>
  );
}

export interface FilesTreeViewProps {
  view: ConfigView;
  /** The layer being edited. */
  layer: ConfigLayer;
  /** What the walk found, or `null` while it is being asked. */
  report: HiddenReport | null;
  /** Why the report could not be read, when it could not. */
  error?: string | undefined;
  busy: boolean;
  onWrite: (layer: ConfigLayer, doc: JsonValue) => void;
  /** The add line's text, and its preview (`null` while there is none). */
  typed: string;
  preview: HiddenReport | null;
  onType: (text: string) => void;
  /** The "why" line's text, and its answer. */
  asked: string;
  answer: HiddenVerdict | string | null;
  onAsk: (text: string) => void;
  /** Which groups the person has folded or opened — absent means the default for that group. */
  open: Record<string, boolean>;
  onFold: (id: string, open: boolean) => void;
}

/** The section, drawn from a report. */
export function FilesTreeView(props: FilesTreeViewProps): JSX.Element {
  const { view, layer, report, busy, onWrite } = props;
  const doc = docOf(view, layer);
  const own = hiddenIn(doc);
  const list = own ?? [];
  const here = layer as string as HiddenRuleLayer;
  const rank = RANK.indexOf(here);
  const write = (next: readonly string[]): void => onWrite(layer, withHidden(doc, next));
  const add = (pattern: string): void => {
    const clean = pattern.trim();
    // A bare `!` reveals nothing and hides nothing: it is a half-typed entry.
    if (clean.length === 0 || clean === "!" || list.includes(clean)) return;
    write([...list, clean]);
    props.onType("");
  };

  const rules = report?.rules ?? [];
  const groups = groupRules(rules);
  const capped = report?.capped === true;

  // "Show system/" — the person's own `!` for JaiRA's own directory, in both root shapes.
  const personalDoc = docOf(view, PERSONAL);
  const personal = hiddenIn(personalDoc) ?? rules.filter((r) => r.layer === "you").map((r) => r.pattern);
  const showsSystem = SYSTEM_DIRS.some((dir) => personal.includes(`!${dir}`));
  const toggleSystem = (on: boolean): void => {
    const without = personal.filter((p) => !SYSTEM_DIRS.some((dir) => p === `!${dir}`));
    onWrite(PERSONAL, withHidden(personalDoc, on ? [...without, ...SYSTEM_DIRS.map((dir) => `!${dir}`)] : without));
  };

  const line = ({ rule, index }: { rule: HiddenRuleReport; index: number }): JSX.Element => {
    const mine = rule.layer === here;
    const undo = negationOf(rule.pattern);
    const word = lastWordOn(rules, index);
    // A layer read after the one being edited has the last word, or wrote the rule: nothing written
    // here could change what the tree does, so the switch says where to go instead.
    const later = rankOf(word.by) > rank || rankOf(rule.layer) > rank;
    const off = !word.on;
    const put = rule.pattern.startsWith("!");
    const amount = amountOf(rule.hides);
    const notes = ruleNotes(rule, index, rules);
    const switchLabel = later
      ? `${LAYER_WORDS[rankOf(rule.layer) > rank ? rule.layer : word.by].says} has the last word on this, and is read after ${LAYER_WORDS[here].says} — edit that layer to change it`
      : mine
        ? `${rule.pattern} — switch off to remove it from ${LAYER_WORDS[here].says}`
        : off
          ? `switch on here — ${word.by === here ? `stops writing ${undo}` : `writes ${rule.pattern} to ${LAYER_WORDS[here].says}`}`
          : `switch off here — writes ${undo} to ${LAYER_WORDS[here].says}`;
    const toggle = (next: boolean): void => {
      if (mine) return write(list.filter((p) => p !== rule.pattern));
      // What the line would be without this layer's word on it, and the word it needs, if any.
      const without = list.filter((p) => p !== undo && p !== rule.pattern);
      const inherited = lastWordOn(rules, index, here).on;
      write(next === inherited ? without : [...without, next ? rule.pattern : undo]);
    };
    return (
      <li key={`${index}-${rule.pattern}`} className={`hid-line${off ? " is-off" : ""}`}>
        <span className="hid-pat-cell">
          <Pattern pattern={rule.pattern} />
          {put ? <span className="hid-chip hid-puts">puts back</span> : null}
        </span>
        <span className="hid-what">
          {off ? (
            <span className="hid-offnote">
              {word.by === here ? "off here" : `off in ${LAYER_WORDS[word.by].says}`}, so {LAYER_WORDS[word.by].says} {put ? "hides it again" : "shows it"} (writes{" "}
              <code className="hid-code">{undo}</code>)
            </span>
          ) : amount !== null ? (
            <>
              <span className="hid-count">
                {capped ? "at least " : ""}
                {amount}
              </span>
              <span className="hid-samples data-secondary">{samplesOf(rule)}</span>
            </>
          ) : (
            <span className="hid-none app-absent">nothing here</span>
          )}
          {notes.map((note) => (
            <span key={note} className="hid-note">
              {note}
            </span>
          ))}
        </span>
        <span className={`hid-chip hid-origin${mine ? " is-here" : ""}`}>{LAYER_WORDS[rule.layer].origin}</span>
        <span className="hid-switch">
          <Switch
            on={!off}
            label={switchLabel}
            disabled={busy || later}
            onChange={toggle}
          />
        </span>
      </li>
    );
  };

  const extra = props.preview?.extra;
  return (
    <SettingsSection
      id="files-tree"
      title="Files tree"
      info="What the Files tree leaves out, and why. Built-in rules come first, then what Shared, this project and you add; the last rule to match a path decides."
    >
      <FieldGrid>
        <Field
          label="Hidden in the tree"
          param="files.hidden"
          hint="Later rules win, so a !pattern puts back something an earlier rule hid. A folder that matches takes its contents with it."
          toggle={{ on: own !== null, disabled: busy, onChange: (on) => (on ? undefined : onWrite(layer, withHidden(doc, []))) }}
        >
          <span className="hid-own app-secondary">
            {own === null || own.length === 0 ? `${LAYER_WORDS[here].says} adds nothing` : `${LAYER_WORDS[here].says} adds ${plural(own.length, "rule")}`}
          </span>
        </Field>
      </FieldGrid>

      <div className="hid-body">
        <div className="hid-box" role="table" aria-label="Hidden-path rules">
          <div className="hid-cols" role="row">
            <span role="columnheader">Pattern</span>
            <span role="columnheader">What it hides here</span>
            <span role="columnheader">From</span>
            <span role="columnheader" className="hid-col-switch" aria-label="in effect" />
          </div>
          {report === null ? (
            <div className="hid-wait app-absent">{props.error !== undefined ? props.error : "reading the tree…"}</div>
          ) : (
            groups.map((group) => {
              // Folded when it hides nothing here — unless a layer switched one of its rules off, which
              // is a decision somebody made and is worth seeing without looking for it.
              const open = props.open[group.id] ?? (group.lines.some(({ rule }) => totalOf(rule.hides) > 0) || offIn(group, rules) > 0);
              return (
                <div key={group.id} className={`hid-group${open ? " open" : ""}`}>
                  <button type="button" className="hid-fold" aria-expanded={open} onClick={() => props.onFold(group.id, !open)}>
                    <span className="hid-chev" aria-hidden="true">
                      ›
                    </span>
                    <span className="hid-group-name">{group.name}</span>
                    <span className="hid-group-sum app-secondary">{groupSummary(group, rules, capped)}</span>
                  </button>
                  {open ? <ul className="hid-lines">{group.lines.map(line)}</ul> : null}
                </div>
              );
            })
          )}
        </div>

        <div className="hid-add">
          <input
            className="cfg-input mono hid-add-input"
            value={props.typed}
            placeholder="pattern, or !pattern to put something back"
            disabled={busy}
            spellCheck={false}
            aria-label="add a rule"
            onChange={(e) => props.onType(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add(props.typed);
              if (e.key === "Escape") props.onType("");
            }}
          />
          <button type="button" disabled={busy || props.typed.trim().length === 0 || props.typed.trim() === "!"} onClick={() => add(props.typed)}>
            Add
          </button>
          {props.typed.trim().length > 0 && extra !== undefined && extra.pattern === props.typed.trim() ? (
            <span className="hid-preview data-secondary">{previewSentence(extra, props.preview?.capped === true)}</span>
          ) : null}
        </div>
      </div>

      <FieldGrid>
        <Field label="Why is a path hidden?" hint="A path inside the tree's root, or a full path from a file manager." wide>
          <div className="hid-ask">
            <input
              className="cfg-input mono"
              value={props.asked}
              placeholder="packages/cli/dist/index.js"
              spellCheck={false}
              aria-label="path to explain"
              onChange={(e) => props.onAsk(e.target.value)}
            />
            {props.answer !== null && props.asked.trim().length > 0 ? (
              <div className={`hid-why${typeof props.answer === "string" ? " is-bad" : ""}`} aria-live="polite">
                {typeof props.answer === "string" ? props.answer : whySentence(props.answer)}
              </div>
            ) : null}
          </div>
        </Field>
        <Field
          label={`Show ${SYSTEM_DIR_NAME}/`}
          hint={
            showsSystem
              ? "Shown, for you alone: a !system rule in your own list."
              : "Hidden — the default. It holds the database, tasks, snapshots and logs, which nobody authors."
          }
        >
          <Switch on={showsSystem} label={showsSystem ? "shown" : "hidden"} disabled={busy} onChange={toggleSystem} />
        </Field>
      </FieldGrid>
    </SettingsSection>
  );
}

/** How long typing pauses before the preview and the "why" line ask main. */
const DEBOUNCE_MS = 250;

/**
 * The section, with the asking: the report (again whenever the layers change), the add line's
 * preview and the "why" line, each debounced as it is typed.
 *
 * `project` is the project the page is for (`null` at the root, where the shared root is walked);
 * `onWrite` takes the layer's WHOLE new document, the same contract as `config:write`.
 */
export function FilesTreeSection(props: {
  view: ConfigView;
  layer: ConfigLayer;
  project: string | null;
  busy: boolean;
  onWrite: (layer: ConfigLayer, doc: JsonValue) => void;
}): JSX.Element {
  const { view, layer, project } = props;
  const at = project !== null ? { project } : {};
  const [report, setReport] = useState<HiddenReport | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [typed, setTyped] = useState("");
  const [preview, setPreview] = useState<HiddenReport | null>(null);
  const [asked, setAsked] = useState("");
  const [answer, setAnswer] = useState<HiddenVerdict | string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // A reply that arrives after a newer question was asked is dropped rather than drawn.
  const ticket = useRef({ report: 0, preview: 0, why: 0 });

  useEffect(() => {
    const mine = ++ticket.current.report;
    invoke("files:hiddenReport", at).then(
      (next) => {
        if (ticket.current.report !== mine) return;
        setReport(next);
        setError(undefined);
      },
      (e: unknown) => ticket.current.report === mine && setError((e as Error).message),
    );
    // The view's identity changes on every config write, which is when the rules did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, project]);

  useEffect(() => {
    const pattern = typed.trim();
    const mine = ++ticket.current.preview;
    if (pattern.length === 0 || pattern === "!") {
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => {
      invoke("files:hiddenReport", { ...at, extra: pattern, layer }).then(
        (next) => ticket.current.preview === mine && setPreview(next),
        () => ticket.current.preview === mine && setPreview(null),
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed, layer, project, view]);

  useEffect(() => {
    const path = asked.trim();
    const mine = ++ticket.current.why;
    if (path.length === 0) {
      setAnswer(null);
      return;
    }
    const timer = setTimeout(() => {
      invoke("files:whyHidden", { ...at, path }).then(
        (verdict) => ticket.current.why === mine && setAnswer(verdict),
        (e: unknown) => ticket.current.why === mine && setAnswer((e as Error).message),
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, project, view]);

  return (
    <FilesTreeView
      view={view}
      layer={layer}
      report={report}
      error={error}
      busy={props.busy}
      onWrite={props.onWrite}
      typed={typed}
      preview={preview}
      onType={setTyped}
      asked={asked}
      answer={answer}
      onAsk={setAsked}
      open={open}
      onFold={(id, next) => setOpen((was) => ({ ...was, [id]: next }))}
    />
  );
}
