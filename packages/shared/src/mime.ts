/**
 * What kind of thing a file in a layer root is, as a MIME type.
 *
 * The Files view resolves its two halves — the viewer on top, the editor below — by looking a
 * `(type, action)` pair up in a registry, and this is the function that supplies the type. One axis
 * rather than two: the tree already carries a semantic {@link FileKind}, but that vocabulary is a
 * closed union in this package, so keying the registry on it would mean editing shared/ every time a
 * new file type wants a surface. A MIME string is open, and an unrecognised one still resolves
 * through the fallback chain to a plain text editor rather than to nothing.
 *
 * JaiRA's own documents get vendor types. `workflows/plan.json` and a stray `notes.json` are both
 * JSON and are emphatically not the same thing to edit — one goes through `workflow:write`, which
 * parses and re-lints, and the other is just text — so the distinction has to survive into the
 * registry rather than being re-derived from the path by every component that cares.
 *
 * Pure and path-only: nothing here reads a file. Classifying by content would mean the tree could
 * not be built without opening every file in it, and the one case it would resolve better —
 * extensionless text — is rare enough in `.jaira/` to be worth the plain-text default instead.
 */

/** A state file the workflow editor can author: parsed, linted, written through `workflow:write`. */
export const WORKFLOW_JSON = "application/vnd.jaira.workflow+json";

/**
 * A state file written as YAML.
 *
 * A separate type, not a variant of {@link WORKFLOW_JSON}, because the authoring form cannot save
 * it: `workflow:write` parses as JSON and would reject the document it was given. It still names a
 * state, so it still gets the board on top — but the bottom half must be a text editor, and that is
 * exactly the distinction a registry key exists to carry.
 */
export const WORKFLOW_YAML = "application/vnd.jaira.workflow+yaml";

/** A layer's `config.json`. Its viewer is the *effective* configuration, which is not a file at all. */
export const CONFIG_JSON = "application/vnd.jaira.config+json";

/**
 * The English description of what the workflows are supposed to do — `workflows/workflow.md`.
 *
 * Still markdown, and it falls back to markdown for both surfaces, so nothing is lost by naming it.
 * What the name buys is the one thing a prompt or a README has no use for: this file and the state
 * files beside it are two accounts of the same flow, and either can fall behind the other. The type
 * is what puts the sync controls on it (WORKFLOWS.md §11.2) instead of on every `.md` in the tree.
 */
export const WORKFLOW_DESCRIPTION = "text/vnd.jaira.workflow-description+markdown";

/**
 * Where that description lives, relative to a layer root.
 *
 * One per layer, directly under `workflows/`, because the check it drives is about a whole set of
 * workflows: a description per subdirectory would raise "which of these am I being judged against?"
 * with no answer. The name is matched case-insensitively — `WORKFLOW.md` is what most people type.
 */
export const WORKFLOW_DESCRIPTION_PATH = "workflows/workflow.md";

/** True for the one path in a layer root that is the workflow description. */
export function isWorkflowDescription(relPath: string): boolean {
  return relPath.toLowerCase() === WORKFLOW_DESCRIPTION_PATH;
}

/** Directories, by the freedesktop convention. Present so every node in the tree has a type. */
export const DIRECTORY = "inode/directory";

/**
 * Extensions whose contents are not text.
 *
 * Listed so `file:read` can refuse them and the panel can say why, rather than handing a text editor
 * a string of replacement characters and letting the user save the corruption back.
 */
const BINARY: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/vnd.microsoft.icon",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  db: "application/vnd.sqlite3",
  sqlite: "application/vnd.sqlite3",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
};

/**
 * Text extensions worth naming.
 *
 * Everything absent from here is `text/plain`, which is not a failure: the fallback chain sends
 * `text/*` to the plain-text editor anyway, so the only thing a missing entry costs is the chance to
 * register something better later. Naming a type is how you make that chance exist.
 */
const TEXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  jsonc: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/x-typescript",
  tsx: "text/x-typescript",
  py: "text/x-python",
  sh: "application/x-sh",
  toml: "application/toml",
  xml: "application/xml",
  svg: "image/svg+xml",
};

/** The lowercased extension, without the dot. Empty for a name that has none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * The MIME type of a path relative to a layer root.
 *
 * `relPath` is root-relative with forward slashes, which is what makes the vendor types decidable:
 * `workflows/` and a bare `config.json` are positions, not extensions, and a classifier that only
 * saw the file name would have to guess at both.
 */
export function mimeOfPath(relPath: string, isDirectory = false): string {
  if (isDirectory) return DIRECTORY;

  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  const ext = extensionOf(name);

  if (relPath === "config.json") return CONFIG_JSON;
  if (isWorkflowDescription(relPath)) return WORKFLOW_DESCRIPTION;
  if (relPath.startsWith("workflows/")) {
    if (ext === "json") return WORKFLOW_JSON;
    if (ext === "yaml" || ext === "yml") return WORKFLOW_YAML;
  }

  return BINARY[ext] ?? TEXT[ext] ?? "text/plain";
}

/** True when a type is one this app is willing to read as a UTF-8 string. */
export function isTextMime(mime: string): boolean {
  if (mime === DIRECTORY) return false;
  if (mime.startsWith("text/")) return true;
  // `image/svg+xml` is markup, and the `+json` / `+yaml` / `+xml` suffixes are the structured-syntax
  // convention (RFC 6839) — both say "this is text with a schema on top of it".
  if (mime === "image/svg+xml") return true;
  if (mime.endsWith("+json") || mime.endsWith("+yaml") || mime.endsWith("+xml")) return true;
  return ["application/json", "application/yaml", "application/xml", "application/toml", "application/x-sh"].includes(
    mime,
  );
}

/**
 * The registered type each structured-syntax suffix means.
 *
 * `application/<suffix>` is right for the syntaxes that are registered under it, and wrong for
 * markdown, which the world spells `text/markdown`. Without this entry a `+markdown` vendor type
 * would fall back to a type nothing has ever registered and land on the plain-text editor — losing
 * the preview that is the whole reason markdown has a viewer.
 */
const SUFFIX_TYPES: Record<string, string> = { markdown: "text/markdown" };

/**
 * The chain of types to try when resolving a component, most specific first.
 *
 * A vendor type falls back to the syntax it is written in — a `+json` document is still JSON, so a
 * type with no registered editor of its own gets the JSON one rather than nothing — and every text
 * type ends at `text/plain`, which is the entry that guarantees no file in the tree is dead.
 */
export function mimeFallbacks(mime: string): string[] {
  const chain = [mime];
  const plus = mime.lastIndexOf("+");
  if (plus > 0) {
    const suffix = mime.slice(plus + 1);
    chain.push(SUFFIX_TYPES[suffix] ?? `application/${suffix}`);
  }
  if (isTextMime(mime) && !chain.includes("text/plain")) chain.push("text/plain");
  return chain;
}
