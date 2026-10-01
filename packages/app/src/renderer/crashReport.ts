/**
 * What the crash screen reports, apart from how it is drawn
 * (`packages/universal/src/components/floats/CrashScreen.tsx`): the words, the one notification that is
 * not a failure, and the sink the banner listens on. See `CrashScreen.tsx`'s header for the two nets and
 * why both exist.
 */

/** An error as text worth pasting: the message, and the frames under it. */
export function textOf(error: unknown, extra?: string): string {
  const e = error instanceof Error ? error : new Error(String(error));
  return [e.stack ?? `${e.name}: ${e.message}`, extra].filter((part) => part !== undefined && part !== "").join("\n\n");
}

/**
 * The one "error" that is not one: `ResizeObserver loop completed with undelivered notifications`.
 *
 * It is a NOTIFICATION the specification defines, not a failure. An observer callback that changes a
 * size makes the browser run the loop again; if there are still deliveries pending when the frame
 * ends, it reports this and delivers them on the next frame. Nothing is lost, nothing went
 * unhandled, and there is nothing to fix — which the event itself shows by arriving with no `error`
 * object and no stack, only a message. The stack in the crash log was always this reporter's own.
 *
 * Any layout that resizes in response to a resize produces it, and this app is made of them: Monaco
 * keeps an observer per editor, the code pane fits its height to its content, the splitter drags one
 * pane against another. So the choice is to recognise it or to put a banner over a working window
 * for a frame-scheduling artefact, which is what it did.
 *
 * Matched on the message and nothing else, and on BOTH spellings — Chrome and Edge said "loop limit
 * exceeded" before they said this. Narrow on purpose: everything else this handler sees is a real
 * failure, and a filter that grew would be how one stopped being reported.
 */
export function isResizeNotification(message: unknown): boolean {
  if (typeof message !== "string") return false;
  return message.includes("ResizeObserver loop completed") || message.includes("ResizeObserver loop limit exceeded");
}

/** A failure with no render to belong to — see `CrashScreen.tsx`'s header. */
export interface LooseError {
  at: number;
  text: string;
}

let report: ((error: LooseError) => void) | undefined;

/**
 * Hand a loose failure to the banner, if one is mounted. A host with nets of its own calls it — a
 * phone's global handler (`ErrorUtils`), which has no `window` to listen on.
 */
export function reportLooseError(error: LooseError): void {
  report?.(error);
}

/**
 * Where the banner listens: one at a time, as there is one banner. The sink is a mutable binding so
 * the banner can subscribe when it mounts without the handlers having to exist twice.
 */
export function onLooseError(listener: (error: LooseError) => void): () => void {
  report = listener;
  return () => {
    if (report === listener) report = undefined;
  };
}

/**
 * Catch what escapes everything else, once, at module scope.
 *
 * Registered from the entry point rather than from a component, because a rejection can land before
 * the first render and a net installed after the fall is not a net.
 */
export function installGlobalErrorReporting(): void {
  window.addEventListener("error", (event) => {
    if (isResizeNotification(event.message)) {
      // Swallowed, and the default with it — see {@link isResizeNotification}. `preventDefault` is
      // what stops the browser ALSO writing it to the console, which the main process mirrors into
      // the crash log (`main/index.ts`): without it the noise would survive this filter twice over.
      event.preventDefault();
      return;
    }
    const text = textOf(event.error ?? event.message, `${event.filename}:${event.lineno}`);
    console.error("[jaira] uncaught in the interface:", text);
    reportLooseError({ at: Date.now(), text });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const text = textOf(event.reason);
    console.error("[jaira] a promise rejected with nobody waiting:", text);
    reportLooseError({ at: Date.now(), text });
  });
}
