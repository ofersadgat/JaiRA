/**
 * The `.dc.html` runtime an artboard loads as `./support.js` (decision 0020 §5) — JaiRA's own, built
 * from `packages/dc-runtime` — and what a frame is answered with.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultBuiltInDir, type ArtifactPolicy } from "@jaira/shared";

/** What the artifact protocol answers for a granted path: the bytes, their type, and the policy to serve them under. */
export interface ServedBody {
  body: string | Buffer;
  mediaType: string;
  policy: ArtifactPolicy;
}

let cached: string | undefined;

/**
 * The runtime's source, read once. A packaged app and a bundle carry it in the built-in layer
 * (`artifact-types/design/support.js`, copied there by the build); running from source it is the
 * package's own build output. `undefined` when neither has been built — an artboard then shows its
 * template unrendered, and the log says why.
 */
export function designRuntimeSource(): string | undefined {
  if (cached !== undefined) return cached;
  const builtIn = defaultBuiltInDir();
  const candidates = [join(builtIn, "artifact-types", "design", "support.js"), join(builtIn, "..", "..", "dc-runtime", "dist", "support.js")];
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) return undefined;
  cached = readFileSync(found, "utf8");
  return cached;
}
