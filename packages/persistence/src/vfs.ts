/**
 * The filesystem references resolve against (REFERENCES.md §1.1).
 *
 * Its own module rather than a member of `workflowRefs`, because two things need it now and one of
 * them sits UNDER the other: `userModules` builds the symbol index the reference options carry, so a
 * shared adapter living beside the options would make the two import each other. A filesystem
 * adapter is not reference-resolution logic; this is where it belonged.
 */
import { readFileSync, readdirSync } from "node:fs";
import type { Vfs } from "@declarative-ai/hw";

/**
 * Listings are cached for the life of one load: resolution asks for the same directory once per
 * reference into it, and a workflow with a shared type library asks a lot. Caching also makes one
 * load SELF-CONSISTENT — a file appearing mid-load cannot change what an earlier reference meant.
 *
 * Entries are matched case-sensitively even on Windows, so a workflow resolves identically wherever
 * it runs rather than inheriting the host's rules.
 */
export function nodeVfs(): Vfs {
  const listings = new Map<string, readonly string[]>();
  return {
    list(dir) {
      const cached = listings.get(dir);
      if (cached !== undefined) return cached;
      let names: readonly string[];
      try {
        names = readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name);
      } catch {
        names = [];
      }
      listings.set(dir, names);
      return names;
    },
    read(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}
