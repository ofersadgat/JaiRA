/**
 * The settings' layer roots, and what each holds besides a settings file: its `permission-sets/` and
 * its `workflows/` — decision 0023, amended 2026-11-18. Most specific first, then what ships:
 *
 * | layer            | root                         | named by           |
 * | ---------------- | ---------------------------- | ------------------ |
 * | `projectYou`     | `<base>/projects/<key>/`     | `$PROJECTYOU`      |
 * | `you`            | `<base>/personal/`           | `$YOU`             |
 * | `projectMachine` | `<project>/.jaira/local/`    | `$PROJECTMACHINE`  |
 * | `machine`        | `<base>/machine/`            | `$MACHINE`         |
 * | `project`        | `<project>/.jaira/`          | `$JAIRA`           |
 * | `base`           | `<base>/`                    | `$BASE`            |
 * | `system`         | what ships                   | `$SYSTEM`          |
 *
 * The order is the settings' (`configLayers.ts`): the person over the machine over the project, a
 * project's own over the layer it is the project's in. `<key>` is the project's settings key — its
 * repository identity, the same in every clone (`projectSettingsKey`) — so the person's sets for a
 * project sit beside their `personal-settings.json` for it.
 *
 * ## Permission sets
 *
 * A `$` reference searches the four newer roots first, then the project's own `roots` (its `.jaira/`,
 * the shared root, what ships) — {@link referenceRootPath}.
 *
 * ## Workflows
 *
 * Every layer keeps workflows under its own `workflows/`, and a bare state id — `feature/plan`,
 * `system/events/push_main` — is found in the most specific layer that has a file for it: you in the
 * project, Just you, the project on this machine, this machine, the project, Shared, what ships. An id
 * is the file's path under the `workflows/` it was found in, as it always was, so nothing a project
 * names moves. The four newer layers' `workflows/` lead the search path (`workflowRefs.ts`), and their
 * states are laid over the project's own files when a bundle loads ({@link nearerStates}), so a copy
 * in one of them stands in front of the project's. A child, a `./` reference and a `children[].state`
 * are ids too: each is found the same way, nearest first, wherever its parent was found — a parent in
 * Just you and its child in the project, or a project's parent whose child Just you overrides, both
 * read the nearest copy of each.
 *
 * The events workflow SPLICES along the chain. Each layer's copy says its own lines, then the lines of
 * the layer directly under it (`EVENTS_FOLLOWS`: `$YOU`, `$PROJECTMACHINE`, `$MACHINE`, `$JAIRA`,
 * `$BASE`, `$SYSTEM`) less the ones it turns off by name — the same `$ref` a project's copy has always
 * had for Shared's. A named root names one place and never searches, and the layers between may hold no
 * copy, so where one of the five above Shared has none, reading it gives a copy that only passes the
 * layer under it through ({@link automationsVfs}). Shared's copy is still written before any other
 * (`ensureBaseEventsCopy`); a `$BASE` with nothing there still names nothing.
 *
 * With no project (the shared root opened as one), the project's three layers are not there: `$JAIRA`
 * names Shared, and `$PROJECTMACHINE` and `$PROJECTYOU` name the machine's and the person's roots — the
 * layers they would stand over — so a copy that names them still reads.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { stateIdFromPath, type Vfs } from "@declarative-ai/hw";
import {
  LOCAL_LAYER_DIR_NAME,
  MACHINE_LAYER_DIR_NAME,
  PERSONAL_LAYER_DIR_NAME,
  eventsRefOf,
  projectSettingsKey,
  type JairaPaths,
  type SetLayer,
  type WorkflowLayer,
} from "@jaira/shared";
import { readRepositoryIdentity } from "./repositoryIdentity";
import { readWorkflowFiles } from "./snapshots";

/** One layer root: which layer, where, the explicit root a reference names it by, and how a person reads it. */
export interface FileLayerRoot {
  layer: SetLayer;
  /** The layer's root directory; its permission sets are under `permission-sets/`. */
  root: string;
  /** `$PROJECTYOU`, `$YOU`, `$PROJECTMACHINE`, `$MACHINE`, `$JAIRA`, `$BASE`, `$SYSTEM`. */
  token: string;
  /** The root as a person reads it in a path: `.jaira/local`, `~/.jaira/machine`. */
  label: string;
}

/** The layers that are no workflow root — the four the settings added (2026-11-17) — nearest first. */
const SETTINGS_ONLY: readonly SetLayer[] = ["projectYou", "you", "projectMachine", "machine"];

/**
 * A project's layer roots, nearest first. The shared root opened as a project has no layer of its own,
 * so none of the three a project has (`project`, `projectMachine`, `projectYou`) — as the settings read
 * it (`layerFilesOf`). A directory named twice is listed once, in its first place.
 */
export function fileLayerRoots(paths: JairaPaths): FileLayerRoot[] {
  const base = paths.base.baseDir;
  const own = resolve(paths.jairaDir) !== resolve(base);
  const key = own ? projectSettingsKey(readRepositoryIdentity(paths.projectDir), paths.projectDir) : undefined;
  const all: FileLayerRoot[] = [
    ...(key !== undefined ? [{ layer: "projectYou" as const, root: join(paths.base.projectSettingsDir, key), token: "$PROJECTYOU", label: `~/.jaira/projects/${key}` }] : []),
    { layer: "you", root: join(base, PERSONAL_LAYER_DIR_NAME), token: "$YOU", label: "~/.jaira/personal" },
    ...(own ? [{ layer: "projectMachine" as const, root: join(paths.jairaDir, LOCAL_LAYER_DIR_NAME), token: "$PROJECTMACHINE", label: ".jaira/local" }] : []),
    { layer: "machine", root: join(base, MACHINE_LAYER_DIR_NAME), token: "$MACHINE", label: "~/.jaira/machine" },
    ...(own ? [{ layer: "project" as const, root: paths.jairaDir, token: "$JAIRA", label: ".jaira" }] : []),
    { layer: "base", root: base, token: "$BASE", label: "~/.jaira" },
    { layer: "system", root: paths.builtIn.dir, token: "$SYSTEM", label: "built in" },
  ];
  const seen = new Set<string>();
  return all.filter((one) => {
    const at = resolve(one.root);
    if (seen.has(at)) return false;
    seen.add(at);
    return true;
  });
}

/**
 * The roots a bare `$` reference is searched along: the four settings-only layers' roots, nearest
 * first, ahead of the project's own `roots` (its `.jaira/`, the shared root, what ships).
 */
export function referenceRootPath(paths: JairaPaths): string[] {
  const out: string[] = [];
  for (const root of [...fileLayerRoots(paths).filter((one) => SETTINGS_ONLY.includes(one.layer)).map((one) => one.root), ...paths.roots]) {
    if (!out.includes(root)) out.push(root);
  }
  return out;
}

/**
 * The named roots of the four settings-only layers, for a reference that means exactly one: `{ MACHINE: … }`.
 * With no project, `PROJECTMACHINE` and `PROJECTYOU` name the machine's and the person's roots — the
 * layers they would stand over — so an automation that follows one still reads (see the header).
 */
export function settingsLayerRootNames(paths: JairaPaths): Record<string, string> {
  const named = Object.fromEntries(fileLayerRoots(paths).filter((one) => SETTINGS_ONLY.includes(one.layer)).map((one) => [one.token.slice(1), one.root]));
  return { PROJECTMACHINE: named["MACHINE"]!, PROJECTYOU: named["YOU"]!, ...named };
}

// --- automations along the six layers ----------------------------------------------------------

const STATE_EXTENSIONS = [".json", ".yaml", ".yml"] as const;

/** A path with forward slashes — how a reference spells one, whatever the platform. */
const slashed = (path: string): string => path.split(sep).join("/");

/** Where a layer root keeps its workflows: `<root>/workflows`. */
const workflowsOf = (root: string): string => join(root, "workflows");

/** One layer's `workflows/`: which layer, the directory, and the root a reference names its layer by. */
export interface WorkflowLayerDir {
  layer: WorkflowLayer;
  dir: string;
  /** `$PROJECTYOU` … `$SYSTEM`. */
  token: string;
  /** The layer's root, `workflows/` is under it. */
  root: string;
  /** The root as a person reads it: `~/.jaira/personal`, `.jaira`. */
  label: string;
}

/**
 * Every layer's `workflows/` a project searches, most specific first: you in the project, Just you, the
 * project on this machine, this machine, the project, Shared, what ships — each once (the shared root
 * opened as a project has none of a project's three). The project's, Shared's and what ships are the
 * directories its paths name, as they always were.
 */
export function workflowLayerDirs(paths: JairaPaths): WorkflowLayerDir[] {
  return fileLayerRoots(paths).map((one) => ({
    layer: one.layer,
    dir: one.layer === "project" ? paths.workflowsDir : one.layer === "base" ? paths.base.workflowsDir : one.layer === "system" ? paths.builtIn.workflowsDir : workflowsOf(one.root),
    token: one.token,
    root: one.root,
    label: one.label,
  }));
}

/** The four newer layers' `workflows/`, nearest first — the ones that stand in front of the project's. */
export function nearerWorkflowDirs(paths: JairaPaths): string[] {
  return workflowLayerDirs(paths)
    .filter((one) => SETTINGS_ONLY.includes(one.layer))
    .map((one) => one.dir);
}

/**
 * The states the four newer layers hold, by id, the nearest layer's copy of each: what stands in front
 * of the project's own files when a bundle loads (`loadWorkflowBundle`). Each layer's `workflows/` is
 * read exactly as a project's is (`readWorkflowFiles`): its state files, and its workflow SCRIPTS
 * compiled through the same compiler and cache, a state file and a script of one id refused. An id is
 * the file's path under the `workflows/` it was found in. A file that does not read throws, as a
 * project's own does for a run; `tolerant`, it is left out.
 */
export function nearerStates(paths: JairaPaths, tolerant = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Farthest first, so a nearer layer's copy of an id replaces a farther one's.
  for (const dir of [...nearerWorkflowDirs(paths)].reverse()) {
    if (!existsSync(dir)) continue;
    let files: Record<string, unknown>;
    try {
      files = readWorkflowFiles(dir, tolerant ? { onError: () => undefined } : {});
    } catch (e) {
      throw new Error(`${dir}: ${(e as Error).message}`);
    }
    for (const [key, doc] of Object.entries(files)) out[stateIdFromPath(key.split(sep).join("/"))] = doc;
  }
  return out;
}

/**
 * The filesystem with each newer layer's — and the project's — missing copy of the events workflow read
 * as one that passes the layer under it through: `{ $ref, transitions: [ …its lines ], children }`, all
 * three naming that layer. What lets every copy name its neighbour (`EVENTS_FOLLOWS`) whether or not
 * the neighbour holds one. Shared's is not made up: a `$BASE` with nothing there names nothing, as it
 * always has, and what writes a copy writes Shared's first.
 */
export function automationsVfs(vfs: Vfs, paths: JairaPaths): Vfs {
  const chain = fileLayerRoots(paths);
  const made = new Map<string, string>();
  const listed = new Set<string>();
  chain.forEach((one, index) => {
    if (one.layer === "base" || one.layer === "system") return;
    const next = chain[index + 1];
    if (next === undefined) return;
    const dir = join(workflowsOf(one.root), "system");
    if (STATE_EXTENSIONS.some((ext) => existsSync(join(dir, `events${ext}`)))) return;
    const under = eventsRefOf(next.token);
    made.set(slashed(join(dir, "events.json")), `${JSON.stringify({ $ref: under, transitions: [{ $ref: `...${under}.transitions` }], children: { $ref: `${under}.children` } })}\n`);
    listed.add(slashed(dir));
  });
  if (made.size === 0) return vfs;
  return {
    list: (dir) => {
      const real = vfs.list(dir);
      return !listed.has(slashed(dir)) || real.includes("events.json") ? real : [...real, "events.json"];
    },
    read: (path) => vfs.read(path) ?? made.get(slashed(path)),
  };
}

/** The line `.jaira/.gitignore` keeps the project's layer on this machine out of the repository with. */
export const LOCAL_LAYER_IGNORE = `${LOCAL_LAYER_DIR_NAME}/`;

/**
 * Make sure an EXISTING `.jaira/.gitignore` hides `local/` — the project's files on this machine — the
 * one line an ignore file made before that layer existed lacks, appended and nothing else touched. No
 * file: nothing is done here (the template, which carries the line, is `project.ts`'s to write).
 */
export function ensureLocalLayerIgnored(jairaDir: string): void {
  const ignoreFile = join(jairaDir, ".gitignore");
  let text: string;
  try {
    text = readFileSync(ignoreFile, "utf8");
  } catch {
    return;
  }
  const named = text.split(/\r?\n/).map((line) => line.trim().replace(/^\//, "").replace(/\/?\*{0,2}$/, ""));
  if (named.includes(LOCAL_LAYER_DIR_NAME)) return;
  const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  writeFileSync(ignoreFile, `${text}${separator}\n# Added by JaiRA: this project's files on this machine (its permission sets), which a clone elsewhere must not take.\n${LOCAL_LAYER_IGNORE}\n`, "utf8");
}
