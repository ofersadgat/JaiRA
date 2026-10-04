/**
 * How much of the window's foot the on-screen keyboard covers. Nothing on web: a browser's window is
 * what is left of the screen, and the desktop has no such keyboard. A phone's is `keyboard.native.ts`.
 */
export function useKeyboardInset(): number {
  return 0;
}

/** Whether the on-screen keyboard is up: never, on web. */
export function useKeyboardShown(): boolean {
  return false;
}

/** Where the keyboard's top edge stands: nowhere, on web. */
export function useKeyboardTop(): number | null {
  return null;
}

/** Where the text box being typed into stands: web has no keyboard to move out of the way of. */
export function focusedInputTop(done: (top: number | null) => void): void {
  done(null);
}
