import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** This checkout's own packages, by name. */
const local = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    // `@jaira/*` must resolve to THIS checkout's sources, not through `node_modules`. The workspace
    // junctions live in the repository root's `node_modules` and point at the MAIN checkout's
    // packages — so inside a git worktree, a bare import crossed into another checkout's code and a
    // cross-package change tested everything except itself. Order matters: the subpath entry must
    // precede its package, or the package alias swallows it.
    alias: [
      { find: "@jaira/shared/browser", replacement: local("./packages/shared/src/browser.ts") },
      { find: "@jaira/shared", replacement: local("./packages/shared/src/index.ts") },
      { find: "@jaira/runtime", replacement: local("./packages/runtime/src/index.ts") },
      { find: "@jaira/persistence", replacement: local("./packages/persistence/src/index.ts") },
      // Test-only, and outside every package on purpose: a home per test is infrastructure the
      // whole suite shares, not a thing any one package exports. See `test/testing.ts`.
      { find: "@jaira/testing", replacement: local("./test/testing.ts") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    // Redirects the shared base root away from the developer's real `~/.jaira` — see test/setup.ts.
    setupFiles: ["./test/setup.ts"],
  },
});
