/**
 * Persisting the artifacts the ENGINE registered (DESIGN §7.6).
 *
 * There are two ways an artifact comes into being, and the tools in `fileTools.ts`
 * only cover one of them:
 *
 *  1. an agent calls `write_file` — intercepted, placed, and recorded there;
 *  2. a state declares a `blob` output slot and its operation *returns* the
 *     content — a prompt state writing a plan, for instance. The engine registers
 *     that inline as an `ArtifactRef` and never touches the filesystem.
 *
 * Case 2 is the reason a workflow with no agent in it still produces files. The
 * engine is upstream and read-only from here, so rather than changing it, this
 * walks the run's outputs for the refs it left behind and applies the same
 * destination the tools use. One placement rule, two producers.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue } from "@declarative-ai/exec";
import type { ArtifactRecord, ArtifactStore } from "./artifacts";
import { parseDestination, resolveDestination, type Destination, type DestinationVars } from "./artifactPath";

/** The shape the engine registers for a blob output slot. */
export interface EngineArtifact {
  artifact: true;
  /** `<state.id.with.dots>#<instanceId>.<slot>` — the engine's naming. */
  name: string;
  format?: string;
  content?: string;
}

export function isEngineArtifact(value: unknown): value is EngineArtifact {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { artifact?: unknown; name?: unknown };
  return candidate.artifact === true && typeof candidate.name === "string";
}

/** Every artifact ref anywhere in a value, depth-first. */
export function collectEngineArtifacts(value: JsonValue | undefined): EngineArtifact[] {
  const found: EngineArtifact[] = [];
  const walk = (node: unknown): void => {
    if (isEngineArtifact(node)) {
      found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const item of Object.values(node as Record<string, unknown>)) walk(item);
    }
  };
  walk(value);
  return found;
}

/**
 * Split the engine's artifact name into the pieces a destination template wants.
 *
 * `feature.plan.context#3.plan_doc` → state `feature/plan/context`, instance 3,
 * slot `plan_doc`. The engine flattens `/` to `.` when it builds the name, so the
 * state id cannot be recovered exactly — it is reported dotted, which is fine
 * because `$STATE_ID` is sanitized into one path segment anyway.
 */
export function parseArtifactName(name: string): { stateId?: string; instanceId?: number; slot?: string } {
  const match = /^(.*)#(\d+)\.([^.]+)$/.exec(name);
  if (!match) return {};
  return { stateId: match[1]!, instanceId: Number(match[2]), slot: match[3]! };
}

/** A sensible logical path for an engine artifact: `<slot>.<ext from format>`. */
export function logicalPathFor(artifact: EngineArtifact, slot: string | undefined): string {
  const ext = extensionFor(artifact.format);
  const base = slot ?? artifact.name.replace(/[^A-Za-z0-9_.-]/g, "-");
  return ext ? `${base}.${ext}` : base;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  "text/markdown": "md",
  markdown: "md",
  "text/plain": "txt",
  "application/json": "json",
  "text/html": "html",
  "text/csv": "csv",
  "application/x-patch": "patch",
};

function extensionFor(format: string | undefined): string | undefined {
  if (format === undefined) return undefined;
  const known = EXTENSIONS[format.toLowerCase()];
  if (known !== undefined) return known;
  // `application/x-thing` → `thing`; anything stranger is left alone rather than
  // guessed at.
  const tail = format.split("/").pop() ?? "";
  return /^[A-Za-z0-9]{1,8}$/.test(tail) ? tail.toLowerCase() : undefined;
}

export interface PersistArtifactsOptions {
  destination: Destination;
  store: ArtifactStore;
  vars: Omit<DestinationVars, "relPath" | "instanceId" | "stateId" | "slot">;
  runId?: number;
  inlineMaxBytes?: number;
  now?: () => number;
  /** Reported rather than thrown: one unwritable artifact must not fail a finished run. */
  onError?: (name: string, error: Error) => void;
}

const DEFAULT_INLINE_MAX = 65_536;

/**
 * Everything a run needs to place artifacts, assembled once from project config.
 *
 * Both the CLI and the app call this rather than each assembling the pieces, so
 * the two surfaces cannot drift on where files go — the same failure mode that
 * let the CLI skip agent registration entirely (§1j).
 */
export interface ArtifactWiring {
  destination: Destination;
  vars: Omit<DestinationVars, "relPath" | "instanceId" | "stateId" | "slot">;
  inlineMaxBytes: number;
}

export function artifactWiring(input: {
  destination: string;
  artifactDir: string;
  inlineMaxBytes: number;
  taskId: string;
  runId?: number;
  /** The task's workspace (worktree, or the project dir when unbound). */
  workspaceRoot: string;
  projectDir: string;
  jairaDir: string;
}): ArtifactWiring {
  return {
    destination: parseDestination(input.destination),
    inlineMaxBytes: input.inlineMaxBytes,
    vars: {
      worktree: input.workspaceRoot,
      project: input.projectDir,
      jaira: input.jairaDir,
      artifactDir: input.artifactDir,
      taskId: input.taskId,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    },
  };
}

/**
 * Write every engine-registered artifact in `outputs` to its configured
 * destination and record it.
 *
 * Runs after the workflow finishes, so a failure here cannot fail the run — the
 * work is already done and the content is already in the journal. Errors are
 * reported, not thrown.
 */
export function persistEngineArtifacts(
  outputs: JsonValue | undefined,
  options: PersistArtifactsOptions,
): ArtifactRecord[] {
  const now = options.now ?? Date.now;
  const inlineMax = options.inlineMaxBytes ?? DEFAULT_INLINE_MAX;
  const written: ArtifactRecord[] = [];

  for (const artifact of collectEngineArtifacts(outputs)) {
    const content = artifact.content;
    if (typeof content !== "string") continue; // a ref with no inline content: nothing to write
    const { stateId, instanceId, slot } = parseArtifactName(artifact.name);
    const logicalPath = logicalPathFor(artifact, slot);
    try {
      const resolved = resolveDestination(
        options.destination,
        {
          ...options.vars,
          ...(instanceId !== undefined ? { instanceId } : {}),
          ...(stateId !== undefined ? { stateId } : {}),
          ...(slot !== undefined ? { slot } : {}),
          relPath: logicalPath,
        },
        logicalPath,
      );
      const bytes = Buffer.byteLength(content, "utf8");
      if (resolved.path !== undefined) {
        mkdirSync(dirname(resolved.path), { recursive: true });
        writeFileSync(resolved.path, content, "utf8");
      }
      const record: ArtifactRecord = {
        taskId: options.vars.taskId,
        ...(options.runId !== undefined ? { runId: options.runId } : {}),
        logicalPath,
        ...(resolved.path !== undefined ? { physicalPath: resolved.path } : {}),
        ...(resolved.scheme === "virtual" || bytes <= inlineMax ? { content } : {}),
        hash: createHash("sha256").update(content, "utf8").digest("hex"),
        bytes,
        ...(artifact.format !== undefined ? { format: artifact.format } : {}),
        ...(instanceId !== undefined ? { instanceId } : {}),
        ...(stateId !== undefined ? { stateId } : {}),
        ...(slot !== undefined ? { slot } : {}),
        createdAt: now(),
      };
      options.store.put(record);
      written.push(record);
    } catch (e) {
      options.onError?.(artifact.name, e as Error);
    }
  }
  return written;
}
