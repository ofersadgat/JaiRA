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
 * by construction rather than by assertion, and what is left here is about the policy itself. The
 * page carries no `<meta>`: the policy is a header, sent with it by whoever serves it — the desktop's
 * `app://` protocol and the engine's listener alike (`clientPolicy`, `packages/service/src/clientFiles.ts`).
 */
import { describe, expect, it } from "vitest";
import { clientPolicy } from "@jaira/service";

/** One's SPA shell, as far as the policy reads it: the inline scripts that set its globals. */
const PAGE = "<html><head><script>window.a=1</script></head><body><script>window.b=2</script></body></html>";

describe("the renderer's content policy", () => {
  it("is declared at all", () => {
    // A window with no policy is the failure the harness comparison used to catch from the other
    // side: not a wrong policy, an absent one.
    expect(clientPolicy(PAGE)).not.toBe("");
    expect(clientPolicy("<html></html>")).toContain("default-src 'none'");
  });

  it("permits WebAssembly, which the TextMate tokenizer needs", () => {
    // `'wasm-unsafe-eval'` and NOT `'unsafe-eval'`: the narrow directive admits WebAssembly
    // compilation and nothing else, where the broad one would admit `eval()` of JavaScript. The
    // grammars run on an Oniguruma WASM build (`textmate.ts`), and a bare `script-src 'self'`
    // refuses to instantiate it — silently, which is how this went unnoticed.
    const app = clientPolicy(PAGE);
    expect(app).toContain("'wasm-unsafe-eval'");
    expect(app).not.toContain("'unsafe-eval'");
  });

  it("still admits no remote code", () => {
    // The §7.3 Electron rule: everything is bundled, nothing is fetched. Adding a directive for
    // WebAssembly must not have widened where CODE may come from: the page's own inline scripts are
    // admitted by their hashes, and nothing is admitted by `'unsafe-inline'` or by address.
    const app = clientPolicy(PAGE);
    expect(app).toContain("default-src 'none'");
    expect(app).toMatch(/script-src 'self' 'wasm-unsafe-eval'/);
    expect(app).not.toMatch(/script-src[^;]*https?:/);
    expect(app).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(app.match(/'sha256-[^']+'/g)).toHaveLength(2);
  });
});
