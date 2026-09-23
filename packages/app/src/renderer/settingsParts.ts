/**
 * The sections of the Settings page on screen, and which one is being read — what the sidebar's
 * accordion lists under the open tab (the person's design, 2026-09-23: "the sections are listed
 * indented under the tab and as you scroll each section highlights, and clicking a section will
 * scroll to that section").
 *
 * Read off the DOM rather than declared by each pane. A section says it is one with `data-part` and
 * `data-part-label` (`SettingsSection`, and a top-level `Level`), and this finds whatever the page
 * drew — so a pane that adds a section, or draws one only when a project is open, is listed without
 * anybody keeping a second list in step with the first.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface SettingsPart {
  id: string;
  label: string;
}

/** How far below the top of the scroll box a section's heading may sit and still be the one read. */
const READING_LINE = 56;

/** How long a click's choice outranks the scroll it caused — a smooth scroll takes about this. */
const CLICK_HOLD_MS = 900;

function partsIn(body: HTMLElement): HTMLElement[] {
  return [...body.querySelectorAll<HTMLElement>("[data-part]")];
}

/**
 * The parts of `body`, the one being read, and a way to go to one.
 *
 * `key` is what makes a new page a new page (the section id): the list is re-read when it changes,
 * and the scroll box is back at its top.
 */
export function useSettingsParts(
  body: HTMLElement | null,
  key: string,
): { parts: SettingsPart[]; active: string | null; go: (id: string) => void } {
  const [parts, setParts] = useState<SettingsPart[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // A click names the section it went to, and holds it while the scroll it started is still moving —
  // otherwise a section too short to reach the top would be un-lit by its own arrival.
  const held = useRef<{ id: string; until: number } | null>(null);

  useEffect(() => {
    if (body === null) return undefined;
    let frame = 0;
    const read = (): void => {
      const els = partsIn(body);
      const next = els.map((el) => ({ id: el.dataset["part"] ?? "", label: el.dataset["partLabel"] ?? el.dataset["part"] ?? "" }));
      setParts((prev) => (prev.length === next.length && prev.every((p, i) => p.id === next[i]!.id && p.label === next[i]!.label) ? prev : next));
      const hold = held.current;
      if (hold !== null && Date.now() < hold.until) {
        setActive(hold.id);
        return;
      }
      if (els.length === 0) {
        setActive(null);
        return;
      }
      // The last section whose heading has reached the reading line — and at the very bottom of the
      // page, the last section, which may never get that far up.
      const top = body.getBoundingClientRect().top;
      let current = els[0]!.dataset["part"] ?? null;
      for (const el of els) if (el.getBoundingClientRect().top - top <= READING_LINE) current = el.dataset["part"] ?? current;
      if (body.scrollTop > 0 && body.scrollTop + body.clientHeight >= body.scrollHeight - 2) current = els[els.length - 1]!.dataset["part"] ?? current;
      if (hold !== null && hold.until <= Date.now()) held.current = null;
      setActive(current);
    };
    const soon = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    held.current = null;
    // A new page starts at its top, not wherever the last one was scrolled to.
    body.scrollTop = 0;
    read();
    body.addEventListener("scroll", soon, { passive: true });
    // Sections that arrive after the first paint — a pane waiting on its data — join the list.
    const watch = new MutationObserver(soon);
    watch.observe(body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      body.removeEventListener("scroll", soon);
      watch.disconnect();
    };
  }, [body, key]);

  const go = useCallback(
    (id: string) => {
      if (body === null) return;
      const el = partsIn(body).find((part) => part.dataset["part"] === id);
      if (el === undefined) return;
      held.current = { id, until: Date.now() + CLICK_HOLD_MS };
      setActive(id);
      const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
    },
    [body],
  );

  return { parts, active, go };
}
