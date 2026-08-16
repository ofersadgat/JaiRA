/**
 * `glob` and `grep` — finding files, and finding things in them.
 *
 * These existed already, twice over, and neither copy was ours. An agent that reaches for its own
 * `Glob` is a call we never see: not gated, not journalled, not subject to the destination map that
 * makes `read_file` able to find an artifact somebody wrote to a virtual path. And a state that
 * declared only `bash` got the same capability through `find` and `rg` with none of the structure —
 * one opaque command line where there should be an intent we can read.
 *
 * That is the whole argument for implementing them rather than leaning on the shell: `glob` says
 * "list files matching this", which a policy can reason about, a transcript can summarize, and a
 * person can approve. `bash("find . -name '*.ts' -delete")` says "run this", and the only thing that
 * can reason about it is a command parser trying to reconstruct the intent we started with.
 *
 * Both are `readOnly`, both are confined to the workspace, and both are bounded — a walk that could
 * enumerate a `node_modules` is a walk that hangs a run, so the limits are part of the contract
 * rather than a defensive afterthought.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ExecServices, JsonValue, Tool } from "@declarative-ai/exec";
import { globToRegExp } from "@jaira/shared";
import { withinWorkspace } from "./artifactPath";
import { isDeniedPath } from "./policy";

export const GLOB = "glob";
export const GREP = "grep";

export interface SearchToolOptions {
  /** Fallback workspace root when the operation carries no `ctx.workspace`. */
  cwd?: string;
}

/**
 * Directories never walked.
 *
 * Not a performance tweak: a `node_modules` in a real project holds more files than the rest of the
 * repository by two orders of magnitude, so a walk that entered one would spend its whole budget
 * there and report a truncated list that happens to contain nothing anybody asked about. `.jaira` is
 * excluded for the reason `isDeniedPath` exists — it is the app's own state, not the project's work.
 */
const SKIP = new Set([".git", ".jaira", "node_modules", "dist", "build", "out", "target", "vendor", "coverage", "__pycache__", ".venv"]);

/** How much of a tree either tool will look at before it stops and says so. */
const MAX_VISIT = 20_000;
const MAX_MATCHES = 200;
/** Files bigger than this are not searched — a grep through a bundled artifact finds only noise. */
const MAX_GREP_BYTES = 2_000_000;

/** Every file under `root`, workspace-relative with forward slashes, bounded and pruned. */
function walk(root: string, limit: number): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  const stack: string[] = [root];
  let visited = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A directory we cannot read is a fact about permissions, not a reason to abandon the walk.
      continue;
    }
    for (const entry of entries) {
      if (++visited > limit) return { files, truncated: true };
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) stack.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
    }
  }
  return { files, truncated: false };
}

/**
 * Whether this call's own scope table would refuse to open a path.
 *
 * A refusal at the CALL is not enough for a tool whose answer IS a listing. `grep` at the root under
 * a table that denies `infra/**` is allowed — the root is allowed — and would then return the
 * matching lines from `infra/`, which is exactly what the scope exists to withhold; a later
 * `read_file` being refused is no comfort once the content is in the transcript.
 *
 * So the two walking tools apply the table to their RESULTS. Read off `ctx.policy.scopeOf`, the same
 * narrowing the gate consults, so a listing and an open agree by construction.
 */
function refuses(ctx: ExecServices | undefined, tool: string, path: string): boolean {
  const scopeOf = ctx?.policy?.scopeOf;
  return scopeOf !== undefined && scopeOf({ name: tool, readOnly: true }, { path } as never) === "deny";
}

/** The workspace root for this call, or the reason there is none. */
function rootOf(options: SearchToolOptions, ctx?: ExecServices): string | undefined {
  return ctx?.workspace?.root ?? options.cwd;
}

/**
 * The subtree a call is scoped to, checked for containment.
 *
 * `path` is a convenience and a trap: it is the natural way to say "only under `src`", and it is also
 * the natural way to say `../../..`. Resolved through the same `withinWorkspace` every other tool
 * uses, so the answer is the one the rest of the policy already gives.
 */
function scopeOf(root: string, path: unknown): { dir: string } | { error: string } {
  if (typeof path !== "string" || path.trim() === "") return { dir: root };
  const rel = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (isDeniedPath(rel)) return { error: `'${rel}' is inside .jaira/, which is not searchable` };
  const within = withinWorkspace(root, rel);
  if (within === undefined) return { error: `'${rel}' is outside the workspace` };
  return { dir: within };
}

/**
 * `glob` — the files matching a pattern.
 *
 * Sorted by path rather than by modification time. Mtime ordering is what a person wants when they
 * are hunting for what they just touched; a model asking for `**\/*.test.ts` is building a list, and
 * a list whose order changes between two identical calls is one it cannot reason about or cache.
 */
export function createGlobTool(options: SearchToolOptions = {}): Tool {
  return {
    description:
      "List files in the workspace whose path matches a glob pattern. `**` crosses directories, `*` does not. Returns paths relative to the workspace root.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "A glob, e.g. `src/**/*.ts`." },
        path: { type: "string", description: "Only look under this directory. Defaults to the whole workspace." },
      },
      required: ["pattern"],
    },
    readOnly: true,
    run: async (input, ctx?: ExecServices): Promise<JsonValue> => {
      const args = (input ?? {}) as { pattern?: unknown; path?: unknown };
      const pattern = typeof args.pattern === "string" ? args.pattern.replace(/\\/g, "/") : "";
      if (pattern.trim() === "") return { error: "no pattern given" };
      const root = rootOf(options, ctx);
      if (root === undefined) return { error: "this operation has no workspace to search" };
      const scope = scopeOf(root, args.path);
      if ("error" in scope) return { error: scope.error };

      let matcher: RegExp;
      try {
        matcher = globToRegExp(pattern);
      } catch (e) {
        return { error: `'${pattern}' is not a usable pattern: ${(e as Error).message}` };
      }
      const { files, truncated } = walk(scope.dir, MAX_VISIT);
      const matched = files
        .filter((file) => matcher.test(file))
        // SILENTLY. "12 results were withheld" tells the model exactly where to aim, which is the
        // one thing a withheld listing must not do. The count belongs in the journal.
        .filter((file) => !refuses(ctx, GLOB, join(scope.dir, file)))
        .sort();
      return {
        // Relative to the SCOPE, which is what the caller named — a path it can hand straight back
        // to `read_file` only if the two agree about where they start from.
        paths: matched.slice(0, MAX_MATCHES),
        count: matched.length,
        ...(matched.length > MAX_MATCHES || truncated
          ? { truncated: `showing ${Math.min(matched.length, MAX_MATCHES)} of ${matched.length}${truncated ? "+ (the walk hit its limit)" : ""}` }
          : {}),
      };
    },
  } as Tool;
}

/** One matching line, with enough around it to be worth reading. */
interface Hit {
  path: string;
  line: number;
  text: string;
}

/**
 * `grep` — lines matching a pattern, with their file and line number.
 *
 * A regular expression rather than a substring, because that is what the callers of this shape
 * expect and what makes it worth having over `read_file` plus reading. Case-insensitive is a flag
 * rather than the default: a search for `Error` that also finds `error` is usually right and
 * occasionally the exact thing you were trying to distinguish.
 */
export function createGrepTool(options: SearchToolOptions = {}): Tool {
  return {
    description:
      "Search file contents in the workspace for a regular expression. Returns matching lines with their path and line number.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "A JavaScript regular expression." },
        path: { type: "string", description: "Only search under this directory. Defaults to the whole workspace." },
        glob: { type: "string", description: "Only search files whose path matches this glob." },
        ignoreCase: { type: "boolean", description: "Match without regard to case." },
      },
      required: ["pattern"],
    },
    readOnly: true,
    run: async (input, ctx?: ExecServices): Promise<JsonValue> => {
      const args = (input ?? {}) as { pattern?: unknown; path?: unknown; glob?: unknown; ignoreCase?: unknown };
      const source = typeof args.pattern === "string" ? args.pattern : "";
      if (source.trim() === "") return { error: "no pattern given" };
      const root = rootOf(options, ctx);
      if (root === undefined) return { error: "this operation has no workspace to search" };
      const scope = scopeOf(root, args.path);
      if ("error" in scope) return { error: scope.error };

      let matcher: RegExp;
      try {
        matcher = new RegExp(source, args.ignoreCase === true ? "i" : "");
      } catch (e) {
        return { error: `'${source}' is not a usable regular expression: ${(e as Error).message}` };
      }
      const only = typeof args.glob === "string" && args.glob.trim() !== "" ? globToRegExp(args.glob.replace(/\\/g, "/")) : undefined;

      const { files, truncated: walkTruncated } = walk(scope.dir, MAX_VISIT);
      const hits: Hit[] = [];
      let searched = 0;
      for (const file of files) {
        if (only !== undefined && !only.test(file)) continue;
        const full = join(scope.dir, file);
        // See `refuses`: a search that reports matches from a denied directory has leaked the very
        // content the scope withholds, whatever a later open would have been told.
        if (refuses(ctx, GREP, full)) continue;
        try {
          if (statSync(full).size > MAX_GREP_BYTES) continue;
          const text = readFileSync(full, "utf8");
          // A NUL byte is the oldest reliable "this is not text" test there is, and it costs one scan
          // of a file already read — the alternative is a hundred lines of mojibake in a result.
          if (text.includes("\u0000")) continue;
          searched++;
          for (const [i, line] of text.split("\n").entries()) {
            if (!matcher.test(line)) continue;
            hits.push({ path: file, line: i + 1, text: line.length > 400 ? `${line.slice(0, 400)}…` : line });
            if (hits.length >= MAX_MATCHES) break;
          }
        } catch {
          // Unreadable, vanished mid-walk, or not decodable — none is a reason to fail the search.
          continue;
        }
        if (hits.length >= MAX_MATCHES) break;
      }
      return {
        matches: hits as unknown as JsonValue,
        count: hits.length,
        filesSearched: searched,
        ...(hits.length >= MAX_MATCHES || walkTruncated
          ? { truncated: `stopped at ${hits.length} matches${walkTruncated ? " (the walk hit its limit)" : ""}` }
          : {}),
      };
    },
  } as Tool;
}

/** Register both search tools on a registry's `tools` facet. */
export function registerSearchTools(registry: { tools: Map<string, Tool> }, options: SearchToolOptions = {}): void {
  registry.tools.set(GLOB, createGlobTool(options));
  registry.tools.set(GREP, createGrepTool(options));
}
