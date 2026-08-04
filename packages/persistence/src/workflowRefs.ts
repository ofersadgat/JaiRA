/**
 * Where a workflow reference points (DESIGN §5.2; WORKFLOWS.md §2.1).
 *
 * A state `id` — and every `children[].state` that names one — is a PATH. It has always been one
 * (the file's location under `.jaira/workflows/`, minus the suffix); what this module adds is the
 * rest of what a path can say, with the same vocabulary artifact destinations use (DESIGN §7.6):
 * `$JAIRA` / `$PROJECT` roots, absolute paths, and `./` relative to the referring state.
 *
 * Every `loadBundle` call in JaiRA goes through here, because the answer has to be identical in all
 * of them: the workflow browser, the pre-run gate, the snapshotter and the CLI must agree on which
 * file a reference names, or a workflow would lint against one state and execute another.
 *
 * An out-of-tree reference reads a file outside the project. That is deliberate — it is how a shared
 * library of states is mounted — and it is a decision the AUTHOR makes in a file they control, the
 * same trust boundary an absolute artifact destination sits on. Nothing an agent produces reaches
 * this path.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LoadBundleOptions, Vfs } from "@declarative-ai/hw";
import { stateFilePath } from "@declarative-ai/hw";
import { parseJsonText, workflowSearchPath, type JairaPaths } from "@jaira/shared";

/**
 * The filesystem references resolve against (REFERENCES.md §1.1).
 *
 * Listings are cached for the life of one load: resolution asks for the same directory once per
 * reference into it, and a workflow with a shared type library asks a lot. Caching also makes one
 * load SELF-CONSISTENT — a file appearing mid-load cannot change what an earlier reference meant.
 *
 * Entries are matched case-sensitively even on Windows, so a workflow resolves identically wherever
 * it runs rather than inheriting the host's rules.
 */
export function nodeVfs(): Vfs {
  const listings = new Map<string, readonly string[]>();
  return {
    list(dir) {
      const cached = listings.get(dir);
      if (cached !== undefined) return cached;
      let names: readonly string[];
      try {
        names = readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name);
      } catch {
        names = [];
      }
      listings.set(dir, names);
      return names;
    },
    read(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

export interface WorkflowRefOptions {
  /** Where bare references hang off. Defaults to the project's `.jaira/workflows`. */
  workflowsDir?: string;
  /**
   * The project's configured search path (`config.workflows.path`, EXPRESSIONS.md §4), as authored —
   * `$JAIRA`/`$PROJECT` entries are expanded here against the same roots a reference uses.
   *
   * Absent ⇒ generated from the project's layer roots (`<root>/workflows`, `<root>/functions`).
   * The first entry always ends up being `workflowsDir`, whatever the config says: it is the root a
   * bare state id folds back against, and moving it would change every id in the project.
   */
  path?: readonly string[];
  /** Swallow read/parse failures instead of throwing — the lint surface's tolerant mode. */
  tolerant?: boolean;
  /** Override the filesystem — a snapshot resolves against its own copy, not the live project. */
  vfs?: Vfs;
  /** Non-fatal reference ambiguities, for the lint surface. */
  onWarn?: (message: string) => void;
  /** Each file a document reference pulled in, for the snapshot closure. */
  onReferencedFile?: (file: string) => void;
}

/**
 * Build the reference-resolution options for one project.
 *
 * `roots` is deliberately small: `$JAIRA` and `$PROJECT` are the two anchors a workflow can name.
 * `$WORKTREE` is absent because it is per-TASK — a workflow definition is loaded before any task
 * binds a worktree, and a reference that resolved differently per task would make the snapshot hash
 * depend on which task read it.
 */
export function workflowLoadOptions(paths: JairaPaths, options: WorkflowRefOptions = {}): LoadBundleOptions {
  const workflowsDir = options.workflowsDir ?? paths.workflowsDir;
  const roots = { JAIRA: paths.jairaDir, PROJECT: paths.projectDir, BASE: paths.base.baseDir };
  const searchPath = searchPathFor(workflowsDir, roots, options.path ?? workflowSearchPath(paths.roots));
  return {
    defaultRoot: searchPath,
    roots,
    // The LAYER roots, which a bare `$` is searched along. This is what makes the fragments a state
    // is assembled from — prompts, types, guards, operation documents — layer exactly as whole
    // states do; `$JAIRA` and `$BASE` still name one root each, for an author who means one.
    rootPath: paths.roots,
    vfs: options.vfs ?? nodeVfs(),
    // Searched along the WHOLE path, not just the workflows directory: a bare id may be supplied by
    // any layer, and reading only the first would make a base-root state unloadable at exactly the
    // moment it is needed — when nothing in the project defines it.
    loadState: (id) => readStateFile(id, searchPath, options.tolerant === true),
    // Shadowing is this project's override mechanism, so it is not news. Without this the lint
    // surface would carry one warning per overridden state, which is how a warning stops being read.
    shadowing: "override",
    ...(options.onWarn !== undefined ? { onWarn: options.onWarn } : {}),
    ...(options.onReferencedFile !== undefined ? { onReferencedFile: options.onReferencedFile } : {}),
  };
}

/**
 * The ordered roots a bare reference is searched along, with `$JAIRA`/`$PROJECT`/`$BASE` expanded.
 *
 * `workflowsDir` is forced FIRST, whatever the config lists — it is the root this project's own
 * states are authored under, and a layer that configuration could push behind another would stop
 * being an override. What configuration decides is what comes AFTER, which is where `$BASE` sits.
 *
 * An entry naming a directory that does not exist is harmless: the vfs lists it as empty, and the
 * search moves on. That is what makes `$BASE/workflows` a safe default on a machine with no shared
 * root yet, and `$JAIRA/functions` a safe one before anything is in it.
 */
function searchPathFor(workflowsDir: string, roots: Readonly<Record<string, string>>, configured: readonly string[] | undefined): string[] {
  const out = [workflowsDir];
  for (const entry of configured ?? []) {
    const match = /^\$([A-Z_][A-Z0-9_]*)?(?:\/(.*))?$/.exec(entry);
    const expanded = match ? join(roots[match[1] ?? "JAIRA"] ?? "", match[2] ?? "") : entry;
    if (expanded.length > 0 && !out.includes(expanded)) out.push(expanded);
  }
  return out;
}

/** Options for a workflows directory with no project behind it (`jaira workflow lint --workflows`). */
export function standaloneLoadOptions(workflowsDir: string, tolerant = false): LoadBundleOptions {
  return {
    defaultRoot: workflowsDir,
    loadState: (id) => readStateFile(id, workflowsDir, tolerant),
  };
}

/**
 * Read one state file by canonical id, searching the roots in order. Only reached for a state the
 * caller's `files` map does not already hold — a base-root state, or an out-of-tree reference — so
 * the in-tree path never touches the disk twice.
 *
 * First match wins, which is the same rule reference resolution uses; the two have to agree or a
 * bundle would lint against the project's copy of a state and load the base's.
 *
 * A read that fails for a reason OTHER than absence is reported straight away rather than falling
 * through to the next root. An unreadable file is not the same as a missing one, and quietly
 * resolving to the base copy because the project's is malformed would hide the actual fault.
 */
function readStateFile(id: string, roots: string | readonly string[], tolerant: boolean): unknown | undefined {
  const search = typeof roots === "string" ? [roots] : roots;
  for (const root of search) {
    const file = `${stateFilePath(id, root)}.json`;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // not at this root — try the next
      if (tolerant) return undefined;
      throw e;
    }
    try {
      return parseJsonText(text, file);
    } catch (e) {
      if (tolerant) return undefined;
      throw e;
    }
  }
  // Absent everywhere. Left to the caller as an unknown-state VALIDATION error, which carries the
  // referring field and reads far better than a raw ENOENT would.
  return undefined;
}
