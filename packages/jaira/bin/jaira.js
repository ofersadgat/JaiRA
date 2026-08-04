#!/usr/bin/env node
// This package exists only to own the unscoped `jaira` name on npm. The CLI
// itself lives in @jaira/cli, pinned to the exact version above; its own bin
// registers tsx, runs main, and sets process.exitCode. Nothing to add here.
import "@jaira/cli/bin/jaira.js";
