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
      // Only where a person could actually answer. BOTH ends have to be a terminal: stdin decides
      // whether anything can be typed, and stdout decides whether the question was ever seen — a
      // command whose output is redirected would otherwise block on a prompt printed into a file.
      ...(process.stdin.isTTY === true && process.stdout.isTTY === true ? { confirm } : {}),
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

/**
 * A yes/no on the terminal, defaulting to NO.
 *
 * Anything that is not `y`/`yes` is a no, end-of-input included: this answers "may this code run",
 * and the safe reading of a shrug is refusal. The listener is removed on the way out so a second
 * question does not accumulate one, and so the process can still exit.
 */
async function confirm(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  return new Promise<boolean>((resolve) => {
    const done = (answer: boolean): void => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.pause();
      process.stdout.write("\n");
      resolve(answer);
    };
    const onData = (chunk: Buffer): void => done(/^y(es)?$/i.test(chunk.toString("utf8").trim()));
    const onEnd = (): void => done(false);
    process.stdin.resume();
    process.stdin.once("data", onData);
    process.stdin.once("end", onEnd);
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
