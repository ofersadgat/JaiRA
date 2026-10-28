/**
 * What git ignores in a checkout, for the file tree (`fileTree`, `listDirectory`): asked of git itself,
 * so `.gitignore` at every depth, `.git/info/exclude` and the person's global excludes all count, as they
 * do for everything else git does.
 *
 * `--directory` names a folder ONCE when everything in it is ignored — `node_modules/`, a build, a
 * worktree — which is what keeps the answer small: 60 lines for this repository, where walking the same
 * folders took 31,000 entries. Paths are relative to the folder asked about (`ls-files` answers for the
 * current directory and below), forward-slashed, a folder's trailing `/` dropped.
 *
 * `undefined` when there is no answer — not a repository, no git, a git that hung — and the tree is then
 * walked as it always was.
 */
import { execFileSync } from "node:child_process";
import type { IgnoredPaths } from "@jaira/persistence";

export function gitIgnoredPaths(dir: string): IgnoredPaths | undefined {
  let out: string;
  try {
    out = execFileSync("git", ["-C", dir, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
  const dirs = new Set<string>();
  const files = new Set<string>();
  for (const entry of out.split("\0")) {
    if (entry === "") continue;
    if (entry.endsWith("/")) dirs.add(entry.slice(0, -1));
    else files.add(entry);
  }
  return { dirs, files };
}
