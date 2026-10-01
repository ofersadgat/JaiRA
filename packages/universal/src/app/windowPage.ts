import type { Tokens } from "../tokens";

/**
 * The native half of `windowPage.web.ts`: a phone has no window to name, no keyboard focus ring and no
 * scrollbar gutter, so the desktop's page-wide rules have nothing to apply to.
 */
export function useWindowTitle(_title: string): void {}

export function usePageRules(_t: Tokens): void {}

/** A phone has no page under the shell: the shell paints the window's ground itself. */
export const pageGround = (_t: Tokens): boolean => false;
