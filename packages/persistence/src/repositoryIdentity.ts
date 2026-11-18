/**
 * A project's repository identity (decision 0013 §4), read from git once per directory: what groups the
 * clones of one repository, and what the person's settings and files for a project are keyed by
 * (`projectSettingsKey`), the same on every machine.
 */
import { execFileSync } from "node:child_process";
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

