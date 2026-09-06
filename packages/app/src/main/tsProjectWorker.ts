/**
 * The type-check worker's entry point — a thread whose whole job is to hold {@link TsProjects}.
 *
 * ## Why a thread at all
 *
 * Measured, on this repository: the first check of a file in `packages/app` takes 2.2 seconds and
 * every check after it takes about 230 ms. On the main thread that is a two-second freeze the first
 * time somebody clicks a `.ts` file, and a quarter of a second of dropped input every time they stop
 * typing — in the process that also draws the window, answers every other IPC call, and runs the
 * engine. The whole point of moving the check off the renderer was to get an answer that is true;
 * moving it into the main thread would have bought that with the responsiveness of the app.
 *
 * A worker is the cheap version of the fix. The compiler is loaded once, in a place where a
 * two-second pause is nobody's problem, and the main thread's part is a `postMessage`.
 *
 * ## Why not a `utilityProcess`
 *
 * Electron's `utilityProcess` is the other candidate and would isolate a compiler crash into its own
 * process. It is also Electron's, and this half of the app is deliberately Electron-free so the
 * whole service surface stays testable headlessly (see `service.ts`'s ports). `worker_threads` is
 * Node's, works in a plain `node` run and in a test, and a language service that throws is already
 * caught and reported as "nothing checked this" rather than taken as a crash.
 */
import { parentPort } from "node:worker_threads";
import { TsCheckers, type BaselineOverlay, type Caret } from "./tsProject";

/** What the client sends. One shape, discriminated — the things there are to ask. */
export type TsRequest =
  | { id: number; op: "check"; file: string; text?: string; baseline?: readonly BaselineOverlay[] }
  | { id: number; op: AtCaret; file: string; at: Caret; text?: string; baseline?: readonly BaselineOverlay[] }
  | { id: number; op: "sourceOf"; file: string; target: string; baseline?: readonly BaselineOverlay[] }
  | { id: number; op: "release"; file: string };

/** The three questions about a POSITION — see {@link TsProjects.atCaret}, which is their shape. */
export type AtCaret = "definitions" | "references" | "hover";

/** What comes back. A failure is a REPLY, not an unhandled rejection, so no call is left hanging. */
export type TsReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string };

const projects = new TsCheckers();

// `parentPort` is null when this module is loaded on the main thread, which is what an accidental
// import looks like. Doing nothing is right: the class above is exported and usable directly, and
// the wiring is what this file adds.
parentPort?.on("message", (request: TsRequest) => {
  const answer =
    request.op === "check"
      ? projects.check(request.file, request.text, request.baseline)
      : request.op === "release"
        ? projects.release(request.file)
        : request.op === "sourceOf"
          ? projects.sourceOf(request.file, request.target, request.baseline)
          : projects[request.op](request.file, request.at, request.text, request.baseline);
  answer.then(
    (value) => parentPort?.postMessage({ id: request.id, ok: true, value } satisfies TsReply),
    (e: unknown) =>
      parentPort?.postMessage({
        id: request.id,
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      } satisfies TsReply),
  );
});
