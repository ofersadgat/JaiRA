/**
 * Toolsets on disk, and the one door a workflow goes through on its way to the engine
 * (decision 0007 §1–§2; `@jaira/shared` `toolsets.ts` for the model itself).
 *
 * Two things live here because both need a filesystem and the upstream reference resolver, which the
 * shared package deliberately has neither of:
 *
 *  - {@link loadWorkflowBundle} — `loadBundle`, with every map-form `tools` LOWERED first. The engine
 *    reads a non-array `tools` as a binding and refuses a map (`unrecognized binding form`), so a
 *    toolset has to become `tools: string[]` + a `permissions` block before the engine sees it. Every
 *    load of AUTHORED files goes through this, for the reason `workflowRefs.ts` gives for its
 *    options: the browser, the pre-run gate, the snapshotter and the CLI must agree on what a state
 *    says, or a workflow would lint as one thing and run as another. (The built-in sync, review and
 *    conformance workflows are generated in the list form and call `loadBundle` directly.)
 *  - {@link listToolsets} — the BUCKETS: `toolsets/<bucket>/<name>.json` under each layer root,
 *    first layer winning, a bucket free to nest.
 *
 * A toolset reference is resolved by the SAME resolver as every other reference in a workflow
 * (`resolveReference`), with the same options — so `$/toolsets/chat/read-only` searches the layer
 * roots in order (`rootPath`, which is `paths.roots`: a third layer is picked up by being in that
 * list), `./` means what it means elsewhere, and the file lands in the snapshot closure through the
 * same `onReferencedFile`.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  loadBundle,
  parseReferencedFile,
  resolveReference,
  selectProperty,
  stateIdFromPath,
  WorkflowLoadError,
  type LoadBundleOptions,
  type WorkflowBundle,
} from "@declarative-ai/hw";
import {
  lowerStateToolsets,
  parseToolset,
  resolveToolsetDecl,
  type JairaPaths,
  type StateToolsetIssue,
  type ToolsetChoice,
  type ToolsetDecl,
  type ToolsetIssue,
  type ToolsetReader,
  type WorkflowLayer,
} from "@jaira/shared";
import { workflowLoadOptions } from "./workflowRefs";

/** The folder toolsets live in, under every layer root. */
export const TOOLSETS_DIR_NAME = "toolsets";

/**
 * A {@link ToolsetReader} over the options a bundle loads with.
 *
 * Throws what the resolver throws — `reference '…' matches no file` reads the same here as it does
 * for a prompt fragment, which is the point of sharing it.
 */
export function toolsetReader(options: LoadBundleOptions): ToolsetReader {
  return (reference, from) => {
    const vfs = options.vfs;
    if (vfs === undefined) throw new Error(`reference '${reference}' cannot be followed — this load has no filesystem to read a toolset from`);
    const resolved = resolveReference(reference, {
      ...(options.defaultRoot !== undefined ? { defaultRoot: options.defaultRoot } : {}),
      ...(options.roots !== undefined ? { roots: options.roots } : {}),
      ...(options.rootPath !== undefined ? { rootPath: options.rootPath } : {}),
      ...(options.shadowing !== undefined ? { shadowing: options.shadowing } : {}),
      ...(options.onWarn !== undefined ? { onWarn: options.onWarn } : {}),
      from,
      vfs,
    });
    if (resolved.local || resolved.file === undefined) {
      throw new Error(`reference '${reference}' names no file — a toolset reference is a path, like $/toolsets/chat/read-only`);
    }
    const text = vfs.read(resolved.file);
    if (text === undefined) throw new Error(`reference '${reference}' names '${resolved.file}', which does not exist`);
    options.onReferencedFile?.(resolved.file);
    return {
      value: selectProperty(parseReferencedFile(resolved.file, text), resolved.property, reference),
      key: `${resolved.file}#${resolved.property.join(".")}`,
      from: resolved.id ?? from,
    };
  };
}

/**
 * Lower the toolsets in a set of state files, keyed as `loadBundle` takes them.
 *
 * A file with no toolset in it is passed through as the same object — see `lowerStateToolsets`.
 */
export function lowerWorkflowToolsets(
  files: Record<string, unknown>,
  options: LoadBundleOptions = {},
): { files: Record<string, unknown>; issues: StateToolsetIssue[] } {
  const read = toolsetReader(options);
  const out: Record<string, unknown> = {};
  const issues: StateToolsetIssue[] = [];
  for (const [file, def] of Object.entries(files)) {
    const lowered = lowerStateToolsets(stateIdFromPath(file), def, read);
    out[file] = lowered.def;
    issues.push(...lowered.issues);
  }
  return { files: out, issues };
}

export interface LoadWorkflowBundleOptions extends LoadBundleOptions {
  /**
   * Collect toolset issues instead of throwing on the first error — the lint surface's mode.
   *
   * A broken toolset then lowers to what could be read of it, the load carries on, and the caller
   * reports the issues against the state that wrote them. Without this an ERROR is a load error,
   * because a run must not start under a toolset nobody could read.
   */
  onToolsetIssue?: (issue: StateToolsetIssue) => void;
}

/** `loadBundle`, with toolsets lowered — in the files handed over and in any state read on demand. */
export function loadWorkflowBundle(files: Record<string, unknown>, rootRef: string, options: LoadWorkflowBundleOptions = {}): WorkflowBundle {
  const { onToolsetIssue, ...loadOptions } = options;
  const read = toolsetReader(loadOptions);
  const report = (issues: readonly StateToolsetIssue[]): void => {
    for (const issue of issues) {
      if (onToolsetIssue !== undefined) onToolsetIssue(issue);
      else if (issue.severity === "error") throw new WorkflowLoadError(`${issue.path}: ${issue.message}`, issue.stateId);
    }
  };
  const lowered = lowerWorkflowToolsets(files, loadOptions);
  report(lowered.issues);
  const loadState = loadOptions.loadState;
  return loadBundle(lowered.files, rootRef, {
    ...loadOptions,
    ...(loadState !== undefined
      ? {
          // A state the files map did not hold — a base-root one, an out-of-tree reference — is
          // read on demand, and has to come through the same door.
          loadState: (id: string) => {
            const def = loadState(id);
            if (def === undefined) return undefined;
            const one = lowerStateToolsets(id, def, read);
            report(one.issues);
            return one.def;
          },
        }
      : {}),
  });
}

/**
 * Every toolset a project can name, READ: which layer supplied it, and its map with references
 * followed — what the composer's Permissions card is drawn from (decision 0007 §5).
 *
 * Read through the same reader a state's `tools` reference goes through, so a toolset file that
 * starts from another (`{ "$ref": "$/toolsets/chat/read-only", "bash": "ask" }`) is offered as the
 * map it resolves to — the map picking it would write. A file that cannot be read, or whose
 * references do not resolve, is LEFT OUT rather than offered as half of itself: a row that writes
 * something other than what its file says is worse than a missing row, and the linter is where a
 * broken toolset is reported.
 */
export function readToolsets(paths: JairaPaths): ToolsetChoice[] {
  const read = toolsetReader(workflowLoadOptions(paths, { tolerant: true }));
  const layerOf = (root: string): WorkflowLayer =>
    root === paths.builtIn.dir ? "system" : root === paths.base.baseDir ? "base" : "project";
  const out: ToolsetChoice[] = [];
  for (const file of listToolsets(paths.roots)) {
    const issues: ToolsetIssue[] = [];
    const resolved = resolveToolsetDecl(file.reference, read, "", issues);
    if (resolved === undefined || issues.some((issue) => issue.severity === "error")) continue;
    if (parseToolset(resolved).issues.some((issue) => issue.severity === "error")) continue;
    out.push({ id: file.id, bucket: file.bucket, name: file.name, layer: layerOf(file.root), decl: resolved as ToolsetDecl });
  }
  return out;
}

/** One toolset file, as a layer root holds it. */
export interface ToolsetFile {
  /** `<bucket>/<name>` — what follows `$/toolsets/` in a reference. */
  id: string;
  /** The bucket: the folder path, `/`-separated. A bucket may nest (`feature/implementation`). */
  bucket: string;
  name: string;
  /** How a state names it. */
  reference: string;
  /** The layer root that supplied it — the first in `roots` to hold this id. */
  root: string;
  file: string;
  /** True when a LATER root also holds this id, which this one overrides. */
  overrides: boolean;
}

/**
 * Every toolset the layer roots hold, first root winning per id.
 *
 * `roots` is `JairaPaths.roots`, in search order — the same list a bare `$` reference is searched
 * along, so what this lists is what a reference would find. A file directly under `toolsets/` has no
 * bucket and is skipped: a bucket is what gives two toolsets of one name somewhere to differ.
 */
export function listToolsets(roots: readonly string[]): ToolsetFile[] {
  const byId = new Map<string, ToolsetFile>();
  for (const root of roots) {
    const walk = (dir: string, bucket: string[]): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // no `toolsets/` at this root — most roots, most of the time
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), [...bucket, entry.name]);
          continue;
        }
        const match = /^(.+)\.(json|ya?ml)$/.exec(entry.name);
        if (!entry.isFile() || match === null || bucket.length === 0) continue;
        const id = [...bucket, match[1]!].join("/");
        const prior = byId.get(id);
        if (prior !== undefined) {
          if (prior.root !== root) prior.overrides = true;
          continue;
        }
        byId.set(id, {
          id,
          bucket: bucket.join("/"),
          name: match[1]!,
          reference: `$/${TOOLSETS_DIR_NAME}/${id}`,
          root,
          file: join(dir, entry.name),
          overrides: false,
        });
      }
    };
    walk(join(root, TOOLSETS_DIR_NAME), []);
  }
  // By code point, so a bucket sorts ahead of a longer name that starts with it (`chat/` before `chat_control/`).
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
