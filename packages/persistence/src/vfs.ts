/**
 * The filesystem references resolve against (REFERENCES.md §1.1).
 *
 * Its own module rather than a member of `workflowRefs`, because two things need it now and one of
 * them sits UNDER the other: `userModules` builds the symbol index the reference options carry, so a
 * shared adapter living beside the options would make the two import each other. A filesystem
 * adapter is not reference-resolution logic; this is where it belonged.
 */
import { readFileSync } from "node:fs";
import type { Vfs } from "@declarative-ai/hw";
import { currentDefinitionOverlay, listDefinitions, overlaidText, type DefinitionOverlay } from "@jaira/runtime";

/**
 * Listings are cached for the life of one load: resolution asks for the same directory once per
 * reference into it, and a workflow with a shared type library asks a lot. Caching also makes one
 * load SELF-CONSISTENT — a file appearing mid-load cannot change what an earlier reference meant.
 *
 * Entries are matched case-sensitively even on Windows, so a workflow resolves identically wherever
 * it runs rather than inheriting the host's rules.
 *
 * A simulation's run reads a proposed change as if it were written (`definitionOverlay.ts`): by default
 * a read goes through the overlay the code running NOW reads through, and a listing is cached per
 * overlay, so one made for a simulation never answers for the disk. `overlay` names one instead, and
 * `null` reads the disk alone — what a cache that outlives one load must be built on.
 */
export function nodeVfs(overlay?: DefinitionOverlay | null): Vfs {
  const listings = new Map<string, readonly string[]>();
  const via = (): DefinitionOverlay | null | undefined => (overlay === undefined ? currentDefinitionOverlay() : overlay);
  return {
    list(dir) {
      const at = via();
      const key = `${at?.id ?? ""}\0${dir}`;
      const cached = listings.get(key);
      if (cached !== undefined) return cached;
      let names: readonly string[];
      try {
        names = listDefinitions(dir, at ?? null)
          .filter((e) => e.isFile())
          .map((e) => e.name);
      } catch {
        names = [];
      }
      listings.set(key, names);
      return names;
    },
    read(path) {
      const overlaid = overlaidText(path, via() ?? null);
      if (overlaid !== undefined) return overlaid;
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}
