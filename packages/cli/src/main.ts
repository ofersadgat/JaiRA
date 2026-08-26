/** Process entry point for the `jaira` CLI. */
import { pathToFileURL } from "node:url";
import { runCli } from "./cli";

// Source maps are enabled in `bin/jaira.js`, which loads this bundle — NOT here. The flag only
// registers maps for modules compiled after it runs, and a bundle finishes compiling before its first
// statement executes. See `packages/app/entry.cjs` for the measurement behind that.

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const abort = new AbortController();
  const onSigint = (): void => abort.abort();
  process.once("SIGINT", onSigint);
  try {
    return await runCli(argv, {
      cwd: process.cwd(),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      abortSignal: abort.signal,
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
