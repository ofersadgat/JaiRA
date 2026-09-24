/**
 * Follow the live edge of a scrolling transcript — the behaviour every chat client has and only one
 * of this app's four transcripts had.
 *
 * The rule is not "scroll to the bottom when something arrives". It is: **a reader standing at the
 * bottom is reading the newest thing, so keep them there; a reader who has scrolled up is reading
 * something particular, so do not move them at all.** Those are the same view, and which one you are
 * in is decided by nothing but where you are standing.
 *
 * Getting the second half wrong is the worse failure and the easy one to write. A panel that scrolls
 * itself down whenever a fragment lands is unusable while a run is going: you scroll up to a tool
 * call, the next delta arrives 100 ms later, and the page yanks you back — for as long as the model
 * is talking. Getting the first half wrong is quieter and is what the run and leaf conversations
 * actually did: they never followed at all, so watching a workflow meant scrolling by hand after
 * every message, and the thing you were waiting for arrived below the fold.
 *
 * Lifted out of `chatPane`, where it was written once and worked, rather than reimplemented per
 * panel — three hand-rolled copies of a scroll heuristic is three sets of off-by-a-pixel bugs, and
 * the reader cannot see which panel they are in.
 */
import { useCallback, useLayoutEffect, useRef, useState, type DependencyList, type RefObject } from "react";

/**
 * How close to the bottom still counts as being AT it.
 *
 * Not zero: a fractional scroll height, a sub-pixel device ratio and a row that grows by a line while
 * the deltas land all put the reader a few pixels off the floor without them having moved, and an
 * exact test reads that as "they scrolled away" and stops following. One line of the transcript is
 * the smallest slack that survives all three.
 */
const SLACK_PX = 24;

/** Whether this element is scrolled to (or within {@link SLACK_PX} of) its bottom. */
export function nearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= SLACK_PX;
}

export interface StickToBottom<T extends HTMLElement> {
  /** Put this on the SCROLLING element — the one with `overflow`, not its content. */
  ref: RefObject<T | null>;
  /** Put this on the same element. Re-decides the pin on every scroll, whoever caused it. */
  onScroll: () => void;
  /**
   * The reader has gone looking somewhere else, so the panel is no longer following.
   *
   * State rather than the ref below, because this one is drawn: it is what a "jump to now" control
   * is gated on. Set through a comparison, so a scroll that does not cross the line costs no render.
   */
  away: boolean;
  /** Back to the live edge, and pinned again. */
  jump: () => void;
  /**
   * Whether it is following the live edge RIGHT NOW — the ref, not {@link away}, which lags a render.
   * What a reader of the position asks: stuck to the bottom, the step being viewed is the live one.
   */
  following: () => boolean;
  /**
   * Stop following, without moving anybody.
   *
   * For a scroll this panel is about to make on the reader's behalf — a bookmark landing somewhere up
   * the page. Nothing else needs it: an ordinary scroll decides the pin by where it ends up, and that
   * is the whole rule. But a programmatic jump races the pin, and loses: the follow effect is a
   * LAYOUT effect, so the next thing to arrive lands before the browser has painted the jump and
   * yanks the reader back to the bottom before they have seen where they were sent.
   */
  unpin: () => void;
}

/**
 * @param follow  What means "the content grew" — the transcript, the live tail. Re-runs the pin.
 * @param reset   What means "a different conversation is on screen" — go to the end and re-pin,
 *                however far up the reader had climbed in the last one. The pin is a fact about
 *                where somebody is standing in ONE conversation and does not travel with them.
 */
export function useStickToBottom<T extends HTMLElement>(follow: DependencyList, reset: DependencyList = []): StickToBottom<T> {
  const ref = useRef<T | null>(null);
  /**
   * Whether the reader is still standing at the live edge.
   *
   * A REF rather than state on purpose. Nothing on screen changes when it flips, so re-rendering the
   * transcript to record it would be work for no picture; and the scroll effect must read the value
   * as of the moment it runs, which a ref gives it and a state closure would not.
   *
   * Starts pinned: a conversation you have just opened is one you are reading from the end.
   */
  const pinned = useRef(true);
  const [away, setAway] = useState(false);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el === null) return;
    // Including the effect's own write below, which lands at the bottom and so re-affirms the pin
    // rather than fighting it.
    const at = nearBottom(el);
    pinned.current = at;
    setAway((was) => (was === !at ? was : !at));
  }, []);

  const jump = useCallback(() => {
    pinned.current = true;
    setAway(false);
    const el = ref.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, []);

  const unpin = useCallback(() => {
    pinned.current = false;
    setAway(true);
  }, []);

  // BEFORE paint, not after: an effect that runs afterwards shows one frame of the new content at
  // the old offset, which on a fast stream reads as the panel juddering.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || !pinned.current) return;
    el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, follow);

  useLayoutEffect(() => {
    pinned.current = true;
    setAway(false);
    const el = ref.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, reset);

  const following = useCallback(() => pinned.current, []);
  return { ref, onScroll, away, jump, unpin, following };
}
