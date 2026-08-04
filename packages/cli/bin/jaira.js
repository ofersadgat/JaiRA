#!/usr/bin/env node
// The CLI ships as one bundled ESM file (see build.mjs) — no TypeScript to
// register at runtime. `main` is called explicitly rather than leaning on the
// entry-point guard in src/main.ts, because this file is also imported by the
// `jaira` wrapper package, where it is not the process entry point.
import { main } from "../dist/cli.mjs";

process.exitCode = await main(process.argv.slice(2));
