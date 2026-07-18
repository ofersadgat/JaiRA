/** Process entry point for the `jaira` CLI. */
import { pathToFileURL } from "node:url";
import { runCli } from "./cli";

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
