import type { JSX } from "react";
import { View } from "@tamagui/core";
import { askedWords, useMachines } from "@jaira/ui/machinesModel";
import { invoke } from "@jaira/ui/store";
import { Txt, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { MachineIcon } from "../MachineIcon";
import { Button } from "../settings/Button";
import { ModalBox } from "./Modal";

/**
 * The code another machine or a phone asked this one to show (decision 0022 §5): over whatever the
 * window shows, until it is typed there, runs out, or is refused. Typing it on the asker proves the
 * person can use both screens. What it says is `machinesModel.ts`'s `askedWords`. How it looks:
 *
 *   the dialog     `ModalBox`, 470 wide at most; its parts a column, gap 12
 *   its title      row, gap 10: the asker's icon (22: its shape, its system's mark), app 17/12.5, 700
 *   the code       the data face at 24/12, 500, 0.04em, centred, padding 14 8, --panel-2, radius
 *                  --control-radius, selectable
 *   the note       app 1, line 1.45, --dim
 *   Refuse         `ghost`, at the end
 */
export function PairCodeDialog(): JSX.Element | null {
  const t = useTokens();
  const [view, setView] = useMachines();
  const words = view === undefined ? undefined : askedWords(view);
  const asked = view?.asked;
  if (words === undefined || asked === undefined) return null;
  const refuse = (): void => void invoke("machines:refuse", undefined).then(setView, () => undefined);
  return (
    <ModalBox label={words.title} testID="pair-code-dialog" width={470}>
      <View gap={12}>
        <View flexDirection="row" alignItems="center" gap={10}>
          <MachineIcon face={{ shape: asked.by.kind === "phone" ? "phone" : (asked.by.form ?? "desktop"), ...(asked.by.os !== undefined ? { mark: asked.by.os } : {}) }} size={22} />
          <Txt spec={{ voice: "app", scale: 17 / 12.5, weight: 700, lineHeight: 1.35 }} flexShrink={1}>
            {words.title}
          </Txt>
        </View>
        <Txt
          spec={{ voice: "data", scale: 24 / 12, weight: 500, ls: 0.04 }}
          textAlign="center"
          paddingVertical={14}
          paddingHorizontal={8}
          backgroundColor={t.v("panel-2") as never}
          borderRadius={lengthToken(t, "control-radius", 7)}
          selectable
        >
          {asked.code}
        </Txt>
        <Txt spec={{ voice: "app", scale: 1, lineHeight: 1.45, color: "dim" }}>{words.note}</Txt>
        <View flexDirection="row" justifyContent="flex-end">
          <Button kind="ghost" onPress={refuse}>
            Refuse
          </Button>
        </View>
      </View>
    </ModalBox>
  );
}
