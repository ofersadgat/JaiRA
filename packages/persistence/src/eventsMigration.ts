/**
 * The one-shot rewrite of the events workflow's automations from the shape decision 0010 was first
 * built in (2026-09-25, commit 7c92fc93) into the one the person ruled the same day — run on every open
 * until there is nothing left to rewrite.
 *
 * The OLD shape: a line's rule handed step 1 everything — `{ name, when, to: name, inputs: { event:
 * ".event", workflow: { text }, inputs: { $literal: { … { $binding: ".event.payload.x" } … } } } }` —
 * into an async child naming a built-in step state (`system/events/start` or `/notify`), and every
 * further step was a child `<name>_<n>` the one before chained to with `{ when: "true", to }`, wired
 * from `.children.<prev>.output.event`.
 *
 * The NEW shape (`@jaira/shared` `automations.ts`): the rule hands in the event only — `inputs: {
 * event: ".event" }` — to one async child `name: { async: true }`, whose state is a file of its own,
 * `system/events/<name>`, written beside the root in the same layer: its steps are ONE operation list
 * of `start_task` / `notify` calls, reading the event as `.inputs.event`. The built-in step states are
 * gone, so a line left in the old shape no longer loads; that is why this runs.
 *
 * Each layer's copy is rewritten on its own: Shared's (`~/.jaira/workflows/system/events.json`) and a
 * project's (`.jaira/workflows/system/events.json`) — a project's own lines and children only; the
 * spliced `$ref`s to Shared's are kept as they are. A line this cannot take apart (a hand-written
 * guard wired some other way) is left exactly as it stands and named in the report. The original root
 * file is kept under `<system>/logs/events-migration-<stamp>/`.
 *
 * Once every copy has been opened, this module and its calls in `project.ts` go (the standing rule:
 * migrate the data, then delete the reader of the old form).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogger } from "@declarative-ai/log";
import type { JsonValue } from "@declarative-ai/json";
import { automationStateIdOf, automationStateOf, EVENTS_STATE_ID, type AutomationStep, type JairaPaths, type StepValue } from "@jaira/shared";

const log = createLogger("jaira.persistence.events-migration");

/** The step states the old shape named — shipped until 2026-09-25, gone since. */
export const OLD_START_STEP = "system/events/start";
export const OLD_NOTIFY_STEP = "system/events/notify";

/** What one layer's rewrite did — or, dry, would do. */
export interface EventsMigrationReport {
  /** The layer's events workflow. */
  file: string;
  /** The lines rewritten, by name. */
  lines: string[];
  /** Lines in the old shape that could not be taken apart, left as they stand. */
  kept: string[];
  /** Every file written, in the order written (the automations' states before the root). */
  writes: Array<{ file: string; text: string }>;
  /** Where the original root was kept; absent on a dry run. */
  keptAt?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (doc: unknown): string => `${JSON.stringify(doc, null, 2)}\n`;

/** A root whose children name one of the old step states. */
export function isOldEventsShape(doc: unknown): boolean {
  if (!isRecord(doc) || !isRecord(doc["children"])) return false;
  return Object.values(doc["children"]).some((mount) => isRecord(mount) && (mount["state"] === OLD_START_STEP || mount["state"] === OLD_NOTIFY_STEP));
}

/** A literal as the old wiring spelled it: `{ "text": … }` or `{ "json": … }`. */
function literalOf(value: unknown): { value: JsonValue } | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1) return undefined;
  if (typeof value["text"] === "string") return { value: value["text"] };
  if ("json" in value) return { value: value["json"] as JsonValue };
  return undefined;
}

/** One old step, from its state and wiring, as a step of the new list; `undefined` when it is not one. */
function stepOfOld(state: unknown, wiring: unknown, eventRef: string): AutomationStep | undefined {
  if (!isRecord(wiring)) return undefined;
  if (state === OLD_NOTIFY_STEP) {
    const said = literalOf(wiring["text"]);
    return typeof said?.value === "string" ? { kind: "notify", text: said.value } : undefined;
  }
  if (state !== OLD_START_STEP) return undefined;
  const workflow = literalOf(wiring["workflow"]);
  if (typeof workflow?.value !== "string") return undefined;
  const inputs: Record<string, StepValue> = {};
  const held = wiring["inputs"];
  if (held !== undefined) {
    if (!isRecord(held) || !isRecord(held["$literal"])) return undefined;
    for (const [key, value] of Object.entries(held["$literal"])) {
      if (isRecord(value) && Object.keys(value).length === 1 && typeof value["$binding"] === "string") {
        const ref = value["$binding"];
        if (ref !== eventRef && !ref.startsWith(`${eventRef}.`)) return undefined;
        inputs[key] = { event: ref === eventRef ? "" : ref.slice(eventRef.length + 1) };
      } else inputs[key] = { literal: value as JsonValue };
    }
  }
  const title = wiring["title"] !== undefined ? literalOf(wiring["title"]) : undefined;
  if (wiring["title"] !== undefined && typeof title?.value !== "string") return undefined;
  return { kind: "start", workflow: workflow.value, inputs, ...(typeof title?.value === "string" ? { title: title.value } : {}) };
}

/** One old line — its rule and the chain of children it starts — as the new line's steps and the keys it owned. */
function lineOfOld(rule: Record<string, unknown>, children: Record<string, unknown>): { name: string; steps: AutomationStep[]; owned: string[] } | undefined {
  const name = rule["name"];
  if (typeof name !== "string" || rule["to"] !== name) return undefined;
  const steps: AutomationStep[] = [];
  const owned: string[] = [];
  let key: string | undefined = name;
  let previous: string | undefined;
  while (key !== undefined) {
    const mount: unknown = children[key];
    if (!isRecord(mount) || mount["async"] !== true || owned.includes(key)) return undefined;
    const eventRef = previous === undefined ? ".event" : `.children.${previous}.output.event`;
    const wiring = previous === undefined ? rule["inputs"] : mount["inputs"];
    if (!isRecord(wiring) || wiring["event"] !== eventRef) return undefined;
    const step = stepOfOld(mount["state"], wiring, eventRef);
    if (step === undefined) return undefined;
    steps.push(step);
    owned.push(key);
    previous = key;
    const next: unknown = mount["transitions"];
    if (next === undefined) key = undefined;
    else if (Array.isArray(next) && next.length === 1 && isRecord(next[0]) && next[0]["when"] === "true" && typeof next[0]["to"] === "string") key = next[0]["to"];
    else return undefined;
  }
  return { name, steps, owned };
}

/** The layer's rewrite, as data: the new root, and each automation's state. `undefined`: nothing to rewrite. */
export function rewriteEventsDoc(doc: unknown): { root: Record<string, unknown>; states: Record<string, Record<string, unknown>>; lines: string[]; kept: string[] } | undefined {
  if (!isRecord(doc) || !isOldEventsShape(doc)) return undefined;
  const children = isRecord(doc["children"]) ? { ...doc["children"] } : {};
  const rules = Array.isArray(doc["transitions"]) ? doc["transitions"] : [];
  const states: Record<string, Record<string, unknown>> = {};
  const lines: string[] = [];
  const kept: string[] = [];
  const nextRules = rules.map((rule) => {
    if (!isRecord(rule) || typeof rule["$ref"] === "string") return rule;
    const line = lineOfOld(rule, children);
    if (line === undefined) {
      if (typeof rule["name"] === "string") kept.push(rule["name"]);
      return rule;
    }
    for (const key of line.owned) delete children[key];
    children[line.name] = { async: true };
    states[line.name] = automationStateOf(line.name, line.steps);
    lines.push(line.name);
    const { inputs: _old, ...rest } = rule;
    return { ...rest, inputs: { event: ".event" } };
  });
  return { root: { ...doc, transitions: nextRules, children }, states, lines, kept };
}

/**
 * Rewrite every layer of `paths` whose events workflow is still in the old shape: the shared root
 * first, then the project (unless the project IS the shared root). `dryRun` writes nothing and says
 * what it would. Returns one report per layer rewritten; an empty list means nothing was.
 */
export function migrateEventsWorkflows(paths: JairaPaths, options: { dryRun?: boolean; now?: () => number } = {}): EventsMigrationReport[] {
  const stamp = new Date((options.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-");
  const layers = [{ workflowsDir: paths.base.workflowsDir, systemDir: paths.base.systemDir }];
  if (paths.workflowsDir !== paths.base.workflowsDir) layers.push({ workflowsDir: paths.workflowsDir, systemDir: paths.systemDir });
  const reports: EventsMigrationReport[] = [];
  for (const { workflowsDir, systemDir } of layers) {
    const file = join(workflowsDir, `${EVENTS_STATE_ID}.json`);
    if (!existsSync(file)) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue; // the browser reports a file that does not parse; this is not where that is said
    }
    const rewritten = rewriteEventsDoc(doc);
    if (rewritten === undefined) continue;
    const writes = [
      ...Object.entries(rewritten.states).map(([name, state]) => ({ file: join(workflowsDir, `${automationStateIdOf(name)}.json`), text: text(state) })),
      { file, text: text(rewritten.root) },
    ];
    const report: EventsMigrationReport = { file, lines: rewritten.lines, kept: rewritten.kept, writes };
    if (options.dryRun !== true) {
      const keptAt = join(systemDir, "logs", `events-migration-${stamp}`);
      mkdirSync(keptAt, { recursive: true });
      copyFileSync(file, join(keptAt, "events.json"));
      for (const write of writes) {
        mkdirSync(dirname(write.file), { recursive: true });
        writeFileSync(write.file, write.text, "utf8");
      }
      report.keptAt = keptAt;
      log.info(
        `${file}: ${rewritten.lines.length} automation(s) rewritten as one state each with an operation list (${rewritten.lines.join(", ")})` +
          `${rewritten.kept.length > 0 ? `; left as they stand, since they could not be taken apart: ${rewritten.kept.join(", ")}` : ""}; the original is in ${keptAt}`,
      );
    }
    reports.push(report);
  }
  return reports;
}
