/**
 * Settings → Tools' "Show it in a stack" (decision 0023 §4.3): what each line a set writes comes to
 * when the set is laid over a base, and who said it — the base's answer, the layer's, the result, and
 * the layer (and line) that decided. `PermissionSets.tsx` draws the table; this works it out, pure.
 *
 * The two are composed by the one merge every stack goes through (`composePermissionSetLayers`, §2.1),
 * and each row asks the same question of the base, of the layer and of the merge: what answers a call
 * of this line, at this place. The answer is read as the card reads a line, not as a call is judged:
 *
 *  - a line's places first — the place itself, else the most specific of the line's places that holds it
 *    (`resolvePlace`) — then its own mode, then the next less specific line (§3.4): a command's shorter
 *    commands, `script` for one that runs a file, the shell; a runner's line the group's; then `other`;
 *  - a row is one place a line names, "elsewhere" (none of its places) for a line with places, or
 *    everywhere for a plain one. Named places are not resolved — no project is open here — so `$PROJECT`
 *    holds a folder only where it is written the same way.
 *
 * What stands above every layer — the destructive floor, `.jaira/`, an unreadable piece, an executor's
 * floor (§2.4) — is the policy's, which judges a CALL, and is not drawn here.
 */
import {
  composePermissionSetLayers,
  decidedBy,
  OTHER_SUBJECT,
  parsePermissionSet,
  PLACE_ANYWHERE,
  RUNNER_GROUP_SUBJECT,
  SCRIPT_SUBJECT,
  SHELL_TOOL,
  parseRunnerSubject,
  placesMostSpecificFirst,
  resolvePlace,
  subjectKindOf,
  type PermissionSet,
  type PermissionSetMode,
} from "@jaira/shared/browser";
import { linePlaceKindOf, runsAFile } from "./composerPermissionSet";
import { NAMED_PLACE_WORDS } from "./permissionSetWords";

/** One set of a preview, by the id a person reads (`chat/read-only`, `project/build-safe`) and its map. */
export interface PreviewSet {
  id: string;
  decl: Record<string, unknown>;
}

/** What one set says at a row: a decision (or `unavailable`), and the line that said it. */
export interface PreviewAnswer {
  mode: PermissionSetMode | "unavailable";
  /** The line that answered — the row's own subject, or one it fell to (`script`, `shell`, `other`). */
  line: string;
  /** The place of that line that answered, when one did. */
  place?: string;
}

/** One row of the table. */
export interface PreviewRow {
  subject: string;
  /** The place the row is about; absent for everywhere, and for elsewhere. */
  place?: string;
  /** Under the subject: `in packages/app`, `in this project`, `elsewhere`, or nothing for a plain line. */
  where: string;
  /** What the base says; absent when it says nothing there. */
  base?: PreviewAnswer;
  /** What the layer says ITSELF — its own line at the place; absent when it says nothing there. */
  layer?: PreviewAnswer;
  /** What the stack comes to. With no line anywhere: `ask`, the ledger's last resort. */
  result: PreviewAnswer | { mode: "ask"; line?: undefined };
  /** Who decided: `build-safe`, `read-only · script`, or `no line in either — ask`. */
  decidedBy: string;
}

const placesOf = (set: PermissionSet, line: string): Record<string, PermissionSetMode> => set.entries[line]?.places ?? {};

/** The lines a call of `subject` answers to, most specific first — `other` last, but for a runner's line. */
export function lineChainOf(subject: string): string[] {
  const kind = subjectKindOf(subject);
  if (kind === "other") return [OTHER_SUBJECT];
  const chain = [subject];
  if (kind === "command") {
    const words = subject.split(" ");
    for (let n = words.length - 1; n >= 1; n--) chain.push(words.slice(0, n).join(" "));
    if (runsAFile(subject)) chain.push(SCRIPT_SUBJECT);
    chain.push(SHELL_TOOL);
  } else if (kind === "script") chain.push(SHELL_TOOL);
  else if (kind === "runner") {
    // A runner line that says nothing passes to the group's, and no further: with no runner line the
    // runner is simply not looked inside (`answerOfLines` in `@jaira/runtime`), which `other` does not answer.
    if (parseRunnerSubject(subject)?.program !== undefined) chain.push(RUNNER_GROUP_SUBJECT);
    return chain;
  }
  chain.push(OTHER_SUBJECT);
  return chain;
}

/**
 * What one set says about a call of `subject` at `place` (or at none of the line's places, for
 * `undefined`), walking {@link lineChainOf}. `only` asks the row's own line and nothing below it — what
 * a LAYER says itself. `undefined` when no line of the set speaks.
 */
export function answerAt(set: PermissionSet, subject: string, place: string | undefined, only = false): PreviewAnswer | undefined {
  const chain = only ? [subject] : lineChainOf(subject);
  for (const line of chain) {
    if (line === OTHER_SUBJECT) {
      if (set.other !== undefined) return { mode: set.other, line };
      continue;
    }
    const entry = Object.hasOwn(set.entries, line) ? set.entries[line] : undefined;
    if (entry === undefined) continue;
    if (entry.unavailable === true) return { mode: "unavailable", line };
    const places = placesOf(set, line);
    if (place !== undefined && Object.keys(places).length > 0) {
      if (Object.hasOwn(places, place)) return { mode: places[place]!, line, place };
      const kind = linePlaceKindOf(line);
      const match = kind !== undefined && !/[*?{]/.test(place) && !place.startsWith("$") ? resolvePlace(places, kind, place) : undefined;
      if (match !== undefined) return { mode: match.decision, line, place: match.place };
    }
    if (entry.mode !== undefined) return { mode: entry.mode, line };
  }
  return undefined;
}

/** `in packages/app`, `in this project (`$PROJECT`)`, `everywhere else` — where a row's call is. */
function whereWords(place: string | undefined, placed: boolean): string {
  if (place === undefined) return placed ? "elsewhere" : "";
  if (place === PLACE_ANYWHERE) return "everywhere else";
  return Object.hasOwn(NAMED_PLACE_WORDS, place) ? `in ${NAMED_PLACE_WORDS[place]}` : `in ${place}`;
}

/**
 * The table for `layer` laid over `base` (§4.3), a row per line the layer writes — per place, most
 * specific first, then elsewhere, for a line with places — `other` last where the layer writes one.
 */
export function stackPreviewOf(base: PreviewSet, layer: PreviewSet): PreviewRow[] {
  const composed = composePermissionSetLayers([base, layer]);
  const merged = parsePermissionSet(composed.decl).permissionSet;
  const below = parsePermissionSet(base.decl).permissionSet;
  const own = parsePermissionSet(layer.decl).permissionSet;
  const rows: PreviewRow[] = [];
  const row = (subject: string, place: string | undefined, placed: boolean): void => {
    const result = answerAt(merged, subject, place);
    const by = result === undefined ? undefined : decidedBy(composed, result.line, result.place);
    const said = result === undefined ? "no line in either — ask" : `${by ?? "neither"}${result.line !== subject ? ` · ${result.line}` : ""}`;
    const b = answerAt(below, subject, place);
    const l = answerAt(own, subject, place, true);
    rows.push({
      subject,
      ...(place !== undefined ? { place } : {}),
      where: whereWords(place, placed),
      ...(b !== undefined ? { base: b } : {}),
      ...(l !== undefined ? { layer: l } : {}),
      result: result ?? { mode: "ask" },
      decidedBy: said,
    });
  };
  for (const [subject, entry] of Object.entries(own.entries)) {
    const places = Object.keys(entry.places ?? {});
    if (places.length === 0) {
      row(subject, undefined, false);
      continue;
    }
    for (const place of placesMostSpecificFirst(linePlaceKindOf(subject) ?? "path", places)) row(subject, place, true);
    row(subject, undefined, true);
  }
  if (own.other !== undefined) row(OTHER_SUBJECT, undefined, false);
  return rows;
}

/**
 * The base a set is first shown over: a set whose bucket's standing layers name it is shown over that
 * bucket's `ask-first` (it is laid on every set there); any other over `chat/ask-first`; failing those,
 * the first set offered. Never the set itself.
 */
export function defaultBaseOf(id: string, offered: readonly string[], standing: Readonly<Record<string, readonly string[]>>): string | undefined {
  const others = offered.filter((one) => one !== id);
  const bucket = Object.entries(standing).find(([, list]) => list.some((reference) => reference.replace(/\.(json|ya?ml)$/, "").endsWith(`/permission-sets/${id}`)))?.[0];
  for (const want of [bucket !== undefined ? `${bucket}/ask-first` : undefined, "chat/ask-first"]) if (want !== undefined && others.includes(want)) return want;
  return others[0];
}
