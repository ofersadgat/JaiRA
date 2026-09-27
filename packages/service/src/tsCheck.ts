/**
 * The main thread's half of the type checker: a worker, spawned on first use.
 *
 * Everything expensive is on the other side of the `postMessage` (see `tsProjectWorker.ts` for why
 * there is a thread at all). What lives here is the small, boring part — a lazy spawn, a table of
 * calls waiting for their reply, and the rule that a worker which dies takes its callers down with a
 * message rather than leaving them waiting forever.
 */
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { FileCheck, FileDefinitions, FileHover, FileReferences } from "@jaira/shared";
import type { BaselineOverlay, Caret, TypeCheckPort } from "./tsProject";
import type { AtCaret, TsReply, TsRequest } from "./tsProjectWorker";

/** The bundled worker, beside the bundle that loads it — see `build.mjs`. */
const WORKER = join(__dirname, "tsProjectWorker.cjs");

/**
 * `Omit` over a union, one member at a time.
 *
 * The plain one collapses a discriminated union to the keys its members share — so a request minus
 * its `id` lost `at`, `text` and `baseline`, and the compiler refused the very fields it exists to
 * check. The `T extends unknown` is what makes the mapping distribute.
 */
type Asked<T> = T extends unknown ? Omit<T, "id"> : never;

export class WorkerTypeCheck implements TypeCheckPort {
  private worker: Worker | undefined;
  private readonly waiting = new Map<number, { resolve: (value: never) => void; reject: (e: Error) => void }>();
  private id = 0;
  private closed = false;

  constructor(private readonly file: string = WORKER) {}

  check(file: string, text?: string, baseline?: readonly BaselineOverlay[]): Promise<FileCheck> {
    return this.ask<FileCheck>({
      op: "check",
      file,
      ...(text === undefined ? {} : { text }),
      ...(baseline === undefined ? {} : { baseline }),
    });
  }

  definitions(file: string, at: Caret, text?: string, baseline?: readonly BaselineOverlay[]): Promise<FileDefinitions> {
    return this.atCaret<FileDefinitions>("definitions", file, at, text, baseline);
  }

  references(file: string, at: Caret, text?: string, baseline?: readonly BaselineOverlay[]): Promise<FileReferences> {
    return this.atCaret<FileReferences>("references", file, at, text, baseline);
  }

  hover(file: string, at: Caret, text?: string, baseline?: readonly BaselineOverlay[]): Promise<FileHover> {
    return this.atCaret<FileHover>("hover", file, at, text, baseline);
  }

  /** The three position questions differ only in their name — see `tsProject.ts`'s `atCaret`. */
  private atCaret<T>(
    op: AtCaret,
    file: string,
    at: Caret,
    text?: string,
    baseline?: readonly BaselineOverlay[],
  ): Promise<T> {
    return this.ask<T>({
      op,
      file,
      at,
      ...(text === undefined ? {} : { text }),
      ...(baseline === undefined ? {} : { baseline }),
    });
  }

  sourceOf(from: string, target: string, baseline?: readonly BaselineOverlay[]): Promise<string | undefined> {
    return this.ask<string | undefined>({
      op: "sourceOf",
      file: from,
      target,
      ...(baseline === undefined ? {} : { baseline }),
    });
  }

  release(file: string): Promise<void> {
    return this.ask<void>({ op: "release", file });
  }

  /**
   * Stop the worker.
   *
   * Callers still waiting are REJECTED rather than dropped: a promise that will never settle is how
   * a shutdown turns into a hang, and the app closes this on its way out.
   */
  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = undefined;
    this.settleAll(new Error("the type checker is shutting down"));
    await worker?.terminate();
  }

  private ask<T>(what: Asked<TsRequest>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("the type checker is shutting down"));
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: never) => void, reject });
      try {
        this.spawn().postMessage({ ...what, id } as TsRequest);
      } catch (e) {
        this.waiting.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private spawn(): Worker {
    if (this.worker !== undefined) return this.worker;
    const worker = new Worker(this.file);
    worker.on("message", (reply: TsReply) => {
      const waiting = this.waiting.get(reply.id);
      if (waiting === undefined) return;
      this.waiting.delete(reply.id);
      if (reply.ok) waiting.resolve(reply.value as never);
      else waiting.reject(new Error(reply.message));
    });
    // A worker that dies — a compiler that ran out of memory on a very large program, a bundle that
    // is not there — must not leave every caller hanging. It is forgotten as well as reported, so
    // the next question spawns a fresh one instead of posting into a dead port.
    const lost = (e: Error): void => {
      if (this.worker === worker) this.worker = undefined;
      this.settleAll(e);
    };
    worker.on("error", lost);
    worker.on("exit", (code) => {
      if (this.waiting.size > 0 || this.worker === worker) lost(new Error(`the type checker exited (${code})`));
    });
    // Nothing else keeps the process alive for this: a window waiting to close should not wait for a
    // thread whose only job is to answer a question nobody is asking any more.
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private settleAll(e: Error): void {
    for (const waiting of [...this.waiting.values()]) waiting.reject(e);
    this.waiting.clear();
  }
}
