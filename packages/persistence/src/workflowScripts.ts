/**
 * Workflow SCRIPTS: a state written as code, compiled to the state documents it is (hw SCRIPTS.md).
 *
 * A `.ts`/`.js` under a workflows directory is a state whose structure is its code — its phases, the
 * calls it makes, its control flow — and hw's compiler turns it into ordinary `StateDef`s. Nothing
 * downstream learns a new format: the loader, the validator, the snapshot and the board see the
 * documents a person could have written by hand. This module is where JaiRA meets the compiler.
 *
 * ## Two ways in, one compile
 *
 * - A DIRECTORY read ({@link scriptStatesIn}) — the in-tree `files` map and the workflow browser —
 *   adds the documents of every script that declares a `meta`. A module without one sitting among
 *   the workflows is a helper that stays code (SCRIPTS.md §10), and must not be listed as a workflow.
 * - A state id the directory does not hold ({@link scriptStateFor}) — a base or built-in layer's
 *   state, or a state a script GENERATED (`review/sweep/find/map_0`) — is looked for as a script at
 *   the id or at the id of a script that generates it. A script a mount names compiles whether or not
 *   it declares a `meta`: a mount is what makes a module a state.
 *
 * ## Compiled when it is needed, and cached
 *
 * A script is compiled the first time something needs it — the browse lists it, a load reaches it, a
 * run starts it — whether or not this process has opened a project: `loadBundle` is sync, so the
 * compile is `compileScriptWith` over the compiler {@link scriptCompiler} loads on that first need.
 * It used to be the module pair's, awaited when a project opened, so a window that had opened none
 * listed no `session` and could not start a chat (2026-11-20). A compile type-checks the script and
 * what it imports, which is too slow to repeat for every view a board draws — so it is cached, and a
 * cached compile is reused only while every file it read still hashes as it did (`generated.inputs`),
 * which is exactly the staleness rule hw applies to a materialized generated file.
 *
 * Its imports resolve in a project's context ({@link ScriptContext}): the one the caller names, else
 * the pair's when this process built one, else the directory's own with the built-in layer behind it.
 * A compile is cached by the script and its state id, as it was under the pair: the scripts whose
 * imports a project's context changes are that project's own, at paths no other project shares, and
 * keying the shipped ones by context too compiled `session` again for every project opened.
 */
import { basename, join, relative, sep } from "node:path";
import { listDefinitions, readDefinition } from "@jaira/runtime";
import { compileScriptWith, hasScriptMeta, moduleHash, requirePathFor, stateFilePath, type CompiledScript, type StateDef, type Vfs } from "@declarative-ai/hw";
import { jairaBuiltInPaths, workflowSearchPath } from "@jaira/shared";

import { canonicalModulePath, scriptCompiler, userModules, type ScriptContext } from "./userModules";
import { nodeVfs } from "./vfs";

/** A script file — `.ts`/`.js`, never a declaration file. */
export function isScriptFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (lower.endsWith(".ts") || lower.endsWith(".js")) && !lower.endsWith(".d.ts");
}

const SCRIPT_SUFFIXES = [".ts", ".js"] as const;

/**
 * Whether a file under `workflows/` is a workflow SCRIPT — a state — rather than code a script imports:
 * a `.ts`/`.js` that declares a `meta`, the same test the browser lists scripts by (`scriptStatesIn`).
 */
export function isWorkflowScript(file: string): boolean {
  if (!isScriptFile(basename(file))) return false;
  let text: string;
  try {
    text = readDefinition(file);
  } catch {
    return false;
  }
  return hasScriptMeta(scriptCompiler().ts, file, text);
}

/** Compiles by `<file>\n<state id>`, each with the hashes of what it read. */
const compiles = new Map<string, CompiledScript>();

/**
 * Compile one script to the state documents it is — or hand back the compile already made of it,
 * while every file it read still reads the same.
 *
 * Throws hw's `ScriptCompileError` — located at the script's line — for a script that does not
 * compile; a caller that must not fail on one file (a directory read) catches it.
 */
export function compileWorkflowScript(file: string, stateId: string, context: ScriptContext): CompiledScript {
  const path = canonicalModulePath(file);
  const key = `${path}\n${stateId}`;
  // A fresh vfs per compile: the pair's caches listings for the life of the process, and a compile
  // must see an import added since.
  const vfs = nodeVfs();
  const cached = compiles.get(key);
  if (cached !== undefined && isCurrent(cached, vfs)) return cached;
  const compiled = compileScriptWith(scriptCompiler(), {
    file: path,
    stateId,
    vfs,
    requirePath: context.requirePath,
    roots: context.roots,
    defaultMode: "calls",
    // An imported STATE is named by where it sits on the search path, as a mount would name it.
    stateIdOf: (imported) => stateIdOnPath(context.searchPath, imported),
  });
  compiles.set(key, compiled);
  return compiled;
}

/**
 * The context a script under `workflowsDir` compiles in when the caller names none: the pair's, when
 * this process built one (a project is open); else the directory's own, with the built-in layer behind
 * it — what a directory with no project behind it can say.
 */
function contextFor(workflowsDir: string, given: ScriptContext | undefined): ScriptContext {
  if (given !== undefined) return given;
  const modules = userModules();
  if (modules !== undefined) return modules;
  const builtIn = workflowSearchPath([jairaBuiltInPaths().dir]).map(canonicalModulePath);
  const own = canonicalModulePath(workflowsDir);
  const searchPath = [...(builtIn.includes(own) ? [] : [own]), ...builtIn];
  return { searchPath, requirePath: requirePathFor(searchPath), roots: { SYSTEM: jairaBuiltInPaths().dir } };
}

/** Whether every file a compile read still reads the same. */
function isCurrent(compiled: CompiledScript, vfs: Vfs): boolean {
  for (const [file, hash] of Object.entries(compiled.generated.inputs)) {
    const text = vfs.read(file);
    if (text === undefined || moduleHash(text) !== hash) return false;
  }
  return true;
}

/** A state file's id: its path, suffix dropped, under the search-path entry that holds it. */
function stateIdOnPath(searchPath: readonly string[], file: string): string | undefined {
  const path = canonicalModulePath(file);
  for (const root of searchPath) {
    const prefix = `${root}/`;
    if (path.startsWith(prefix)) return path.slice(prefix.length).replace(/\.[^./]+$/, "");
  }
  return undefined;
}

/** One document a script under a workflows directory compiles to. */
export interface ScriptState {
  /** Keyed as a state file there would be — `review/sweep.json` — which is how a loader's `files` map names it. */
  key: string;
  /** The script it comes from, relative to the directory — the file a person opens to change it. */
  script: string;
  /** The state the script IS, rather than one its compile generated (a phase, a call). */
  root: boolean;
  document: StateDef;
}

/**
 * The documents of every script under a workflows directory that declares a `meta` — what the
 * in-tree `files` map and the browser add to the state files they read — compiled in `context`, the
 * project's the directory is read for ({@link contextFor} when none is named).
 *
 * `onError` receives a script that does not compile, against its path; without it the error is
 * thrown, as an unreadable state file's is.
 */
export function scriptStatesIn(workflowsDir: string, onError?: (relPath: string, message: string) => void, context?: ScriptContext): ScriptState[] {
  const out: ScriptState[] = [];
  const vfs = nodeVfs();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = listDefinitions(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
        continue;
      }
      if (!entry.isFile() || !isScriptFile(entry.name)) continue;
      const rel = relative(workflowsDir, full).split(sep).join("/");
      const text = vfs.read(full);
      if (text === undefined || !hasScriptMeta(scriptCompiler().ts, full, text)) continue;
      const stateId = rel.replace(/\.[^./]+$/, "");
      try {
        const compiled = compileWorkflowScript(full, stateId, contextFor(workflowsDir, context));
        for (const [id, document] of Object.entries(compiled.documents)) {
          out.push({ key: `${id}.json`, script: rel, root: id === stateId, document });
        }
      } catch (e) {
        if (onError === undefined) throw e;
        onError(rel, (e as Error).message);
      }
    }
  };
  walk(workflowsDir);
  return out;
}

/**
 * The document a state id names when a SCRIPT defines it — the script at the id itself, or the
 * script whose compile generates it (`review/sweep` for `review/sweep/find/map_0`) — searching the
 * roots in order, first match wins, compiled in `context` (the loading project's). `undefined` when
 * no script on the path defines it.
 */
export function scriptStateFor(id: string, roots: readonly string[], context?: ScriptContext): StateDef | undefined {
  const vfs = nodeVfs();
  const segments = id.split("/");
  for (const root of roots) {
    // The id itself first, then each script that could have generated it, nearest first.
    for (let n = segments.length; n >= 1; n--) {
      const scriptId = segments.slice(0, n).join("/");
      for (const suffix of SCRIPT_SUFFIXES) {
        const file = `${stateFilePath(scriptId, root)}${suffix}`;
        if (vfs.read(file) === undefined) continue;
        const document = compileWorkflowScript(file, scriptId, contextFor(root, context)).documents[id];
        if (document !== undefined) return document;
      }
    }
  }
  return undefined;
}
