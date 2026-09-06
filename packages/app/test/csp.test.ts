/**
 * The window's Content-Security-Policy.
 *
 * This file used to compare two policies. The snapshot harness rendered a page of its own and that
 * page carried NO policy at all, so a WebAssembly module the app's `script-src 'self'` refuses
 * instantiated happily there: the figures showed the TextMate grammars running, the app quietly fell
 * back to Monaco's own tokenizer, and the two disagreed for a whole round of "it still does not look
 * right". The comparison was the fix, and keeping the two pages identical was the standing cost of
 * having two.
 *
 * There is one page now — `shots/` photographs the running app — so that whole class of bug is gone
 * by construction rather than by assertion, and what is left here is about the policy itself.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = join(import.meta.dirname, "..");

/** The policy a page declares, or `null` where it declares none. */
function policyOf(file: string): string | null {
  const html = readFileSync(join(HERE, file), "utf8");
  const meta = /http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/.exec(html);
  return meta?.[1]?.replace(/\s+/g, " ").trim() ?? null;
}

describe("the renderer's content policy", () => {
  it("is declared at all", () => {
    // A window with no policy is the failure the harness comparison used to catch from the other
    // side: not a wrong policy, an absent one.
    expect(policyOf("src/renderer/index.html")).not.toBeNull();
  });

  it("permits WebAssembly, which the TextMate tokenizer needs", () => {
    // `'wasm-unsafe-eval'` and NOT `'unsafe-eval'`: the narrow directive admits WebAssembly
    // compilation and nothing else, where the broad one would admit `eval()` of JavaScript. The
    // grammars run on an Oniguruma WASM build (`textmate.ts`), and a bare `script-src 'self'`
    // refuses to instantiate it — silently, which is how this went unnoticed.
    const app = policyOf("src/renderer/index.html") ?? "";
    expect(app).toContain("'wasm-unsafe-eval'");
    expect(app).not.toContain("'unsafe-eval'");
  });

  it("still admits no remote code", () => {
    // The §7.3 Electron rule: everything is bundled, nothing is fetched. Adding a directive for
    // WebAssembly must not have widened where CODE may come from.
    const app = policyOf("src/renderer/index.html") ?? "";
    expect(app).toContain("default-src 'none'");
    expect(app).toMatch(/script-src 'self' 'wasm-unsafe-eval'/);
    expect(app).not.toMatch(/script-src[^;]*https?:/);
  });
});
