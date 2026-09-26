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
 * ## Why it is synchronous, and cached
 *
 * `loadBundle` is sync, so the compile is `compileScriptWith` over the compiler the process-wide
 * module pair loaded at startup (`userModules().signatures`). A process that never built the pair
 * compiles no script, as it resolves no function module. A compile type-checks the script and what it
 * imports, which is too slow to repeat for every view a board draws — so it is cached, and a cached
 * compile is reused only while every file it read still hashes as it did (`generated.inputs`), which
 * is exactly the staleness rule hw applies to a materialized generated file.
 */
import { join, relative, sep } from "node:path";
import { readdirSync } from "node:fs";
import { compileScriptWith, hasScriptMeta, moduleHash, stateFilePath, type CompiledScript, type StateDef, type Vfs } from "@declarative-ai/hw";

import { canonicalModulePath, userModules, type UserModules } from "./userModules";
import { nodeVfs } from "./vfs";

/** A script file — `.ts`/`.js`, never a declaration file. */
export function isScriptFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (lower.endsWith(".ts") || lower.endsWith(".js")) && !lower.endsWith(".d.ts");
}

const SCRIPT_SUFFIXES = [".ts", ".js"] as const;

/** Compiles by `<file>\n<state id>`, each with the hashes of what it read. */
const compiles = new Map<string, CompiledScript>();

/**
 * Compile one script to the state documents it is, or `undefined` when this process has no compiler.
 *
 * Throws hw's `ScriptCompileError` — located at the script's line — for a script that does not
 * compile; a caller that must not fail on one file (a directory read) catches it.
 */
export function compileWorkflowScript(file: string, stateId: string): CompiledScript | undefined {
  const modules = userModules();
  if (modules === undefined) return undefined;
  const path = canonicalModulePath(file);
  const key = `${path}\n${stateId}`;
  // A fresh vfs per compile: the pair's caches listings for the life of the process, and a compile
  // must see an import added since.
  const vfs = nodeVfs();
  const cached = compiles.get(key);
  if (cached !== undefined && isCurrent(cached, vfs)) return cached;
  const compiled = compileScriptWith(modules.signatures, {
    file: path,
    stateId,
    vfs,
    requirePath: modules.requirePath,
    roots: modules.roots,
    defaultMode: "calls",
    // An imported STATE is named by where it sits on the search path, as a mount would name it.
    stateIdOf: (imported) => stateIdOnPath(modules, imported),
  });
  compiles.set(key, compiled);
  return compiled;
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
function stateIdOnPath(modules: UserModules, file: string): string | undefined {
  const path = canonicalModulePath(file);
  for (const root of modules.searchPath) {
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
 * in-tree `files` map and the browser add to the state files they read.
 *
 * `onError` receives a script that does not compile, against its path; without it the error is
 * thrown, as an unreadable state file's is.
 */
export function scriptStatesIn(workflowsDir: string, onError?: (relPath: string, message: string) => void): ScriptState[] {
  const out: ScriptState[] = [];
  if (userModules() === undefined) return out;
  const vfs = nodeVfs();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
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
      const modules = userModules()!;
      if (text === undefined || !hasScriptMeta(modules.signatures.ts, full, text)) continue;
      const stateId = rel.replace(/\.[^./]+$/, "");
      try {
        const compiled = compileWorkflowScript(full, stateId);
        for (const [id, document] of Object.entries(compiled?.documents ?? {})) {
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
 * roots in order, first match wins. `undefined` when no script on the path defines it.
 */
export function scriptStateFor(id: string, roots: readonly string[]): StateDef | undefined {
  if (userModules() === undefined) return undefined;
  const vfs = nodeVfs();
  const segments = id.split("/");
  for (const root of roots) {
    // The id itself first, then each script that could have generated it, nearest first.
    for (let n = segments.length; n >= 1; n--) {
      const scriptId = segments.slice(0, n).join("/");
      for (const suffix of SCRIPT_SUFFIXES) {
        const file = `${stateFilePath(scriptId, root)}${suffix}`;
        if (vfs.read(file) === undefined) continue;
        const document = compileWorkflowScript(file, scriptId)?.documents[id];
        if (document !== undefined) return document;
      }
    }
  }
  return undefined;
}
