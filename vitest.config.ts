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
    // Vitest's 5 s default is a unit-test budget, and most of this suite is not unit tests: a service
    // test opens a real project, runs whole tasks through the engine and closes it again — 1-2 s
    // alone, and 4 s or more for 139 passing tests when all 345 files share the machine. The default
    // failed a different one of them on almost every full run (2026-09-26: ten timeouts over three
    // runs, nine tests, every one passing alone). A hang still fails; it just fails at 30 s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
