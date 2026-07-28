/**
 * `write_file` / `read_file` — the tools that make JaiRA own an agent's writes
 * (DESIGN §7.6).
 *
 * This is the whole artifact mechanism, and it works because of where the engine
 * puts us: a delegated agent's tools are injected over MCP as
 * `run: (input) => tool.run(input, ctx)`, so **our implementation is called with
 * the agent's raw arguments**. Registering these two turns every agent write into a
 * call we service:
 *
 *   write_file({ path: "docs/plan.md" })
 *     → policy checks the LOGICAL path (what a human would be asked to approve)
 *     → resolve logical → physical, per the configured destination
 *     → write, and record the mapping
 *     → report success, naming the path the agent used
 *
 * The agent is never told the file moved. A later `read_file` of the same logical
 * path consults the map first, so the round trip holds under every destination;
 * a read that misses falls through to the real workspace, leaving ordinary source
 * files alone.
 *
 * The limit, stated where it is implemented: this only covers tools we serve. An
 * agent using its own native write, or `bash` with a redirection, never reaches
 * here — see §7.6's reconciliation note.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecServices, JsonValue, Tool } from "@declarative-ai/exec";
import type { ArtifactRecord, ArtifactStore } from "./artifacts";
import { MemoryArtifactStore } from "./artifacts";
import {
  DestinationError,
  parseDestination,
  resolveDestination,
  withinWorkspace,
  type Destination,
  type DestinationVars,
} from "./artifactPath";
import { isDeniedPath } from "./policy";

export const WRITE_FILE = "write_file";
export const READ_FILE = "read_file";

export interface FileToolOptions {
  /** The parsed `config.artifacts.destination`. Defaults to `$DEFAULT`. */
  destination?: Destination;
  /** Where records go. Defaults to a fresh in-memory store. */
  store?: ArtifactStore;
  /** Everything the destination template can interpolate, minus the per-write parts. */
  vars: Omit<DestinationVars, "relPath">;
  /** Keep content inline at or below this size (also what `virtual:` always does). */
  inlineMaxBytes?: number;
  /** Fallback workspace root when the operation carries no `ctx.workspace`. */
  cwd?: string;
  now?: () => number;
}

const DEFAULT_INLINE_MAX = 65_536;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Normalize an agent-supplied path to the map's key form. */
function logicalKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Reject a path before it is resolved.
 *
 * Deliberately checked on the LOGICAL path: that is what the author wrote policy
 * against and what an approval dialog would show. Checking only the physical path
 * would let a destination template quietly launder a denied location.
 */
function refusePath(logical: string): string | undefined {
  if (logical.trim().length === 0) return "no path given";
  if (isDeniedPath(logical)) return `'${logical}' is inside .jaira/, which agents may not write`;
  return undefined;
}

interface Resolved {
  record: ArtifactRecord;
  physicalPath?: string;
}

function place(
  options: FileToolOptions,
  destination: Destination,
  taskId: string,
  logical: string,
  content: string,
  now: number,
): Resolved {
  const bytes = Buffer.byteLength(content, "utf8");
  const inlineMax = options.inlineMaxBytes ?? DEFAULT_INLINE_MAX;
  const resolved = resolveDestination(destination, { ...options.vars, relPath: logical }, logical);
  const record: ArtifactRecord = {
    taskId,
    logicalPath: logical,
    hash: sha256(content),
    bytes,
    createdAt: now,
    // `virtual:` keeps everything; a file destination keeps small content inline so
    // bindings and prompts stay cheap without a read.
    ...(resolved.scheme === "virtual" || bytes <= inlineMax ? { content } : {}),
    ...(resolved.path !== undefined ? { physicalPath: resolved.path } : {}),
  };
  return { record, ...(resolved.path !== undefined ? { physicalPath: resolved.path } : {}) };
}

/**
 * The tool an agent calls to write a file.
 *
 * `readOnly: false` matters: it is what the `read-only` and `plan` permission
 * profiles gate on, so a plan-mode session cannot write at all regardless of the
 * per-path policy.
 */
export function createWriteFileTool(options: FileToolOptions): Tool {
  const destination = options.destination ?? parseDestination("$DEFAULT");
  const store = options.store ?? new MemoryArtifactStore();
  const now = options.now ?? Date.now;
  return {
    description:
      "Write a file in the task's workspace. The path is where you will find it again; JaiRA may store the bytes elsewhere according to project configuration.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        content: { type: "string", description: "The file's full contents." },
      },
      required: ["path", "content"],
    },
    readOnly: false,
    run: async (input): Promise<JsonValue> => {
      const args = (input ?? {}) as { path?: unknown; content?: unknown };
      const logical = logicalKey(typeof args.path === "string" ? args.path : "");
      const content = typeof args.content === "string" ? args.content : "";
      const refusal = refusePath(logical);
      if (refusal !== undefined) return { error: refusal };

      try {
        const { record, physicalPath } = place(options, destination, options.vars.taskId, logical, content, now());
        if (physicalPath !== undefined) {
          mkdirSync(dirname(physicalPath), { recursive: true });
          writeFileSync(physicalPath, content, "utf8");
        }
        store.put(record);
        // The agent is told about the path IT used. Reporting the physical path
        // would break the illusion the whole design depends on.
        return { path: logical, bytes: record.bytes };
      } catch (e) {
        if (e instanceof DestinationError) return { error: e.message };
        return { error: `could not write '${logical}': ${(e as Error).message}` };
      }
    },
  } as Tool;
}

/**
 * The matching read. Map first, workspace second — so an artifact resolves wherever
 * it was placed, and an ordinary source file is read normally.
 */
export function createReadFileTool(options: FileToolOptions): Tool {
  const store = options.store ?? new MemoryArtifactStore();
  return {
    description: "Read a file from the task's workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the workspace root." } },
      required: ["path"],
    },
    readOnly: true,
    run: async (input, ctx?: ExecServices): Promise<JsonValue> => {
      const args = (input ?? {}) as { path?: unknown };
      const logical = logicalKey(typeof args.path === "string" ? args.path : "");
      const refusal = refusePath(logical);
      if (refusal !== undefined) return { error: refusal };

      const record = store.get(options.vars.taskId, logical);
      if (record?.content !== undefined) return { path: logical, content: record.content };
      const target =
        record?.physicalPath ??
        withinWorkspace(ctx?.workspace?.root ?? options.cwd ?? options.vars.worktree, logical);
      if (target === undefined) return { error: `'${logical}' is outside the workspace` };
      try {
        return { path: logical, content: readFileSync(target, "utf8") };
      } catch (e) {
        return { error: `could not read '${logical}': ${(e as Error).message}` };
      }
    },
  } as Tool;
}

/** Register both file tools on a registry's `tools` facet. */
export function registerFileTools(registry: { tools: Map<string, Tool> }, options: FileToolOptions): void {
  registry.tools.set(WRITE_FILE, createWriteFileTool(options));
  registry.tools.set(READ_FILE, createReadFileTool(options));
}
