/**
 * Whether what moves on its own stands still. A phone's test (`shots/android.mts`, `android-check.mts`)
 * reads the screen through Android's `uiautomator dump`, which waits for the screen to be idle and
 * cannot be told not to: a spinner turning or a dot breathing keeps it waiting until it gives up
 * ("could not get idle state"). The deep link's `&still=1` sets this before the shell mounts
 * (`NativeApp.tsx`), and every endless animation on a phone asks it — `Turn`, Connections' `Spin`, the
 * pulse (`chat/Pulse.tsx`), the Debug session's breathing dot and caret (`debug/motion.tsx`). The desktop's pictures hold still another way
 * (`holdStill` in `shots/driver.mts`: the CSS animations off), so nothing on web sets this.
 */
let still = false;

export function setStill(on: boolean): void {
  still = on;
}

export function isStill(): boolean {
  return still;
}
