import type { JSX } from "react";
import { Press, Txt } from "../primitives";
import { useTokens } from "../tokens";

/**
 * `widgets.tsx`'s `NewTask`, universal (decision 0015): the plain `button` of `styles.css`, which opens the
 * New-task form in the side panel. Open or not it looks the same — no rule dresses `button.on` or
 * `[aria-pressed]` outside the toolbars that have their own.
 *
 *   button          --panel-2 ground, 1px --line ring, radius --control-radius (7), padding
 *                   --control-pad (3 10), the body's font (app voice, 13, line 1.5), --text, one line;
 *                   hovered: --panel-3 ground, --rule ring
 */
export function NewTask({ onOpen, open }: { onOpen: () => void; open: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onOpen}
      label="New task"
      {...({ "aria-pressed": open } as object)}
      flexShrink={0}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      paddingVertical={3}
      paddingHorizontal={10}
      borderRadius={t.v("control-radius") as never}
      borderWidth={1}
      borderStyle="solid"
      box={({ hovered }) => ({ backgroundColor: t.v(hovered ? "panel-3" : "panel-2"), borderColor: t.v(hovered ? "rule" : "line") })}
    >
      <Txt spec={{ voice: "app", scale: 13 / 12.5 }} whiteSpace="nowrap">
        + New task
      </Txt>
    </Press>
  );
}
