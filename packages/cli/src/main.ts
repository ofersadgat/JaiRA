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
      ...(process.stdin.isTTY === true && process.stdout.isTTY === true ? { confirm, ask } : {}),
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

/**
 * One line typed at the terminal — how a run's approvals are answered.
 *
 * The question goes to STDERR: mid-run, stdout is the run's one JSON report, and a question printed
 * into it would corrupt the document a caller parses. End of input and an abort both answer
 * `undefined`, which every caller reads as no; the listeners go on the way out, as `confirm`'s do.
 */
async function ask(question: string, signal?: AbortSignal): Promise<string | undefined> {
  process.stderr.write(question);
  return new Promise<string | undefined>((resolve) => {
    const done = (answer: string | undefined): void => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      signal?.removeEventListener("abort", onAbort);
      process.stdin.pause();
      resolve(answer);
    };
    const onData = (chunk: Buffer): void => done(chunk.toString("utf8").replace(/\r?\n$/, ""));
    const onEnd = (): void => done(undefined);
    const onAbort = (): void => {
      process.stderr.write("\n");
      done(undefined);
    };
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
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
