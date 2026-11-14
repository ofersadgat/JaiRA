/**
 * Whether a conversation's thread is pinned to its live edge, and when it lets go.
 *
 * Pinned, everything that grows the thread or shrinks its viewport is followed: the message just sent,
 * a reply streaming in, a picture loading, the composer growing a line. It lets go only when the READER
 * moves up — a wheel or a key upward, a drag of the scrollbar or of a finger, or a scroll up that came
 * with no change of the content's or the viewport's height (nothing but the reader moves it then) —
 * and when what the reader pressed in the thread unfolded downward (a row opened is read where it
 * opened, not chased off the top). Anywhere within {@link AT_END} of the end pins it again.
 *
 * What it replaced (2026-11-14) judged the pin from every scroll event's distance to the end, and
 * followed growth only for 400 ms after the thread changed: the scroll a send made was reported after
 * the sent message had grown the thread, so the send itself let go; and a reader back at the end was
 * pinned to a thread that no longer followed, so the next word moved the end away and the next scroll
 * let go again.
 */

/** Within this many pixels of the end is at it. */
export const AT_END = 24;
/** How long after a press a growth of the thread is the press's doing. */
export const PRESS_WINDOW = 600;
/** How long after the reader stops dragging (a fling's momentum) a scroll up is still theirs. */
export const DRIVE_TAIL = 1000;

export interface EdgeState {
  pinned: boolean;
  /** Where the last scroll event left it. */
  y: number;
  content: number;
  viewport: number;
  /** The content's height as the last size change said. */
  laid: number;
  /** Until when a scroll up is the reader's doing (`Infinity` while a drag holds). */
  drivingUntil: number;
  /** A press in the thread that no size change has answered yet. */
  pressedAt: number | null;
}

export const EDGE_START: EdgeState = { pinned: true, y: 0, content: 0, viewport: 0, laid: 0, drivingUntil: 0, pressedAt: null };

export interface ScrollMetrics {
  y: number;
  content: number;
  viewport: number;
}

export const atEnd = (m: ScrollMetrics): boolean => m.content - m.y - m.viewport <= AT_END;

/** A scroll event. */
export function scrolled(s: EdgeState, m: ScrollMetrics, now: number): EdgeState {
  let pinned = s.pinned;
  if (atEnd(m)) pinned = true;
  else if (m.y < s.y - 1) {
    const reader = now <= s.drivingUntil;
    const still = Math.abs(m.content - s.content) < 1 && Math.abs(m.viewport - s.viewport) < 1;
    if (reader || still) pinned = false;
  }
  return { ...s, pinned, y: m.y, content: m.content, viewport: m.viewport };
}

/** The reader asked to go up (a wheel or a key upward) with somewhere above to go. */
export const readerUp = (s: EdgeState): EdgeState => ({ ...s, pinned: false });

/** The reader drags the scroller (a finger, the scrollbar): `true` as it starts, `false` as it ends. */
export const dragging = (s: EdgeState, held: boolean, now: number): EdgeState => ({ ...s, drivingUntil: held ? Infinity : now + DRIVE_TAIL });

/** A fling's momentum came to rest. */
export const settled = (s: EdgeState): EdgeState => ({ ...s, drivingUntil: 0 });

/** The reader pressed something in the thread. */
export const pressed = (s: EdgeState, now: number): EdgeState => ({ ...s, pressedAt: now });

/**
 * The content's height changed: whether to go to the end. The first change after a press, if it grew,
 * is the press unfolding something — not followed, and the pin lets go; a shrink (an approval answered
 * folding away) uses the press up, and what grows after it is followed.
 */
export function resized(s: EdgeState, height: number, now: number): { state: EdgeState; follow: boolean } {
  const grew = height > s.laid + 0.5;
  const fresh = s.pressedAt !== null && now - s.pressedAt <= PRESS_WINDOW;
  const next: EdgeState = { ...s, laid: height, pressedAt: null };
  if (fresh && grew && s.pinned) return { state: { ...next, pinned: false }, follow: false };
  return { state: next, follow: next.pinned };
}

/** Pinned again: a send, the jump button, another conversation. */
export const repin = (s: EdgeState): EdgeState => ({ ...s, pinned: true, pressedAt: null });

/** Keys that move a scroller up. */
export const UP_KEYS = new Set(["PageUp", "ArrowUp", "Home"]);
