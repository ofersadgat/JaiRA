import { isWeb } from "@tamagui/core";
import { selectKey, type SelectChoice } from "./selectModel";

/**
 * `selectModel.ts`'s `selectKey` as the box's key handler (a `Press`'s `onKeyDown`). Web only: a phone has no keyboard
 * to step a select with, and opens the menu.
 */
export function selectKeyProps(choices: readonly SelectChoice[], value: string, onChange: (value: string) => void): Record<string, unknown> {
  if (!isWeb) return {};
  return {
    onKeyDown: (event: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; preventDefault: () => void }) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const next = selectKey(event.key, choices, value);
      if (next === undefined) return;
      // Taken even where it changes nothing (↓ on the last): the page behind must not scroll instead.
      event.preventDefault();
      if (next !== value) onChange(next);
    },
  };
}
