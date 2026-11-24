/**
 * What a permission is ABOUT, for a person reading the permission board (decision 0034): a RESOURCE
 * (files, sites, programs…) and an ACCESS to it (read, write, control…). Each tool JaiRA ships sits
 * under the ONE resource it acts on — `read_file` reads files; `open_app` opens a program (with a file or
 * a link in it); `write_clipboard` writes the machine's clipboard — and the board groups tools by it, so
 * answering a resource permission answers every tool that needs it.
 *
 * A tool's places of other kinds stay on its row: `open_app`'s file (`src/**`) and link (`docs.rs`) are
 * places of Programs · Open, and `write_clipboard`'s files are places of Machine · Clipboard. The settings
 * can put a tool under more than one resource; then each place goes to the resource whose KINDS have it
 * (`owner=session` to Programs, `src/**` to Files), a kind none of them has to the first, and the
 * everywhere answer (`**`) to every one.
 *
 * This is the board's grouping, not the engine's: a call is still decided by its tool's line (decision
 * 0023). What ships is {@link DEFAULT_TOOL_RESOURCES}; Settings → Tools → Tool mapping overrides it per
 * tool (`permissions.resources` in the settings, any layer).
 */
import { isMcpSubject } from "./mcp";
import { parseRunnerSubject } from "./commandRunners";
import { parseToolFlagSubject } from "./toolFlags";
import { canonicalToolName, type PlaceKind } from "./toolVocabulary";

/** One way of touching a resource: Files · Read. */
export interface ResourceAccessSpec {
  /** `read` — with the resource's id, `files.read`. */
  id: string;
  label: string;
  /** An icon name of the app's (`iconPaths.ts`). */
  icon: string;
  hint: string;
}

/** A kind of thing a permission is about, its kinds of place, and the ways of touching it. */
export interface ResourceSpec {
  id: string;
  label: string;
  icon: string;
  /** The kinds of place its tools' lines hold. */
  kinds: readonly PlaceKind[];
  accesses: readonly ResourceAccessSpec[];
}

/** The resources, in the order the board lists them. */
export const RESOURCES: readonly ResourceSpec[] = [
  {
    id: "files",
    label: "Files",
    icon: "folder",
    kinds: ["path"],
    accesses: [
      { id: "read", label: "Read", icon: "read", hint: "read a file" },
      { id: "search", label: "Search", icon: "search", hint: "find files by name, and search what is in them" },
      { id: "write", label: "Write", icon: "pencil", hint: "change and create files" },
      { id: "artifacts", label: "Artifacts", icon: "artifact", hint: "a page, a picture or a file made to look at, under the task's own artifacts" },
      { id: "skills", label: "Skills", icon: "think", hint: "list the skills, and load one" },
    ],
  },
  {
    id: "sites",
    label: "Sites",
    icon: "web",
    kinds: ["site"],
    accesses: [
      { id: "search", label: "Search", icon: "search", hint: "search the web" },
      { id: "fetch", label: "Fetch", icon: "download", hint: "read a page" },
    ],
  },
  {
    id: "repositories",
    label: "Repositories",
    icon: "repo",
    kinds: ["repository", "branch"],
    accesses: [
      { id: "read", label: "Read", icon: "read", hint: "merge requests, pipelines and their jobs" },
      { id: "write", label: "Write", icon: "pencil", hint: "open, comment on and close merge requests" },
      { id: "push", label: "Push", icon: "upload", hint: "push a branch" },
      { id: "merge", label: "Merge", icon: "merge", hint: "merge a merge request" },
    ],
  },
  {
    id: "programs",
    label: "Programs",
    icon: "tabs",
    kinds: ["program", "service", "package", "manager", "owner", "machine", "action", "path", "host", "site"],
    accesses: [
      { id: "see", label: "See", icon: "read", hint: "what runs, its windows and what it prints; the services; what is installed" },
      { id: "run", label: "Run", icon: "terminal", hint: "run a command line in a folder, here or on a runner, and read what it prints" },
      { id: "open", label: "Open", icon: "external", hint: "launch an app, or open a file or a link in its app" },
      { id: "control", label: "Control", icon: "pointer", hint: "stop, focus, close and type into a program; start, stop and switch a service" },
      { id: "install", label: "Install", icon: "download", hint: "install, update and remove software" },
      { id: "screen", label: "Screen", icon: "camera", hint: "pictures of the screen and its windows" },
    ],
  },
  {
    id: "machine",
    label: "Machine",
    icon: "system",
    kinds: ["area", "owner", "machine", "action", "path"],
    accesses: [
      { id: "read", label: "Read", icon: "read", hint: "what the machine is, and its settings" },
      { id: "change", label: "Change", icon: "pencil", hint: "change a setting" },
      { id: "power", label: "Power", icon: "power", hint: "restart, shut down, sleep, lock" },
      { id: "clipboard", label: "Clipboard", icon: "clipboard", hint: "what is on the clipboard, and what is put there" },
    ],
  },
  {
    id: "workflows",
    label: "Workflows",
    icon: "workflow",
    kinds: ["workflow"],
    accesses: [
      { id: "see", label: "See", icon: "read", hint: "the workflows, their tasks, and the events they wait for" },
      { id: "start", label: "Start", icon: "play", hint: "start a task" },
      { id: "move", label: "Move", icon: "arrow", hint: "move a task to another state" },
      { id: "control", label: "Control", icon: "pointer", hint: "answer, hold, release and stop tasks" },
    ],
  },
];

/** `files.read` → its resource and access, or undefined for a name no resource has. */
export function resourceAccessOf(name: string): { resource: ResourceSpec; access: ResourceAccessSpec } | undefined {
  const at = name.indexOf(".");
  if (at <= 0) return undefined;
  const resource = RESOURCES.find((each) => each.id === name.slice(0, at));
  const access = resource?.accesses.find((each) => each.id === name.slice(at + 1));
  return resource !== undefined && access !== undefined ? { resource, access } : undefined;
}

/** Every resource permission's name, `files.read` first. */
export const RESOURCE_PERMISSIONS: readonly string[] = RESOURCES.flatMap((resource) => resource.accesses.map((access) => `${resource.id}.${access.id}`));

/**
 * What each tool JaiRA ships touches: the one resource it acts on. A command line is a program run —
 * the shell, `script`, the runners (`runner:*`) and every command line a set writes (`command:*`:
 * `npm run build`, `git`), its places the folders (or hosts) it runs in; a service is a program the
 * machine keeps running; installed software is programs. An artifact and a skill are files. Only what
 * nothing here names — an MCP tool the settings do not map, and `other` — is drawn under Other.
 */
export const DEFAULT_TOOL_RESOURCES: Readonly<Record<string, readonly string[]>> = {
  read_file: ["files.read"],
  glob: ["files.search"],
  grep: ["files.search"],
  edit: ["files.write"],
  write_file: ["files.write"],
  show_artifact: ["files.artifacts"],
  list_skills: ["files.skills"],
  load_skill: ["files.skills"],
  web_search: ["sites.search"],
  web_fetch: ["sites.fetch"],
  list_merge_requests: ["repositories.read"],
  read_merge_request: ["repositories.read"],
  list_pipelines: ["repositories.read"],
  read_pipeline: ["repositories.read"],
  read_pipeline_job: ["repositories.read"],
  download_pipeline_artifact: ["repositories.read"],
  open_merge_request: ["repositories.write"],
  comment_merge_request: ["repositories.write"],
  close_merge_request: ["repositories.write"],
  git_push: ["repositories.push"],
  git_merge: ["repositories.merge"],
  list_processes: ["programs.see"],
  read_process: ["programs.see"],
  wait_process: ["programs.see"],
  list_windows: ["programs.see"],
  list_services: ["programs.see"],
  list_programs: ["programs.see"],
  shell: ["programs.run"],
  script: ["programs.run"],
  "runner:*": ["programs.run"],
  "command:*": ["programs.run"],
  open_app: ["programs.open"],
  stop_process: ["programs.control"],
  control_input: ["programs.control"],
  control_service: ["programs.control"],
  install_program: ["programs.install"],
  screenshot: ["programs.screen"],
  read_system: ["machine.read"],
  read_settings: ["machine.read"],
  write_settings: ["machine.change"],
  power: ["machine.power"],
  read_clipboard: ["machine.clipboard"],
  write_clipboard: ["machine.clipboard"],
  list_workflows: ["workflows.see"],
  list_tasks: ["workflows.see"],
  wait_for_event: ["workflows.see"],
  start_task: ["workflows.start"],
  move_task: ["workflows.move"],
  answer_question: ["workflows.control"],
  hold_task: ["workflows.control"],
  release_task: ["workflows.control"],
  stop_task: ["workflows.control"],
};

/**
 * The key a subject's mapping is looked up by: a flag line is its tool's, a runner is `runner:*`, a
 * command line (`npm run build`, `git`) is `command:*` — unless the settings name the subject itself.
 */
export function mappingKeyOf(subject: string, overrides: Readonly<Record<string, readonly string[]>> = {}): string {
  const normalized = canonicalToolName(subject.trim().replace(/\s+/g, " "));
  if (Object.hasOwn(overrides, normalized) || Object.hasOwn(DEFAULT_TOOL_RESOURCES, normalized)) return normalized;
  const flagged = parseToolFlagSubject(normalized);
  if (flagged !== undefined) return flagged.tool;
  if (normalized === "other" || isMcpSubject(normalized)) return normalized;
  if (parseRunnerSubject(normalized) !== undefined) return "runner:*";
  // A command line: words, or one program's name (`git`, `npm run build`).
  if (/\s/.test(normalized) || /^[a-z][a-z0-9.+-]*$/.test(normalized)) return "command:*";
  return normalized;
}

/**
 * The resource permissions a subject touches: the settings' word for it when they say one (`[]`: none),
 * else what ships. A name no resource has is left out.
 */
export function toolResourcesOf(subject: string, overrides: Readonly<Record<string, readonly string[]>> = {}): string[] {
  // A setting may still name a tool by its old name (`list_software`): it is the tool it is now.
  const settled: Record<string, readonly string[]> = Object.fromEntries(Object.entries(overrides).map(([tool, list]) => [canonicalToolName(tool), list]));
  const key = mappingKeyOf(subject, settled);
  const named = Object.hasOwn(settled, key) ? settled[key]! : DEFAULT_TOOL_RESOURCES[key] ?? [];
  return named.filter((name) => resourceAccessOf(name) !== undefined);
}
