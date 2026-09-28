/**
 * Build every island page (decision 0013, S5): one classic page per component, in `dist-island/<name>/`.
 *
 *   npm --workspace @jaira/client run build:island
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
// Beside `dist/`, not in it: `one build` empties `dist/` on every run.
rmSync(fileURLToPath(new URL("../dist-island", import.meta.url)), { recursive: true, force: true });
for (const island of ["markdown", "diff", "markdownEditor"]) {
  console.log(`island: ${island}`);
  execFileSync(process.execPath, [fileURLToPath(new URL("../../../node_modules/vite/bin/vite.js", import.meta.url)), "build", "--config", "vite.config.ts", "--logLevel", "warn"], {
    cwd: here,
    env: { ...process.env, ISLAND: island },
    stdio: "inherit",
  });
}
