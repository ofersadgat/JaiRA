import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { ScrollView } from "react-native";
import { isWeb } from "@tamagui/core";
import type { InstanceNode } from "@jaira/shared/browser";
import { stepBlockOf, stepOf, stepsAt, type BlockSpan } from "@jaira/ui/programCalls";
import type { TranscriptEntry } from "@jaira/ui/transcript";

/** A drawn block of the thread, by the moments it spans (`data-from`, `data-to`, `SessionTranscript.tsx`). */
interface DrawnBlock extends BlockSpan {
  el: HTMLElement;
}

const boxOf = (scroller: RefObject<ScrollView | null>): HTMLElement | undefined => {
  const box = (scroller.current as unknown as { getScrollableNode?: () => HTMLElement | null } | null)?.getScrollableNode?.();
  return box === null || box === undefined || typeof box.querySelectorAll !== "function" ? undefined : box;
};

/** The thread's own blocks, in order — not those of a conversation nested in one (an agent's, under its call). */
function blocksIn(box: HTMLElement): DrawnBlock[] {
  const out: DrawnBlock[] = [];
  for (const el of Array.from(box.querySelectorAll<HTMLElement>("[data-from]"))) {
    const outer = el.parentElement?.closest("[data-from]");
    if (outer !== null && outer !== undefined && box.contains(outer)) continue;
    const from = Number(el.dataset["from"]);
    const to = Number(el.dataset["to"] ?? from);
    if (Number.isFinite(from)) out.push({ el, from, to: Number.isFinite(to) ? to : from });
  }
  return out;
}

/**
 * A program's thread read as its task, beside the Steps index (decision 0033 §1): a step picked there
 * takes the thread to it — the block it happened in, scrolled to the top and lit for 1.2s, as a run's
 * sheets did (`RunTranscript.tsx`) — and as the reader scrolls, the step they are at and the steps on
 * screen are told back for the index to mark (`onHere`). A step is found by time: the thread draws its
 * messages and its calls, not its states (`stepBlockOf`, `stepsAt`). Web only: a phone has no page to
 * query, and no index beside the thread.
 */
export function useStepBookmarks(
  scroller: RefObject<ScrollView | null>,
  root: InstanceNode | undefined,
  entries: readonly TranscriptEntry[],
  focus: { instance: string; at: number } | undefined,
  onHere: ((instance: string | undefined, onScreen?: ReadonlySet<string>) => void) | undefined,
  letGo: () => void,
  following: () => boolean,
  accent: string,
): { track: () => void } {
  const rootRef = useRef(root);
  rootRef.current = root;
  const hereRef = useRef(onHere);
  hereRef.current = onHere;
  const followingRef = useRef(following);
  followingRef.current = following;

  /** Which step the reader is at: following the live edge, the last on screen; else the block over the middle line. */
  const measure = useCallback((): void => {
    const here = hereRef.current;
    const box = boxOf(scroller);
    if (here === undefined || box === undefined) return;
    const blocks = blocksIn(box);
    if (blocks.length === 0) return;
    const top = box.getBoundingClientRect().top;
    const height = box.clientHeight;
    let at: DrawnBlock | undefined;
    let first: DrawnBlock | undefined;
    let last: DrawnBlock | undefined;
    for (const block of blocks) {
      const rect = block.el.getBoundingClientRect();
      const y = rect.top - top;
      if (y <= height / 2) at = block;
      if (y + rect.height >= 0 && y <= height) {
        first ??= block;
        last = block;
      }
    }
    const reading = followingRef.current() ? (last ?? at) : (at ?? first ?? blocks[0]);
    if (reading === undefined) return;
    const shown = first !== undefined && last !== undefined ? { from: first.from, to: last.to } : undefined;
    const seen = stepsAt(rootRef.current, reading.to, shown);
    here(seen.current, seen.onScreen);
  }, [scroller]);

  // Coalesced to a frame: a scroll fires many times per paint.
  const frame = useRef<number | null>(null);
  const track = useCallback((): void => {
    if (!isWeb || hereRef.current === undefined || frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      measure();
    });
  }, [measure]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      hereRef.current?.(undefined);
    },
    [],
  );
  useEffect(track, [track, entries, root]);

  // A pick landing. Tried again as the thread fills in — the pick can come before the thread is drawn —
  // and `served` keeps a served pick from scrolling the reader again when the next message lands.
  const served = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!isWeb || focus === undefined || served.current === focus.at) return;
    const node = stepOf(root, focus.instance);
    const box = boxOf(scroller);
    if (node === undefined || box === undefined) return;
    if (node === root) {
      served.current = focus.at;
      letGo();
      scroller.current?.scrollTo({ y: 0, animated: true });
      return;
    }
    const blocks = blocksIn(box);
    const index = stepBlockOf(blocks, node.startedAt);
    const block = blocks[index];
    if (block === undefined) return;
    served.current = focus.at;
    letGo();
    const y = block.el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12;
    scroller.current?.scrollTo({ y: Math.max(0, y), animated: true });
    // Lit for 1.2s, as a run's sheet is when a bookmark lands on it.
    block.el.animate?.([{ boxShadow: `0 0 0 2px ${accent}` }, { boxShadow: `0 0 0 2px ${accent}`, offset: 0.6 }, { boxShadow: "0 0 0 2px transparent" }], { duration: 1200, easing: "ease-out" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.instance, focus?.at, entries, root]);

  return { track };
}
