/**
 * Lesson files, and what they measure (decision 0029 §7, "Revisit when").
 *
 * A lesson is `lessons/<slug>.md` in a layer — the project's `.jaira/`, or the Shared layer's root —
 * its frontmatter one JSON value per key: the rule, the lever and target, its status, the changes it
 * made, and every occurrence. An occurrence is one time the lesson turned up and the improver proposed
 * a change for it: APPLIED, or DECLINED at the review. When the lesson had a change applied already,
 * the occurrence says whether a change of it was IN EFFECT where it turned up again.
 *
 * {@link learningMeasures} reads the lessons and the project's journals into the numbers the decision
 * names: corrections per conversation, recurrence per lesson, promotion across projects, how many
 * proposals were applied and how many turned down, and how often a running conversation found a place
 * to take a newer version — and which of the decision's "Revisit when" conditions they show.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { JsonValue } from "@declarative-ai/json";
import { isConversation, type LearningMeasures, type MeasuredLesson } from "@jaira/shared";
import type { Project } from "./project";

/** A lesson's file name, from its rule. */
export function lessonSlug(rule: string): string {
  const slug = rule
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "lesson";
}

/** Frontmatter written one JSON value per key — valid YAML, and read back without a YAML parser. */
export function formatLesson(front: Record<string, JsonValue>, body: string): string {
  const lines = Object.entries(front).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

/** Read a lesson file back: its frontmatter and its body. */
export function parseLesson(text: string): { front: Record<string, JsonValue>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (m === null) return { front: {}, body: text };
  const front: Record<string, JsonValue> = {};
  for (const line of m[1]!.split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    try {
      front[key] = JSON.parse(raw) as JsonValue;
    } catch {
      front[key] = raw;
    }
  }
  return { front, body: m[2]!.trim() };
}

/** The levers that GUIDE (a preference, a body of knowledge); every other lever changes what runs (§4). */
const GUIDING_LEVERS: ReadonlySet<string> = new Set(["instructions", "skill"]);

/** Whether a lever changes what runs — a step, a check, a permission… — rather than what the agent is told. */
export function isStructuralLever(lever: string): boolean {
  return !GUIDING_LEVERS.has(lever);
}

/** One change a lesson made: the file, its content's hash, and when. */
export interface LessonChange {
  file: string;
  hash: string;
  date: string;
  /** When, to the millisecond — what "in effect" is measured against. Older records have only `date`. */
  at?: number;
}

/** One time a lesson turned up. */
export interface LessonOccurrence {
  date: string;
  at?: number;
  /** Where: the conversation's task and position, and the project, by name. */
  task?: string;
  session?: string;
  project?: string;
  quote?: string;
  lever?: string;
  /** What the person did with the change proposed for it. Older records, written only on apply, have none. */
  outcome?: "applied" | "declined";
  /** For a lesson that had a change applied before: whether a change of it was in effect where it turned up again. */
  inEffect?: boolean;
  /** What the person said when they turned it down. */
  comment?: string;
}

/** What a lesson records about itself — see `LessonRecord` in `@jaira/runtime`, which this mirrors. */
export interface LessonFields {
  rule: string;
  lever: string;
  target: string;
  why?: string;
  quote?: string;
  task?: string;
  session?: string;
}

/** A lesson's changes, from the file's frontmatter. */
export function changesOf(front: Record<string, JsonValue>): LessonChange[] {
  return Array.isArray(front.changes) ? (front.changes as unknown as LessonChange[]) : [];
}

/** A lesson's occurrences, from the file's frontmatter. */
export function occurrencesOf(front: Record<string, JsonValue>): LessonOccurrence[] {
  return Array.isArray(front.occurrences) ? (front.occurrences as unknown as LessonOccurrence[]) : [];
}

/** When a change was made: its `at`, else the start of its day. */
export function changedAt(change: LessonChange): number {
  return typeof change.at === "number" ? change.at : Date.parse(`${change.date}T00:00:00Z`);
}

/** The lesson file a rule is recorded in, under a layer root, and what it holds — `undefined` when none. */
export function readLessonAt(root: string, rule: string): { rel: string; front: Record<string, JsonValue>; body: string } | undefined {
  const rel = `lessons/${lessonSlug(rule)}.md`;
  const abs = join(root, rel);
  if (!existsSync(abs)) return undefined;
  return { rel, ...parseLesson(readFileSync(abs, "utf8")) };
}

/**
 * Write or extend `lessons/<slug>.md` under `root`: one more occurrence — applied, with the files the
 * change wrote, or declined, with none — and the lesson's status: `applied` once any change of it was,
 * `declined` while every proposal for it was turned down.
 */
export function recordLessonOccurrence(
  root: string,
  lesson: LessonFields,
  scope: string,
  files: ReadonlyArray<{ path: string; content: string }>,
  occurrence: { at: number; date: string; outcome: "applied" | "declined"; project?: string; inEffect?: boolean; comment?: string },
): string {
  const prior = readLessonAt(root, lesson.rule);
  const rel = prior?.rel ?? `lessons/${lessonSlug(lesson.rule)}.md`;
  const changes: LessonChange[] = [
    ...(prior !== undefined ? changesOf(prior.front) : []),
    ...files.map((f) => ({ file: f.path, hash: createHash("sha256").update(f.content).digest("hex").slice(0, 16), date: occurrence.date, at: occurrence.at })),
  ];
  const occurrences: LessonOccurrence[] = [
    ...(prior !== undefined ? occurrencesOf(prior.front) : []),
    {
      date: occurrence.date,
      at: occurrence.at,
      ...(lesson.task !== undefined ? { task: lesson.task } : {}),
      ...(lesson.session !== undefined ? { session: lesson.session } : {}),
      ...(occurrence.project !== undefined ? { project: occurrence.project } : {}),
      ...(lesson.quote !== undefined ? { quote: lesson.quote } : {}),
      lever: lesson.lever,
      outcome: occurrence.outcome,
      ...(occurrence.inEffect !== undefined ? { inEffect: occurrence.inEffect } : {}),
      ...(occurrence.comment !== undefined && occurrence.comment.length > 0 ? { comment: occurrence.comment } : {}),
    },
  ];
  const applied = changes.length > 0 || prior?.front.status === "applied";
  const front: Record<string, JsonValue> = {
    rule: lesson.rule,
    lever: lesson.lever,
    target: lesson.target,
    scope,
    status: applied ? "applied" : "declined",
    changes: changes as unknown as JsonValue,
    occurrences: occurrences as unknown as JsonValue,
  };
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, formatLesson(front, lesson.why ?? prior?.body ?? ""), "utf8");
  return rel;
}

// --- measures ----------------------------------------------------------------------------------------

/** A compiled program's `input()` children (`scriptCompile.ts`): an answer to one ends a pass. */
const INPUT_CHILD = /^input(_\d+)?$/;

function lessonsIn(dir: string, layer: "project" | "shared"): Array<{ file: string; layer: "project" | "shared"; front: Record<string, JsonValue> }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((name) => ({ file: `lessons/${name}`, layer, front: parseLesson(readFileSync(join(dir, name), "utf8")).front }));
}

/**
 * What a project's learning measures — its lessons and the Shared layer's, and its runs' handoffs.
 * `projectName` is how occurrences name this project (its directory's name, by default).
 */
export function learningMeasures(project: Project, options: { projectName?: string } = {}): LearningMeasures {
  const name = options.projectName ?? basename(project.paths.projectDir);
  const files = [...lessonsIn(join(project.paths.jairaDir, "lessons"), "project"), ...lessonsIn(join(project.paths.base.baseDir, "lessons"), "shared")];
  const lessons: MeasuredLesson[] = [];
  let applied = 0;
  let declined = 0;
  const byTask = new Map<string, number>();
  for (const { file, layer, front } of files) {
    const occurrences = occurrencesOf(front);
    const changes = changesOf(front);
    // Older records were written only on apply: each occurrence there is an applied one.
    const outcomeOf = (o: LessonOccurrence): "applied" | "declined" => o.outcome ?? "applied";
    const firstApplied = occurrences.findIndex((o) => outcomeOf(o) === "applied");
    const after = firstApplied >= 0 ? occurrences.slice(firstApplied + 1) : [];
    const lesson: MeasuredLesson = {
      file,
      layer,
      rule: String(front.rule ?? ""),
      lever: String(front.lever ?? ""),
      target: String(front.target ?? ""),
      status: String(front.status ?? (changes.length > 0 ? "applied" : "")),
      occurrences: occurrences.length,
      applied: occurrences.filter((o) => outcomeOf(o) === "applied").length,
      declined: occurrences.filter((o) => outcomeOf(o) === "declined").length,
      recurred: after.length,
      recurredInEffect: after.filter((o) => o.inEffect === true).length,
      structural: isStructuralLever(String(front.lever ?? "")),
      projects: [...new Set(occurrences.map((o) => o.project).filter((p): p is string => typeof p === "string"))].sort(),
    };
    lessons.push(lesson);
    // This project's own: its lessons, and the Shared layer's occurrences that name it.
    const own = layer === "project" ? occurrences : occurrences.filter((o) => o.project === name);
    for (const o of own) {
      if (outcomeOf(o) === "applied") applied += 1;
      else declined += 1;
      if (typeof o.task === "string" && project.tasks.tryRead(o.task) !== undefined) byTask.set(o.task, (byTask.get(o.task) ?? 0) + 1);
    }
  }
  const conversations = project.tasks.list().filter((meta) => isConversation(meta)).length;
  const corrections = [...byTask.values()].reduce((a, b) => a + b, 0);
  const promoted = lessons.filter((l) => l.layer === "shared" && l.projects.length > 1).map((l) => ({ rule: l.rule, projects: l.projects }));
  const handoffs = handoffsOf(project);
  const revisit: string[] = [];
  for (const l of lessons) {
    if (l.structural && l.recurredInEffect >= 2) revisit.push(`"${l.rule}" came back ${l.recurredInEffect} times after its fix (${l.lever}) was in effect.`);
  }
  if (applied + declined >= 5 && declined > applied) revisit.push(`Most of the improver's proposals were turned down at the review: ${declined} of ${applied + declined}.`);
  if (handoffs.offered >= 5 && handoffs.withinPass * 2 < handoffs.offered) revisit.push(`Running work often found no place to take a newer version within a pass: ${handoffs.offered - handoffs.withinPass} of ${handoffs.offered}.`);
  return {
    lessons,
    proposals: { applied, declined },
    conversations: {
      count: conversations,
      corrections,
      perConversation: conversations > 0 ? corrections / conversations : 0,
      byConversation: [...byTask.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([task, n]) => {
          const title = project.tasks.tryRead(task)?.title;
          return { task, ...(title !== undefined ? { title } : {}), corrections: n };
        }),
    },
    promoted,
    handoffs,
    revisit,
  };
}

/** The newer versions this project's runs were offered, and what became of each (decision 0029 §3). */
function handoffsOf(project: Project): LearningMeasures["handoffs"] {
  const rows = project.db
    .prepare(
      `SELECT task_id, seq, type, payload_json FROM state_machine_events
        WHERE type IN ('version.adopted', 'version.declined', 'instance.entered', 'operation.completed')
        ORDER BY task_id, seq`,
    )
    .all() as Array<{ task_id: string; seq: number; type: string; payload_json: string }>;
  let offered = 0;
  let adopted = 0;
  let withinPass = 0;
  let declines = 0;
  let task: string | undefined;
  let pass = 0;
  let inputs = new Set<string>();
  let firstOffered = new Map<string, number>();
  let taken = new Map<string, number>();
  const close = (): void => {
    offered += firstOffered.size;
    adopted += taken.size;
    for (const [version, at] of taken) if (firstOffered.get(version) === at) withinPass += 1;
  };
  for (const row of rows) {
    if (row.task_id !== task) {
      if (task !== undefined) close();
      task = row.task_id;
      pass = 0;
      inputs = new Set();
      firstOffered = new Map();
      taken = new Map();
    }
    const event = JSON.parse(row.payload_json) as { instanceId?: string; childKey?: string; version?: string };
    if (row.type === "instance.entered") {
      if (event.childKey !== undefined && INPUT_CHILD.test(event.childKey) && event.instanceId !== undefined) inputs.add(event.instanceId);
      continue;
    }
    // A message answered: the next pass begins.
    if (row.type === "operation.completed") {
      if (event.instanceId !== undefined && inputs.delete(event.instanceId)) pass += 1;
      continue;
    }
    if (event.version === undefined) continue;
    if (!firstOffered.has(event.version)) firstOffered.set(event.version, pass);
    if (row.type === "version.declined") declines += 1;
    else if (!taken.has(event.version)) taken.set(event.version, pass);
  }
  if (task !== undefined) close();
  return { offered, adopted, withinPass, neverAdopted: offered - adopted, declines };
}
