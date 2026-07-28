/**
 * Artifact destinations (DESIGN §7.6): where the bytes of an artifact actually go.
 *
 * The destination is a URI/path **template**, not one of a fixed set of modes,
 * because "which backend" and "how the path is derived" are independent questions.
 * A scheme answers the first (`virtual:` = memory, `file:` = disk, implicit when
 * omitted); a closed set of `$VARIABLES` answers the second. One string then
 * expresses every placement anyone has asked for — and adding a backend later adds
 * a scheme rather than multiplying an enum.
 *
 * Three rules keep it safe, and each exists because of a specific way this could
 * go wrong:
 *
 *  - **Unknown variables are an error, not an empty string.** `$WORKTRE/$RELPATH`
 *    would otherwise silently resolve to `/plan.md` — a path outside the project.
 *  - **The resolved path must stay inside the template's anchor.** `$RELPATH` is
 *    agent-controlled, so `../../etc/passwd` is reachable from a model's output.
 *  - **Substitution happens after the path VIEW is chosen.** `$WORKTREE` is not one
 *    string: a WSL project's agent sees `/mnt/c/…` where the host sees `C:\…`.
 */
import { isAbsolute, join, normalize, relative as relPath, resolve as resolvePath } from "node:path";

/** The backend a destination names. */
export type ArtifactScheme = "virtual" | "file";

/** Everything a template may interpolate. Anything else is a config error. */
export interface DestinationVars {
  /** The task's worktree root (the project dir when the task is unbound). */
  worktree: string;
  project: string;
  /** `<project>/.jaira`. */
  jaira: string;
  /** `config.artifacts.dir`. */
  artifactDir: string;
  taskId: string;
  runId?: number | string;
  instanceId?: number | string;
  stateId?: string;
  slot?: string;
  /** The logical path the producer used, relative to the workspace. */
  relPath?: string;
}

/** A parsed, validated destination template. */
export interface Destination {
  scheme: ArtifactScheme;
  /** The template with its scheme stripped and aliases expanded. */
  template: string;
  /** The template exactly as authored, for error messages. */
  source: string;
}

/**
 * One-word spellings of the placements people actually pick, expanded before
 * anything else. They are aliases rather than enum values on purpose: a project
 * that wants `$CENTRAL` but one directory deeper writes the expansion out and
 * edits it, instead of asking for a new mode.
 */
export const DESTINATION_ALIASES: Readonly<Record<string, string>> = {
  DEFAULT: "$WORKTREE/$RELPATH",
  CENTRAL: "$WORKTREE/$ARTIFACT_DIR/$TASK_ID/$RELPATH",
  CENTRAL_FLAT: "$WORKTREE/$ARTIFACT_DIR/$TASK_ID/$INSTANCE_ID-$SLOT.$EXT",
};

/** Base variables, resolved from {@link DestinationVars} plus the logical path. */
const BASE_VARIABLES = [
  "WORKTREE",
  "PROJECT",
  "JAIRA",
  "ARTIFACT_DIR",
  "TASK_ID",
  "RUN_ID",
  "INSTANCE_ID",
  "STATE_ID",
  "SLOT",
  "RELPATH",
  "BASENAME",
  "EXT",
] as const;

/** Variables that anchor a template to a root; one must lead, or the path is workspace-relative. */
const ANCHORS = new Set(["WORKTREE", "PROJECT", "JAIRA"]);

/**
 * Variables derived from the producer's own path — the agent-controlled part.
 *
 * The containment root is the template's longest leading run that mentions none of
 * these: everything the *author* fixed is the boundary, everything the *model*
 * supplied must stay under it. Anchoring on `$WORKTREE` instead would let
 * `$CENTRAL` + `../../src/index.ts` climb out of the artifact directory and
 * overwrite source, while still technically being "inside the worktree".
 */
const AGENT_CONTROLLED = new Set(["RELPATH", "BASENAME", "EXT"]);

const VAR = /\$([A-Z_][A-Z0-9_]*)/g;

export class DestinationError extends Error {}

/**
 * Parse and validate `config.artifacts.destination`.
 *
 * Runs at project open rather than at first write, so a typo is a startup error
 * instead of a surprise three states into a run.
 */
export function parseDestination(source: string): Destination {
  const trimmed = source.trim();
  if (trimmed.length === 0) throw new DestinationError("artifact destination is empty");

  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(\/\/)?(.*)$/.exec(trimmed);
  let scheme: ArtifactScheme = "file";
  let body = trimmed;
  if (match) {
    const name = match[1]!.toLowerCase();
    // A bare Windows drive letter (`C:\…`) parses as a scheme; it is a path.
    const isDriveLetter = match[1]!.length === 1;
    if (!isDriveLetter) {
      if (name !== "virtual" && name !== "file") {
        throw new DestinationError(
          `unknown artifact destination scheme '${match[1]!}:' — expected 'virtual:' or 'file:' (or no scheme, which means file:)`,
        );
      }
      scheme = name;
      body = match[3] ?? "";
    }
  }

  if (scheme === "virtual") {
    if (body.trim().length > 0) {
      throw new DestinationError(`'virtual:' takes no path, got '${body}'`);
    }
    return { scheme, template: "", source };
  }

  // Expand aliases first, bounded — an alias that expanded to another alias
  // forever would hang the loader.
  let template = body;
  for (let pass = 0; pass < 4 && /\$[A-Z_]/.test(template); pass++) {
    const before = template;
    template = template.replace(VAR, (whole, name: string) => DESTINATION_ALIASES[name] ?? whole);
    if (template === before) break;
  }

  const known = new Set<string>(BASE_VARIABLES);
  for (const [, name] of template.matchAll(VAR)) {
    if (!known.has(name!)) {
      throw new DestinationError(
        `unknown variable '$${name}' in artifact destination '${source}' — known: ${[...Object.keys(DESTINATION_ALIASES), ...BASE_VARIABLES].map((v) => `$${v}`).join(", ")}`,
      );
    }
  }
  if (template.trim().length === 0) throw new DestinationError(`artifact destination '${source}' has no path`);
  return { scheme, template, source };
}

/** Split a logical path into the pieces `$BASENAME` / `$EXT` expose. */
function decompose(logical: string): { basename: string; ext: string } {
  const name = logical.split(/[\\/]/).pop() ?? logical;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { basename: name.slice(0, dot), ext: name.slice(dot + 1) } : { basename: name, ext: "" };
}

/** Everything a path segment must not contain once substituted. */
function sanitizeSegment(value: string): string {
  // A slot name or state id becomes ONE path segment; `/` in either would silently
  // create directories the template never asked for.
  return value.replace(/[\\/]/g, "-").replace(/\.\./g, "-");
}

export interface ResolvedDestination {
  scheme: ArtifactScheme;
  /** Absolute path, in the same view as the `worktree`/`project` inputs. Absent for `virtual:`. */
  path?: string;
  /** The root the result was confined to. */
  root?: string;
}

/**
 * Resolve a destination for one artifact.
 *
 * `vars.worktree` / `vars.project` decide the path VIEW: pass the host's spelling
 * for a host-side write, or the distro's for a path an agent inside WSL will see.
 * Substitution deliberately happens here rather than at parse time for exactly
 * that reason.
 */
export function resolveDestination(
  destination: Destination,
  vars: DestinationVars,
  logicalPath: string,
): ResolvedDestination {
  if (destination.scheme === "virtual") return { scheme: "virtual" };

  const normalizedLogical = logicalPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const { basename, ext } = decompose(normalizedLogical);
  const values: Record<string, string> = {
    WORKTREE: vars.worktree,
    PROJECT: vars.project,
    JAIRA: vars.jaira,
    ARTIFACT_DIR: vars.artifactDir,
    TASK_ID: sanitizeSegment(vars.taskId),
    RUN_ID: vars.runId !== undefined ? sanitizeSegment(String(vars.runId)) : "",
    INSTANCE_ID: vars.instanceId !== undefined ? sanitizeSegment(String(vars.instanceId)) : "",
    STATE_ID: vars.stateId !== undefined ? sanitizeSegment(vars.stateId) : "",
    SLOT: vars.slot !== undefined ? sanitizeSegment(vars.slot) : "",
    // NOT sanitized: `$RELPATH` is meant to carry directories. It is the reason the
    // containment check below exists.
    RELPATH: vars.relPath ?? normalizedLogical,
    BASENAME: sanitizeSegment(basename),
    EXT: sanitizeSegment(ext),
  };

  const substitute = (text: string): string => text.replace(VAR, (whole, name: string) => values[name] ?? whole);

  // Where the author's fixed part ends and the model's begins.
  let firstAgentVar = destination.template.length;
  for (const m of destination.template.matchAll(VAR)) {
    if (AGENT_CONTROLLED.has(m[1]!)) {
      firstAgentVar = m.index!;
      break;
    }
  }
  // …truncated to the last directory boundary before it, since a root has to be a
  // directory: `$CENTRAL_FLAT` ends `$INSTANCE_ID-$SLOT.$EXT`, and cutting
  // mid-filename would yield the non-directory root `…/7-plan_doc.`.
  const head = destination.template.slice(0, firstAgentVar);
  const lastSep = Math.max(head.lastIndexOf("/"), head.lastIndexOf("\\"));
  const fixedPrefix = lastSep >= 0 ? head.slice(0, lastSep) : "";

  // The base a relative template hangs off: the leading anchor variable, else the
  // workspace.
  const leading = VAR.exec(destination.template);
  VAR.lastIndex = 0;
  const anchorName = leading !== null && destination.template.startsWith(leading[0]) ? leading[1]! : undefined;
  const base = anchorName !== undefined && ANCHORS.has(anchorName) ? values[anchorName]! : vars.worktree;

  const rootRaw = substitute(fixedPrefix);
  const root = normalize(isAbsolute(rootRaw) ? rootRaw : resolvePath(base, rootRaw || "."));

  // Containment, level one: the ROOT itself must stay under its anchor. The fixed
  // prefix is author-supplied, not agent-supplied, but it interpolates config
  // (`$ARTIFACT_DIR`), so `"dir": "../../escape"` would otherwise place the whole
  // artifact tree outside the project — a typo with filesystem-wide reach. An
  // explicitly ABSOLUTE template is exempt: writing `/var/artifacts/$RELPATH` is an
  // unambiguous choice, whereas `..` climbing out of an anchor is not.
  if (!isAbsolute(destination.template)) {
    const rootInside = relPath(base, root);
    if (rootInside.startsWith("..") || isAbsolute(rootInside)) {
      throw new DestinationError(
        `artifact destination '${destination.source}' resolves its root to '${root}', outside '${base}' — use an absolute path if that is intended`,
      );
    }
  }

  const substituted = substitute(destination.template);
  const absolute = isAbsolute(substituted) ? normalize(substituted) : resolvePath(base, substituted);

  // The containment check. `$RELPATH` comes from a model, so `../../` is reachable
  // from generated content; a destination that escapes its own root is refused
  // rather than clamped, because clamping would silently write somewhere the author
  // did not name.
  const inside = relPath(root, absolute);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new DestinationError(
      `artifact path '${logicalPath}' resolves to '${absolute}', outside the destination root '${root}'`,
    );
  }
  return { scheme: "file", path: absolute, root };
}

/** Join a workspace-relative logical path onto a root, for the pass-through read case. */
export function withinWorkspace(root: string, logicalPath: string): string | undefined {
  const absolute = isAbsolute(logicalPath) ? normalize(logicalPath) : resolvePath(root, logicalPath);
  const inside = relPath(root, absolute);
  if (inside.startsWith("..") || isAbsolute(inside)) return undefined;
  return absolute;
}

/** `join` that keeps forward slashes, for building logical (agent-facing) paths. */
export function logicalJoin(...parts: string[]): string {
  return join(...parts).replace(/\\/g, "/");
}
