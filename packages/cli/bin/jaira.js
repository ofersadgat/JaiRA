#!/usr/bin/env node
// The CLI ships as one bundled ESM file (see build.mjs) — no TypeScript to
// register at runtime. `main` is called explicitly rather than leaning on the
// entry-point guard in src/main.ts, because this file is also imported by the
// `jaira` wrapper package, where it is not the process entry point.
//
// Source maps are turned on HERE, before the bundle is loaded, and the ordering is the whole point:
// `setSourceMapsEnabled` registers a map for modules compiled after the call, so the same line inside
// `dist/cli.mjs` would run too late to map that file's own frames. That also forces the dynamic
// `import` below — a static one is hoisted above the statement, which puts the flag back after the
// compile it exists to precede. See `packages/app/entry.cjs` for the same fix on the Electron side.
process.setSourceMapsEnabled(true);

const { main } = await import("../dist/cli.mjs");

process.exitCode = await main(process.argv.slice(2));
