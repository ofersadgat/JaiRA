/**
 * How much of the window's foot the on-screen keyboard covers. Nothing on web: a browser's window is
 * what is left of the screen, and the desktop has no such keyboard. A phone's is `keyboard.native.ts`.
 */
export function useKeyboardInset(): number {
  return 0;
}
