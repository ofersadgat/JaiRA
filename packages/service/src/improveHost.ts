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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, normalize, sep, dirname } from "node:path";
import type { JsonValue } from "@declarative-ai/json";
import { baseStateIdOf, validateBundle } from "@declarative-ai/hw";
import {
  changedAt,
  changesOf,
  currentPin,
  formatLesson,
  lessonSlug,
  loadWorkflowBundle,
  messagesOfRecord,
  parseLesson,
  readLessonAt,
  readWorkflowFiles,
  recordLessonOccurrence,
  sessionStoreFor,
  stateSessions,
  workflowLoadOptions,
  type Project,
} from "@jaira/persistence";
import { REWOUND_EVENT, STEERED_EVENT } from "@jaira/shared";
import type { ChangeFile, ImproveHost, LessonRecord, LessonScope } from "@jaira/runtime";

/** The gates a person answers in a run — what a refusal or a comment on one is a correction made through. */
const GATE_COMPONENTS: ReadonlySet<string> = new Set(["choose_option", "fill_form", "review_artifact", "review_artifacts", "edit_artifact", "confirm_action"]);

/** The skills a message's content asked for: `load_skill` calls, and the agent's own Skill tool. */
function skillsCalledIn(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    const p = part as { type?: unknown; name?: unknown; toolName?: unknown; input?: unknown; args?: unknown };
    if (p.type !== "tool_use" && p.type !== "tool-call") continue;
    const name = typeof p.name === "string" ? p.name : typeof p.toolName === "string" ? p.toolName : "";
    const input = (p.input ?? p.args) as { name?: unknown; skill?: unknown } | undefined;
    if (/(^|__)load_skill$/.test(name) && typeof input?.name === "string") out.push(input.name);
    else if (name === "Skill" && typeof input?.skill === "string") out.push(input.skill.replace(/^jaira-skills:/, ""));
  }
  return out;
}

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

// The lesson file's format lives with what measures it (`@jaira/persistence`'s `lessons.ts`).
export { formatLesson, lessonSlug, parseLesson };

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
  /** Now, in milliseconds — what an occurrence and a change are stamped with. */
  now?: () => number;
  /** This machine's OTHER projects, by name and `.jaira` directory — where `lessons_list({ elsewhere })` reads. */
  otherProjects?: () => ReadonlyArray<{ name: string; jairaDir: string }>;
  /**
   * Run a simulation's pass (decision 0029 §5 step 5) — the service's: a fork of `task` under `files`,
   * read as if written under `root`. Absent, `simulate_change` answers that this host cannot try one.
   */
  simulate?: (request: SimulationRequest) => Promise<JsonValue>;
}

/** What `simulate_change` hands the service, its paths checked and its conversation found. */
export interface SimulationRequest {
  /** The conversation to fork. */
  task: string;
  /** Where in it the correction was made: its conversation's position then. */
  position: string | undefined;
  /** The layer root the files belong under. */
  root: string;
  files: ChangeFile[];
  lesson: string;
  /** The person's words in the correcting message, when no position names it. */
  quote?: string;
}

export function createImproveHost(project: Project, options: ImproveHostOptions = {}): ImproveHost {
  const today = options.today ?? (() => new Date().toISOString().slice(0, 10));
  const now = options.now ?? (() => Date.now());
  /** How an occurrence names this project, in a lesson every project shares (§7). */
  const projectName = basename(project.paths.projectDir);
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

  /**
   * A task's gates the person turned down or commented on (decision 0029 §8): each gate a state of its
   * run called — told by the component its call's record names — whose answer refused (a `confirmed:
   * false`, a decision to reject) or said something (a comment). A changeset review (`review_artifacts`)
   * says so in its kind.
   */
  const gateSignalsOf = (task: string): JsonValue[] => {
    const store = sessionStoreFor(project, { taskId: task });
    const out: JsonValue[] = [];
    for (const { event } of project.events.list(task)) {
      const done = event as unknown as { type: string; stateId?: string; operationId?: string };
      if (done.type !== "operation.completed" || done.stateId === undefined || done.operationId === undefined) continue;
      // The call's own record says what it called and what it was answered.
      const record = store.record(done.operationId);
      const request = record?.request as { kind?: unknown; functionRef?: unknown } | undefined;
      const component = request?.kind === "function" && typeof request.functionRef === "string" ? request.functionRef : undefined;
      if (component === undefined || !GATE_COMPONENTS.has(component)) continue;
      const result = record?.result as { value?: JsonValue } | JsonValue | undefined;
      const answer = result !== null && typeof result === "object" && !Array.isArray(result) && "value" in result ? result.value : result;
      if (answer === null || answer === undefined || typeof answer !== "object" || Array.isArray(answer)) continue;
      const given = answer as Record<string, JsonValue>;
      const decision = typeof given["decision"] === "string" ? given["decision"] : typeof given["choice"] === "string" ? given["choice"] : "";
      const rejected = given["confirmed"] === false || /^(reject|rejected|deny|denied|no|discard|cancel|canceled|cancelled)$/i.test(decision);
      const said = [given["comment"], given["feedback"], ...(Array.isArray(given["comments"]) ? given["comments"].map((c) => (typeof c === "string" ? c : c !== null && typeof c === "object" && !Array.isArray(c) ? (c["text"] ?? c["body"]) : undefined)) : [])]
        .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
        .join("\n");
      if (!rejected && said.length === 0) continue;
      out.push({
        kind: `${component === "review_artifacts" ? "changeset" : "gate"} ${rejected ? "rejected" : "commented"}`,
        state: baseStateIdOf(done.stateId),
        component,
        ...(decision.length > 0 ? { decision } : {}),
        ...(said.length > 0 ? { comment: said } : {}),
      });
    }
    return out;
  };

  /** The skills a task's conversation loaded — `load_skill`, or a native Skill call (§10). */
  const skillsLoadedIn = (taskId: string): Set<string> => {
    const loaded = new Set<string>();
    const position = latestPosition(taskId);
    if (position === undefined) return loaded;
    try {
      for (const row of sessionStoreFor(project, { taskId }).transcript(position)) {
        for (const m of messagesOfRecord(row.value as JsonValue)) for (const name of skillsCalledIn((m as { content?: unknown }).content)) loaded.add(name);
      }
    } catch {
      // No conversation to read: nothing was loaded.
    }
    return loaded;
  };

  /**
   * Whether a fix of a lesson was in effect in the conversation where it turned up again (decision 0029
   * §4) — what tells a lesson that needs a more certain lever from one whose fix never reached the run.
   * A change was in effect when that run, or a version it switched to, began after the change was
   * applied (a workflow, its instructions and its permissions are pinned when a run or a version
   * begins), and every skill the change wrote was loaded. Any of the lesson's changes will do: an
   * earlier fix in effect is a fix that did not hold. `undefined` when the lesson has no change yet, or
   * names no conversation.
   */
  const inEffectFor = (root: string, lesson: LessonRecord): boolean | undefined => {
    const prior = readLessonAt(root, lesson.rule);
    const changes = prior !== undefined ? changesOf(prior.front) : [];
    if (changes.length === 0 || lesson.task === undefined) return undefined;
    const events = project.events.list(lesson.task);
    const began = [events[0]?.createdAt, ...events.filter((row) => row.type === "version.adopted").map((row) => row.createdAt)].filter((at): at is number => at !== undefined);
    let loaded: Set<string> | undefined;
    // One change is the files one apply wrote: they share its time.
    for (const at of new Set(changes.map(changedAt))) {
      if (!began.some((start) => start > at)) continue;
      const skills = changes.filter((c) => changedAt(c) === at).flatMap((c) => /^skills\/([^/]+)\//.exec(c.file)?.slice(1, 2) ?? []);
      loaded ??= skills.length > 0 ? skillsLoadedIn(lesson.task) : new Set();
      if (skills.every((name) => loaded!.has(name))) return true;
    }
    return false;
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
      /** What the record says the person DID, beyond what they typed (decision 0029 §8). */
      const signals: JsonValue[] = [];
      // A tool call the person was asked about and refused — the plainest correction there is.
      for (const entry of project.commands.list(taskId)) {
        if (entry.decision !== "denied" || entry.decidedBy !== "user") continue;
        signals.push({
          kind: "denied",
          tool: entry.tool,
          ...(entry.command !== undefined ? { command: entry.command } : {}),
          ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        });
      }
      // What the person took back with a rewind, and what they said INTO a reply being made — rows the
      // service keeps for exactly this, since a rewind's cut leaves nothing else behind.
      for (const { event } of project.events.list(taskId)) {
        const row = event as unknown as { type: string; taken?: string[]; message?: string };
        if (row.type === REWOUND_EVENT && Array.isArray(row.taken)) signals.push({ kind: "rewound", taken: row.taken.slice(0, 4) });
        if (row.type === STEERED_EVENT && typeof row.message === "string") signals.push({ kind: "steered", message: row.message });
      }
      // A gate the person turned down or commented on — this conversation's, and those of the tasks it
      // started — and a changeset review they commented on.
      for (const id of [taskId, ...project.tasks.list().filter((t) => t.origin?.kind === "started" && t.origin.taskId === taskId).map((t) => t.id)]) {
        for (const signal of gateSignalsOf(id)) signals.push(id === taskId ? signal : { ...(signal as Record<string, JsonValue>), task: id });
      }
      /** The skills the conversation's agent loaded — `load_skill`, or a native Skill call (§10). */
      const skillsLoaded = new Set<string>();
      if (position !== undefined) {
        // A place the conversation BRANCHED: a message the person edited and sent again, the reply it
        // replaced kept beside it — they did not like what came after.
        try {
          for (const fork of sessionStoreFor(project, { taskId }).forks(position)) {
            const replaced = fork.left
              .flatMap((branch) => branch.rows)
              .flatMap((row) => messagesOfRecord(row.value as JsonValue))
              .map((m) => textOf((m as { content?: unknown }).content))
              .filter((t) => t.length > 0);
            signals.push({ kind: "edited", at: fork.at.seq, replaced: replaced.slice(0, 4) });
          }
        } catch {
          // No branches to read: nothing was edited.
        }
        const rows = sessionStoreFor(project, { taskId }).transcript(position);
        for (const row of rows) {
          const said = messagesOfRecord(row.value as JsonValue);
          for (const m of said) for (const name of skillsCalledIn((m as { content?: unknown }).content)) skillsLoaded.add(name);
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
      // What was in effect (§8): the version running — the newest one the run switched to, else the one
      // it started on — the skills loaded, and the permission set its messages ran under.
      const switched = project.events.list(taskId).flatMap(({ event }) => ((event as { type: string }).type === "version.adopted" ? [(event as unknown as { version: string }).version] : []));
      const permissionSet = meta?.chatSettings?.permissionSet;
      return {
        task: taskId,
        workflow: meta?.workflow ?? null,
        ...(pin !== undefined ? { snapshot: pin } : {}),
        ...(position !== undefined ? { position } : {}),
        messages: last !== undefined && last > 0 ? messages.slice(-last) : messages,
        signals,
        inEffect: {
          version: switched.at(-1) ?? meta?.workflow ?? null,
          skills: [...skillsLoaded].sort(),
          ...(permissionSet !== undefined ? { permissionSet: permissionSet as unknown as JsonValue } : {}),
        },
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
      const listed = (dir: string, extra: Record<string, JsonValue> = {}): JsonValue[] => {
        if (!existsSync(dir)) return [];
        const out: JsonValue[] = [];
        for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
          const { front, body } = parseLesson(readFileSync(join(dir, name), "utf8"));
          const occurrences = Array.isArray(front.occurrences) ? front.occurrences.length : 0;
          out.push({ file: `lessons/${name}`, ...front, occurrences, why: body, ...extra });
        }
        return out;
      };
      if (request.elsewhere === true) {
        return (options.otherProjects?.() ?? []).filter((other) => other.jairaDir !== project.paths.jairaDir).flatMap((other) => listed(join(other.jairaDir, "lessons"), { project: other.name }));
      }
      return listed(join(rootOf(request.scope), "lessons"));
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
      // Read before this change is recorded beside it: whether an earlier one was in effect.
      const inEffect = inEffectFor(root, request.lesson);
      const lessonFile = recordLessonOccurrence(root, request.lesson, scope, files, { at: now(), date: today(), outcome: "applied", project: projectName, ...(inEffect !== undefined ? { inEffect } : {}) });
      return { ok: true, scope, written: files.map((f) => f.path), lesson: lessonFile } as JsonValue;
    },

    async simulate(request, callerTask) {
      const refused = request.files.filter((file) => writablePath(file.path) === undefined || typeof file.content !== "string").map((file) => String(file.path));
      if (refused.length > 0) return { simulated: false, reason: `a lesson may change only ${WRITABLE.join(", ")} and ${INSTRUCTIONS}: refused ${refused.join(", ")}` } as JsonValue;
      if (request.files.length === 0) return { simulated: false, reason: "the change has no files" } as JsonValue;
      const sessionRef = request.context.session?.id;
      const task = request.context.task ?? (sessionRef !== undefined ? taskOfSession(sessionRef) : undefined) ?? (request.context.session === undefined ? callerTask : undefined);
      if (task === undefined || project.tasks.tryRead(task) === undefined) return { simulated: false, reason: "the context names no conversation to try it on" } as JsonValue;
      if (options.simulate === undefined) return { simulated: false, reason: "this host cannot run a simulation" } as JsonValue;
      return options.simulate({
        task,
        position: sessionRef ?? latestPosition(task),
        root: rootOf(request.scope),
        files: request.files.map((file) => ({ path: writablePath(file.path)!, content: file.content })),
        lesson: request.lesson,
        ...(request.context.quote !== undefined && request.context.quote.length > 0 ? { quote: request.context.quote } : {}),
      });
    },

    async decline(request) {
      const scope: LessonScope = request.scope ?? "project";
      const root = rootOf(scope);
      const inEffect = inEffectFor(root, request.lesson);
      const lessonFile = recordLessonOccurrence(root, request.lesson, scope, [], {
        at: now(),
        date: today(),
        outcome: "declined",
        project: projectName,
        ...(inEffect !== undefined ? { inEffect } : {}),
        ...(request.comment !== undefined ? { comment: request.comment } : {}),
      });
      return { ok: true, scope, lesson: lessonFile } as JsonValue;
    },
  };
}
