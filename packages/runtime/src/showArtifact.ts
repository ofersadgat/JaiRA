/**
 * `show_artifact` — Claude Code's `Artifact` tool, answered by JaiRA (decision 0020 §1–§2).
 *
 * The model publishes what it made: a page (`.html`, `.htm`), a Markdown document, or a design canvas
 * (`project/canvas.json` and one `.dc.html` per artboard). It writes the files first, with whatever file
 * tool it has, and this reads them, so the call shape is Claude Code's own — `action`, `file_path`,
 * `root`, `files`, `url`, `type_url`, `asset` — because the Design type's instructions are passed to the
 * model word for word (`$SYSTEM/artifact-types/design/`) and they name it. Nothing is uploaded anywhere:
 * every publish is a version in the task's artifact store, and JaiRA draws it.
 *
 * ## What it answers
 *
 * For a canvas, the Design type's own answers, as Claude Code's tool gave them in the run they were
 * read from: `quickstart-result.md`, `created-result.md` (which carries the type's instructions),
 * `updated-result.md`. Only their per-canvas values are filled in. Everything else — a page's publish,
 * a read, a list, a refusal — is JaiRA's own wording: no run has shown Claude's for those.
 *
 * Each answer is `{ answer, artifact }`: `answer` is what the model reads; `artifact` is what the
 * conversation draws, so the transcript need not parse prose.
 *
 * ## Whose edit wins
 *
 * A person edits a canvas in JaiRA's editor, and each save is a version marked theirs. A publish that
 * would overwrite a file a person saved since this conversation last saw the artifact is refused and
 * names the files to read again — what claude.ai does, and what the instructions tell the model to
 * expect ("a publish over their edit is refused and names the file to re-read").
 */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecServices, JsonValue, Tool } from "@declarative-ai/exec";
import { defaultBuiltInDir, extensionForMime, isTextMime, mediaKindOf, mimeOfPath } from "@jaira/shared";
import { filesAt, MemoryArtifactStore, type ArtifactKind, type ArtifactStore, type ArtifactVersion } from "./artifacts";
import { parseDestination, resolveDestination, withinWorkspace } from "./artifactPath";
import type { FileToolOptions } from "./fileTools";
import { isDeniedPath } from "./policy";

/** The Design type's address, as its instructions name it — accepted as `type_url` and answered as JaiRA's own type. */
export const DESIGN_TYPE_URL = "https://claude.ai/artifact/QKN21svewxgyPb6SYRqWnd";
/** The Design System type, which the instructions may `list`: JaiRA has none, so it lists none. */
const DESIGN_SYSTEM_TYPE_URL = "https://claude.ai/artifact/5M7UeXXcx16TP3vzVFNDzd";

/** Claude Code's limits (code.claude.com/docs/en/artifacts, and the Design instructions' "One call holds 16 MB, a canvas 512 files and 256 MB"). */
const PAGE_MAX_BYTES = 16 * 1024 * 1024;
const CALL_MAX_BYTES = 16 * 1024 * 1024;
const CANVAS_MAX_FILES = 512;
const CANVAS_MAX_BYTES = 256 * 1024 * 1024;

export interface ShowArtifactOptions extends FileToolOptions {
  /** Where `artifact-types/design/` is read from. Defaults to the built-in layer. */
  builtInDir?: string;
  /** Mints an artifact's id. Defaults to `a-` and ten random base-36 characters. */
  mintId?: () => string;
  /** How an `https://` source is fetched. Injected in tests; the platform `fetch` otherwise. */
  fetch?: typeof globalThis.fetch;
  /** How long a fetch may take. 30 s, as `web_fetch`'s. */
  fetchTimeoutMs?: number;
}

/**
 * What the conversation draws for a call: which artifact, at which version. Never its files — the
 * model reads those with `action: "read"`, and handing them back on every publish would let a state
 * that holds this tool but not `read_file` read any file by publishing it. The window reads the files
 * from the store.
 */
export interface ShownArtifact {
  url: string;
  id: string;
  version: number;
  kind: ArtifactKind;
  type?: string;
  title?: string;
  icon?: string;
  entry: string;
}

/** `artifact://<task>/@<id>`: the `@` keeps a published artifact apart from a logical path in the same task. */
export const artifactUrl = (taskId: string, id: string): string => `artifact://${taskId}/@${id}`;

/** The artifact a `url` names in this task: its own form, or a bare id. */
export function artifactIdOf(url: string, taskId: string): string | undefined {
  const own = /^artifact:\/\/([^/]+)\/@([A-Za-z0-9_-]+)$/.exec(url.trim());
  if (own !== null) return own[1] === taskId ? own[2] : undefined;
  return /^a-[A-Za-z0-9_-]+$/.test(url.trim()) ? url.trim() : undefined;
}

class Refusal extends Error {}

/** Decode a file as Claude Code does: UTF-8, or little-endian UTF-16 by its byte-order mark; refused with a line and column otherwise. */
function decodeText(bytes: Buffer, name: string): string {
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = bytes.subarray(2).toString("utf16le");
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      // Find where it stops being UTF-8, for the line and column the model is told to fix.
      const lenient = new TextDecoder("utf-8").decode(bytes);
      throw new Refusal(`Not published: ${name} is not UTF-8 text (${where(lenient, lenient.indexOf("�"))}). Write it again as UTF-8.`);
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  }
  const bad = text.indexOf("�");
  if (bad >= 0) throw new Refusal(`Not published: ${name} holds the replacement character U+FFFD (${where(text, bad)}). Write the real character there and publish again.`);
  return text;
}

/** Text already decoded — kept by `write_file`, or sent in the call itself — held to the rule a file's text is. */
function inlineText(text: string, name: string): { text: string; bytes: number } {
  const bad = text.indexOf("�");
  if (bad >= 0) throw new Refusal(`Not published: ${name} holds the replacement character U+FFFD (${where(text, bad)}). Write the real character there and publish again.`);
  return { text, bytes: Buffer.byteLength(text, "utf8") };
}

function where(text: string, at: number): string {
  const before = text.slice(0, Math.max(0, at));
  const line = before.split("\n").length;
  const column = at - before.lastIndexOf("\n");
  return `line ${line}, column ${column}`;
}

/** A page's title: its `<title>` in the first 8 KB, which beats the call's. */
function titleOf(text: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text.slice(0, 8192));
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title !== undefined && title.length > 0 ? title : undefined;
}

/** A canvas path the instructions allow: under `project/`, no climbing, no backslashes, no leading slash. */
function canvasPathOk(path: string): boolean {
  if (!path.startsWith("project/")) return false;
  if (path.includes("\\") || path.includes("//")) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(segment));
}

const quoted = (paths: readonly string[]): string => [...paths].sort().map((p) => `"${p}"`).join(", ");

/**
 * JaiRA's one paragraph after the Design type's own answer, which is kept word for word: the type's
 * instructions have the model write every file before it publishes it, and a conversation that may not
 * write anywhere (read-only) could then never draw. JaiRA's publish takes a file's text in the call.
 */
export const inlineCanvasNote = (url: string): string =>
  `(In JaiRA a publish can carry each file's text itself, so nothing need be written first — the way to go when you cannot write files, and fine whenever: \`{ "url": "${url}", "files": { "project/canvas.json": { "content": "<its whole text>" }, "project/Main.dc.html": { "content": "<its whole text>" } } }\`, with no \`root\` or \`file_path\`. The order and the rules above stand: the index first, then one artboard per call. Each publish keeps the files earlier ones sent; to change a file, read it (\`action: "read"\`, \`url\`, \`path\`) unless you sent it in this conversation, and send its new whole text.)`;

/** A `files` value that carries a file's text itself — `{ content }` — rather than naming a file to read. */
function inlineContentOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const content = (value as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

/**
 * The files one `show_artifact` call READS from disk, as the call names them: what the gate judges at
 * `read_file`'s line, file by file (decision 0020, amended 2026-11-05) — a publish shows a person the
 * bytes of a file, so it may publish exactly the files the conversation may read, and no fixed list of
 * folders decides that. `file_path` unless the call carries `content`; each `files` entry that names a
 * file — absolute, or under `root` — and none that carries its text. Nothing for a read, a list, a
 * quickstart or a new canvas, which read no file.
 */
export function publishedReadsOf(input: unknown): string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  const args = input as Record<string, unknown>;
  const action = typeof args["action"] === "string" && args["action"].length > 0 ? args["action"] : "publish";
  if (action !== "publish") return [];
  if (typeof args["type_url"] === "string" && args["type_url"].length > 0) return [];
  const reads: string[] = [];
  // Each source `artifacts` names on disk: a path, or a `file://` URI read as the path it names.
  for (const item of showItemsOf(args["artifacts"]) ?? []) {
    const at = sourceReadOf(item.source);
    if (at?.tool === "read_file") reads.push(at.path);
  }
  if (typeof args["file_path"] === "string" && args["file_path"].length > 0 && typeof args["content"] !== "string") reads.push(args["file_path"]);
  const root = typeof args["root"] === "string" && args["root"].length > 0 ? args["root"].replace(/[\\/]+$/, "") : undefined;
  const files = args["files"];
  if (Array.isArray(files)) {
    for (const f of files) if (typeof f === "string" && f.length > 0) reads.push(f);
  } else if (files !== null && typeof files === "object") {
    for (const at of Object.values(files as Record<string, unknown>)) {
      if (typeof at !== "string" || at.length === 0) continue;
      reads.push(isAbsolute(at) || root === undefined ? at : `${root}/${at.replace(/\\/g, "/")}`);
    }
  }
  return [...new Set(reads)];
}

/**
 * The web addresses one `show_artifact` call FETCHES (`https://…` sources in `artifacts`): what the gate
 * judges at `web_fetch`'s line, address by address — showing a page off the web is fetching it.
 */
export function publishedFetchesOf(input: unknown): string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  const args = input as Record<string, unknown>;
  if (typeof args["action"] === "string" && args["action"].length > 0 && args["action"] !== "publish") return [];
  const urls: string[] = [];
  for (const item of showItemsOf(args["artifacts"]) ?? []) {
    const at = sourceReadOf(item.source);
    if (at?.tool === "web_fetch") urls.push(at.url);
  }
  return [...new Set(urls)];
}

/**
 * A file `show_artifact` shows the person (2026-11-13), however it is named: a path (absolute, or from the
 * workspace), a URI — `file://`, `https://`, `artifact://<task>/@<id>[/<path in it>]`, `data:` — or its
 * bytes sent in the call, typed by `name` (its extension) or `mimeType`.
 */
export type ArtifactSource = string | { data: string; encoding?: "utf8" | "base64"; name?: string; mimeType?: string };

/** One thing a call shows, and the line written above it (under its tile, in a gallery). */
export interface ShowItem {
  source: ArtifactSource;
  caption?: string;
}

const isInlineSource = (value: unknown): value is { data: string; encoding?: unknown; name?: unknown; mimeType?: unknown } =>
  value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as { data?: unknown }).data === "string";

/**
 * `artifacts` as a list of items: one source, a list of them, or a list of `{ artifact, caption }`.
 * `undefined` when the call does not use it; an empty list for one that names nothing showable.
 */
export function showItemsOf(raw: unknown): ShowItem[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const one = (value: unknown): ShowItem | undefined => {
    if (typeof value === "string") return value.trim().length > 0 ? { source: value.trim() } : undefined;
    if (isInlineSource(value)) return { source: value as ArtifactSource };
    if (value !== null && typeof value === "object" && !Array.isArray(value) && "artifact" in value) {
      const inner = one((value as { artifact: unknown }).artifact);
      const caption = (value as { caption?: unknown }).caption;
      return inner === undefined ? undefined : { ...inner, ...(typeof caption === "string" && caption.trim().length > 0 ? { caption: caption.trim() } : {}) };
    }
    return undefined;
  };
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(one).filter((item): item is ShowItem => item !== undefined);
}

/** What showing a source reads, for the gate: a file at `read_file`'s line, an address at `web_fetch`'s. Nothing for data sent in the call or an artifact of this task. */
export function sourceReadOf(source: ArtifactSource): { tool: "read_file"; path: string } | { tool: "web_fetch"; url: string } | undefined {
  if (typeof source !== "string") return undefined;
  if (/^https?:\/\//i.test(source)) return { tool: "web_fetch", url: source };
  if (/^file:\/\//i.test(source)) {
    try {
      return { tool: "read_file", path: fileURLToPath(source) };
    } catch {
      return undefined;
    }
  }
  if (/^(artifact|data):/i.test(source)) return undefined;
  return { tool: "read_file", path: source };
}

/** A shown file's text, or its bytes as a `data:` URI: what its one file holds in the store. */
const dataUri = (mime: string, bytes: Buffer): string => `data:${mime};base64,${bytes.toString("base64")}`;

/** The type before its parameters (`text/html; charset=utf-8` → `text/html`), lower-cased. */
const bareMime = (mime: string): string => mime.split(";")[0]!.trim().toLowerCase();

/** The magic numbers of the pictures a file without a telling name may still be. */
function sniffedMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 5 && bytes.toString("latin1", 0, 5) === "%PDF-") return "application/pdf";
  return undefined;
}

/** What JaiRA can draw, in the words a refusal names it with. */
const SHOWN_KINDS = "pictures, clips and tracks, pages, Markdown, code, data (JSON, YAML, TOML, CSV), diffs, and any text";

export function createShowArtifactTool(options: ShowArtifactOptions): Tool {
  const store: ArtifactStore = options.store ?? new MemoryArtifactStore();
  const now = options.now ?? Date.now;
  const typeDir = join(options.builtInDir ?? defaultBuiltInDir(), "artifact-types", "design");
  const mintId = options.mintId ?? ((): string => `a-${BigInt(`0x${randomBytes(8).toString("hex")}`).toString(36).slice(0, 10)}`);
  /** The version of each artifact this conversation last wrote or read: what a person's later save is measured against. */
  const seen = new Map<string, number>();

  const typeFile = (name: string): string | undefined => {
    try {
      return readFileSync(join(typeDir, name), "utf8");
    } catch {
      return undefined;
    }
  };

  /**
   * The task's own artifact folder (`$CENTRAL`), the one place under `.jaira/` a publish may read: what
   * this task's tools wrote there (a screenshot) is the task's own to show.
   */
  const ownArtifactFolder = (): string | undefined => {
    const central = resolveDestination(parseDestination("$CENTRAL"), { ...options.vars, relPath: "x" }, "x");
    return central.path !== undefined ? resolvePath(dirname(central.path)) : undefined;
  };

  const workspaceRoot = (ctx?: ExecServices): string => resolvePath(ctx?.workspace?.root ?? options.cwd ?? options.vars.worktree);

  /**
   * A path as the publish names it: workspace-relative and `/`-separated when it is in the workspace
   * (the form `write_file` keeps it under), absolute otherwise.
   */
  const keyOf = (path: string, ctx?: ExecServices): string => {
    if (!isAbsolute(path)) return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    const full = resolvePath(path);
    const rel = relative(workspaceRoot(ctx), full);
    return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replace(/\\/g, "/") : full.replace(/\\/g, "/");
  };

  /**
   * Bytes from outside the workspace, read where they are. Whether this conversation may read them is
   * the permission set's to say, and the gate said so before the tool ran: it judges every file a
   * publish reads at `read_file`'s line ({@link publishedReadsOf}), so a publish shows exactly what a
   * read could. `.jaira/` is refused as `read_file` refuses it, but for this task's own artifact folder.
   */
  const refuseJaira = (full: string, name: string): void => {
    const own = ownArtifactFolder();
    const inOwn = own !== undefined && ((rel) => rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel))(relative(own, full));
    if (isDeniedPath(full) && !inOwn) throw new Refusal(`Not published: ${name} is inside .jaira/, which agents may not read.`);
  };

  const readOutside = (absolute: string, name: string): Buffer => {
    const full = resolvePath(absolute);
    refuseJaira(full, name);
    try {
      if (!statSync(full).isFile()) throw new Refusal(`Not published: ${name} is not a file.`);
      return readFileSync(full);
    } catch (e) {
      if (e instanceof Refusal) throw e;
      throw new Refusal(`Not published: ${name} could not be read (${(e as Error).message}). Write it first, then publish.`);
    }
  };

  /**
   * The text of a file the model wrote. A workspace path is read the way `read_file` reads it — through
   * the artifact map first — because that is where `write_file` put it: under a virtual or central
   * destination the bytes are not at the path the model knows them by. A path outside the workspace is
   * read from disk, from an allowed root only.
   */
  const readPublished = (path: string, name: string, ctx?: ExecServices): { text: string; bytes: number } => {
    const key = keyOf(path, ctx);
    if (isAbsolute(key)) {
      const bytes = readOutside(key, name);
      return { text: decodeText(bytes, name), bytes: bytes.length };
    }
    const record = store.get(options.vars.taskId, key);
    if (record?.content !== undefined) return inlineText(record.content, name);
    const target = record?.physicalPath ?? withinWorkspace(workspaceRoot(ctx), key);
    if (target === undefined) throw new Refusal(`Not published: ${name} is outside the workspace.`);
    if (record === undefined) refuseJaira(resolvePath(target), name);
    let bytes: Buffer;
    try {
      bytes = readFileSync(target);
    } catch (e) {
      throw new Refusal(`Not published: ${name} could not be read (${(e as Error).message}). Write it first, then publish.`);
    }
    return { text: decodeText(bytes, name), bytes: bytes.length };
  };

  /** An asset's raw bytes: the map's physical copy of a workspace path (else the path itself), or a file outside it. */
  const readAssetBytes = (path: string, name: string, ctx?: ExecServices): Buffer => {
    const key = keyOf(path, ctx);
    if (isAbsolute(key)) return readOutside(key, name);
    const kept = store.get(options.vars.taskId, key)?.physicalPath;
    const target = kept ?? join(workspaceRoot(ctx), key);
    if (kept === undefined) refuseJaira(resolvePath(target), name);
    try {
      return readFileSync(target);
    } catch (e) {
      throw new Refusal(`Not uploaded: ${name} could not be read (${(e as Error).message}).`);
    }
  };

  const shown = (version: ArtifactVersion): ShownArtifact => ({
    url: artifactUrl(version.taskId, version.artifact),
    id: version.artifact,
    version: version.version,
    kind: version.kind,
    ...(version.type !== undefined ? { type: version.type } : {}),
    ...(version.title !== undefined ? { title: version.title } : {}),
    ...(version.icon !== undefined ? { icon: version.icon } : {}),
    entry: version.entry,
  });

  /**
   * The files a person saved since this conversation last saw the artifact, among those about to be
   * published. What this conversation has not seen at all is measured from the newest version the model
   * made: a conversation that never wrote it, publishing over it, is building on the model's last copy.
   */
  const overwritesPerson = (taskId: string, id: string, paths: readonly string[]): string[] => {
    const versions = store.versions(taskId, id);
    const from = seen.get(id) ?? Math.max(0, ...versions.filter((v) => v.author === "model").map((v) => v.version));
    const touched = new Set<string>();
    for (const v of versions) {
      if (v.version <= from || v.author !== "person") continue;
      for (const path of Object.keys(v.changes)) if (paths.includes(path)) touched.add(path);
    }
    return [...touched].sort();
  };

  const quickstart = (): JsonValue => {
    const text = typeFile("quickstart-result.md");
    if (text === undefined) return { error: "Not available: JaiRA's Design type is missing its files (artifact-types/design)." };
    return { answer: text };
  };

  const createCanvas = (taskId: string, title: string): JsonValue => {
    const text = typeFile("created-result.md");
    if (text === undefined) return { error: "Not available: JaiRA's Design type is missing its files (artifact-types/design)." };
    const version = store.publish({
      taskId,
      artifact: mintId(),
      author: "model",
      kind: "canvas",
      type: "design",
      title,
      entry: "project/canvas.json",
      changes: {},
      createdAt: now(),
    });
    seen.set(version.artifact, version.version);
    const url = artifactUrl(taskId, version.artifact);
    return {
      answer: `${text.replaceAll("{{canvas_url}}", url).replaceAll("{{version_id}}", String(version.version)).trimEnd()}\n\n${inlineCanvasNote(url)}`,
      artifact: shown(version) as unknown as JsonValue,
    };
  };

  const publishCanvas = (
    taskId: string,
    id: string,
    args: { file_path?: unknown; root?: unknown; files?: unknown; force?: unknown; content?: unknown },
    ctx?: ExecServices,
  ): JsonValue => {
    const latest = store.versions(taskId, id).at(-1);
    if (latest === undefined || latest.kind !== "canvas") throw new Refusal(`Not published: there is no canvas at that url in this task.`);
    const root = typeof args.root === "string" && args.root.length > 0 ? keyOf(args.root, ctx).replace(/\/+$/, "") : undefined;
    // canvas path → the file as the publish names it, its text sent in the call (`{ content }`), or null: remove it.
    const wanted = new Map<string, string | null | { content: string }>();
    const canvasPathFor = (path: string): string => {
      const key = keyOf(path, ctx);
      if (root !== undefined && key.startsWith(`${root}/`)) return key.slice(root.length + 1);
      if (key.startsWith("project/")) return key;
      const at = key.lastIndexOf("/project/");
      if (at < 0) throw new Refusal(`Not published: give \`root\`, the folder holding \`project/\`.`);
      return key.slice(at + 1);
    };
    /** A `files` value is a path under `root`, unless it is absolute. */
    const underRoot = (at: string): string => (isAbsolute(at) || root === undefined ? at : `${root}/${at.replace(/\\/g, "/")}`);
    if (typeof args.file_path === "string" && args.file_path.length > 0) {
      wanted.set(canvasPathFor(args.file_path), typeof args.content === "string" ? { content: args.content } : args.file_path);
    }
    if (Array.isArray(args.files)) {
      for (const f of args.files) if (typeof f === "string") wanted.set(canvasPathFor(f), f);
    } else if (args.files !== null && typeof args.files === "object") {
      for (const [path, at] of Object.entries(args.files as Record<string, unknown>)) {
        const content = inlineContentOf(at);
        if (at === null) wanted.set(path, null);
        else if (typeof at === "string") wanted.set(path, underRoot(at));
        else if (content !== undefined) wanted.set(path, { content });
      }
    }
    if (wanted.size === 0) throw new Refusal(`Not published: no files were given (\`files\`, or \`file_path\`).`);
    // A file named anywhere is read where it is: the gate judged each at `read_file`'s line (`publishedReadsOf`).
    for (const path of wanted.keys()) {
      if (!canvasPathOk(path)) throw new Refusal(`Not published: \`${path}\` is not a path under \`project/\` (letters, digits, \`_\`, \`.\` and \`-\`, no \`..\`).`);
      if (path === "project/index.html" || path.startsWith("project/artifact-type/")) throw new Refusal(`Not published: \`${path}\` is one of the type's own files.`);
    }
    const conflict = args.force === true ? [] : overwritesPerson(taskId, id, [...wanted.keys()]);
    if (conflict.length > 0) {
      throw new Refusal(
        `Not published: someone saved ${quoted(conflict)} in this canvas since you last read or wrote it. Read each of them (\`action: "read"\`, \`url\`, \`path\`), redo your edit on what they hold now, and publish again. Nothing in this call was kept.`,
      );
    }
    const changes: Record<string, string | null> = {};
    let callBytes = 0;
    for (const [path, at] of wanted) {
      if (at === null) {
        changes[path] = null;
        continue;
      }
      const read = typeof at === "string" ? readPublished(at, `\`${path}\``, ctx) : inlineText(at.content, `\`${path}\``);
      callBytes += read.bytes;
      changes[path] = read.text;
    }
    if (callBytes > CALL_MAX_BYTES) throw new Refusal(`Not published: one call holds 16 MB, and this one is ${(callBytes / 1048576).toFixed(1)} MB. Send the files in several calls.`);
    const after = { ...filesAt(store, taskId, id) };
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) delete after[path];
      else after[path] = text;
    }
    const total = Object.values(after).reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
    if (Object.keys(after).length > CANVAS_MAX_FILES) throw new Refusal(`Not published: a canvas holds 512 files, and this would make it ${Object.keys(after).length}.`);
    if (total > CANVAS_MAX_BYTES) throw new Refusal(`Not published: a canvas holds 256 MB, and this would make it ${(total / 1048576).toFixed(0)} MB.`);
    const title = (() => {
      const index = after["project/canvas.json"];
      if (index === undefined) return latest.title;
      try {
        const parsed = JSON.parse(index) as { title?: unknown };
        return typeof parsed.title === "string" && parsed.title.length > 0 ? parsed.title : latest.title;
      } catch {
        return latest.title;
      }
    })();
    const version = store.publish({
      taskId,
      artifact: id,
      author: "model",
      kind: "canvas",
      type: "design",
      ...(title !== undefined ? { title } : {}),
      entry: "project/canvas.json",
      changes,
      ...(latest.capabilities !== undefined ? { capabilities: latest.capabilities } : {}),
      createdAt: now(),
    });
    seen.set(id, version.version);
    const text = typeFile("updated-result.md") ?? "Updated the Artifact at {{canvas_url}} (Version {{version}}).";
    const first = [...wanted.entries()].find(([, v]) => v !== null);
    const filePath = typeof args.file_path === "string" ? args.file_path : first === undefined ? "" : typeof first[1] === "string" ? first[1] : first[0];
    return {
      answer: text
        .replaceAll("{{canvas_url}}", artifactUrl(taskId, id))
        .replaceAll("{{version}}", String(version.version))
        .replaceAll("{{version_id}}", String(version.version))
        .replaceAll("{{file_path}}", filePath)
        .replaceAll("{{own_files}}", quoted(Object.keys(after))),
      artifact: shown(version) as unknown as JsonValue,
    };
  };

  /** An image or font a canvas names by `/_blob/<id>`: kept in the artifact as a data URI under `_blob/`. */
  const uploadAsset = (taskId: string, id: string, filePath: string, ctx?: ExecServices): JsonValue => {
    const bytes = readAssetBytes(filePath, `\`${basename(filePath)}\``, ctx);
    if (bytes.length > CALL_MAX_BYTES) throw new Refusal(`Not uploaded: one call holds 16 MB.`);
    const ext = extname(filePath).slice(1).toLowerCase();
    const mime =
      ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf", css: "text/css", js: "text/javascript", json: "application/json" } as Record<string, string>)[ext];
    if (mime === undefined) throw new Refusal(`Not uploaded: \`.${ext}\` is not an image, font, or .css/.js/.json file.`);
    const blob = createHash("sha256").update(bytes).digest("hex").slice(0, 24);
    const title = store.versions(taskId, id).at(-1)?.title;
    const version = store.publish({
      taskId,
      artifact: id,
      author: "model",
      kind: "canvas",
      type: "design",
      ...(title !== undefined ? { title } : {}),
      entry: "project/canvas.json",
      changes: { [`_blob/${blob}`]: `data:${mime};base64,${bytes.toString("base64")}` },
      createdAt: now(),
    });
    seen.set(id, version.version);
    return { answer: `Uploaded ${basename(filePath)}. Its url: /_blob/${blob} — use it verbatim where the file is named.`, url: `/_blob/${blob}` };
  };

  const publishPage = (taskId: string, args: { file_path?: unknown; content?: unknown; url?: unknown; title?: unknown; icon?: unknown; capabilities?: unknown; force?: unknown }, ctx?: ExecServices): JsonValue => {
    // Sent in the call: `content` is the page, and `file_path`, when given, only names it.
    const inline = typeof args.content === "string" ? args.content : undefined;
    const filePath = typeof args.file_path === "string" && args.file_path.length > 0 ? args.file_path : inline !== undefined ? "page.html" : "";
    if (filePath.length === 0) throw new Refusal(`Not published: give \`content\`, the page itself, or \`file_path\`, the page you wrote.`);
    const ext = extname(filePath).toLowerCase();
    if (![".html", ".htm", ".md"].includes(ext)) throw new Refusal(`Not published: a page is a .html, .htm or .md file, and ${basename(filePath)} is not.`);
    const name = basename(filePath.replace(/\\/g, "/"));
    const { text, bytes } = inline !== undefined ? inlineText(inline, name) : readPublished(filePath, name, ctx);
    if (bytes > PAGE_MAX_BYTES) throw new Refusal(`Not published: a page is at most 16 MiB, and ${name} is ${(bytes / 1048576).toFixed(1)} MiB. Images embedded as data URIs are the usual cause.`);
    const kind: ArtifactKind = ext === ".md" ? "markdown" : "page";
    // The same artifact: the one `url` names, else the page this conversation published from the same
    // file. A page sent in the call has no file to be the same as: without a `url` it is a new one.
    let id = typeof args.url === "string" && args.url.length > 0 ? artifactIdOf(args.url, taskId) : undefined;
    if (typeof args.url === "string" && args.url.length > 0 && id === undefined) throw new Refusal(`Not published: there is no artifact at ${args.url} in this task.`);
    if (id === undefined && inline === undefined) id = store.latest(taskId).find((v) => v.kind !== "canvas" && v.entry === name)?.artifact;
    if (id !== undefined && args.force !== true && overwritesPerson(taskId, id, [name]).length > 0) {
      throw new Refusal(`Not published: someone changed this page since you last published it. Read it (\`action: "read"\`, \`url\`), redo your edit on what it holds now, and publish again.`);
    }
    const title = kind === "page" ? titleOf(text) ?? (typeof args.title === "string" && args.title.length > 0 ? args.title : undefined) : undefined;
    const capabilities = args.capabilities !== null && typeof args.capabilities === "object" && !Array.isArray(args.capabilities) ? (args.capabilities as Record<string, unknown>) : undefined;
    const version = store.publish({
      taskId,
      artifact: id ?? mintId(),
      author: "model",
      kind,
      ...(title !== undefined ? { title } : {}),
      ...(typeof args.icon === "string" && args.icon.length > 0 ? { icon: args.icon } : {}),
      entry: name,
      changes: { [name]: text },
      ...(capabilities !== undefined ? { capabilities } : {}),
      createdAt: now(),
    });
    seen.set(version.artifact, version.version);
    const url = artifactUrl(taskId, version.artifact);
    const again = inline !== undefined ? "give this url with its new `content`" : "publish the same file_path again in this conversation, or give this url";
    return {
      answer:
        version.version === 1
          ? `Published ${name} as a new artifact at ${url} (version 1). It is shown in this conversation. To update it, ${again}.`
          : `Updated the artifact at ${url} (version ${version.version}) with ${name}. To update it again, ${again}.`,
      artifact: shown(version) as unknown as JsonValue,
    };
  };

  /**
   * One source, read: the key it is shown under (what showing it again matches — the path as the
   * workspace names it, the address, the artifact URI, or the name of data sent in the call), its name,
   * its type, and its bytes. `from` names where it came from when that was not this machine.
   */
  type Resolved = { key: string; name: string; mime: string; bytes: Buffer; from?: string } | { again: ArtifactVersion };

  const resolveSource = async (taskId: string, source: ArtifactSource, ctx?: ExecServices): Promise<Resolved> => {
    if (typeof source !== "string") {
      const named = typeof source.name === "string" && source.name.trim().length > 0 ? basename(source.name.trim().replace(/\\/g, "/")) : undefined;
      const declared = typeof source.mimeType === "string" && source.mimeType.length > 0 ? bareMime(source.mimeType) : undefined;
      if (named === undefined && declared === undefined) throw new Refusal(`Not shown: data sent in the call needs a \`name\` (its extension says what it is) or a \`mimeType\`.`);
      const bytes = source.encoding === "base64" ? Buffer.from(source.data, "base64") : Buffer.from(source.data, "utf8");
      const mime = declared ?? mimeOfPath(named!);
      const name = named ?? `shown.${extensionForMime(mime) ?? "txt"}`;
      return { key: name, name, mime, bytes };
    }
    const data = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(source);
    if (data !== null) {
      const mime = bareMime(data[1]! || "text/plain");
      const bytes = /;base64/i.test(data[2]!) ? Buffer.from(data[3]!, "base64") : Buffer.from(decodeURIComponent(data[3]!), "utf8");
      const name = `shown.${extensionForMime(mime) ?? "txt"}`;
      return { key: name, name, mime, bytes };
    }
    if (/^artifact:\/\//i.test(source)) {
      const at = /^artifact:\/\/([^/]+)\/@([A-Za-z0-9_-]+)(?:\/(.+))?$/.exec(source) ?? /^artifact:\/\/()(a-[A-Za-z0-9_-]+)(?:\/(.+))?$/.exec(source);
      if (at === null || (at[1] !== "" && at[1] !== taskId)) throw new Refusal(`Not shown: ${source} is not an artifact of this task.`);
      const id = at[2]!;
      const latest = store.versions(taskId, id).at(-1);
      if (latest === undefined) throw new Refusal(`Not shown: there is no artifact at ${source} in this task.`);
      // The artifact itself, as it is now: its newest version, shown again with no new one made.
      if (at[3] === undefined) return { again: latest };
      const path = decodeURIComponent(at[3]).replace(/^\/+/, "");
      const held = filesAt(store, taskId, id)[path];
      if (held === undefined) throw new Refusal(`Not shown: ${artifactUrl(taskId, id)} has no file ${path}.`);
      const inner = /^data:([^;,]+);base64,(.*)$/s.exec(held);
      const mime = inner !== null ? bareMime(inner[1]!) : mimeOfPath(path);
      return { key: `${artifactUrl(taskId, id)}/${path}`, name: basename(path), mime, bytes: inner !== null ? Buffer.from(inner[2]!, "base64") : Buffer.from(held, "utf8"), from: latest.title ?? latest.entry };
    }
    if (/^https?:\/\//i.test(source)) return fetchSource(source, ctx);
    const read = sourceReadOf(source);
    if (read?.tool !== "read_file") throw new Refusal(`Not shown: ${source} names no file.`);
    const key = keyOf(read.path, ctx);
    const name = basename(key);
    const bytes = readShownBytes(key, name, ctx);
    return { key, name, mime: mimeOfPath(name), bytes };
  };

  /** A file's bytes as `show_artifact` reads them: the artifact map's copy of a workspace path (else the path itself), or a file outside it. */
  const readShownBytes = (key: string, name: string, ctx?: ExecServices): Buffer => {
    if (isAbsolute(key)) return readOutside(key, name);
    const record = store.get(options.vars.taskId, key);
    if (record?.physicalPath === undefined && record?.content !== undefined) return Buffer.from(record.content, "utf8");
    const target = record?.physicalPath ?? withinWorkspace(workspaceRoot(ctx), key);
    if (target === undefined) throw new Refusal(`Not shown: ${name} is outside the workspace.`);
    if (record === undefined) refuseJaira(resolvePath(target), name);
    try {
      if (!statSync(target).isFile()) throw new Refusal(`Not shown: ${name} is not a file.`);
      return readFileSync(target);
    } catch (e) {
      if (e instanceof Refusal) throw e;
      throw new Refusal(`Not shown: ${name} could not be read (${(e as Error).message}).`);
    }
  };

  /** A page or file off the web, fetched once and kept as fetched: the gate judged the address at `web_fetch`'s line. */
  const fetchSource = async (url: string, ctx?: ExecServices): Promise<Resolved> => {
    const doFetch = options.fetch ?? globalThis.fetch;
    const clock = new AbortController();
    const timer = setTimeout(() => clock.abort(), options.fetchTimeoutMs ?? 30_000);
    const cancel = (): void => clock.abort();
    const signal = (ctx as { signal?: AbortSignal } | undefined)?.signal;
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const res = await doFetch(url, { signal: clock.signal, redirect: "follow" });
      if (!res.ok) throw new Refusal(`Not shown: ${url} answered ${res.status}${res.statusText.length > 0 ? ` ${res.statusText}` : ""}.`);
      const length = Number(res.headers.get("content-length") ?? "0");
      if (length > PAGE_MAX_BYTES) throw new Refusal(`Not shown: ${url} is ${(length / 1048576).toFixed(1)} MiB, and a file shown is at most 16 MiB.`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const path = new URL(res.url.length > 0 ? res.url : url).pathname;
      const last = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
      const declared = bareMime(res.headers.get("content-type") ?? "");
      const byName = last.length > 0 ? mimeOfPath(last) : undefined;
      // What the server says, unless it says nothing useful: then the name's, then the bytes'.
      const mime = declared.length > 0 && declared !== "application/octet-stream" ? declared : byName !== undefined && byName !== "text/plain" ? byName : (sniffedMime(bytes) ?? byName ?? "text/plain");
      const ext = extensionForMime(mime);
      const name = last.length > 0 && (extname(last).length > 0 || ext === undefined) ? last : `${last.length > 0 ? last : new URL(url).hostname}.${ext}`;
      return { key: url.replace(/#.*$/, ""), name, mime, bytes, from: new URL(url).hostname };
    } catch (e) {
      if (e instanceof Refusal) throw e;
      const reason = (e as Error).name === "AbortError" ? "it timed out or was cancelled" : (e as Error).message;
      throw new Refusal(`Not shown: ${url} could not be fetched (${reason}).`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  };

  /**
   * What a resolved source is shown AS, by its type alone: a page (it runs in its frame), a Markdown
   * document, or a file, whose view the window picks from the same list a tool's result gets — a
   * picture, a clip or a track kept as a `data:` URI, anything that is text as its text. A type none of
   * those draws (a PDF, an archive, a Word file) is refused, and so are bytes that claim to be text and
   * are not.
   */
  const shapeOf = (resolved: { name: string; mime: string; bytes: Buffer }): { kind: ArtifactKind; text: string } => {
    const { name } = resolved;
    let mime = resolved.mime;
    if (mime === "text/plain" || mime === "application/octet-stream") mime = sniffedMime(resolved.bytes) ?? mime;
    const ext = extname(name).toLowerCase();
    if (mime === "text/html" || ext === ".html" || ext === ".htm") return { kind: "page", text: decodeText(resolved.bytes, name) };
    if (mime === "text/markdown" || ext === ".md") return { kind: "markdown", text: decodeText(resolved.bytes, name) };
    if (mediaKindOf(mime) !== undefined && mime !== "image/svg+xml") return { kind: "file", text: dataUri(mime, resolved.bytes) };
    if (isTextMime(mime) || mime === "application/octet-stream") {
      try {
        return { kind: "file", text: decodeText(resolved.bytes, name) };
      } catch {
        // Not text after all: refused below as a type with no view.
      }
    }
    throw new Refusal(`Not shown: JaiRA has no view for ${name} (${mime === "text/plain" ? "binary" : mime}). It shows ${SHOWN_KINDS}. Name the file in your answer instead.`);
  };

  /**
   * Show the person what `artifacts` names (2026-11-13), each source as one artifact: shown again —
   * the same path, address or URI, or data under the same name — it is that artifact's next version.
   * What can be shown is shown; what cannot comes back in `refused` with why, and only a call that
   * showed nothing fails.
   */
  const showSources = async (taskId: string, items: readonly ShowItem[], caption: string | undefined, ctx?: ExecServices): Promise<JsonValue> => {
    if (items.length === 0) return { error: "Not shown: `artifacts` names nothing — give a path, a URI, or `{ data, name }`." };
    const shownItems: JsonValue[] = [];
    const refused: Array<{ source: string; why: string }> = [];
    const lines: string[] = [];
    let callBytes = 0;
    for (const item of items) {
      const label = typeof item.source === "string" ? (item.source.startsWith("data:") ? `${item.source.slice(0, 32)}…` : item.source) : `{ data, name: ${JSON.stringify(item.source.name ?? item.source.mimeType ?? "")} }`;
      try {
        const resolved = await resolveSource(taskId, item.source, ctx);
        if ("again" in resolved) {
          const latest = resolved.again;
          seen.set(latest.artifact, latest.version);
          shownItems.push({ ...(shown(latest) as unknown as Record<string, JsonValue>), source: label, ...(item.caption !== undefined ? { caption: item.caption } : {}) });
          lines.push(`- ${label}: ${artifactUrl(taskId, latest.artifact)}, version ${latest.version}, as it is now.`);
          continue;
        }
        if (resolved.bytes.length > PAGE_MAX_BYTES) throw new Refusal(`Not shown: ${resolved.name} is ${(resolved.bytes.length / 1048576).toFixed(1)} MiB, and a file shown is at most 16 MiB.`);
        callBytes += resolved.bytes.length;
        if (callBytes > CALL_MAX_BYTES * 4) throw new Refusal(`Not shown: one call shows at most 64 MiB; show the rest in another call.`);
        const shape = shapeOf(resolved);
        // A page or a document keeps the name it is served by, as one published from a file does today;
        // any other file keeps its source, which is what showing it again names.
        const entry = shape.kind === "file" ? resolved.key : resolved.name;
        const id = store.latest(taskId).find((v) => v.kind === shape.kind && v.entry === entry)?.artifact;
        if (id !== undefined && overwritesPerson(taskId, id, [entry]).length > 0) {
          throw new Refusal(`Not shown: someone changed ${resolved.name} since you last showed it. Read it (\`action: "read"\`, \`url\`: ${artifactUrl(taskId, id)}) and show it again.`);
        }
        const title = shape.kind === "page" ? (titleOf(shape.text) ?? resolved.name) : resolved.name;
        const version = store.publish({
          taskId,
          artifact: id ?? mintId(),
          author: "model",
          kind: shape.kind,
          title,
          entry,
          changes: { [entry]: shape.text },
          createdAt: now(),
        });
        seen.set(version.artifact, version.version);
        shownItems.push({
          ...(shown(version) as unknown as Record<string, JsonValue>),
          source: label,
          ...(resolved.from !== undefined ? { from: resolved.from } : {}),
          ...(item.caption !== undefined ? { caption: item.caption } : {}),
        });
        lines.push(`- ${label}: ${artifactUrl(taskId, version.artifact)}, version ${version.version}${version.version === 1 ? " (new)" : ""}.`);
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        refused.push({ source: label, why: e.message });
      }
    }
    if (shownItems.length === 0) return { error: refused.map((r) => r.why).join("\n") };
    const answer = [
      `Shown in this conversation:`,
      ...lines,
      ...(refused.length > 0 ? [`Not shown:`, ...refused.map((r) => `- ${r.source}: ${r.why}`)] : []),
      `To show a new version, show the same source again.`,
    ].join("\n");
    return { answer, ...(caption !== undefined ? { caption } : {}), shown: shownItems, refused: refused as unknown as JsonValue };
  };

  const read = (taskId: string, args: { url?: unknown; path?: unknown }): JsonValue => {
    const path = typeof args.path === "string" ? args.path.replace(/^\/+/, "") : "";
    // The type's own files: what JaiRA has of them, verbatim.
    if (path === "SKILL.md" || path.startsWith("artifact-type/")) {
      const local = path === "SKILL.md" ? "SKILL.md" : path.replace(/^artifact-type\//, "");
      const text = typeFile(local);
      if (text === undefined) return { error: `Not available: JaiRA does not have the Design type's ${path} — carry on without it.` };
      return { answer: `${path}:\n${text}`, path, content: text };
    }
    const id = typeof args.url === "string" ? artifactIdOf(args.url, taskId) : undefined;
    if (id === undefined) return { error: `Not read: give the \`url\` of an artifact in this task.` };
    const versions = store.versions(taskId, id);
    const latest = versions.at(-1);
    if (latest === undefined) return { error: `Not read: there is no artifact at ${String(args.url)} in this task.` };
    const files = filesAt(store, taskId, id);
    seen.set(id, latest.version);
    if (path.length === 0) {
      const own = Object.keys(files).filter((p) => !p.startsWith("_blob/")).sort();
      return { answer: `${artifactUrl(taskId, id)} is at version ${latest.version}. Its own files: ${quoted(own)}.`, artifact: shown(latest) as unknown as JsonValue };
    }
    const text = files[path] ?? (latest.kind !== "canvas" ? files[latest.entry] : undefined);
    if (text === undefined) return { error: `Not read: ${artifactUrl(taskId, id)} has no file ${path}.` };
    return { answer: `${path} at version ${latest.version}:\n${text}`, path, content: text, version: latest.version };
  };

  const list = (taskId: string, args: { type?: unknown; scope?: unknown; limit?: unknown }): JsonValue => {
    if (typeof args.type === "string" && args.type.length > 0) {
      if (args.type === "Design System" || args.type === DESIGN_SYSTEM_TYPE_URL) {
        return { answer: `No Artifacts made from the type "Design System" (${DESIGN_SYSTEM_TYPE_URL}) that this user can open are listed — carry on without one.` };
      }
      if (args.type !== "Design" && args.type !== DESIGN_TYPE_URL) return { answer: `No Artifact type "${args.type}" is listed.` };
    }
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 25;
    const rows = store
      .latest(taskId)
      .filter((v) => typeof args.type !== "string" || v.type === "design")
      .slice(-limit)
      .reverse();
    if (rows.length === 0) return { answer: "No artifacts in this task yet." };
    return {
      answer: rows.map((v) => `- ${v.title ?? v.entry} (mine) — ${v.kind}, version ${v.version} — ${artifactUrl(taskId, v.artifact)}`).join("\n"),
    };
  };

  return {
    description:
      "Show the person a file, and the Artifact tool (wherever instructions name `Artifact` or 'your Artifact tool', they mean this one). When you want the person to see a file — a screenshot, a picture, a page, a log, a diff, a table — show it with `artifacts`; don't name a path for them to go and open. `artifacts` is one source or a list, each a path (absolute, or from the workspace), a URI (`file://…`, `https://…` fetched once, `artifact://<task>/@<id>` or with `/<path in it>` for one of its files, `data:<type>;base64,…`), or `{ data, encoding?: \"utf8\" | \"base64\", name?, mimeType? }` sent in the call, typed by `name` (its extension) or `mimeType`; or a list of `{ artifact: <source>, caption }`. `caption` is a line over what is shown. Any type is taken: pictures, clips and tracks, pages, Markdown, code, data (JSON, YAML, TOML, CSV), diffs and any text are drawn; a type none of those draws (a PDF, an archive) is refused with why. Several pictures in one call are shown side by side. Showing the same source again is its next version. The answer lists each one's `url` and version, and what was refused. Beside showing files, it publishes what you made: a page (`.html`, `.htm`), a Markdown document (`.md`), or a design canvas. Give the text in the call — `content` for a page (with `file_path` only to name it, `notes.md` for Markdown), or `files: { \"project/<path>\": { \"content\": \"…\" } }` for a canvas's files — or write the file first and publish it with `file_path` (its absolute path). Sending the text needs no file and no write permission. A file you publish must be one you may read. The page is shown in the conversation and every publish is a new version of the same artifact: to update one, give its `url` (or, for a page from a file, publish the same `file_path` again in this conversation); `action: \"read\"` gives back what it holds now. A page is one self-contained file: it may load fonts from Google Fonts and scripts from cdnjs, unpkg, cdn.tailwindcss.com, code.jquery.com and cdn.jsdelivr.net/npm/, and nothing else — inline other CSS and JavaScript, embed images as data URIs, use in-page anchors (relative links do not resolve); at most 16 MiB. The page's `<title>` names it. When the person wants a design or a mock-up, in whatever words and whether or not they typed `/design`, your first call is `action: \"quickstart\"` with `intent: \"design\"`, before you write any file, and then you do what it answers: the result is a design canvas, which the person can edit. A page or a Markdown document is for what is not a design. `action: \"read\"` reads an artifact (`url`, and `path` for one of a canvas's files); `action: \"list\"` lists this task's artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["publish", "read", "list", "quickstart"], description: "Omit (or 'publish') to show `artifacts` or publish `file_path`. 'read' reads an artifact; 'list' lists them; 'quickstart' starts a design." },
        artifacts: {
          description:
            "What to show the person: one source, a list of them, or a list of `{ artifact, caption }`. A source is a path or a URI (file://, https://, artifact://<task>/@<id>[/<path>], data:) as a string, or `{ data, encoding?, name?, mimeType? }`.",
          anyOf: [
            { type: "string" },
            { type: "object", properties: { data: { type: "string" }, encoding: { type: "string", enum: ["utf8", "base64"] }, name: { type: "string" }, mimeType: { type: "string" } }, required: ["data"] },
            {
              type: "array",
              items: {
                anyOf: [
                  { type: "string" },
                  { type: "object", properties: { data: { type: "string" }, encoding: { type: "string", enum: ["utf8", "base64"] }, name: { type: "string" }, mimeType: { type: "string" } }, required: ["data"] },
                  { type: "object", properties: { artifact: { anyOf: [{ type: "string" }, { type: "object", properties: { data: { type: "string" }, encoding: { type: "string", enum: ["utf8", "base64"] }, name: { type: "string" }, mimeType: { type: "string" } }, required: ["data"] }] }, caption: { type: "string" } }, required: ["artifact"] },
                ],
              },
            },
          ],
        },
        caption: { type: "string", description: "One line written over what is shown." },
        file_path: { type: "string", description: "The absolute path of the file to publish (a page, or one of a canvas's files). With `content`, it only names the page (or the canvas path)." },
        content: { type: "string", description: "The page's whole text, sent in the call instead of written to a file." },
        root: { type: "string", description: "A canvas: the folder holding `project/`." },
        files: {
          description:
            "A canvas: the files of this publish, by their `project/…` paths → `{ \"content\": \"<the file's whole text>\" }`, or their path under `root`, or null to remove one; or a list of absolute paths.",
          anyOf: [
            {
              type: "object",
              additionalProperties: { anyOf: [{ type: "string" }, { type: "null" }, { type: "object", properties: { content: { type: "string" } }, required: ["content"] }] },
            },
            { type: "array", items: { type: "string" } },
          ],
        },
        url: { type: "string", description: "The artifact to update or read." },
        type_url: { type: "string", description: "Make a new artifact of this type (the design canvas)." },
        title: { type: "string", description: "The artifact's name; a page's own `<title>` wins over it." },
        icon: { type: "string", description: "What the page is, for its glyph: chart, table, calendar, document, diagram, map, list, image, code, slides, form, timeline." },
        intent: { type: "string", description: "quickstart: 'design'." },
        auto_open: { type: "string", description: "Accepted; JaiRA shows every artifact in the conversation as it is published." },
        asset: { type: "boolean", description: "Upload `file_path` (an image or font) to the canvas `url`; answered with its `/_blob/<id>` url." },
        path: { type: "string", description: "read: one file of the artifact." },
        capabilities: {
          type: "object",
          description:
            "Runtime capabilities the page declares. `{ \"downloads\": {} }` lets it offer files to save: a page cannot start a download itself, so its download control posts `window.parent.postMessage({ type: \"download\", name: \"table.csv\", data: <the file's text, or its bytes in base64 with base64: true> }, \"*\")` and the person chooses where it goes.",
        },
        force: { type: "boolean", description: "Publish over a version someone else saved since you last read it. Only when the user asks." },
        scope: { type: "string", description: "list: accepted; JaiRA lists this task's artifacts." },
        limit: { type: "number", description: "list: at most this many (default 25)." },
        type: { type: "string", description: "list: only artifacts of this type ('Design', 'Design System')." },
        design_systems: { type: "boolean", description: "quickstart: accepted; JaiRA has no design systems." },
      },
    },
    // Nothing that was already there is different afterwards: it reads files and adds versions to the
    // task's own store (the person's definition of read-only, decision 0020 §1).
    readOnly: true,
    run: async (input, ctx?: ExecServices): Promise<JsonValue> => {
      const args = (input ?? {}) as Record<string, unknown>;
      const taskId = options.vars.taskId;
      const action = typeof args["action"] === "string" && args["action"].length > 0 ? args["action"] : "publish";
      try {
        if (action === "quickstart") return quickstart();
        if (action === "read") return read(taskId, args);
        if (action === "list") return list(taskId, args);
        if (action !== "publish") return { error: `Not done: \`action\` is publish, read, list or quickstart.` };
        const caption = typeof args["caption"] === "string" && args["caption"].trim().length > 0 ? args["caption"].trim() : undefined;
        // Show the person files, from wherever they are (2026-11-13).
        const items = showItemsOf(args["artifacts"]);
        if (items !== undefined) return await showSources(taskId, items, caption, ctx);
        if (typeof args["type_url"] === "string" && args["type_url"].length > 0) {
          if (args["type_url"] !== DESIGN_TYPE_URL) return { error: `Not published: JaiRA knows one Artifact type, the design canvas (${DESIGN_TYPE_URL}).` };
          if (typeof args["url"] === "string" && args["url"].length > 0) return { error: `Not published: the canvas exists — use its \`url\` and send \`type_url\` no more.` };
          const title = typeof args["title"] === "string" ? args["title"].trim() : "";
          if (title.length === 0) return { error: `Not published: a new canvas needs a \`title\` — what the user called it.` };
          return createCanvas(taskId, title);
        }
        const url = typeof args["url"] === "string" ? args["url"] : "";
        const id = url.length > 0 ? artifactIdOf(url, taskId) : undefined;
        const target = id !== undefined ? store.versions(taskId, id).at(-1) : undefined;
        if (target?.kind === "canvas") {
          if (args["asset"] === true) return uploadAsset(taskId, target.artifact, String(args["file_path"] ?? ""), ctx);
          return publishCanvas(taskId, target.artifact, args, ctx);
        }
        if (url.length > 0 && target === undefined) return { error: `Not published: there is no artifact at ${url} in this task.` };
        // A canvas file published without its url: the canvas this conversation is filling.
        const filePath = typeof args["file_path"] === "string" ? args["file_path"].replace(/\\/g, "/") : "";
        if ((filePath.includes("/project/") || filePath.startsWith("project/")) && (filePath.endsWith(".dc.html") || filePath.endsWith("/canvas.json"))) {
          const canvas = store.latest(taskId).filter((v) => v.kind === "canvas").at(-1);
          if (canvas !== undefined) return publishCanvas(taskId, canvas.artifact, args, ctx);
        }
        // `file_path` is the one-item spelling of `artifacts`: any file that is not a page is shown as itself.
        if (filePath.length > 0 && url.length === 0 && ![".html", ".htm", ".md"].includes(extname(filePath).toLowerCase())) {
          const source: ArtifactSource = typeof args["content"] === "string" ? { data: args["content"], name: filePath } : filePath;
          return await showSources(taskId, [{ source }], caption, ctx);
        }
        return publishPage(taskId, args, ctx);
      } catch (e) {
        if (e instanceof Refusal) return { error: e.message };
        throw e;
      }
    },
  } as Tool;
}
