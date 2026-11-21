/**
 * A project's repository identity (decision 0013 §4), read from git once per directory: what groups the
 * clones of one repository, and what the person's settings and files for a project are keyed by
 * (`projectSettingsKey`), the same on every machine.
 */
import { execFile, execFileSync } from "node:child_process";
import { repositoryIdentity } from "@jaira/shared";

/** Each project's repository identity, read once from git: a remote added later is seen at the next start. */
const identities = new Map<string, string | null>();

/**
 * A project's repository identity (decision 0013 §4): its `upstream` remote's, else its `origin`'s,
 * normalized by `repositoryIdentity`; undefined for a folder with neither (or no git).
 */
export function readRepositoryIdentity(dir: string): string | undefined {
  let identity = identities.get(dir);
  if (identity === undefined) {
    identity = null;
    for (const remote of ["upstream", "origin"]) {
      try {
        const url = execFileSync("git", ["-C", dir, "config", "--get", `remote.${remote}.url`], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
        const found = repositoryIdentity(url);
        if (found !== undefined) {
          identity = found;
          break;
        }
      } catch {
        // No such remote, or no git.
      }
    }
    identities.set(dir, identity);
  }
  return identity ?? undefined;
}

/** A folder's identity from `git config --get-regexp` of its remotes: `upstream`'s, else `origin`'s. */
function identityOfRemotes(listed: string): string | null {
  const urls = new Map<string, string>();
  for (const line of listed.split(/\r?\n/)) {
    const match = /^remote\.(upstream|origin)\.url\s+(.+)$/.exec(line.trim());
    if (match !== null && !urls.has(match[1]!)) urls.set(match[1]!, match[2]!);
  }
  for (const remote of ["upstream", "origin"]) {
    const url = urls.get(remote);
    const found = url !== undefined ? repositoryIdentity(url) : undefined;
    if (found !== undefined) return found;
  }
  return null;
}

/**
 * Many folders' repository identities at once, without holding the process up: each read as
 * {@link readRepositoryIdentity} reads it and kept with its readings, so a folder listed by this groups
 * as it will once it is open. A few at a time: a folder of a hundred clones is a hundred gits.
 */
export async function readRepositoryIdentities(dirs: readonly string[]): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>();
  const todo = dirs.filter((dir) => {
    const known = identities.get(dir);
    if (known === undefined) return true;
    out.set(dir, known ?? undefined);
    return false;
  });
  const read = (dir: string): Promise<string | null> =>
    new Promise((resolve) => {
      execFile("git", ["-C", dir, "config", "--get-regexp", "^remote\\.(upstream|origin)\\.url$"], { encoding: "utf8", windowsHide: true, timeout: 5000 }, (_error, stdout) =>
        resolve(identityOfRemotes(stdout ?? "")),
      );
    });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const dir = todo[next++]!;
      const identity = await read(dir);
      identities.set(dir, identity);
      out.set(dir, identity ?? undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, todo.length) }, worker));
  return out;
}
