/**
 * What a task CHANGED, read from its own record of calls — the side panel's Changes tab (the person's
 * rulings of 2026-09-26, over five rounds of mockups).
 *
 * A call is a change when the project's read-only permission set does not let it through — the same
 * judgment that names a phase of the work summary "Changed" — and the changes are grouped as the tool
 * menu groups tools, in its order: Files, Execution, Web, Git, Tasks & workflows, MCP, Other. A tool in
 * none of the first six is Other.
 *
 * Everything comes from the record, never from the disk. An agent's own record of an edit carries the
 * patch and the file as it was (Claude's `structuredPatch`, `originalFile`; codex's patch IS its
 * input), so a file's counts and hunks are read, not recomputed. Where a COMMAND changed a file the
 * record says which file and how (`rm` deleted it, `mv` moved it) but not by how much, and the change
 * says so — `by: "rm"`, no counts — rather than reading the disk to find out.
 *
 * Pure: judged calls in (`ChangeCall`, which main builds — it holds the permission set and the shell
 * classifier), a {@link TaskChangeLog} out. The panel draws it.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { ToolCategoryId } from "./toolVocabulary";

/** Who made a change, when it was not this conversation itself. */
export type ChangeAuthor =
  /** A subagent this conversation spawned: its conversation lives inside the spawning call. */
  | { kind: "subagent"; name: string; call: string }
  /** A task this one made (a fan-out's element), which files its work where this task does. */
  | { kind: "subtask"; name: string; taskId: string };

/** One part of a shell line, as the permission set sees it, judged on its own. */
export interface ChangeCallPart {
  /** The part as written. */
  text: string;
  program?: string;
  subcommand?: string;
  /** The standard tool the part is on its paths (`write_file` for `rm`, `mv`, `sed -i`, `> out`). */
  tool?: string;
  paths: string[];
  /** A redirect's direction, for a part that is one. */
  redirect?: "read" | "write";
  /** The read-only set does not let this part through on its own. */
  change: boolean;
}

/** One call, paired with its answer and judged — what main hands {@link changeLogOf}. */
export interface ChangeCall {
  id: string;
  /** As the agent called it (`Edit`, `mcp__dai__edit`, `mcp__linear__update_issue`). */
  name: string;
  /** The standard tool it stands for, where it stands for one (`edit`, `bash`, `start_task`). */
  standard?: string;
  /** The tool menu's group; `other` for a tool in none. */
  category: ToolCategoryId | "other";
  args: JsonValue;
  ok?: boolean;
  /** What the model saw. */
  text?: string;
  /** The provider's structured record of the execution (Claude's `toolUseResult`). */
  data?: JsonValue;
  at?: number;
  by?: ChangeAuthor;
  /** The read-only permission set does not let this call through. */
  change: boolean;
  /** A shell call's parts, each judged — `undefined` for every other call. */
  parts?: ChangeCallPart[];
}

/** A diff hunk as a patch prints it: its header, and each line with its `' '`, `'+'` or `'-'`. */
export interface ChangedLines {
  header: string;
  lines: string[];
}

export type FileChangeAction = "create" | "modify" | "delete" | "rename";

export interface FileChange {
  /** Relative to the workspace root when it is inside it, forward slashes. */
  path: string;
  action: FileChangeAction;
  /** A rename's old path. */
  from?: string;
  /** Lines added and removed, where the record says. Absent when a command made the change. */
  added?: number;
  removed?: number;
  /** The command that made the change, when one did (`rm`, `mv`, `git mv`, `>`), and no counts are known. */
  command?: string;
  hunks: ChangedLines[];
  /** The calls that changed it, oldest first. */
  calls: string[];
  /** When it was last changed. */
  at?: number;
  by?: ChangeAuthor;
}

/** A line of any group but Files and Git. */
export interface ChangeItem {
  call: string;
  /** The tool's display title (`Update issue`), or what the line says it did. */
  said: string;
  /** A code-set detail after the words: the state started, the issue moved. */
  subject?: string;
  /** A shell line, drawn in the colours of its parts. */
  command?: string;
  /** One quiet line under it. */
  detail?: string;
  /** Somewhere outside the app this change can be seen — an issue, a page. */
  url?: string;
  /** Somewhere inside it: a task, a state's definition. */
  open?: { taskId?: string; stateId?: string };
  at?: number;
  by?: ChangeAuthor;
}

export interface MergeRequestView {
  number: number;
  title?: string;
  url?: string;
  branch?: string;
  target?: string;
  state: "open" | "merged" | "closed";
  by?: ChangeAuthor;
}

export type GitStepKind = "commit" | "push" | "open" | "comment" | "merge" | "close" | "stage" | "other";

export interface GitStep {
  call: string;
  kind: GitStepKind;
  /** `3f2a1c9` for a commit, the branch for a push, `!482` for a request. */
  subject?: string;
  /** The commit's message, the request's title, the part as written for anything else. */
  detail?: string;
  /** The request a step is about. */
  request?: number;
  url?: string;
  command?: string;
  at?: number;
  by?: ChangeAuthor;
}

export interface GitChanges {
  requests: MergeRequestView[];
  steps: GitStep[];
  /** Files changed after the last commit, when there was one — the ladder's last rung. */
  uncommitted: string[];
}

export interface TaskChangeLog {
  files: FileChange[];
  execution: ChangeItem[];
  web: ChangeItem[];
  git: GitChanges;
  tasks: ChangeItem[];
  mcp: ChangeItem[];
  other: ChangeItem[];
}

export const EMPTY_CHANGE_LOG: TaskChangeLog = { files: [], execution: [], web: [], git: { requests: [], steps: [], uncommitted: [] }, tasks: [], mcp: [], other: [] };

// --- small readers --------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** The result as data: the structured record, else the text parsed as JSON when it is some. */
function resultOf(call: ChangeCall): Record<string, unknown> | undefined {
  if (isRecord(call.data)) return call.data;
  const text = call.text?.trim();
  if (text === undefined || !text.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A result whose text is a JSON list — `resultOf` reads only objects. */
function parsedList(text: string | undefined): unknown {
  const trimmed = text?.trim();
  if (trimmed === undefined || !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** The first web address a result names — a forge's or a tracker's own page for what changed. */
function urlOf(value: unknown, depth = 0): string | undefined {
  if (depth > 3 || !isRecord(value)) return undefined;
  for (const key of ["web_url", "html_url", "url", "href", "permalink"]) {
    const found = str(value[key]);
    if (found !== undefined && /^https?:\/\//.test(found)) return found;
  }
  for (const nested of Object.values(value)) {
    const found = urlOf(nested, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A path as the panel shows it: under the root when it is inside it, forward slashes. */
export function relativePath(path: string, root: string | undefined): string {
  const norm = path.replace(/\\/g, "/");
  if (root === undefined || root === "") return norm.replace(/^\.\//, "");
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const lower = norm.toLowerCase();
  if (lower === base.toLowerCase()) return ".";
  if (lower.startsWith(`${base.toLowerCase()}/`)) return norm.slice(base.length + 1);
  return norm.replace(/^\.\//, "");
}

/** Hunks from a `structuredPatch` — `{ oldStart, oldLines, newStart, newLines, lines }` each. */
function hunksOfStructured(patch: unknown): ChangedLines[] | undefined {
  if (!Array.isArray(patch)) return undefined;
  const out: ChangedLines[] = [];
  for (const hunk of patch) {
    if (!isRecord(hunk) || !Array.isArray(hunk["lines"])) continue;
    const n = (key: string): number => (typeof hunk[key] === "number" ? (hunk[key] as number) : 0);
    out.push({ header: `@@ -${n("oldStart")},${n("oldLines")} +${n("newStart")},${n("newLines")} @@`, lines: (hunk["lines"] as unknown[]).filter((line): line is string => typeof line === "string") });
  }
  return out;
}

/** What an edit replaced, as one hunk of `-` then `+` lines. */
function hunkOfReplace(before: string, after: string): ChangedLines {
  const minus = before.length === 0 ? [] : before.replace(/\n$/, "").split("\n").map((line) => `-${line}`);
  const plus = after.length === 0 ? [] : after.replace(/\n$/, "").split("\n").map((line) => `+${line}`);
  return { header: "", lines: [...minus, ...plus] };
}

const countsOf = (hunks: readonly ChangedLines[]): { added: number; removed: number } => ({
  added: hunks.reduce((n, hunk) => n + hunk.lines.filter((line) => line.startsWith("+")).length, 0),
  removed: hunks.reduce((n, hunk) => n + hunk.lines.filter((line) => line.startsWith("-")).length, 0),
});

/** The files one apply_patch input touches: `*** Add File:`, `*** Update File:` (and `*** Move to:`), `*** Delete File:`. */
function filesOfPatch(patch: string): Array<{ path: string; action: FileChangeAction; from?: string; hunks: ChangedLines[] }> {
  const out: Array<{ path: string; action: FileChangeAction; from?: string; hunks: ChangedLines[] }> = [];
  let current: (typeof out)[number] | undefined;
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header !== null) {
      current = { path: header[2]!.trim(), action: header[1] === "Add" ? "create" : header[1] === "Delete" ? "delete" : "modify", hunks: [{ header: "", lines: [] }] };
      out.push(current);
      continue;
    }
    const moved = /^\*\*\* Move to: (.+)$/.exec(line);
    if (moved !== null && current !== undefined) {
      current.from = current.path;
      current.path = moved[1]!.trim();
      current.action = "rename";
      continue;
    }
    if (current === undefined || line.startsWith("***")) continue;
    if (line.startsWith("@@")) current.hunks.push({ header: line, lines: [] });
    else if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) current.hunks[current.hunks.length - 1]!.lines.push(line);
  }
  for (const file of out) file.hunks = file.hunks.filter((hunk) => hunk.lines.length > 0 || hunk.header !== "");
  return out;
}

// --- files ------------------------------------------------------------------------------------------

interface FileTouch {
  path: string;
  action: FileChangeAction;
  from?: string;
  hunks: ChangedLines[];
  /** No counts: a command did it. */
  command?: string;
}

/** What one call did to files — the file tools by their own record, a shell line by its parts. */
function touchesOf(call: ChangeCall, root: string | undefined): FileTouch[] {
  const args = isRecord(call.args) ? call.args : {};
  const rel = (path: string): string => relativePath(path, root);
  const data = isRecord(call.data) ? call.data : undefined;
  if (call.standard === "edit" || call.standard === "write_file") {
    // codex: the patch is the input.
    const patch = str(args["input"]) ?? str(args["patch"]) ?? (typeof call.args === "string" ? call.args : undefined);
    if (patch !== undefined && patch.includes("*** ")) return filesOfPatch(patch).map((file) => ({ ...file, path: rel(file.path), ...(file.from !== undefined ? { from: rel(file.from) } : {}) }));
    const path = str(args["file_path"]) ?? str(args["path"]) ?? str(args["notebook_path"]);
    if (path === undefined) return [];
    const structured = hunksOfStructured(data?.["structuredPatch"]);
    const content = str(args["content"]);
    if (data?.["type"] === "create") {
      return [{ path: rel(path), action: "create", hunks: content !== undefined ? [hunkOfReplace("", content)] : structured ?? [] }];
    }
    if (structured !== undefined && structured.length > 0) return [{ path: rel(path), action: "modify", hunks: structured }];
    if (Array.isArray(args["edits"])) {
      return [{ path: rel(path), action: "modify", hunks: (args["edits"] as unknown[]).filter(isRecord).map((edit) => hunkOfReplace(str(edit["old_string"]) ?? "", str(edit["new_string"]) ?? "")) }];
    }
    const before = str(args["old_string"]) ?? str(args["old"]);
    const after = typeof args["new_string"] === "string" ? args["new_string"] : typeof args["new"] === "string" ? args["new"] : undefined;
    if (before !== undefined && after !== undefined) return [{ path: rel(path), action: "modify", hunks: [hunkOfReplace(before, after)] }];
    // JaiRA's `write_file` replaces a file whole: what was there before is not in its record.
    return [{ path: rel(path), action: "modify", hunks: content !== undefined ? [hunkOfReplace("", content)] : [] }];
  }
  if (call.parts === undefined) return [];
  const out: FileTouch[] = [];
  for (const part of call.parts) {
    if (!part.change) continue;
    const paths = part.paths.map(rel);
    if (part.redirect === "write") {
      for (const path of paths) out.push({ path, action: "modify", hunks: [], command: ">" });
      continue;
    }
    const git = part.program === "git";
    const program = git ? `git ${part.subcommand ?? ""}`.trim() : part.program;
    if (git && part.subcommand === "mv" && paths.length >= 2) {
      out.push({ path: paths[paths.length - 1]!, from: paths[0]!, action: "rename", hunks: [], command: "git mv" });
      continue;
    }
    if (git && part.subcommand === "rm") {
      for (const path of paths) out.push({ path, action: "delete", hunks: [], command: "git rm" });
      continue;
    }
    if (git || part.tool !== "write_file" || program === undefined) continue;
    if (program === "rm" || program === "rmdir") for (const path of paths) out.push({ path, action: "delete", hunks: [], command: program });
    else if (program === "mv" && paths.length >= 2) out.push({ path: paths[paths.length - 1]!, from: paths[0]!, action: "rename", hunks: [], command: "mv" });
    else if ((program === "cp" || program === "ln") && paths.length >= 2) out.push({ path: paths[paths.length - 1]!, action: "create", hunks: [], command: program });
    else if (program === "touch" || program === "mkdir") for (const path of paths) out.push({ path, action: "create", hunks: [], command: program });
    else for (const path of paths) out.push({ path, action: "modify", hunks: [], command: program });
  }
  return out;
}

/** Fold every touch into one line per file, in the order they happened. */
function filesOf(calls: readonly ChangeCall[], root: string | undefined): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const call of calls) {
    if (!call.change) continue;
    for (const touch of touchesOf(call, root)) {
      const counted = touch.command === undefined ? countsOf(touch.hunks) : undefined;
      const stamp = { ...(call.at !== undefined ? { at: call.at } : {}), ...(call.by !== undefined ? { by: call.by } : {}) };
      if (touch.action === "rename" && touch.from !== undefined) {
        const moved = byPath.get(touch.from);
        byPath.delete(touch.from);
        if (moved?.action === "create") {
          byPath.set(touch.path, { ...moved, path: touch.path, calls: [...moved.calls, call.id], ...stamp });
          continue;
        }
        byPath.set(touch.path, {
          path: touch.path,
          action: "rename",
          from: moved?.from ?? touch.from,
          hunks: moved?.hunks ?? [],
          ...(moved?.added !== undefined ? { added: moved.added, removed: moved.removed ?? 0 } : {}),
          ...(touch.command !== undefined && moved?.added === undefined ? { command: touch.command } : {}),
          calls: [...(moved?.calls ?? []), call.id],
          ...stamp,
        });
        continue;
      }
      const was = byPath.get(touch.path);
      if (was === undefined) {
        byPath.set(touch.path, {
          path: touch.path,
          action: touch.action,
          hunks: touch.hunks,
          ...(counted !== undefined ? counted : { command: touch.command! }),
          calls: [call.id],
          ...stamp,
        });
        continue;
      }
      if (touch.action === "delete") {
        // Made here and deleted here: nothing is left of it.
        if (was.action === "create") byPath.delete(touch.path);
        else byPath.set(touch.path, { path: touch.path, action: "delete", hunks: [], command: touch.command ?? was.command ?? "delete", calls: [...was.calls, call.id], ...stamp });
        continue;
      }
      const action: FileChangeAction = was.action === "delete" ? "modify" : was.action;
      const known = was.added !== undefined && counted !== undefined;
      byPath.set(touch.path, {
        ...was,
        action,
        hunks: [...was.hunks, ...touch.hunks],
        ...(known ? { added: was.added! + counted!.added, removed: (was.removed ?? 0) + counted!.removed } : {}),
        ...(!known && touch.command !== undefined && was.added === undefined ? { command: was.command ?? touch.command } : {}),
        calls: [...was.calls, call.id],
        ...stamp,
      });
      if (!known && was.added !== undefined && counted === undefined) {
        // Edited, then changed by a command: the counts no longer describe the file.
        const next = byPath.get(touch.path)!;
        delete next.added;
        delete next.removed;
        next.command = touch.command;
      }
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// --- git --------------------------------------------------------------------------------------------

/** `[main 3f2a1c9] settings: the sidebar…` — git's own line after a commit. */
function commitOf(text: string | undefined): { branch?: string; hash?: string; message?: string } {
  const match = /\[([^\]\s]+)(?: \([^)]*\))? ([0-9a-f]{7,40})\] (.*)/.exec(text ?? "");
  return match === null ? {} : { branch: match[1]!, hash: match[2]!, message: match[3]! };
}
/** The branch a push sent — `* [new branch]  x -> x`, `a1..b2  x -> x`, else the part's last word. */
function pushedOf(text: string | undefined, part: string): string | undefined {
  const arrow = /->\s+(\S+)/.exec(text ?? "");
  if (arrow !== null) return arrow[1]!;
  const words = part.split(/\s+/).filter((word) => !word.startsWith("-"));
  return words.length > 3 ? words[words.length - 1] : undefined;
}

/**
 * A request named by its id — `<host>/<project>!<number>` on GitLab, `#` on GitHub (`RemoteHandle.id`)
 * — and the page it is on. What `git_comment`, `git_merge` and `close_merge_request` answer with.
 */
export function requestOfId(id: string | undefined): { number: number; url: string } | undefined {
  const match = /^([^/]+)\/(.+)([!#])(\d+)$/.exec(id ?? "");
  if (match === null) return undefined;
  const [, host, project, sigil, n] = match;
  return { number: Number(n), url: sigil === "!" ? `https://${host}/${project}/-/merge_requests/${n}` : `https://${host}/${project}/pull/${n}` };
}

const numberOf = (value: unknown): number | undefined => (typeof value === "number" ? value : typeof value === "string" && /^!?\d+$/.test(value) ? Number(value.replace("!", "")) : undefined);

function gitOf(calls: readonly ChangeCall[], files: readonly FileChange[]): GitChanges {
  const requests = new Map<number, MergeRequestView>();
  const steps: GitStep[] = [];
  let lastCommit: number | undefined;
  for (const call of calls) {
    if (!call.change) continue;
    const stamp = { call: call.id, ...(call.at !== undefined ? { at: call.at } : {}), ...(call.by !== undefined ? { by: call.by } : {}) };
    if (call.category === "git" && call.standard !== undefined) {
      const args = isRecord(call.args) ? call.args : {};
      const result = resultOf(call);
      const request = isRecord(result?.["merge_request"]) ? (result!["merge_request"] as Record<string, unknown>) : undefined;
      const named = requestOfId(str(result?.["merge_request"]));
      const number = numberOf(request?.["number"]) ?? named?.number ?? numberOf(args["number"]);
      // A request this task did not open is still one it acted on: known by its id from here on.
      if (number !== undefined && !requests.has(number) && named !== undefined && call.standard !== "open_merge_request") {
        requests.set(number, { number, url: named.url, state: "open", ...(call.by !== undefined ? { by: call.by } : {}) });
      }
      const known = number !== undefined ? requests.get(number) : undefined;
      switch (call.standard) {
        case "open_merge_request": {
          if (number === undefined) break;
          const view: MergeRequestView = {
            number,
            state: "open",
            ...(str(args["title"]) !== undefined ? { title: str(args["title"])! } : known?.title !== undefined ? { title: known.title } : {}),
            ...(str(request?.["url"]) !== undefined ? { url: str(request!["url"])! } : {}),
            ...(str(request?.["branch"]) !== undefined ? { branch: str(request!["branch"])! } : {}),
            ...(str(request?.["target"]) !== undefined ? { target: str(request!["target"])! } : {}),
            ...(call.by !== undefined ? { by: call.by } : {}),
          };
          requests.set(number, view);
          steps.push({ ...stamp, kind: "open", subject: `!${number}`, request: number, ...(view.title !== undefined ? { detail: view.title } : {}), ...(view.url !== undefined ? { url: view.url } : {}) });
          break;
        }
        case "git_comment":
          steps.push({ ...stamp, kind: "comment", ...(number !== undefined ? { subject: `!${number}`, request: number } : {}), ...(str(args["path"]) !== undefined ? { detail: `on ${str(args["path"])}` } : {}), ...(known?.url !== undefined ? { url: known.url } : {}) });
          break;
        case "git_merge":
          if (known !== undefined) known.state = "merged";
          steps.push({ ...stamp, kind: "merge", ...(number !== undefined ? { subject: `!${number}`, request: number } : {}), ...(known?.url !== undefined ? { url: known.url } : {}) });
          break;
        case "close_merge_request":
          if (known !== undefined) known.state = "closed";
          steps.push({ ...stamp, kind: "close", ...(number !== undefined ? { subject: `!${number}`, request: number } : {}), ...(known?.url !== undefined ? { url: known.url } : {}) });
          break;
        case "git_push":
          steps.push({ ...stamp, kind: "push", ...(str(result?.["branch"]) ?? str(args["branch"]) ? { subject: (str(result?.["branch"]) ?? str(args["branch"]))! } : {}) });
          break;
        default:
          break;
      }
      continue;
    }
    for (const part of call.parts ?? []) {
      if (!part.change || part.program !== "git") continue;
      const sub = part.subcommand;
      if (sub === "commit") {
        const commit = commitOf(call.text);
        steps.push({ ...stamp, kind: "commit", command: part.text, ...(commit.hash !== undefined ? { subject: commit.hash } : {}), ...(commit.message !== undefined ? { detail: commit.message } : {}) });
        if (call.at !== undefined) lastCommit = call.at;
      } else if (sub === "push") {
        const branch = pushedOf(call.text, part.text);
        steps.push({ ...stamp, kind: "push", command: part.text, ...(branch !== undefined ? { subject: branch } : {}) });
      } else if (sub === "add") {
        steps.push({ ...stamp, kind: "stage", command: part.text, detail: part.paths.length === 1 ? part.paths[0]! : `${part.paths.length || "all"} ${part.paths.length === 1 ? "path" : "paths"}` });
      } else {
        steps.push({ ...stamp, kind: "other", command: part.text });
      }
    }
  }
  // A request this task acted on without opening is known by its number alone; what the Git tools
  // READ about it — `list_merge_requests`, `read_merge_request` — says its title and branches.
  const described = new Map<number, Record<string, unknown>>();
  const collect = (value: unknown, depth: number): void => {
    if (depth > 3) return;
    if (Array.isArray(value)) for (const item of value) collect(item, depth + 1);
    else if (isRecord(value)) {
      const number = numberOf(value["number"]) ?? numberOf(value["iid"]);
      if (number !== undefined && str(value["title"]) !== undefined) described.set(number, { ...described.get(number), ...value });
      for (const nested of Object.values(value)) collect(nested, depth + 1);
    }
  };
  for (const call of calls) if (call.category === "git" && requests.size > 0) collect(resultOf(call) ?? parsedList(call.text), 0);
  for (const request of requests.values()) {
    const read = described.get(request.number);
    if (read === undefined) continue;
    request.title ??= str(read["title"]);
    request.branch ??= str(read["branch"]) ?? str(read["source_branch"]) ?? str(read["sourceBranch"]);
    request.target ??= str(read["target"]) ?? str(read["target_branch"]) ?? str(read["targetBranch"]);
    if (request.title === undefined) delete request.title;
    if (request.branch === undefined) delete request.branch;
    if (request.target === undefined) delete request.target;
  }
  const uncommitted = lastCommit === undefined ? [] : files.filter((file) => file.at !== undefined && file.at > lastCommit!).map((file) => file.path);
  return { requests: [...requests.values()], steps, uncommitted };
}

// --- the other groups ----------------------------------------------------------------------------------

const WORKFLOW_WORDS: Record<string, string> = {
  start_task: "Started",
  move_task: "Moved a task to",
  stop_task: "Stopped a task",
  hold_task: "Held a task",
  release_task: "Released a task",
  answer_question: "Answered a question",
};

function taskItemOf(call: ChangeCall): ChangeItem {
  const args = isRecord(call.args) ? call.args : {};
  const result = resultOf(call);
  const state = str(args["state"]) ?? str(args["to"]);
  const taskId = str(result?.["task"]) ?? str(args["task"]);
  return {
    call: call.id,
    said: WORKFLOW_WORDS[call.standard ?? ""] ?? call.name,
    ...(state !== undefined ? { subject: state } : {}),
    ...(state !== undefined || taskId !== undefined ? { open: { ...(taskId !== undefined ? { taskId } : {}), ...(state !== undefined ? { stateId: state } : {}) } } : {}),
    ...(str(result?.["status"]) !== undefined ? { detail: str(result!["status"])! } : {}),
    ...(call.at !== undefined ? { at: call.at } : {}),
    ...(call.by !== undefined ? { by: call.by } : {}),
  };
}

/** The first plain string argument — what a call is ABOUT (an issue id, a url, a query). */
function firstArg(args: JsonValue): string | undefined {
  if (typeof args === "string") return args;
  if (!isRecord(args)) return undefined;
  for (const key of ["id", "issue", "identifier", "url", "path", "name", "title", "query"]) if (str(args[key]) !== undefined) return str(args[key]);
  const first = Object.values(args).find((value) => typeof value === "string" && value.length <= 80);
  return typeof first === "string" ? first : undefined;
}

function itemOf(call: ChangeCall, title: (name: string) => string): ChangeItem {
  const subject = firstArg(call.args);
  const url = urlOf(resultOf(call));
  return {
    call: call.id,
    said: title(call.name),
    ...(subject !== undefined ? { subject } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(call.at !== undefined ? { at: call.at } : {}),
    ...(call.by !== undefined ? { by: call.by } : {}),
  };
}

/** A shell call's line, when something in it besides git and files changed. */
function executionOf(call: ChangeCall): ChangeItem | undefined {
  const rest = (call.parts ?? []).filter((part) => part.change && part.program !== "git" && part.tool !== "write_file" && part.redirect !== "write");
  if (rest.length === 0) return undefined;
  const args = isRecord(call.args) ? call.args : {};
  const line = str(args["command"]) ?? (Array.isArray(args["command"]) ? (args["command"] as unknown[]).join(" ") : rest.map((part) => part.text).join(" && "));
  return {
    call: call.id,
    said: str(args["description"]) ?? "Ran a command",
    command: line,
    ...(call.ok === false ? { detail: "failed" } : {}),
    ...(call.at !== undefined ? { at: call.at } : {}),
    ...(call.by !== undefined ? { by: call.by } : {}),
  };
}

/**
 * Every change the calls made, grouped as the tool menu groups tools. `root` is the workspace, which
 * the paths are shown under; `title` names a tool for a line (`toolDisplayOf`).
 */
export function changeLogOf(calls: readonly ChangeCall[], options: { root?: string; title: (name: string) => string }): TaskChangeLog {
  const ordered = [...calls].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const files = filesOf(ordered, options.root);
  const log: TaskChangeLog = { files, execution: [], web: [], git: gitOf(ordered, files), tasks: [], mcp: [], other: [] };
  for (const call of ordered) {
    if (!call.change) continue;
    switch (call.category) {
      case "files":
      case "git":
        break;
      case "execution": {
        const item = executionOf(call);
        if (item !== undefined) log.execution.push(item);
        break;
      }
      case "web":
        log.web.push(itemOf(call, options.title));
        break;
      case "tasks":
        log.tasks.push(taskItemOf(call));
        break;
      case "mcp":
        log.mcp.push(itemOf(call, options.title));
        break;
      case "other":
        log.other.push(itemOf(call, options.title));
        break;
    }
  }
  return log;
}

/** How many changes the tab counts: a file, a git step, a line of any other group. */
export function changeCountOf(log: TaskChangeLog): number {
  return log.files.length + log.execution.length + log.web.length + log.git.steps.length + log.tasks.length + log.mcp.length + log.other.length;
}

/** The log without what subagents and subtasks did — the header switch turned off. */
export function ownChangesOf(log: TaskChangeLog): TaskChangeLog {
  const mine = <T extends { by?: ChangeAuthor }>(list: readonly T[]): T[] => list.filter((item) => item.by === undefined);
  const steps = mine(log.git.steps);
  const requests = mine(log.git.requests);
  const files = mine(log.files);
  const kept = new Set(files.map((file) => file.path));
  return {
    files,
    execution: mine(log.execution),
    web: mine(log.web),
    git: { requests, steps, uncommitted: log.git.uncommitted.filter((path) => kept.has(path)) },
    tasks: mine(log.tasks),
    mcp: mine(log.mcp),
    other: mine(log.other),
  };
}
