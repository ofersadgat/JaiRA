import { LogBox } from "react-native";
import { setStill } from "@jaira/universal";

/**
 * `&still=1` on the deep link: the app holds still for a test that reads its screen
 * (`shots/android.mts`). Android's `uiautomator dump` waits for a second in which nothing on screen
 * changes and gives up after ten ("could not get idle state"), so with a running task's panel open —
 * "Waiting for you … 2m 14s", a new second every second — it never read anything. Held from here on:
 *
 * - what turns or breathes on its own (`setStill`: `Turn`, Connections' `Spin`, the Debug session's
 *   pulse and caret);
 * - the clocks: a repeating timer of a tenth of a second to five is never started, which is every
 *   count of elapsed time (`useElapsed`, the run index's clock, the work summary's) and nothing else —
 *   the slower ones (the limits' half minute, the reviewer's re-read every ten seconds) leave the
 *   second it needs, and a faster one is a gesture's own (a card held at the board's edge scrolls it a
 *   step a frame);
 * - a development build's LogBox toasts, which cover the foot of the screen.
 *
 * A test's flag, read once before the shell mounts; nothing puts it back.
 */
let held = false;

export function holdStill(): void {
  if (held) return;
  held = true;
  setStill(true);
  LogBox.ignoreAllLogs();
  const start = globalThis.setInterval;
  const never = ((handler: () => void, ms?: number, ...rest: unknown[]) => (typeof ms === "number" && ms >= 50 && ms < 5000 ? 0 : (start as (...all: unknown[]) => unknown)(handler, ms, ...rest))) as unknown as typeof setInterval;
  globalThis.setInterval = never;
}
