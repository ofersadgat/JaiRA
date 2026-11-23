/**
 * `write_file` / `read_file` — the tools that make JaiRA own an agent's writes
 * (DESIGN §7.6).
 *
 * This is the whole artifact mechanism, and it works because of where the engine
 * puts us: a delegated agent's tools are injected over MCP as
 * `run: (input) => tool.run(input, ctx)`, so **our implementation is called with
 * the agent's raw arguments**. Registering these two turns every agent write into a
 * call we service:
 *
 *   write_file({ path: "docs/plan.md" })
 *     → policy checks the LOGICAL path (what a human would be asked to approve)
 *     → resolve logical → physical, per the configured destination
 *     → write, and record the mapping
 *     → report success, naming the path the agent used
 *
 * The agent is never told the file moved. A later `read_file` of the same logical
 * path consults the map first, so the round trip holds under every destination;
 * a read that misses falls through to the real workspace, leaving ordinary source
 * files alone.
 *
 * The limit, stated where it is implemented: this only covers tools we serve. An
 * agent using its own native write, or `shell` with a redirection, never reaches
 * here — see §7.6's reconciliation note.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative as relativePath, resolve as resolvePath } from "node:path";
import type { ExecServices, JsonValue, Tool } from "@declarative-ai/exec";
import { mimeOfPath } from "@jaira/shared";
import type { ArtifactRecord, ArtifactStore } from "./artifacts";
import { MemoryArtifactStore } from "./artifacts";
import {
  DestinationError,
  parseDestination,
  resolveDestination,
  withinWorkspace,
  type Destination,
  type DestinationVars,
} from "./artifactPath";
import { callAgentOf } from "./callAgent";
import { createShowArtifactTool } from "./showArtifact";

export const WRITE_FILE = "write_file";
export const READ_FILE = "read_file";
export const EDIT_FILE = "edit";
export const SHOW_ARTIFACT = "show_artifact";

export interface FileToolOptions {
  /** The parsed `config.artifacts.destination`. Defaults to `$DEFAULT`. */
  destination?: Destination;
  /** Where records go. Defaults to a fresh in-memory store. */
  store?: ArtifactStore;
  /** Everything the destination template can interpolate, minus the per-write parts. */
  vars: Omit<DestinationVars, "relPath">;
  /** Keep content inline at or below this size (also what `virtual:` always does). */
  inlineMaxBytes?: number;
  /** Fallback workspace root when the operation carries no `ctx.workspace`. */
  cwd?: string;
  now?: () => number;
  /** What each task's agent last read or wrote, file by file. Defaults to the one the process keeps. */
  seen?: SeenFiles;
}

const DEFAULT_INLINE_MAX = 65_536;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * What an agent last saw of each file — the content's hash when it read it, or when it wrote or edited it
 * — so a `write_file` over a file it never read, or one changed since, is refused rather than done.
 *
 * A write replaces the whole file: one made over a file the model has not read throws away whatever it
 * did not think to include (t-elvj5dhzoy, 2026-11-11: a 587-line Sidebar.tsx replaced whole, its only
 * read 120 lines, six days before). Claude Code's own Write refuses the same; ours did not.
 *
 * Kept per task, in the process: a conversation's turns are one task, so a file read in one turn may be
 * written in the next. After a restart the agent reads again, which is the cost of one read.
 */
export class SeenFiles {
  private readonly hashes = new Map<string, string>();
  /** Note that the task's agent now knows the file as `text`. */
  saw(taskId: string, file: string, text: string): void {
    this.hashes.set(seenKey(taskId, file), sha256(text));
  }
  /** The hash of what the task's agent last saw of the file, or `undefined` for one it never read or wrote. */
  hashOf(taskId: string, file: string): string | undefined {
    return this.hashes.get(seenKey(taskId, file));
  }
  /**
   * Forget every file the task's agent saw — its conversation was compacted. What it read is a summary
   * now, not the file, so a write after it is a write over a file it no longer holds, which is the
   * write this guard exists to refuse (the person, 2026-11-22: "does the tool check … properly reset
   * when compaction happens?" — it did not; a read from before a compaction let a write through after).
   */
  forget(taskId: string): void {
    const prefix = `${taskId}\u0000`;
    for (const key of [...this.hashes.keys()]) if (key.startsWith(prefix)) this.hashes.delete(key);
  }
}

/** Forget what the task's agent saw, in the process's own {@link SeenFiles} — see {@link SeenFiles.forget}. */
export function forgetSeenFiles(taskId: string): void {
  PROCESS_SEEN.forget(taskId);
}

/** One file as {@link SeenFiles} keys it: absolute, slashes forward, case folded where the disk folds it. */
function seenKey(taskId: string, file: string): string {
  const slashed = normalize(file).replace(/\\/g, "/");
  return `${taskId}\u0000${process.platform === "win32" ? slashed.toLowerCase() : slashed}`;
}

const PROCESS_SEEN = new SeenFiles();
const seenOf = (options: FileToolOptions): SeenFiles => options.seen ?? PROCESS_SEEN;

/** The file a logical path names, absolute — what {@link SeenFiles} keys it by. */
const fileOf = (root: string, logical: string): string => resolvePath(root, logical);

/**
 * Why a `write_file` of `text`'s path may not replace it, or `undefined` when it may: the file does not
 * exist, or the agent last saw it as it is now. Only an AGENT's call is held to it (`callAgentOf`): a call
 * JaiRA makes itself — a workflow writing its output — is not a model that may have forgotten a file.
 */
function unreadRefusal(options: FileToolOptions, input: unknown, file: string, shown: string, current: string | undefined): string | undefined {
  if (current === undefined || callAgentOf(input) === undefined) return undefined;
  const last = seenOf(options).hashOf(options.vars.taskId, file);
  if (last === undefined) {
    return `'${shown}' already exists and you have not read it in this conversation, so writing it whole could drop what it holds. Nothing was changed. Read it with read_file first, then write it, or change part of it with edit.`;
  }
  if (last !== sha256(current)) {
    return `'${shown}' has changed since you last read or wrote it. Nothing was changed. Read it again with read_file, then write it, or change part of it with edit.`;
  }
  return undefined;
}

/**
 * A path in the calling agent's OWN folder (`$AGENT_WORKSPACE`, decision 0023 ruling 19), made absolute,
 * or `undefined`. Writes keep the workspace (ruling 18) but for this folder, which is the agent's and not
 * the project's: whether a call may write there is the line's, at that place, and the gate said so before
 * the tool ran. A call no agent made has no such folder.
 */
function ownFolderPath(root: string, path: string, input: unknown): string | undefined {
  if (!isAbsolute(path)) return undefined;
  const folder = callAgentOf(input)?.workspace?.(root);
  return folder !== undefined ? withinWorkspace(folder, path) : undefined;
}

/** A file's text, or `undefined` when it cannot be read — most often, it does not exist. */
function textAt(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Normalize an agent-supplied path to the map's key form.
 *
 * An ABSOLUTE path inside the workspace is taken relative to it first: an agent following instructions
 * that ask for absolute paths (the Design type's, decision 0020) names its files that way, and treated
 * as relative it was joined onto the root — `<root>\C:\<root>\…` — and refused as outside it. One
 * outside the workspace keeps its form, and the destination refuses it as before.
 */
function logicalKey(path: string, root?: string): string {
  if (root !== undefined && isAbsolute(path)) {
    const inside = relativePath(root, path);
    if (inside.length > 0 && !inside.startsWith("..") && !isAbsolute(inside)) path = inside;
  }
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** The workspace a call works in: its own, else the tool's fallback, else the task's worktree. */
const rootOf = (options: FileToolOptions, ctx?: ExecServices): string => ctx?.workspace?.root ?? options.cwd ?? options.vars.worktree;

/**
 * Reject a path before it is resolved: one that names nothing.
 *
 * Where a call may read or write is not this tool's to say: it is the permission set's, at its places
 * (decision 0023 §3.2), and the gate said so before the tool ran — judged on the path as the call wrote
 * it, which is what an approval dialog shows, so a destination template cannot launder a refused place.
 * `.jaira/` is no exception: the sets JaiRA ships refuse writing there with lines of their own.
 */
function refusePath(logical: string): string | undefined {
  if (logical.trim().length === 0) return "no path given";
  return undefined;
}

interface Resolved {
  record: ArtifactRecord;
  physicalPath?: string;
}

function place(
  options: FileToolOptions,
  destination: Destination,
  taskId: string,
  logical: string,
  content: string,
  now: number,
): Resolved {
  const bytes = Buffer.byteLength(content, "utf8");
  const inlineMax = options.inlineMaxBytes ?? DEFAULT_INLINE_MAX;
  const resolved = resolveDestination(destination, { ...options.vars, relPath: logical }, logical);
  const record: ArtifactRecord = {
    taskId,
    logicalPath: logical,
    hash: sha256(content),
    bytes,
    createdAt: now,
    // `virtual:` keeps everything; a file destination keeps small content inline so
    // bindings and prompts stay cheap without a read.
    ...(resolved.scheme === "virtual" || bytes <= inlineMax ? { content } : {}),
    ...(resolved.path !== undefined ? { physicalPath: resolved.path } : {}),
  };
  return { record, ...(resolved.path !== undefined ? { physicalPath: resolved.path } : {}) };
}

/**
 * The tool an agent calls to write a file.
 *
 * `readOnly: false` matters: it is what the `read-only` and `plan` permission
 * profiles gate on, so a plan-mode session cannot write at all regardless of the
 * per-path policy.
 */
export function createWriteFileTool(options: FileToolOptions): Tool {
  const destination = options.destination ?? parseDestination("$DEFAULT");
  const store = options.store ?? new MemoryArtifactStore();
  const now = options.now ?? Date.now;
  return {
    description:
      "Write a file in the task's workspace, or in your own folder. The path is where you will find it again; JaiRA may store the bytes elsewhere according to project configuration. To replace a file that exists, read it with read_file first: a write over a file you have not read, or one changed since you read it, is refused. To change part of a file, use edit.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        content: { type: "string", description: "The file's full contents." },
      },
      required: ["path", "content"],
    },
    readOnly: false,
    run: async (input, ctx?: ExecServices): Promise<JsonValue> => {
      const args = (input ?? {}) as { path?: unknown; content?: unknown };
      const raw = typeof args.path === "string" ? args.path : "";
      const root = rootOf(options, ctx);
      const content = typeof args.content === "string" ? args.content : "";
      const own = ownFolderPath(root, raw, input);
      if (own !== undefined) return writeOwn(options, input, raw, own, content);
      const logical = logicalKey(raw, root);
      const refusal = refuseOutside(root, raw) ?? refusePath(logical);
      if (refusal !== undefined) return { error: refusal };
      const existing = currentContent(options, logical, ctx);
      const unread = unreadRefusal(options, input, fileOf(root, logical), logical, "text" in existing ? existing.text : undefined);
      if (unread !== undefined) return { error: unread };

      try {
        const { record, physicalPath } = place(options, destination, options.vars.taskId, logical, content, now());
        if (physicalPath !== undefined) {
          mkdirSync(dirname(physicalPath), { recursive: true });
          writeFileSync(physicalPath, content, "utf8");
        }
        store.put(record);
        seenOf(options).saw(options.vars.taskId, fileOf(root, logical), content);
        // The agent is told about the path IT used. Reporting the physical path
        // would break the illusion the whole design depends on.
        return { path: logical, bytes: record.bytes };
      } catch (e) {
        if (e instanceof DestinationError) return { error: e.message };
        return { error: `could not write '${logical}': ${(e as Error).message}` };
      }
    },
  } as Tool;
}

/**
 * A `write_file` into the calling agent's own folder ({@link ownFolderPath}): written where it is, by the
 * path the call named — it is no artifact of the task's, and no destination places it.
 */
function writeOwn(options: FileToolOptions, input: unknown, raw: string, file: string, content: string): JsonValue {
  const refused = refusePath(file);
  if (refused !== undefined) return { error: refused };
  const unread = unreadRefusal(options, input, file, raw, textAt(file));
  if (unread !== undefined) return { error: unread };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
  } catch (e) {
    return { error: `could not write '${raw}': ${(e as Error).message}` };
  }
  seenOf(options).saw(options.vars.taskId, file, content);
  return { path: raw, bytes: Buffer.byteLength(content, "utf8") };
}

/**
 * A path a call names OUTSIDE the workspace, made absolute, or `undefined` for one inside it.
 *
 * Read where it is: whether it may be read is the permission set's to say, at its places (decision 0023
 * §3.2), and the gate said so before the tool ran — the same answer a shell's `Get-Content` of it gets.
 * Taken from the path as the call wrote it, which is what the gate judged; the logical key drops a
 * leading `/`, which would read `/etc/x` as the project's `etc/x`.
 */
function outsidePath(root: string, path: string): string | undefined {
  if (path.trim() === "") return undefined;
  const absolute = isAbsolute(path) ? normalize(path) : resolvePath(root, path);
  return withinWorkspace(root, absolute) === undefined ? absolute : undefined;
}

/**
 * A write's refusal of an ABSOLUTE path outside the workspace, judged on the path as the call wrote it.
 * Writes keep the workspace (decision 0023 ruling 18), but for the calling agent's own folder, taken
 * before this ({@link ownFolderPath}). Judged before the logical key, which drops a
 * leading `/`: on Linux `/tmp/x` would otherwise be written as the project's `tmp/x`. A relative path
 * that climbs out (`../x`) is the destination's to refuse, against its own root.
 */
function refuseOutside(root: string, path: string): string | undefined {
  return isAbsolute(path) && outsidePath(root, path) !== undefined ? `'${path}' is outside the workspace` : undefined;
}

/**
 * The matching read. Map first, workspace second — so an artifact resolves wherever
 * it was placed, and an ordinary source file is read normally. A path outside the workspace is read
 * where it is ({@link outsidePath}).
 */
export function createReadFileTool(options: FileToolOptions): Tool {
  return {
    description: "Read a file: a path relative to the workspace root, or an absolute path.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the workspace root, or absolute." } },
      required: ["path"],
    },
    readOnly: true,
    run: async (input, ctx?: ExecServices): Promise<JsonValue> => {
      const args = (input ?? {}) as { path?: unknown };
      const raw = typeof args.path === "string" ? args.path : "";
      const root = rootOf(options, ctx);
      const seen = seenOf(options);
      const outside = outsidePath(root, raw);
      if (outside !== undefined) {
        const refused = refusePath(outside);
        if (refused !== undefined) return { error: refused };
        const picture = pictureRead(raw, outside, (text) => seen.saw(options.vars.taskId, outside, text));
        if (picture !== undefined) return picture;
        try {
          const content = readFileSync(outside, "utf8");
          seen.saw(options.vars.taskId, outside, content);
          return { path: raw, content };
        } catch (e) {
          return { error: `could not read '${raw}': ${(e as Error).message}` };
        }
      }
      const logical = logicalKey(raw, root);
      const refusal = refusePath(logical);
      if (refusal !== undefined) return { error: refusal };

      // A picture on disk is handed over as a picture (`$images`), which the model sees.
      const record = (options.store ?? new MemoryArtifactStore()).get(options.vars.taskId, logical);
      const onDisk = record?.physicalPath ?? (record?.content === undefined ? withinWorkspace(ctx?.workspace?.root ?? options.cwd ?? options.vars.worktree, logical) : undefined);
      if (onDisk !== undefined) {
        const picture = pictureRead(logical, onDisk, (text) => seen.saw(options.vars.taskId, fileOf(root, logical), text));
        if (picture !== undefined) return picture;
      }
      const read = currentContent(options, logical, ctx);
      if ("error" in read) return { error: read.error };
      seen.saw(options.vars.taskId, fileOf(root, logical), read.text);
      return { path: logical, content: read.text };
    },
  } as Tool;
}

/** The pictures a model can be handed as pictures (Anthropic's and OpenAI's image inputs alike). */
const SEEN_PICTURES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** A picture's bytes past which it is not handed over: 5 MB once in base64, a model API's limit for one image. */
export const PICTURE_MAX_BYTES = 3_750_000;

/**
 * `read_file` on a picture (2026-11-13): its bytes as a picture the model SEES — `$images`, which every
 * route hands a model as an image beside the rest — rather than as text. Read as UTF-8 text a PNG is tens
 * of thousands of characters of mojibake: an agent asked to check a screenshot was refused it as too long
 * and "couldn't view images". `undefined` for anything that is not such a picture, read as text as before.
 */
function pictureRead(path: string, file: string, saw: (text: string) => void): JsonValue | undefined {
  const mediaType = mimeOfPath(path.replace(/\\/g, "/"));
  if (!SEEN_PICTURES.has(mediaType)) return undefined;
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (e) {
    return { error: `could not read '${path}': ${(e as Error).message}` };
  }
  // What a later write is measured against is the file as a text read would see it.
  saw(bytes.toString("utf8"));
  if (bytes.length > PICTURE_MAX_BYTES) {
    return { path, mediaType, bytes: bytes.length, note: `${path} is a picture of ${(bytes.length / 1048576).toFixed(1)} MB, more than a model takes as one image (3.75 MB). Show it to the person with show_artifact, or make a smaller copy and read that.` };
  }
  return { path, mediaType, bytes: bytes.length, $images: [{ mimeType: mediaType, data: bytes.toString("base64") }] };
}

/**
 * The current content of a logical path — the read half, without the tool around it.
 *
 * Split out because `edit` needs exactly what `read_file` does and for the same reason: an artifact
 * written to a virtual destination is not on disk at the path the agent knows it by, so an edit that
 * went straight to the filesystem would either miss it or, worse, create a second copy beside it.
 */
function currentContent(options: FileToolOptions, logical: string, ctx?: ExecServices): { text: string } | { error: string } {
  const store = options.store ?? new MemoryArtifactStore();
  const record = store.get(options.vars.taskId, logical);
  // A placed file is what its disk holds now: the copy kept inline is what was written, and a person (or
  // a shell) may have changed it since — read back from the copy, the change was invisible to a read and
  // an edit undid it. Only a `virtual:` artifact, which has no file, is its copy.
  if (record?.physicalPath !== undefined) {
    const now = textAt(record.physicalPath);
    if (now !== undefined) return { text: now };
  }
  if (record?.content !== undefined) return { text: record.content };
  const target = record?.physicalPath ?? withinWorkspace(ctx?.workspace?.root ?? options.cwd ?? options.vars.worktree, logical);
  if (target === undefined) return { error: `'${logical}' is outside the workspace` };
  try {
    return { text: readFileSync(target, "utf8") };
  } catch (e) {
    return { error: `could not read '${logical}': ${(e as Error).message}` };
  }
}

/** The current content of a file in the agent's own folder ({@link ownFolderPath}), read where it is. */
function ownContent(file: string, raw: string): { text: string } | { error: string } {
  try {
    return { text: readFileSync(file, "utf8") };
  } catch (e) {
    return { error: `could not read '${raw}': ${(e as Error).message}` };
  }
}

/**
 * `edit` — replace exact text in a file that already exists.
 *
 * The distinction from `write_file` is intent, and intent is the whole argument for having both. A
 * write says "the file is now this", and a model that meant to change one line and returned the file
 * whole has silently reverted everything it did not think to include. An edit says "this became
 * that", which fails loudly when the file is not what the model believed — and being wrong about the
 * current content is the failure mode that matters.
 *
 * So a match that is not unique is REFUSED rather than resolved by picking the first. Two identical
 * fragments mean the caller has not identified the one it meant, and choosing for it is how an edit
 * lands in the wrong function.
 */
export function createEditFileTool(options: FileToolOptions): Tool {
  const destination = options.destination ?? parseDestination("$DEFAULT");
  const store = options.store ?? new MemoryArtifactStore();
  const now = options.now ?? Date.now;
  return {
    description:
      "Replace exact text in an existing file, in the workspace or in your own folder. `old` must appear exactly once unless `all` is set. Use write_file to create a file or replace one whole.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        old: { type: "string", description: "The exact text to replace, including its indentation." },
        new: { type: "string", description: "What to put in its place. Empty deletes it." },
        all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." },
      },
      required: ["path", "old", "new"],
    },
    readOnly: false,
    run: async (input, ctx?: ExecServices): Promise<JsonValue> => {
      const args = (input ?? {}) as { path?: unknown; old?: unknown; new?: unknown; all?: unknown };
      const raw = typeof args.path === "string" ? args.path : "";
      const root = rootOf(options, ctx);
      const own = ownFolderPath(root, raw, input);
      const logical = own !== undefined ? raw : logicalKey(raw, root);
      const refusal = own !== undefined ? refusePath(own) : (refuseOutside(root, raw) ?? refusePath(logical));
      if (refusal !== undefined) return { error: refusal };
      const oldText = typeof args.old === "string" ? args.old : "";
      const newText = typeof args.new === "string" ? args.new : "";
      if (oldText === "") return { error: "`old` is empty — use write_file to create a file" };
      if (oldText === newText) return { error: "`old` and `new` are identical, so this edit would change nothing" };

      const read = own !== undefined ? ownContent(own, raw) : currentContent(options, logical, ctx);
      if ("error" in read) return { error: read.error };
      const occurrences = read.text.split(oldText).length - 1;
      if (occurrences === 0) return { error: `'${logical}' does not contain that text` };
      if (occurrences > 1 && args.all !== true) {
        return { error: `that text appears ${occurrences} times in '${logical}' — include more context, or set \`all\`` };
      }
      const content = args.all === true ? read.text.split(oldText).join(newText) : read.text.replace(oldText, newText);
      const replaced = args.all === true ? occurrences : 1;

      try {
        // The agent's own folder: changed where it is, as a write there is (`writeOwn`).
        if (own !== undefined) {
          writeFileSync(own, content, "utf8");
          seenOf(options).saw(options.vars.taskId, own, content);
          return { path: raw, replaced, bytes: Buffer.byteLength(content, "utf8") };
        }
        const { record, physicalPath } = place(options, destination, options.vars.taskId, logical, content, now());
        if (physicalPath !== undefined) {
          mkdirSync(dirname(physicalPath), { recursive: true });
          writeFileSync(physicalPath, content, "utf8");
        }
        store.put(record);
        // What the agent edited it knows: a write of it after is not of a file it has not read.
        seenOf(options).saw(options.vars.taskId, fileOf(root, logical), content);
        return { path: logical, replaced, bytes: record.bytes };
      } catch (e) {
        if (e instanceof DestinationError) return { error: e.message };
        return { error: `could not write '${logical}': ${(e as Error).message}` };
      }
    },
  } as Tool;
}

/** Register the file tools on a registry's `tools` facet. */
export function registerFileTools(registry: { tools: Map<string, Tool> }, options: FileToolOptions): void {
  registry.tools.set(WRITE_FILE, createWriteFileTool(options));
  registry.tools.set(READ_FILE, createReadFileTool(options));
  registry.tools.set(EDIT_FILE, createEditFileTool(options));
  registry.tools.set(SHOW_ARTIFACT, createShowArtifactTool(options));
}
