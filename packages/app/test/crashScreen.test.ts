/**
 * What the window's last-resort error handler is allowed to swallow.
 *
 * Exactly one thing, and the risk runs both ways. Too narrow and the app puts a banner over a
 * working window every time two panes resize each other, which is what it did. Too broad and a real
 * failure stops being reported — the worst outcome this file has, because the handler exists to
 * catch what nothing else did.
 *
 * So the predicate is tested rather than the handler: the handler needs a DOM and this suite is
 * node, and the only thing that could be wrong here is which strings it recognises.
 */
import { describe, expect, it } from "vitest";
import { isResizeNotification } from "../src/renderer/crashScreen";

describe("the one report that is not a failure", () => {
  it("knows the notification, in both spellings browsers have used", () => {
    // Chrome and Firefox today…
    expect(isResizeNotification("ResizeObserver loop completed with undelivered notifications.")).toBe(true);
    // …and what Chrome and Edge said before that. A settings file outlives a release and so does a
    // browser string; recognising only the current one would let the noise back on an older engine.
    expect(isResizeNotification("ResizeObserver loop limit exceeded")).toBe(true);
    // Browsers prefix the message when it arrives as an uncaught error.
    expect(isResizeNotification("Uncaught Error: ResizeObserver loop completed with undelivered notifications.")).toBe(true);
  });

  it("recognises nothing else — including things that merely mention the observer", () => {
    // The failure mode that matters: a real fault in code that happens to use a ResizeObserver is a
    // real fault, and swallowing it would hide it behind a filter nobody would think to look at.
    expect(isResizeNotification("TypeError: ResizeObserver is not a constructor")).toBe(false);
    expect(isResizeNotification("Cannot read properties of null (reading 'observe')")).toBe(false);
    expect(isResizeNotification("")).toBe(false);
  });

  it("does not throw on a message that is not a string", () => {
    // `ErrorEvent.message` is typed as a string and is not always one — a worker, an old engine, a
    // synthetic event from a library. The handler runs on the path where everything else has already
    // failed, so it may not be the thing that throws.
    expect(isResizeNotification(undefined)).toBe(false);
    expect(isResizeNotification(null)).toBe(false);
    expect(isResizeNotification({ message: "ResizeObserver loop completed" })).toBe(false);
  });
});
