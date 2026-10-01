/**
 * A closed `<select>`'s keys, for the copies that draw one as a box that opens a menu (`settings/fields.tsx`,
 * `logs/Select.tsx`, `workflow/controls.tsx`) — what Chromium does with the list shut, which the desktop's
 * real `<select>`s get for nothing:
 *
 *   ↓ →            the next choice          ↑ ←            the one before
 *   Home, PageUp   the first                End, PageDown  the last
 *   a letter       the next choice that begins with it, round from the one chosen
 *
 * A choice that is off (a group's heading, a disabled option) is stepped over. Space and Enter are the
 * box's own press, which opens the menu.
 */
export interface SelectChoice {
  label: string;
  value: string;
  disabled?: boolean | undefined;
}

/** The value a key moves a select to, or `undefined` for a key that is not the select's to take. */
export function selectKey(key: string, choices: readonly SelectChoice[], value: string): string | undefined {
  const live = choices.filter((choice) => choice.disabled !== true);
  if (live.length === 0) return undefined;
  const at = live.findIndex((choice) => choice.value === value);
  const pick = (index: number): string => live[Math.max(0, Math.min(live.length - 1, index))]!.value;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return pick(at + 1);
    case "ArrowUp":
    case "ArrowLeft":
      return pick(at < 0 ? 0 : at - 1);
    case "Home":
    case "PageUp":
      return pick(0);
    case "End":
    case "PageDown":
      return pick(live.length - 1);
    default: {
      if (key.length !== 1 || key === " ") return undefined;
      const letter = key.toLowerCase();
      // From the choice after the one chosen, and round: the same letter again goes on to the next.
      for (let step = 1; step <= live.length; step++) {
        const choice = live[(Math.max(at, -1) + step) % live.length]!;
        if (choice.label.trim().toLowerCase().startsWith(letter)) return choice.value;
      }
      return undefined;
    }
  }
}
