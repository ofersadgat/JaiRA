/**
 * The improver's host (decision 0029 §3–§5): what `conversation_digest`, `workflow_source`,
 * `lessons_list` and `apply_change` answer, over one open project.
 *
 * `apply_change` is the one write, and it is JaiRA's code doing it, never a model's tool call: the
 * shipped permission sets refuse an agent every write under `.jaira/`, and they still do. A change is
 * PROPOSED as whole files; this decides whether each path is one a lesson may change, writes them,
 * loads what changed, and puts every file back if the result does not load — so a lesson can make a
 * workflow different, but never leave it broken.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import type { JsonValue } from "@declarative-ai/json";
import { validateBundle } from "@declarative-ai/hw";
import {
  currentPin,
  loadWorkflowBundle,
  messagesOfRecord,
  readWorkflowFiles,
  sessionStoreFor,
  stateSessions,
  workflowLoadOptions,
  type Project,
} from "@jaira/persistence";
import type { ChangeFile, ImproveHost, LessonRecord, LessonScope } from "@jaira/runtime";

/** Where under a layer root a lesson may write (decision 0029 §5). Anything else is refused. */
const WRITABLE = ["workflows/", "prompts/", "skills/", "functions/", "permission-sets/", "lessons/"] as const;
const INSTRUCTIONS = "instructions.md";
const STATE_SUFFIXES = [".ts", ".js", ".json", ".yaml", ".yml"] as const;

/** A message's plain text — a string, or the text parts of a content array. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .filter((t) => t.length > 0)
      .join("\n");
  }
  return "";
}

/** `<id>@<seq>` → the id. */
function streamOf(ref: string): string {
  const at = ref.lastIndexOf("@");
  return at > 0 ? ref.slice(0, at) : ref;
}

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

/** Whether `path` (relative, forward-slashed) is one a lesson may write, and its normal form. */
export function writablePath(path: string): string | undefined {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path) || /^[A-Za-z]:/.test(path)) return undefined;
  const norm = normalize(path).split(sep).join("/");
  if (norm.startsWith("../") || norm === ".." || norm.includes("/../")) return undefined;
  if (norm === INSTRUCTIONS) return norm;
  return WRITABLE.some((prefix) => norm.startsWith(prefix) && norm.length > prefix.length) ? norm : undefined;
}

export interface ImproveHostOptions {
  /** Today, as the lesson files date an occurrence. */
  today?: () => string;
}

export function createImproveHost(project: Project, options: ImproveHostOptions = {}): ImproveHost {
  const today = options.today ?? (() => new Date().toISOString().slice(0, 10));
  const roots = project.paths.roots;
  const builtIn = project.paths.builtIn.dir;
  const layerOf = (root: string): "project" | "shared" | "system" => (root === project.paths.jairaDir ? "project" : root === builtIn ? "system" : "shared");
  const rootOf = (scope: LessonScope | undefined): string => (scope === "shared" ? project.paths.base.baseDir : project.paths.jairaDir);

  const workflowOfTask = (taskId: string | undefined): string | undefined => (taskId !== undefined ? project.tasks.tryRead(taskId)?.workflow : undefined);

  /** A conversation's latest position in a task: where its last call ended. */
  const latestPosition = (taskId: string): string | undefined => {
    const rows = stateSessions(project, taskId);
    const last = rows.at(-1);
    return last !== undefined ? `${last.sessionId}@${last.seq + 1}` : undefined;
  };

  /** Which task holds a conversation, when only its position is known. */
  const taskOfSession = (ref: string): string | undefined => {
    const stream = streamOf(ref);
    for (const meta of project.tasks.list()) {
      if (stateSessions(project, meta.id).some((row) => row.sessionId === stream)) return meta.id;
    }
    return undefined;
  };

  const findState = (id: string): { root: string; file: string; rel: string } | undefined => {
    for (const root of roots) {
      for (const suffix of STATE_SUFFIXES) {
        const rel = `workflows/${id}${suffix}`;
        const file = join(root, rel);
        if (existsSync(file)) return { root, file, rel };
      }
    }
    return undefined;
  };

  const skillsIn = (root: string): Array<{ name: string; description: string; path: string }> => {
    const dir = join(root, "skills");
    if (!existsSync(dir)) return [];
    const out: Array<{ name: string; description: string; path: string }> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(dir, entry.name, "SKILL.md");
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
      out.push({ name: entry.name, description, path: `skills/${entry.name}/SKILL.md` });
    }
    return out;
  };

  return {
    async digest(request, callerTask) {
      const sessionRef = request.session?.id;
      const taskId = request.task ?? (sessionRef !== undefined ? (taskOfSession(sessionRef) ?? callerTask) : callerTask);
      if (taskId === undefined) throw new Error("conversation_digest needs a task or a session it can find");
      const position = sessionRef ?? latestPosition(taskId);
      const meta = project.tasks.tryRead(taskId);
      const task = project.runtime.get(taskId);
      const pin = task !== undefined ? currentPin(project, task)?.snapshotHash : undefined;
      const messages: JsonValue[] = [];
      if (position !== undefined) {
        const rows = sessionStoreFor(project, { taskId }).transcript(position);
        for (const row of rows) {
          const said = messagesOfRecord(row.value as JsonValue);
          const signals: string[] = [];
          if (row.status === "interrupted") signals.push("stopped: the person stopped this turn");
          if (row.status === "failed") signals.push("failed: this turn ended in an error");
          said.forEach((m, i) => {
            const message = m as { role?: unknown; content?: unknown };
            const text = textOf(message.content);
            if (text.length === 0) return;
            const isLast = i === said.length - 1;
            messages.push({ role: String(message.role ?? ""), text, ...(isLast && signals.length > 0 ? { signals } : {}) });
          });
        }
      }
      const last = request.last;
      return {
        task: taskId,
        workflow: meta?.workflow ?? null,
        ...(pin !== undefined ? { snapshot: pin } : {}),
        ...(position !== undefined ? { position } : {}),
        messages: last !== undefined && last > 0 ? messages.slice(-last) : messages,
      } as JsonValue;
    },

    async source(request, callerTask) {
      const id = request.workflow ?? workflowOfTask(request.task ?? callerTask);
      if (id === undefined) throw new Error("workflow_source needs a workflow id, or a task whose workflow it reads");
      const found = findState(id);
      const instructions = roots
        .filter((root) => existsSync(join(root, INSTRUCTIONS)))
        .map((root) => ({ layer: layerOf(root), path: INSTRUCTIONS, text: readFileSync(join(root, INSTRUCTIONS), "utf8") }));
      const skills = roots.flatMap((root) => skillsIn(root).map((s) => ({ ...s, layer: layerOf(root) })));
      const description = roots.map((root) => join(root, "workflows", `${id}.md`)).find((f) => existsSync(f));
      const base = {
        workflow: id,
        instructions,
        skills,
        ...(description !== undefined ? { description: readFileSync(description, "utf8") } : {}),
      };
      if (found === undefined) return { ...base, found: false } as JsonValue;
      const layer = layerOf(found.root);
      return {
        ...base,
        found: true,
        layer,
        path: found.rel,
        text: readFileSync(found.file, "utf8"),
        writable: layer !== "system",
        // A built-in one is read-only: a change is the same path in the project's layer, which wins.
        ...(layer === "system" ? { override: found.rel } : {}),
      } as JsonValue;
    },

    async lessons(request) {
      const dir = join(rootOf(request.scope), "lessons");
      if (!existsSync(dir)) return [];
      const out: JsonValue[] = [];
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
        const { front, body } = parseLesson(readFileSync(join(dir, name), "utf8"));
        const occurrences = Array.isArray(front.occurrences) ? front.occurrences.length : 0;
        out.push({ file: `lessons/${name}`, ...front, occurrences, why: body });
      }
      return out;
    },

    async apply(request) {
      const scope: LessonScope = request.scope ?? "project";
      const root = rootOf(scope);
      const refused: string[] = [];
      const files: ChangeFile[] = [];
      for (const file of request.files) {
        const path = writablePath(file.path);
        if (path === undefined || typeof file.content !== "string") refused.push(String(file.path));
        else files.push({ path, content: file.content });
      }
      if (refused.length > 0) {
        return { ok: false, refused, problems: [`a lesson may change only ${WRITABLE.join(", ")} and ${INSTRUCTIONS}: refused ${refused.join(", ")}`] } as JsonValue;
      }
      // Kept so a change that does not load is put back exactly as it was.
      const before = new Map<string, string | undefined>();
      for (const file of files) {
        const abs = join(root, file.path);
        before.set(abs, existsSync(abs) ? readFileSync(abs, "utf8") : undefined);
      }
      const restore = (): void => {
        for (const [abs, text] of before) {
          if (text === undefined) rmSync(abs, { force: true });
          else writeFileSync(abs, text, "utf8");
        }
      };
      for (const file of files) {
        const abs = join(root, file.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, file.content, "utf8");
      }
      // Load every state a change wrote — a script compiles, a state file parses and validates — and
      // a permission set or a skill at least reads.
      const problems: string[] = [];
      for (const file of files) {
        if (file.path.startsWith("workflows/") && STATE_SUFFIXES.some((s) => file.path.endsWith(s))) {
          const id = file.path.slice("workflows/".length).replace(/\.[^./]+$/, "");
          try {
            const bundle = loadWorkflowBundle(readWorkflowFiles(project.paths.workflowsDir), id, workflowLoadOptions(project.paths));
            const report = validateBundle(bundle);
            for (const e of report.errors) problems.push(`${e.stateId} ${e.path}: ${e.message}`);
          } catch (e) {
            problems.push(`${file.path}: ${(e as Error).message}`);
          }
        } else if (file.path.endsWith(".json")) {
          try {
            JSON.parse(file.content);
          } catch (e) {
            problems.push(`${file.path}: ${(e as Error).message}`);
          }
        } else if (file.path.endsWith("SKILL.md")) {
          if (!/^---\n[\s\S]*?\bname:\s*\S[\s\S]*?\bdescription:\s*\S[\s\S]*?\n---/.test(file.content)) problems.push(`${file.path}: a skill opens with frontmatter naming its name and description`);
        }
      }
      if (problems.length > 0) {
        restore();
        return { ok: false, problems } as JsonValue;
      }
      const lessonFile = recordLesson(root, request.lesson, scope, files, today());
      return { ok: true, scope, written: files.map((f) => f.path), lesson: lessonFile } as JsonValue;
    },
  };
}

/** Write or extend `lessons/<slug>.md`: one more occurrence, and the change this time made. */
function recordLesson(root: string, lesson: LessonRecord, scope: LessonScope, files: readonly ChangeFile[], date: string): string {
  const rel = `lessons/${lessonSlug(lesson.rule)}.md`;
  const abs = join(root, rel);
  const prior = existsSync(abs) ? parseLesson(readFileSync(abs, "utf8")) : undefined;
  const changes = [
    ...(Array.isArray(prior?.front.changes) ? prior.front.changes : []),
    ...files.map((f) => ({ file: f.path, hash: createHash("sha256").update(f.content).digest("hex").slice(0, 16), date })),
  ];
  const occurrences = [
    ...(Array.isArray(prior?.front.occurrences) ? prior.front.occurrences : []),
    {
      date,
      ...(lesson.task !== undefined ? { task: lesson.task } : {}),
      ...(lesson.session !== undefined ? { session: lesson.session } : {}),
      ...(lesson.quote !== undefined ? { quote: lesson.quote } : {}),
      lever: lesson.lever,
    },
  ];
  const front: Record<string, JsonValue> = {
    rule: lesson.rule,
    lever: lesson.lever,
    target: lesson.target,
    scope,
    status: "applied",
    changes: changes as JsonValue,
    occurrences: occurrences as JsonValue,
  };
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, formatLesson(front, lesson.why ?? prior?.body ?? ""), "utf8");
  return rel;
}


