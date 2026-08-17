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
import { mimeOfPath } from "@jaira/shared";
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
export const EDIT_FILE = "edit";
export const SHOW_ARTIFACT = "show_artifact";

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

/**
 * The current content of a logical path — the read half, without the tool around it.
 *
 * Split out because `edit` needs exactly what `read_file` does and for the same reason: an artifact
 * written to a virtual destination is not on disk at the path the agent knows it by, so an edit that
 * went straight to the filesystem would either miss it or, worse, create a second copy beside it.
 */
function currentContent(options: FileToolOptions, logical: string, ctx?: ExecServices): { text: string } | { error: string } {
  const store = options.store ?? new MemoryArtifactStore();
  const record = store.get(options.vars.taskId, logical);
  if (record?.content !== undefined) return { text: record.content };
  const target = record?.physicalPath ?? withinWorkspace(ctx?.workspace?.root ?? options.cwd ?? options.vars.worktree, logical);
  if (target === undefined) return { error: `'${logical}' is outside the workspace` };
  try {
    return { text: readFileSync(target, "utf8") };
  } catch (e) {
    return { error: `could not read '${logical}': ${(e as Error).message}` };
  }
}

/**
 * `edit` — replace exact text in a file that already exists.
 *
 * The distinction from `write_file` is intent, and intent is the whole argument for having both. A
 * write says "the file is now this", and a model that meant to change one line and returned the file
 * whole has silently reverted everything it did not think to include. An edit says "this became
 * that", which fails loudly when the file is not what the model believed — and being wrong about the
 * current content is the failure mode that matters.
 *
 * So a match that is not unique is REFUSED rather than resolved by picking the first. Two identical
 * fragments mean the caller has not identified the one it meant, and choosing for it is how an edit
 * lands in the wrong function.
 */
export function createEditFileTool(options: FileToolOptions): Tool {
  const destination = options.destination ?? parseDestination("$DEFAULT");
  const store = options.store ?? new MemoryArtifactStore();
  const now = options.now ?? Date.now;
  return {
    description:
      "Replace exact text in an existing workspace file. `old` must appear exactly once unless `all` is set. Use write_file to create a file or replace one whole.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        old: { type: "string", description: "The exact text to replace, including its indentation." },
        new: { type: "string", description: "What to put in its place. Empty deletes it." },
        all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." },
      },
      required: ["path", "old", "new"],
    },
    readOnly: false,
    run: async (input, ctx?: ExecServices): Promise<JsonValue> => {
      const args = (input ?? {}) as { path?: unknown; old?: unknown; new?: unknown; all?: unknown };
      const logical = logicalKey(typeof args.path === "string" ? args.path : "");
      const refusal = refusePath(logical);
      if (refusal !== undefined) return { error: refusal };
      const oldText = typeof args.old === "string" ? args.old : "";
      const newText = typeof args.new === "string" ? args.new : "";
      if (oldText === "") return { error: "`old` is empty — use write_file to create a file" };
      if (oldText === newText) return { error: "`old` and `new` are identical, so this edit would change nothing" };

      const read = currentContent(options, logical, ctx);
      if ("error" in read) return { error: read.error };
      const occurrences = read.text.split(oldText).length - 1;
      if (occurrences === 0) return { error: `'${logical}' does not contain that text` };
      if (occurrences > 1 && args.all !== true) {
        return { error: `that text appears ${occurrences} times in '${logical}' — include more context, or set \`all\`` };
      }
      const content = args.all === true ? read.text.split(oldText).join(newText) : read.text.replace(oldText, newText);

      try {
        const { record, physicalPath } = place(options, destination, options.vars.taskId, logical, content, now());
        if (physicalPath !== undefined) {
          mkdirSync(dirname(physicalPath), { recursive: true });
          writeFileSync(physicalPath, content, "utf8");
        }
        store.put(record);
        return { path: logical, replaced: args.all === true ? occurrences : 1, bytes: record.bytes };
      } catch (e) {
        if (e instanceof DestinationError) return { error: e.message };
        return { error: `could not write '${logical}': ${(e as Error).message}` };
      }
    },
  } as Tool;
}

/**
 * Where a SHOWN artifact goes — the artifact directory, never the workspace at large.
 *
 * This is what makes `show_artifact` genuinely non-destructive rather than merely intended to be.
 * The configured destination is not used, because the default one (`$DEFAULT` = `$WORKTREE/$RELPATH`)
 * puts an agent-chosen path straight into the workspace: `show_artifact({path: "src/index.ts"})`
 * would overwrite source, and a tool that can do that is a writer whatever we call it.
 *
 * `$CENTRAL` (`$WORKTREE/$ARTIFACT_DIR/$TASK_ID/$RELPATH`) fixes the author-controlled prefix at the
 * task's artifact directory, which is precisely the boundary `resolveDestination` confines a model's
 * `$RELPATH` to — so `../../src/index.ts` is refused rather than clamped. That containment already
 * existed and is already tested; this just points the tool at it.
 *
 * `virtual:` is kept as-is when configured, because it writes nothing at all — which is as
 * non-destructive as a destination gets, and a project that chose it did so deliberately.
 *
 * The logical path is still whatever the producer said, so the artifact map answers a later
 * `read_file` for it — the same shadowing every artifact under a non-`$DEFAULT` destination already
 * has, and the reason the round trip holds at all.
 */
function showDestination(configured: Destination | undefined): Destination {
  if (configured?.scheme === "virtual") return configured;
  return parseDestination("$CENTRAL");
}

/**
 * `show_artifact` — produce something for a person to LOOK AT.
 *
 * The distinction from `write_file` is the audience, and it is what earns a second tool rather than a
 * flag. A write says "this belongs in the workspace"; a show says "this is a result, and it has a
 * rendering". Everything downstream turns on the second claim: the media type reaches the renderer,
 * the transcript draws the page instead of printing its tags, and the value carries a reference that
 * outlives the call.
 *
 * It is deliberately the SAME artifact map underneath. Three producers converge there already — an
 * engine-registered `blob` output slot, an agent's `write_file`, and now this — and a widget channel
 * beside the map would be a fourth place for "content a run made" to live, which is how a task's
 * output comes to depend on which door it walked through.
 *
 * ## Two calls, one tool
 *
 * With `content`, it creates. Without, it shows what is already at `path` — which is the whole of
 * "send the user this file", and needs nothing new because {@link currentContent} already resolves a
 * logical path through the map and then the workspace. Splitting those into two tools would give a
 * model two names for one intention and a reason to pick wrong.
 *
 * ## What comes back
 *
 * An ENVELOPE — `{path, mediaType, bytes, uri}` — and the content with it while it is small enough to
 * inline. Deliberately not the engine's `{artifact: true, …}` spelling: that shape is what
 * `persistEngineArtifacts` walks a run's outputs for, and returning it would offer this artifact for
 * placement a second time under a name derived from a slot it never came out of. Both spellings read
 * as one artifact to `artifactOf`, so the renderer does not care which it gets.
 */
export function createShowArtifactTool(options: FileToolOptions): Tool {
  const destination = showDestination(options.destination);
  const store = options.store ?? new MemoryArtifactStore();
  const now = options.now ?? Date.now;
  const inlineMax = options.inlineMaxBytes ?? DEFAULT_INLINE_MAX;
  return {
    description:
      "Show the user something you produced — an HTML page, an SVG drawing, a markdown document. Give `content` to create it, or just a `path` to show something that already exists. It is rendered in the conversation, so give it a path whose extension says what it is (mockup.html, chart.svg).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to the workspace root. Its extension is how the media type is inferred.",
        },
        content: {
          type: "string",
          description: "The full contents. Omit to show what is already at this path.",
        },
        mediaType: {
          type: "string",
          description: "Overrides what the extension implies, e.g. `text/html`, `image/svg+xml`, `text/markdown`.",
        },
        interactive: {
          type: "boolean",
          description:
            "Set only if the page needs its own scripts to run — a control that responds, a chart that filters. It is then shown in an isolated frame that can reach nothing: no network, no storage, no access to the app. A static page or drawing does not need this and should not ask for it.",
        },
      },
      required: ["path"],
    },
    // Nothing that was already there is different afterwards — see {@link showDestination} for the
    // confinement that makes that true, and the vocabulary entry for why it is the right reading.
    readOnly: true,
    run: async (input, ctx?: ExecServices): Promise<JsonValue> => {
      const args = (input ?? {}) as { path?: unknown; content?: unknown; mediaType?: unknown; interactive?: unknown };
      const logical = logicalKey(typeof args.path === "string" ? args.path : "");
      const refusal = refusePath(logical);
      if (refusal !== undefined) return { error: refusal };
      const interactive = args.interactive === true;

      // The declared type beats the inferred one — an author who says `text/html` about a file named
      // `.txt` is making a statement, and `mimeOfPath` is only ever a guess from a name.
      const declared = typeof args.mediaType === "string" && args.mediaType !== "" ? args.mediaType : undefined;
      const mediaType = declared ?? mimeOfPath(logical);
      const taskId = options.vars.taskId;
      const uri = `artifact://${taskId}/${logical}`;

      // No `content`: this is "show what is already there", and the bytes are wherever they landed.
      if (typeof args.content !== "string") {
        const read = currentContent(options, logical, ctx);
        if ("error" in read) return { error: read.error };
        const bytes = Buffer.byteLength(read.text, "utf8");
        return {
          path: logical,
          mediaType,
          bytes,
          uri,
          ...(bytes <= inlineMax ? { content: read.text } : {}),
        };
      }

      const content = args.content;
      try {
        const { record, physicalPath } = place(options, destination, taskId, logical, content, now());
        if (physicalPath !== undefined) {
          mkdirSync(dirname(physicalPath), { recursive: true });
          writeFileSync(physicalPath, content, "utf8");
        }
        // The declared type is recorded, so what the renderer is told the bytes ARE survives the run
        // that made them — a `.txt` holding a diagram renders as a diagram tomorrow too.
        store.put({ ...record, format: mediaType, ...(interactive ? { interactive } : {}) });
        return {
          path: logical,
          mediaType,
          bytes: record.bytes,
          uri,
          ...(interactive ? { interactive } : {}),
          ...(record.bytes <= inlineMax ? { content } : {}),
        };
      } catch (e) {
        if (e instanceof DestinationError) return { error: e.message };
        return { error: `could not show '${logical}': ${(e as Error).message}` };
      }
    },
  } as Tool;
}

/** Register the file tools on a registry's `tools` facet. */
export function registerFileTools(registry: { tools: Map<string, Tool> }, options: FileToolOptions): void {
  registry.tools.set(WRITE_FILE, createWriteFileTool(options));
  registry.tools.set(READ_FILE, createReadFileTool(options));
  registry.tools.set(EDIT_FILE, createEditFileTool(options));
  registry.tools.set(SHOW_ARTIFACT, createShowArtifactTool(options));
}
