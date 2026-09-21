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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadBundleOptions, Vfs } from "@declarative-ai/hw";
import { stateFilePath } from "@declarative-ai/hw";
import { parseJsonText, workflowSearchPath, type JairaPaths } from "@jaira/shared";
import { hostCalleeSignatures } from "@jaira/runtime";

import { userModules, type UnapprovedWatch } from "./userModules";
import { nodeVfs } from "./vfs";

/**
 * The callees JaiRA ships — a bare name every workflow can call without authoring a file.
 *
 * DERIVED from the registration the run itself uses (`hostCalleeSignatures`), not restated here.
 * That is the whole point of SPEC §7.5's unification: a registry entry declares its own slots, so
 * the thing the loader binds arguments against and the thing the engine dispatches are one object.
 * This used to be a hand-written map of operation DOCUMENTS, and the drift it allowed was not
 * hypothetical — the option carrying it was removed upstream and every `on_user_event` guard in the
 * tree silently stopped resolving, with nothing but a typecheck to say so.
 *
 * Computed once: it is the same answer for every project, and building a throwaway registry per
 * `loadBundle` call would be work with no question behind it.
 */
const HOST_FUNCTIONS = hostCalleeSignatures();

// `nodeVfs` moved to ./vfs so `userModules` can share it without a cycle; re-exported
// because it is part of this module's published surface.
export { nodeVfs } from "./vfs";

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
  /**
   * Watch what the APPROVAL GATE withholds from this load (SPEC §7.5.5).
   *
   * Supplied by a caller that will have to explain a failure — the pre-run gate and the lint
   * surface. Without it an unapproved module is reported as `'confidence.score' is not a known
   * operation`, which is indistinguishable from a typo and sends the reader looking for one.
   */
  watch?: UnapprovedWatch;
}

/**
 * Build the reference-resolution options for one project.
 *
 * `roots` is deliberately small: `$JAIRA` and `$PROJECT` are the two anchors a workflow can name
 * in its own project, `$BASE` names the shared root, and `$SYSTEM` names what JaiRA ships
 * (decision 0006) — for an author who means exactly the shipped copy, whatever shadows it.
 * `$WORKTREE` is absent because it is per-TASK — a workflow definition is loaded before any task
 * binds a worktree, and a reference that resolved differently per task would make the snapshot hash
 * depend on which task read it.
 *
 * ⚠️ `$SYSTEM` HERE is the built-in layer (`paths.builtIn.dir`). In an ARTIFACT DESTINATION the same
 * spelling is a root's generated `system/` directory (`artifactPath.ts`). Two vocabularies that never
 * meet — a destination template is not a reference — but worth knowing before grepping for one.
 */
export function workflowLoadOptions(paths: JairaPaths, options: WorkflowRefOptions = {}): LoadBundleOptions {
  const workflowsDir = options.workflowsDir ?? paths.workflowsDir;
  const roots = { JAIRA: paths.jairaDir, PROJECT: paths.projectDir, BASE: paths.base.baseDir, SYSTEM: paths.builtIn.dir };
  const searchPath = searchPathFor(workflowsDir, roots, options.path ?? workflowSearchPath(paths.roots), paths.builtIn.dir);
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
    // The operations JaiRA itself supplies, as a CONTRIBUTOR on the search path (SPEC §7.1) —
    // consulted where the path finds nothing, so `on_user_event('task_drag')` resolves in any
    // workflow without a file anybody had to create, and a project that puts its own
    // `functions/on_user_event.json` on the path still wins.
    functions: HOST_FUNCTIONS,
    // js/ts function modules (SPEC §7.5). Both halves come from the pair this process built at
    // startup, and BOTH are omitted when it did not: a loader that can find a symbol and cannot type
    // it would report "not an operation document" about a file that is perfectly good, so the two
    // travel together or not at all. Absent ⇒ no module contributes anything, which is exactly the
    // behavior that predates the feature.
    ...userModuleOptions(options.watch),
    ...(options.onWarn !== undefined ? { onWarn: options.onWarn } : {}),
    ...(options.onReferencedFile !== undefined ? { onReferencedFile: options.onReferencedFile } : {}),
  };
}

/**
 * The module half of the load options, from the process-wide pair.
 *
 * Read here rather than passed in by every caller because there are four call sites and none of them
 * has an opinion: whether modules resolve is a property of the PROCESS having built a compiler, not
 * of which project is being loaded.
 */
function userModuleOptions(watch?: UnapprovedWatch): Pick<LoadBundleOptions, "symbols" | "userFunctions"> {
  const modules = userModules();
  if (modules === undefined) return {};
  // The watch is per-LOAD, not per-process, which is why it is threaded rather than stashed beside
  // the pair: two loads running against one set of modules must not pool their withheld symbols, and
  // a surface that never asks pays nothing — the wrapper is not built at all.
  return { symbols: watch?.symbols ?? modules.symbols, userFunctions: modules.userFunctions };
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
 *
 * The built-in layer's two directories are forced LAST, as `workflowsDir` is forced first and for the
 * mirrored reason (decision 0006): `workflows.path` REPLACES the generated list, so a project that
 * set it would otherwise have silently dropped everything JaiRA ships — and one that listed
 * `$SYSTEM/workflows` early would have put the shipped copy ahead of a person's override of it. An
 * entry naming them is therefore lifted out of wherever it was written and put on the end.
 */
function searchPathFor(
  workflowsDir: string,
  roots: Readonly<Record<string, string>>,
  configured: readonly string[] | undefined,
  builtInDir: string,
): string[] {
  const last = workflowSearchPath([builtInDir]);
  const out = [workflowsDir];
  for (const entry of configured ?? []) {
    const match = /^\$([A-Z_][A-Z0-9_]*)?(?:\/(.*))?$/.exec(entry);
    const expanded = match ? join(roots[match[1] ?? "JAIRA"] ?? "", match[2] ?? "") : entry;
    if (expanded.length > 0 && !out.includes(expanded) && !last.includes(expanded)) out.push(expanded);
  }
  // Unless the project's own workflows directory IS the built-in one — which is nobody's layout, but
  // a directory must not be searched twice whoever asked.
  for (const dir of last) if (!out.includes(dir)) out.push(dir);
  return out;
}

/**
 * Options for a workflows directory with NO PROJECT behind it (`jaira workflow lint --workflows`).
 *
 * ⚠️ Deliberately minimal, and therefore not interchangeable with {@link workflowLoadOptions}: no
 * search path, no `roots`, no vfs, no registry contributor and no modules. A caller that HAS a
 * project must use `workflowLoadOptions` — using this one instead is why `jaira run --root` could
 * not load any workflow calling a `.ts` function, reporting "'confidence.score' is not a known
 * operation" about a function that is approved, resolved and registered.
 */
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
