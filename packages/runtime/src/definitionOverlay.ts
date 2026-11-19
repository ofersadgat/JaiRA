/**
 * A PROPOSED change, read by one run as if it were written (decision 0029 §5 step 5, simulation).
 *
 * An improver's change is whole files under a layer root — a workflow, a prompt, a skill, a permission
 * set, `instructions.md` — and a simulation runs a fork of the conversation under them BEFORE anyone
 * has agreed to write them. Writing them to the layer, even for a moment, would hand them to every other
 * run that loads the workflow in that moment. So they are not written: every read of a workflow's
 * definition goes through here, and inside {@link withDefinitionOverlay} — the fork's run, and the
 * loads made for it — a path the change names reads as the change says. Everywhere else, and for every
 * other path, this is the filesystem.
 *
 * Scoped by `AsyncLocalStorage`: what the fork's run awaits, and what it starts, carry the overlay;
 * another run, loaded in the same moment, does not.
 *
 * Paths compare in their real spelling (symlinks followed as far as the path exists), so `/var/…` and
 * `/private/var/…` are one file, as the module loader also reads them.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The files a change proposes, as one run reads them. */
export interface DefinitionOverlay {
  /** A name for it — what a cache that must not mix it up with the disk keys on. */
  readonly id: string;
  /** Real path → the content read there in place of the disk's. */
  readonly files: ReadonlyMap<string, string>;
  /** Real directory → the names under it the change adds: its files, and the folders that lead to them. */
  readonly children: ReadonlyMap<string, ReadonlyMap<string, "file" | "dir">>;
  /**
   * What a load under it needs beside the files — the module pair built over them, so a proposed
   * script compiles and runs (`@jaira/persistence`'s `prepareOverlayModules`). Opaque here.
   */
  modules?: unknown;
}

const current = new AsyncLocalStorage<DefinitionOverlay>();

/** A path in its real spelling: the longest part of it that exists, symlinks followed, and the rest as written. */
export function realPathOf(path: string): string {
  const abs = resolve(path);
  const rest: string[] = [];
  let at = abs;
  for (;;) {
    try {
      const real = realpathSync(at);
      return rest.length > 0 ? join(real, ...rest.reverse()) : real;
    } catch {
      const parent = dirname(at);
      if (parent === at) return abs;
      rest.push(basename(at));
      at = parent;
    }
  }
}

/** An overlay of `files` — absolute path → content. */
export function makeDefinitionOverlay(id: string, files: Readonly<Record<string, string>>): DefinitionOverlay {
  const byPath = new Map<string, string>();
  const children = new Map<string, Map<string, "file" | "dir">>();
  for (const [path, text] of Object.entries(files)) {
    const real = realPathOf(path);
    byPath.set(real, text);
    let child = real;
    let kind: "file" | "dir" = "file";
    for (;;) {
      const parent = dirname(child);
      if (parent === child) break;
      const names = children.get(parent) ?? new Map<string, "file" | "dir">();
      if (names.get(basename(child)) !== "file") names.set(basename(child), kind);
      children.set(parent, names);
      if (existsSync(parent)) break;
      child = parent;
      kind = "dir";
    }
  }
  return { id, files: byPath, children };
}

/** Run `fn` reading definitions through `overlay` — and everything it awaits or starts. */
export function withDefinitionOverlay<T>(overlay: DefinitionOverlay, fn: () => T): T {
  return current.run(overlay, fn);
}

/** The overlay the code running now reads through, if any. */
export function currentDefinitionOverlay(): DefinitionOverlay | undefined {
  return current.getStore();
}

/**
 * Which overlay a read goes through: the one named, none for `null`, else the one the code running now
 * reads through.
 */
type Through = DefinitionOverlay | null | undefined;
const through = (overlay: Through): DefinitionOverlay | undefined => (overlay === null ? undefined : (overlay ?? current.getStore()));

/** What the overlay says a file holds — `undefined` when there is no overlay, or it does not name the file. */
export function overlaidText(path: string, via?: Through): string | undefined {
  const overlay = through(via);
  if (overlay === undefined || overlay.files.size === 0) return undefined;
  return overlay.files.get(realPathOf(path));
}

/** A definition file's text: the overlay's, else the disk's — throwing as `readFileSync` does for a file that is not there. */
export function readDefinition(path: string, via?: Through): string {
  return overlaidText(path, via) ?? readFileSync(path, "utf8");
}

/** Whether a definition file or folder is there, as the overlay sees it. */
export function definitionExists(path: string, via?: Through): boolean {
  const overlay = through(via);
  if (overlay !== undefined && overlay.files.size > 0) {
    const real = realPathOf(path);
    if (overlay.files.has(real) || overlay.children.has(real)) return true;
  }
  return existsSync(path);
}

/** One entry of a definition folder. */
export interface DefinitionEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

/**
 * A definition folder's entries, as the overlay sees it: the disk's, with what the change adds beside
 * them. Throws as `readdirSync` does when neither has the folder.
 */
export function listDefinitions(dir: string, via?: Through): DefinitionEntry[] {
  const overlay = through(via);
  const added = overlay !== undefined && overlay.files.size > 0 ? overlay.children.get(realPathOf(dir)) : undefined;
  let disk: DefinitionEntry[];
  try {
    disk = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (added === undefined) throw e;
    disk = [];
  }
  if (added === undefined) return disk;
  const out = disk.filter((entry) => !added.has(entry.name));
  for (const [name, kind] of added) out.push({ name, isFile: () => kind === "file", isDirectory: () => kind === "dir" });
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
