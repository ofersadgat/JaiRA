import { useState, type JSX } from "react";
import { TextInput, View as RNView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { AskSpec } from "@jaira/ui/menu";
import { Press, Txt, font, lengthToken, padToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { MenuLayer } from "../MenuLayer";
import { Button } from "../settings/Button";

/**
 * `menu.tsx`'s `AskDialog`, universal (decision 0015): ask before something irreversible, and ask for a
 * name when one is needed — the tree's rename, duplicate and delete, and the second ask a refused one
 * makes. Not portalled on the desktop, so it wears the variables of where it is opened (the sidebar's,
 * from the tree); it takes the tokens of where it is drawn here too. The rules, from `styles.css`:
 *
 *   .modal-backdrop   over everything, --scrim, the dialog centred
 *   .modal            --panel, 1px --line, radius 12, padding 18, 380 to 720 wide, --lift
 *   .modal h3         app 17/12.5, line 1.35, --text
 *   .notice(.bad)     --tint-accent (--tint-bad) ground, radius --control-radius, padding 7 9, app 11/12.5,
 *                     --dim (--bad)
 *   .field            12 above; its label app 11/12.5, --dim, 0.04em, uppercase, 4 over the box
 *   input             --bg, 1px --line, radius --control-radius, padding 5 9, the body's font
 *   .options          row, gap 8, 14 above; the confirm `primary` (or `danger`: --bad on nothing, its
 *                     ring --bad at 40% into --line), then Cancel `ghost`
 */
export function AskDialog({ spec, onCancel }: { spec: AskSpec; onCancel: () => void }): JSX.Element {
  const t = useTokens();
  const [value, setValue] = useState(spec.initial ?? "");
  const [focused, setFocused] = useState(false);
  const needsValue = spec.field !== undefined;
  const ok = !needsValue || value.trim().length > 0;
  const confirm = (): void => {
    if (ok) spec.onConfirm(value.trim());
  };
  return (
    <MenuLayer onClose={onCancel}>
      <RNView pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", backgroundColor: String(t.v("scrim")) }}>
        <View
          backgroundColor={t.v("panel") as never}
          borderWidth={1}
          borderStyle="solid"
          borderColor={t.v("line") as never}
          borderRadius={12}
          padding={18}
          minWidth={380}
          maxWidth={720}
          {...({ boxShadow: t.v("lift") } as object)}
          role="dialog"
          aria-label={spec.title}
        >
          <Txt spec={{ voice: "app", scale: 17 / 12.5, weight: 700, lineHeight: 1.35 }} marginBottom={8}>
            {spec.title}
          </Txt>
          {spec.note ? (
            <View backgroundColor={t.v(spec.danger ? "tint-bad" : "tint-accent") as never} borderRadius={lengthToken(t, "control-radius", 7)} paddingVertical={7} paddingHorizontal={9}>
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: spec.danger ? "bad" : "dim" }}>{spec.note}</Txt>
            </View>
          ) : null}
          {needsValue ? (
            <View marginTop={12} gap={4}>
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim", ls: 0.04, upper: true }}>{spec.field}</Txt>
              <TextInput
                value={value}
                onChangeText={setValue}
                autoFocus
                spellCheck={false}
                onSubmitEditing={confirm}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                style={{
                  ...(font(t, { voice: "app", scale: 13 / 12.5 }) as object),
                  backgroundColor: t.v("bg"),
                  borderWidth: 1,
                  borderStyle: "solid",
                  borderColor: t.v("line"),
                  borderRadius: lengthToken(t, "control-radius", 7),
                  paddingVertical: 5,
                  paddingHorizontal: 9,
                  // `:focus-visible`: a 2px --focus-ring outline, 1 outside the box (web).
                  ...(isWeb ? (focused ? { outlineWidth: 2, outlineStyle: "solid", outlineColor: t.v("focus-ring"), outlineOffset: 1 } : { outlineStyle: "none" }) : {}),
                } as never}
              />
            </View>
          ) : null}
          <View flexDirection="row" flexWrap="wrap" gap={8} marginTop={14}>
            {spec.danger ? <DangerButton label={spec.confirmLabel} disabled={!ok} onPress={confirm} /> : (
              <Button kind="primary" onPress={confirm} disabled={!ok}>
                {spec.confirmLabel}
              </Button>
            )}
            <Button kind="ghost" onPress={onCancel}>
              Cancel
            </Button>
          </View>
        </View>
      </RNView>
    </MenuLayer>
  );
}

/** `button.danger`: --bad on nothing, its ring --bad at 40% into --line; hovered --tint-bad, the ring at 60%. */
function DangerButton({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  const [padV, padH] = padToken(t, "control-pad", [3, 10]);
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      label={label}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      paddingVertical={padV}
      paddingHorizontal={padH}
      borderWidth={1}
      borderStyle="solid"
      borderRadius={lengthToken(t, "control-radius", 7)}
      {...(disabled ? { opacity: 0.5 } : {})}
      box={({ hovered }) => ({
        backgroundColor: hovered && !disabled ? t.v("tint-bad") : "transparent",
        borderColor: t.mix(t.v("bad"), hovered && !disabled ? 60 : 40, t.v("line")),
      })}
    >
      <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "bad" }} {...(isWeb ? { whiteSpace: "nowrap" } : {})}>
        {label}
      </Txt>
    </Press>
  );
}
