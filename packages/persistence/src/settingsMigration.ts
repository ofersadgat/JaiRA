/**
 * The one-shot migration that dissolves the project `policy` block (decision 0007, amended
 * 2026-09-23), run on every open until there is nothing left to move.
 *
 * Per layer `settings.json` — the shared root's and the project's — it:
 *
 *  - moves `smart` to `functions.smart`, `policy.remote.publish` and `integrations.review.settleAfter`
 *    to `functions.review_artifacts`, and `policy.builtins` to `functions.bash.builtins`;
 *  - writes each `policy.rules` entry as a command line under the `bash` tool of every permission set that
 *    layer can name — its own files in place, a lower layer's (the shared root's, or what ships) as an
 *    override in the layer's own `permission-sets/` that keeps following it;
 *  - carries a stricter-than-default `policy.default` onto each set's `bash` line and a
 *    `policy.toolDefault` onto a set that has no `other` line;
 *  - deletes `policy` and `smart`.
 *
 * What it cannot say exactly it says so, line by line, and never widens an allow to say it: the report
 * is logged, and kept with a copy of every file it changed in place under the layer's
 * `system/logs/settings-migration-<stamp>/`. A layer with nothing to move is not touched, which is what
 * makes it idempotent. Once every checkout has opened, this module and its call in `project.ts` go
 * (the standing rule: migrate the data, then delete the reader of the old form).
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createLogger } from "@declarative-ai/log";
import {
  entryOfDecl,
  isFunctionMode,
  OTHER_SUBJECT,
  readJsonFile,
  parsePermissionSet,
  SHELL_TOOL,
  shellWithheld,
  subjectKindOf,
  type JairaPaths,
  type PermissionSetDecl,
  type PermissionSetEntryDecl,
  type PermissionSetMode,
  type PermissionSetRecord,
  type WorkflowLayer,
} from "@jaira/shared";
import { readPermissionSetLayers, permissionSetLayers, writePermissionSet, type PermissionSetLayer } from "./permissionSets";

const log = createLogger("jaira.persistence.settings-migration");

/** What one layer's migration did — or, on a dry run, would do. */
export interface SettingsMigrationReport {
  layer: "project" | "base";
  settingsFile: string;
  /** Every file written, or that would be: the settings file and the permission set files. */
  written: string[];
  /** One sentence per thing moved, written, kept or left out, in the order it was decided. */
  lines: string[];
  /** Where the report and the originals of the files changed in place were kept. Absent on a dry run. */
  keptAt?: string;
}

export interface SettingsMigrationOptions {
  /** Say what would be done and write nothing. */
  dryRun?: boolean;
  now?: () => number;
}

/** The old `policy.rules[i]`, as the document holds it — read for this migration and nothing else. */
interface OldRule {
  match?: unknown;
  action?: unknown;
  reason?: unknown;
}

interface OldMatcher {
  program?: string;
  subcommand?: string;
  flags?: string[];
  anyFlag?: string[];
  argIncludes?: string;
}

type LineMode = "allow" | "ask" | "deny";

/** A command line a rule becomes, and the rule it came from (1-based, as a person counts). */
interface CommandLine {
  subject: string;
  mode: LineMode;
  rule: number;
}

/** What the old `policy` block asks of every permission set in its layer. */
interface PermissionSetAsk {
  lines: CommandLine[];
  /** `policy.default`, as a mode, where it is not the default `allow`. */
  shell?: LineMode;
  /** `policy.toolDefault`, where it is a mode a permission set line can hold and not upstream's own `ask`. */
  other?: LineMode;
}

const RANK: Record<LineMode, number> = { allow: 0, ask: 2, deny: 3 };
const rankOf = (mode: PermissionSetMode): number => (isFunctionMode(mode) ? 1 : RANK[mode as LineMode]);
const ACTION_MODE: Record<string, LineMode> = { allow: "allow", require_approval: "ask", deny: "deny" };
const normalizeSubject = (subject: string): string => subject.trim().replace(/\s+/g, " ").toLowerCase();
const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const modeText = (mode: PermissionSetMode): string => (isFunctionMode(mode) ? `{ "function": "${mode.function}" }` : `"${mode}"`);

/**
 * The destructive floor's own commands, as the old matcher read them — to say where an allowing rule
 * used to reach past the floor, which it no longer can: the floor stands above every permission set line.
 */
const FLOOR_PROBES: Array<{ line: string; program: string; subcommand?: string; flags: string[]; words: string[] }> = [
  ...["--force", "-f", "--force-with-lease", "--mirror"].map((flag) => ({ line: `git push ${flag}`, program: "git", subcommand: "push", flags: [flag], words: ["push"] })),
  { line: "git reset --hard", program: "git", subcommand: "reset", flags: ["--hard"], words: ["reset"] },
  ...["rebase", "filter-branch", "filter-repo", "gc", "prune"].map((sub) => ({ line: `git ${sub}`, program: "git", subcommand: sub, flags: [], words: [sub] })),
  { line: "git clean -f", program: "git", subcommand: "clean", flags: ["-f"], words: ["clean"] },
  { line: "rm -rf .git", program: "rm", subcommand: ".git", flags: ["-rf"], words: [".git"] },
];

function oldMatches(m: OldMatcher, probe: (typeof FLOOR_PROBES)[number]): boolean {
  if (m.program !== undefined && m.program !== probe.program) return false;
  if (m.subcommand !== undefined && m.subcommand !== probe.subcommand) return false;
  if (m.flags !== undefined && !m.flags.every((f) => probe.flags.includes(f))) return false;
  if (m.anyFlag !== undefined && !m.anyFlag.some((f) => probe.flags.includes(f))) return false;
  if (m.argIncludes !== undefined && !probe.words.some((w) => w.includes(m.argIncludes!))) return false;
  return true;
}

/** Does the old matcher `a` reach every command `b` does — is `b` behind it under first-match-wins? */
function covers(a: OldMatcher, b: OldMatcher): boolean {
  if (a.argIncludes !== undefined || a.anyFlag !== undefined || b.anyFlag !== undefined) return false;
  if (a.program !== b.program) return false;
  if (a.subcommand !== undefined && a.subcommand !== b.subcommand) return false;
  return (a.flags ?? []).every((f) => (b.flags ?? []).includes(f));
}

const WORD = /^[^\s]+$/;
const isFlag = (word: string): boolean => word.startsWith("-") && WORD.test(word);

/**
 * `policy.rules` as command lines. First match won; a permission set's most specific line wins — so a rule
 * a broader earlier one used to hide is said, as is every rule a line cannot hold as it was written.
 */
function linesOfRules(raw: unknown, builtinsOn: boolean, lines: string[]): CommandLine[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    lines.push("policy.rules is not a list, so no rule was carried over.");
    return [];
  }
  const out: CommandLine[] = [];
  const kept: Array<{ matcher: OldMatcher; mode: LineMode; rule: number }> = [];
  raw.forEach((entry: unknown, index) => {
    const n = index + 1;
    const rule = (isPlainObject(entry) ? entry : {}) as OldRule;
    const mode = typeof rule.action === "string" ? ACTION_MODE[rule.action] : undefined;
    const said = JSON.stringify(entry);
    if (mode === undefined) {
      lines.push(`rule ${n} ${said} has no action a line can hold (allow, require_approval, deny) — left out.`);
      return;
    }
    if (!isPlainObject(rule.match)) {
      lines.push(`rule ${n} ${said} has no matcher — left out.`);
      return;
    }
    const m = rule.match as Record<string, unknown>;
    const program = typeof m["program"] === "string" ? m["program"].trim().toLowerCase() : undefined;
    const subcommand = typeof m["subcommand"] === "string" ? m["subcommand"].trim().toLowerCase() : undefined;
    const flags = Array.isArray(m["flags"]) ? m["flags"] : m["flags"] === undefined ? [] : undefined;
    const anyFlag = m["anyFlag"] === undefined ? undefined : Array.isArray(m["anyFlag"]) ? m["anyFlag"] : null;
    const argIncludes = typeof m["argIncludes"] === "string" ? m["argIncludes"] : undefined;
    const unknown = Object.keys(m).filter((key) => !["program", "subcommand", "flags", "anyFlag", "argIncludes"].includes(key));

    const refuse = (why: string): void => void lines.push(`rule ${n} ${said} cannot be a permission set line — ${why}; left out.`);
    if (unknown.length > 0) return refuse(`it names ${unknown.join(", ")}, which no matcher ever read`);
    if (program === undefined || !/^[a-z][a-z0-9.+-]*$/.test(program)) return refuse("a command line starts with the program, and the rule names none a line can spell");
    if (subcommand !== undefined && (!WORD.test(subcommand) || isFlag(subcommand))) return refuse(`its subcommand '${subcommand}' is not one word`);
    if (flags === undefined || !flags.every((f): f is string => typeof f === "string" && isFlag(f))) return refuse("its flags are not a list of flags");
    if (anyFlag === null || (anyFlag !== undefined && !anyFlag.every((f): f is string => typeof f === "string" && isFlag(f)))) return refuse("its anyFlag is not a list of flags");
    if (anyFlag !== undefined && anyFlag.length === 0) return refuse("an empty anyFlag never matched anything");
    const base = [program, ...(subcommand !== undefined ? [subcommand] : []), ...(flags as string[])];
    if (subcommand === undefined && flags.length === 0 && anyFlag === undefined && subjectKindOf(program) !== "command") {
      return refuse(`'${program}' alone is the name of a ${subjectKindOf(program) === "tool" ? "standard tool" : "subject"}, not a command`);
    }
    if (argIncludes !== undefined) {
      if (mode === "allow") return refuse(`a line cannot require '${argIncludes}' in an argument, and allowing every '${base.join(" ")}' would allow more than the rule did`);
      lines.push(
        `rule ${n} ${said} required '${argIncludes}' in an argument, which a line cannot say — written for every '${base.join(" ")}' instead, which ${mode === "deny" ? "refuses" : "asks about"} more than the rule did.`,
      );
    }
    const subjects = anyFlag === undefined ? [base.join(" ")] : (anyFlag as string[]).map((flag) => [...base, ...(base.includes(flag) ? [] : [flag])].join(" "));
    if (anyFlag !== undefined && anyFlag.length > 1) lines.push(`rule ${n}'s anyFlag is ${subjects.length} lines, one per flag: ${subjects.map((s) => `"${s}"`).join(", ")}.`);
    const matcher: OldMatcher = { program, ...(subcommand !== undefined ? { subcommand } : {}), flags: flags as string[], ...(anyFlag !== undefined ? { anyFlag: anyFlag as string[] } : {}), ...(argIncludes !== undefined ? { argIncludes } : {}) };

    // First match won: an earlier rule that reaches every command this one does hid it.
    // (An identical matcher is a twin: the line keeps the first, as first-match did — said below.)
    const same = (a: OldMatcher): boolean => a.program === matcher.program && a.subcommand === matcher.subcommand && (a.flags ?? []).join(" ") === (matcher.flags ?? []).join(" ");
    const hider = kept.find((earlier) => covers(earlier.matcher, matcher) && !same(earlier.matcher) && earlier.mode !== mode);
    if (hider !== undefined) {
      lines.push(
        `rule ${n} (${mode}) was never reached, because rule ${hider.rule} (${hider.mode}) matched first; as lines the more specific one decides, so '${subjects.join("', '")}' is now ${mode === "ask" ? "asked about" : mode === "deny" ? "refused" : "allowed"}.`,
      );
    }
    if (builtinsOn && mode !== "deny") {
      const past = FLOOR_PROBES.filter((probe) => oldMatches(matcher, probe)).map((probe) => probe.line);
      if (past.length > 0) lines.push(`rule ${n} used to ${mode} ${past.join(", ")} ahead of the built-in floor; the floor now stands above every permission set line, so those stay refused.`);
    }
    kept.push({ matcher, mode, rule: n });
    for (const subject of subjects) {
      const twin = out.find((line) => normalizeSubject(line.subject) === normalizeSubject(subject));
      if (twin !== undefined) {
        if (twin.mode !== mode) lines.push(`rule ${n} says ${mode} for '${subject}', which rule ${twin.rule} already answered ${twin.mode} and first match kept — the line is ${twin.mode}.`);
        continue;
      }
      out.push({ subject, mode, rule: n });
    }
  });
  return out;
}

/** The changes one permission set takes, and what was said about it. */
function planPermissionSet(id: string, decl: PermissionSetDecl, ask: PermissionSetAsk, lines: string[]): PermissionSetDecl {
  const changes: PermissionSetDecl = {};
  const keyOf = (subject: string): string | undefined => Object.keys(decl).find((key) => normalizeSubject(key) === normalizeSubject(subject));
  const holdsShell = Object.hasOwn(decl, SHELL_TOOL);
  const withheld = holdsShell && shellWithheld(parsePermissionSet(decl).permissionSet);

  if (ask.lines.length > 0) {
    if (!holdsShell) lines.push(`${id} offers no shell, so the ${ask.lines.length} command line(s) have nothing to judge there and were not written.`);
    else {
      let skipped = 0;
      for (const line of ask.lines) {
        const key = keyOf(line.subject);
        if (key !== undefined) {
          const held = entryOfDecl(decl[key]!).mode;
          if (isFunctionMode(held) || held !== line.mode) {
            const looser = rankOf(held) < RANK[line.mode];
            lines.push(`${id} already holds "${key}": ${modeText(held)}, which is kept — rule ${line.rule} said "${line.mode}"${looser ? ", so this set is now LOOSER than the policy was for it" : ""}.`);
          }
          continue;
        }
        // A withheld shell stays withheld: a line that allows or asks would open it.
        if (withheld && line.mode !== "deny") {
          skipped += 1;
          continue;
        }
        changes[line.subject] = line.mode;
      }
      if (skipped > 0) lines.push(`${id} withholds its shell ("bash": "deny"), so ${skipped} line(s) that allow or ask were not written — they would have handed it a shell.`);
    }
  }

  // `policy.default` was the verdict for a command nothing named, composed with the set's `bash` line
  // as the stricter of the two; the line now says it alone.
  if (ask.shell !== undefined && holdsShell) {
    const { mode, implementation } = entryOfDecl((changes[SHELL_TOOL] ?? decl[SHELL_TOOL])!);
    if (rankOf(mode) < RANK[ask.shell]) {
      changes[SHELL_TOOL] = implementation !== undefined ? { mode: ask.shell, implementation } : ask.shell;
      lines.push(`${id}'s "bash" line goes from ${modeText(mode)} to "${ask.shell}", the policy's default for a command nothing names.`);
    }
  }

  // `policy.toolDefault` was the mode for a tool nothing named, and a set's `other` already said that.
  if (ask.other !== undefined && !Object.hasOwn(decl, OTHER_SUBJECT)) {
    changes[OTHER_SUBJECT] = ask.other;
    lines.push(`${id} had no "other" line, so it takes the policy's toolDefault: "other": "${ask.other}".`);
  }
  return changes;
}

/** The map a layer reads for a permission set — its own file, else the nearest lower layer's. */
function declAt(record: PermissionSetRecord, order: readonly WorkflowLayer[], layer: WorkflowLayer): { decl?: PermissionSetDecl; problem?: string } | undefined {
  const from = order.indexOf(layer);
  const file = record.files.find((candidate) => order.indexOf(candidate.layer) >= from);
  if (file === undefined) return undefined;
  return file.decl !== undefined ? { decl: file.decl } : { problem: file.problem ?? "it is not a permission set" };
}

/** Move one layer's document, and say what the rest of its policy asks of the permission sets. */
function moveSettings(doc: Record<string, unknown>, lines: string[]): { next: Record<string, unknown>; ask: PermissionSetAsk } {
  const next = structuredClone(doc);
  const functions = (isPlainObject(next["functions"]) ? next["functions"] : {}) as Record<string, unknown>;
  const block = (name: string): Record<string, unknown> => (isPlainObject(functions[name]) ? functions[name] : (functions[name] = {})) as Record<string, unknown>;
  const put = (fn: string, key: string, value: unknown, from: string): void => {
    const target = block(fn);
    if (target[key] !== undefined) {
      lines.push(`${from} (${JSON.stringify(value)}) was dropped: functions.${fn}.${key} already says ${JSON.stringify(target[key])}.`);
      return;
    }
    target[key] = value;
    lines.push(`${from} → functions.${fn}.${key} (${JSON.stringify(value)}).`);
  };

  const smart = next["smart"];
  if (smart !== undefined) {
    if (isPlainObject(smart)) {
      for (const [key, value] of Object.entries(smart)) {
        if (key === "model" || key === "prompt") put("smart", key, value, `smart.${key}`);
        else lines.push(`smart.${key} was dropped: the smart function has no such setting.`);
      }
    } else lines.push("smart was not an object, and was dropped.");
    delete next["smart"];
  }

  const integrations = next["integrations"];
  if (isPlainObject(integrations) && integrations["review"] !== undefined) {
    const review = integrations["review"];
    if (isPlainObject(review)) {
      for (const [key, value] of Object.entries(review)) {
        if (key === "settleAfter") put("review_artifacts", "settleAfter", value, "integrations.review.settleAfter");
        else lines.push(`integrations.review.${key} was dropped: review_artifacts has no such setting.`);
      }
    }
    delete integrations["review"];
    if (Object.keys(integrations).length === 0) delete next["integrations"];
  }

  const ask: PermissionSetAsk = { lines: [] };
  const policy = next["policy"];
  if (policy !== undefined) {
    if (isPlainObject(policy)) {
      const builtins = policy["builtins"];
      if (builtins !== undefined) {
        if (typeof builtins === "boolean") put("bash", "builtins", builtins, "policy.builtins");
        else lines.push(`policy.builtins (${JSON.stringify(builtins)}) was not true or false, and was dropped.`);
      }
      const remote = policy["remote"];
      if (isPlainObject(remote)) {
        for (const [key, value] of Object.entries(remote)) {
          if (key === "publish") put("review_artifacts", "publish", value, "policy.remote.publish");
          else lines.push(`policy.remote.${key} was dropped: review_artifacts has no such setting.`);
        }
      }
      const builtinsOn = builtins !== false;
      ask.lines = linesOfRules(policy["rules"], builtinsOn, lines);
      const fallback = policy["default"];
      if (fallback !== undefined && fallback !== "allow") {
        const mode = typeof fallback === "string" ? ACTION_MODE[fallback] : undefined;
        if (mode !== undefined) {
          ask.shell = mode;
          lines.push(
            `policy.default was "${fallback}". It is carried onto each set's "bash" line where that line was looser; a file utility on a line (cat, ls, rm) answers to its file tool's line, which the default no longer tightens, and a line no permission set judges now answers to the built-ins alone.`,
          );
        } else lines.push(`policy.default (${JSON.stringify(fallback)}) is not an action, and was dropped.`);
      }
      const toolDefault = policy["toolDefault"];
      if (toolDefault !== undefined && toolDefault !== "ask") {
        if (toolDefault === "allow" || toolDefault === "deny") {
          ask.other = toolDefault;
          lines.push(`policy.toolDefault was "${toolDefault}". A set with an "other" line already said this for itself; a set without one takes it as "other".`);
        } else lines.push(`policy.toolDefault (${JSON.stringify(toolDefault)}) is not a mode a permission set line can hold, and was dropped.`);
      }
      const tools = policy["tools"];
      if (isPlainObject(tools) && Object.keys(tools).length > 0) {
        lines.push(
          `policy.tools (${Object.keys(tools).join(", ")}) was dropped: a permission set's own line for a tool already decided over it, and a tool line is not added to a set that does not offer the tool.`,
        );
      }
      const known = ["builtins", "remote", "rules", "default", "toolDefault", "tools"];
      for (const key of Object.keys(policy).filter((k) => !known.includes(k))) lines.push(`policy.${key} was dropped: nothing ever read it.`);
    } else lines.push("policy was not an object, and was dropped.");
    delete next["policy"];
  }

  if (Object.keys(functions).length > 0) next["functions"] = functions;
  return { next, ask };
}

const hasOldForm = (doc: Record<string, unknown>): boolean =>
  doc["policy"] !== undefined || doc["smart"] !== undefined || (isPlainObject(doc["integrations"]) && doc["integrations"]["review"] !== undefined);

function readDoc(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const doc = readJsonFile(file);
    return isPlainObject(doc) ? doc : undefined;
  } catch {
    return undefined; // the open reports a file that does not parse; this is not where that is said
  }
}

/**
 * Migrate every layer of `paths` that still has the old form: the shared root first, then the
 * project (unless the project IS the shared root). Returns one report per layer that had something to
 * move; an empty list means nothing was, and nothing was written.
 */
export function migrateSettingsLayers(paths: JairaPaths, options: SettingsMigrationOptions = {}): SettingsMigrationReport[] {
  const layers = permissionSetLayers(paths);
  const order = layers.map((layer) => layer.layer);
  const candidates: Array<{ layer: PermissionSetLayer; file: string; systemDir: string }> = [];
  const base = layers.find((layer) => layer.layer === "base");
  if (base !== undefined) candidates.push({ layer: base, file: paths.base.settingsFile, systemDir: paths.base.systemDir });
  const project = layers.find((layer) => layer.layer === "project");
  if (project !== undefined) candidates.push({ layer: project, file: paths.settingsFile, systemDir: paths.systemDir });

  const pending = candidates.flatMap((candidate) => {
    const doc = readDoc(candidate.file);
    return doc !== undefined && hasOldForm(doc) ? [{ ...candidate, doc }] : [];
  });
  if (pending.length === 0) return [];

  // What each set held BEFORE anything here wrote — so a project's rule is not kept out of a set by a
  // line the shared root's rules have just put there, where the project's rules used to replace them.
  const before = readPermissionSetLayers(paths);
  const reports: SettingsMigrationReport[] = [];
  const stamp = new Date((options.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-");
  const hadRules = pending.filter((p) => isPlainObject(p.doc["policy"]) && Array.isArray(p.doc["policy"]["rules"]) && p.doc["policy"]["rules"].length > 0);

  for (const { layer, file, systemDir, doc } of pending) {
    const lines: string[] = [];
    const { next, ask } = moveSettings(doc, lines);
    if (layer.layer === "project" && hadRules.length === 2) {
      lines.push("Both the shared root and this project had policy.rules. The project's used to replace the shared root's; as lines, a set this project names from the shared root keeps the shared root's lines beside the project's.");
    }

    const plans: Array<{ id: string; changes: PermissionSetDecl }> = [];
    const asksAnything = ask.lines.length > 0 || ask.shell !== undefined || ask.other !== undefined;
    if (asksAnything) {
      for (const record of before) {
        const at = declAt(record, order, layer.layer);
        if (at === undefined) continue;
        if (at.decl === undefined) {
          lines.push(`${record.id} could not be read (${at.problem}), so nothing was written to it.`);
          continue;
        }
        const changes = planPermissionSet(record.id, at.decl, ask, lines);
        if (Object.keys(changes).length > 0) plans.push({ id: record.id, changes });
      }
    }

    if (lines.length === 0) lines.push("The old blocks said nothing, and were removed.");
    const report: SettingsMigrationReport = { layer: layer.layer as "project" | "base", settingsFile: file, written: [], lines };
    // The current map, re-read: an earlier layer's writes may sit under this one's, and a whole map
    // that left one of them out would stop following the file below instead of adding to it.
    const records = options.dryRun === true ? before : readPermissionSetLayers(paths);
    for (const plan of plans) {
      const record = records.find((r) => r.id === plan.id);
      const current = record === undefined ? undefined : declAt(record, order, layer.layer)?.decl;
      if (current === undefined) continue;
      const own = record!.files.find((f) => f.layer === layer.layer);
      const target = join(layer.root, "permission-sets", `${plan.id}.json`);
      const says = Object.entries(plan.changes)
        .map(([subject, entry]) => `"${subject}": ${JSON.stringify(entry as PermissionSetEntryDecl)}`)
        .join(", ");
      if (options.dryRun === true) {
        lines.push(`${plan.id}: would write ${says} ${own !== undefined ? "into this layer's file" : "as an override in this layer"}.`);
        report.written.push(target);
        continue;
      }
      try {
        keepOriginal(target, layer.root, systemDir, stamp);
        const written = writePermissionSet(paths, plan.id, layer.layer, { ...current, ...plan.changes });
        lines.push(`${plan.id}: wrote ${says} (${written.kind}, ${written.file}).`);
        report.written.push(written.file);
      } catch (e) {
        lines.push(`${plan.id}: NOT written — ${(e as Error).message}. Its lines were ${says}.`);
      }
    }

    if (options.dryRun !== true) {
      keepOriginal(file, dirname(file), systemDir, stamp);
      writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      report.written.unshift(file);
      const keptAt = migrationDir(systemDir, stamp);
      mkdirSync(keptAt, { recursive: true });
      writeFileSync(join(keptAt, "report.txt"), [`settings migration of ${file} (${layer.label}), ${stamp}`, "", ...lines.map((line) => `- ${line}`), ""].join("\n"), "utf8");
      report.keptAt = keptAt;
      for (const line of lines) log.info(`${layer.label}: ${line}`);
      log.info(`${layer.label}: the policy block is dissolved; the report and the originals are in ${keptAt}`);
    } else report.written.unshift(file);
    reports.push(report);
  }
  return reports;
}

const migrationDir = (systemDir: string, stamp: string): string => join(systemDir, "logs", `settings-migration-${stamp}`);

/** A copy of a file about to be changed in place, under the migration's own folder, at its path in the layer. */
function keepOriginal(file: string, root: string, systemDir: string, stamp: string): void {
  if (!existsSync(file)) return;
  const inside = relative(root, file);
  const copy = join(migrationDir(systemDir, stamp), "originals", inside.startsWith("..") ? file.replace(/[:\\/]+/g, "_") : inside);
  if (existsSync(copy)) return;
  mkdirSync(dirname(copy), { recursive: true });
  copyFileSync(file, copy);
}
