/**
 * What Appearance → Files tree COMPUTES (decision 0015): the rules grouped as they apply, each line's
 * switch and words, the layer's own list and "Show system/", and what the section asks main — moved
 * unchanged out of `filesTreePane.tsx` (which re-exports them), so the desktop's section and the
 * universal copy (`packages/universal/src/components/settings/FilesTree.tsx`) say and write the same.
 */
import { useEffect, useRef, useState } from "react";
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
import { invoke } from "./store";

/** The person's own layer ("Just you", `personal-settings.json`), where Show system/ is written. */
export const PERSONAL: ConfigLayer = "you";

/** The two spellings of JaiRA's own directory — the shared root's, and a checkout's. */
export const SYSTEM_DIRS = [SYSTEM_DIR_NAME, `${JAIRA_DIR_NAME}/${SYSTEM_DIR_NAME}`];

/** How each layer is named on a line, as a group, and in a sentence. */
export const LAYER_WORDS: Record<HiddenRuleLayer, { origin: string; group: string; says: string }> = {
  "built in": { origin: "built in", group: "Built in", says: "JaiRA" },
  base: { origin: "shared", group: "Added in Shared", says: "Shared" },
  project: { origin: "this project", group: "Added in this project", says: "this project" },
  you: { origin: "just you", group: "Added just for you", says: "you alone" },
};

/** Weakest first — a rule of a layer AFTER the one being edited cannot be undone from it. */
export const RANK: readonly HiddenRuleLayer[] = ["built in", ...HIDDEN_RULE_LAYERS];

/** One layer's document, whichever layer. */
export function docOf(view: ConfigView, layer: ConfigLayer): JsonValue | null {
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
export const negationOf = (pattern: string): string => (pattern.startsWith("!") ? pattern.slice(1) : `!${pattern}`);

export const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "8 folders", "3 files", "2 folders and 1 file" — or `null` for nothing. */
export function amountOf(hides: { files: number; folders: number }): string | null {
  const parts = [hides.folders > 0 ? plural(hides.folders, "folder") : "", hides.files > 0 ? plural(hides.files, "file") : ""].filter((s) => s.length > 0);
  return parts.length > 0 ? parts.join(" and ") : null;
}

export const totalOf = (hides: { files: number; folders: number }): number => hides.files + hides.folders;

/** The first matches, and how many more: `a, b, +6`. */
export function samplesOf(rule: HiddenRuleReport): string {
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
export interface RuleGroup {
  id: string;
  name: string;
  lines: Array<{ rule: HiddenRuleReport; index: number }>;
}

export const rankOf = (layer: HiddenRuleLayer): number => RANK.indexOf(layer);

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
export const offIn = (group: RuleGroup, rules: readonly HiddenRuleReport[]): number => group.lines.filter(({ index }) => !lastWordOn(rules, index).on).length;

/**
 * A group's head: "5 rules · hides 8 folders", with what its `!` rules put back and how many of its
 * lines are switched off after.
 */
export function groupSummary(group: RuleGroup, rules: readonly HiddenRuleReport[], capped: boolean): string {
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

/** A sentence in parts: words, and a pattern or path in the data voice (`code.hid-code`). */
export type HidPart = { text: string } | { code: string };

/** The sentence under "Why is a path hidden?", in parts. */
export function whyParts(verdict: HiddenVerdict): HidPart[] {
  const origin = verdict.layer !== undefined ? LAYER_WORDS[verdict.layer].origin : "";
  if (!verdict.hidden) {
    if (verdict.rule === undefined) return [{ text: "not hidden" }];
    return [{ text: "not hidden: " }, { code: verdict.rule }, { text: `, ${origin}, puts it back` }];
  }
  const group = verdict.layer === "built in" && verdict.rule !== undefined ? hiddenGroupOf(verdict.rule)?.name : undefined;
  return [
    { text: "hidden by " },
    { code: verdict.rule ?? "" },
    { text: `, ${origin}` },
    ...(group !== undefined ? [{ text: `, in ${group}` }] : []),
    ...(verdict.via !== undefined ? [{ text: ": its folder " }, { code: verdict.via }, { text: " matches" }] : []),
  ];
}

/** The add line's preview: "would hide 3 folders: a, b, +1". */
export function previewSentence(extra: HiddenRuleReport, capped: boolean): string {
  const amount = amountOf(extra.hides);
  const verb = extra.pattern.startsWith("!") ? "would put back" : "would hide";
  if (amount === null) return `${verb} nothing here`;
  return `${verb} ${capped ? "at least " : ""}${amount}: ${samplesOf(extra)}`;
}

/** What the section draws from the view and the report: the layer's own list, the groups, "Show system/". */
export function filesTreeOf(view: ConfigView, layer: ConfigLayer, report: HiddenReport | null, onWrite: (layer: ConfigLayer, doc: JsonValue) => void) {
  const doc = docOf(view, layer);
  const own = hiddenIn(doc);
  const list = own ?? [];
  const here = layer as string as HiddenRuleLayer;
  const rank = RANK.indexOf(here);
  const write = (next: readonly string[]): void => onWrite(layer, withHidden(doc, next));
  /** Add a typed pattern; whether it was added (a bare `!`, or one already listed, is not). */
  const add = (pattern: string): boolean => {
    const clean = pattern.trim();
    // A bare `!` reveals nothing and hides nothing: it is a half-typed entry.
    if (clean.length === 0 || clean === "!" || list.includes(clean)) return false;
    write([...list, clean]);
    return true;
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
  const ownWords = own === null || own.length === 0 ? `${LAYER_WORDS[here].says} adds nothing` : `${LAYER_WORDS[here].says} adds ${plural(own.length, "rule")}`;
  const clearLabel = `Take out the rules ${LAYER_WORDS[here].says} adds`;
  const clear = (): void => onWrite(layer, withHidden(doc, []));
  /** Whether a group is drawn open: folded when it hides nothing here — unless a layer switched one of its rules off. */
  const openOf = (group: RuleGroup, open: Record<string, boolean>): boolean => open[group.id] ?? (group.lines.some(({ rule }) => totalOf(rule.hides) > 0) || offIn(group, rules) > 0);
  /** One line of the table: what it says, its switch, and what the switch writes. */
  const lineOf = ({ rule, index }: { rule: HiddenRuleReport; index: number }) => {
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
    /** "off here, so this project shows it (writes !pattern)" — the words, and the rule in the data voice. */
    const offNote: HidPart[] = [
      { text: `${word.by === here ? "off here" : `off in ${LAYER_WORDS[word.by].says}`}, so ${LAYER_WORDS[word.by].says} ${put ? "hides it again" : "shows it"} (writes ` },
      { code: undo },
      { text: ")" },
    ];
    return { mine, undo, word, later, off, put, amount, notes, switchLabel, toggle, offNote, samples: samplesOf(rule), origin: LAYER_WORDS[rule.layer].origin };
  };
  return { doc, own, list, here, rank, write, add, rules, groups, capped, showsSystem, toggleSystem, ownWords, clearLabel, clear, openOf, lineOf };
}

/** How long typing pauses before the preview and the "why" line ask main. */
const DEBOUNCE_MS = 250;

/**
 * What the section asks main, and what is typed into it: the report (again whenever the layers change), the add line's
 * preview and the "why" line, each debounced as it is typed.
 *
 * `project` is the project the page is for (`null` at the root, where the shared root is walked);
 * `onWrite` takes the layer's WHOLE new document, the same contract as `config:write`.
 */
export function useFilesTree(props: {
  view: ConfigView;
  layer: ConfigLayer;
  project: string | null;
  busy: boolean;
  onWrite: (layer: ConfigLayer, doc: JsonValue) => void;
}) {
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

  return {
    view: props.view,
    layer: props.layer,
    report,
    error,
    busy: props.busy,
    onWrite: props.onWrite,
    typed,
    preview,
    onType: setTyped,
    asked,
    answer,
    onAsk: setAsked,
    open,
    onFold: (id: string, next: boolean) => setOpen((was) => ({ ...was, [id]: next })),
  };
}
