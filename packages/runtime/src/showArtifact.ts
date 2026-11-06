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
import type { ExecServices, JsonValue, Tool } from "@declarative-ai/exec";
import { defaultBuiltInDir } from "@jaira/shared";
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
      "The Artifact tool (wherever instructions name `Artifact` or 'your Artifact tool', they mean this one). Publish what you made for the user to look at: a page (`.html`, `.htm`), a Markdown document (`.md`), or a design canvas. Give the text in the call — `content` for a page (with `file_path` only to name it, `notes.md` for Markdown), or `files: { \"project/<path>\": { \"content\": \"…\" } }` for a canvas's files — or write the file first and publish it with `file_path` (its absolute path). Sending the text needs no file and no write permission. A file you publish must be one you may read. The page is shown in the conversation and every publish is a new version of the same artifact: to update one, give its `url` (or, for a page from a file, publish the same `file_path` again in this conversation); `action: \"read\"` gives back what it holds now. A page is one self-contained file: it may load fonts from Google Fonts and scripts from cdnjs, unpkg, cdn.tailwindcss.com, code.jquery.com and cdn.jsdelivr.net/npm/, and nothing else — inline other CSS and JavaScript, embed images as data URIs, use in-page anchors (relative links do not resolve); at most 16 MiB. The page's `<title>` names it. When the person wants a design or a mock-up, in whatever words and whether or not they typed `/design`, your first call is `action: \"quickstart\"` with `intent: \"design\"`, before you write any file, and then you do what it answers: the result is a design canvas, which the person can edit. A page or a Markdown document is for what is not a design. `action: \"read\"` reads an artifact (`url`, and `path` for one of a canvas's files); `action: \"list\"` lists this task's artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["publish", "read", "list", "quickstart"], description: "Omit (or 'publish') to publish `file_path`. 'read' reads an artifact; 'list' lists them; 'quickstart' starts a design." },
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
        return publishPage(taskId, args, ctx);
      } catch (e) {
        if (e instanceof Refusal) return { error: e.message };
        throw e;
      }
    },
  } as Tool;
}
