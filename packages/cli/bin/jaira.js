#!/usr/bin/env node
// Dev-mode bin: packages are consumed as TypeScript source (ai-exec convention),
// so the CLI runs through tsx. A bundled (esbuild) bin replaces this later.
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/main.ts");
process.exitCode = await main(process.argv.slice(2));
