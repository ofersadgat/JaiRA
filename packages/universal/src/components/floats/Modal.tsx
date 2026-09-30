import type { JSX, ReactNode } from "react";
import { View as RNView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { useTokens } from "../../tokens";
import { MenuLayer } from "../MenuLayer";

/**
 * `.modal-backdrop` and `.modal`, universal (decision 0015): a dialog over everything, on the scrim,
 * centred — in the one layer the menus use (`MenuLayer`: portalled into `<body>` on web, a transparent
 * `Modal` on a phone). The rules, from `styles.css`:
 *
 *   .modal-backdrop   fixed over the window, --scrim, the dialog centred
 *   .modal            --panel, 1px --line, radius 12, padding 18, 380 wide at least, at most 720 (or 90%
 *                     of the window), --lift
 *   .modal-wide       1100 wide (or 94% of the window), at most 90% of its height, a column
 *
 * `onDismiss` is what a press on the scrim does, and Escape or Back: nothing, for a dialog the DOM does
 * not let go of that way (an approval, a module to trust). `staged` draws the box alone, where it
 * stands, as the Components room's stage neutralises the backdrop (`.gallery-stage .modal-backdrop`:
 * static; `.modal`: no least width, at most its place's, no shadow).
 */
export function ModalBox({
  wide = false,
  staged = false,
  onDismiss,
  label,
  testID,
  width,
  children,
}: {
  /** The dialog's own width, where its class sets one (`.folder-browser`: min(560px, 90vw)). */
  width?: number | string;
  wide?: boolean;
  staged?: boolean;
  onDismiss?: (() => void) | undefined;
  label?: string;
  testID?: string;
  children: ReactNode;
}): JSX.Element {
  const t = useTokens();
  const box = (
    <View
      flexDirection="column"
      backgroundColor={t.v("panel") as never}
      borderWidth={1}
      borderStyle="solid"
      borderColor={t.v("line") as never}
      borderRadius={12}
      padding={18}
      {...(staged
        ? { minWidth: 0, maxWidth: "100%", ...(wide ? { alignSelf: "stretch" } : { alignSelf: "flex-start" }) }
        : wide
          ? { width: isWeb ? "min(1100px, 94vw)" : "94%", maxWidth: isWeb ? "min(1100px, 94vw)" : "94%", maxHeight: isWeb ? "90vh" : "90%" }
          : { minWidth: 380, maxWidth: isWeb ? "min(720px, 90vw)" : "90%" })}
      {...(width !== undefined ? { width } : {})}
      {...((staged ? {} : { boxShadow: t.v("lift") }) as object)}
      {...(testID !== undefined ? { testID } : {})}
      {...((isWeb ? { role: "dialog", ...(label !== undefined ? { "aria-label": label } : {}) } : {}) as object)}
    >
      {children}
    </View>
  );
  if (staged) return box;
  return (
    <MenuLayer onClose={onDismiss ?? (() => undefined)} z={50}>
      <RNView pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", backgroundColor: String(t.v("scrim")) }}>
        {box}
      </RNView>
    </MenuLayer>
  );
}
