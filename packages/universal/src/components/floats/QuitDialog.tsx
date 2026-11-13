import { useEffect, type JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import type { QuitChoice, RunningWork } from "@jaira/shared/browser";
import { quitWaitingWords, quitWordsOf } from "@jaira/ui/quitModel";
import { answerQuit, quitShown, useQuit } from "@jaira/ui/quitStore";
import { Txt, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { FocusRing } from "./FocusRing";
import { Button } from "../settings/Button";
import { ModalBox } from "./Modal";

/**
 * Quitting with work going (the person, 2026-11-12): the dialog while main holds the quit, then the strip
 * while it waits for that work to finish. When each shows is main's (`main/quitGuard.ts`); the words are
 * `quitModel.ts`'s. Placed by `ShellFloats`; {@link QuitAsk} and {@link QuitWaiting} draw the two alone.
 */
export function QuitDialog(): JSX.Element | null {
  const state = useQuit();
  if (state.phase === "asking") return <QuitAsk work={state.work} onChoose={answerQuit} onShown={quitShown} />;
  if (state.phase === "waiting") return <QuitWaiting work={state.work} onChoose={answerQuit} />;
  return null;
}

const SUB = { voice: "app", scale: 11 / 12.5, color: "dim" } as const;

/**
 * The question. How it looks:
 *
 *   the dialog     `ModalBox`, 480 wide; not let go of by the scrim, Escape or a resize: its buttons answer it
 *   its title      app 17/12.5, 700, line 1.35, 8 under it
 *   the note       --tint-accent ground, radius --control-radius, padding 7 9, app 11/12.5, --dim
 *   the list       12 above, a column, 1px --line, radius 8; a row padding 6 10, a 1px --line between;
 *                  the title app 12.5, one line, ellipsed, the detail and a parked row's status under it
 *                  app 11/12.5 --dim; "and N more" app 11/12.5 --dim, padding 6 10
 *   the buttons    row, wrapping, gap 8, 14 above: Wait `primary` (with the focus), Quit now `danger`,
 *                  Cancel `ghost`
 */
export function QuitAsk({
  work,
  onChoose,
  onShown,
  staged = false,
}: {
  work: readonly RunningWork[];
  onChoose: (choice: QuitChoice) => void;
  onShown?: () => void;
  staged?: boolean;
}): JSX.Element {
  const t = useTokens();
  const words = quitWordsOf(work);
  useEffect(() => {
    onShown?.();
  }, [onShown]);
  const radius = lengthToken(t, "control-radius", 7);
  return (
    // No `onDismiss`: the layer lets go on a press outside, Escape and a resize alike, and a window
    // brought back from the taskbar to show this resizes. It is answered by its buttons.
    <ModalBox staged={staged} label={words.title} testID="quit-dialog" width={480}>
      <Txt spec={{ voice: "app", scale: 17 / 12.5, weight: 700, lineHeight: 1.35 }} marginBottom={8}>
        {words.title}
      </Txt>
      <View backgroundColor={t.v("tint-accent") as never} borderRadius={radius} paddingVertical={7} paddingHorizontal={9}>
        <Txt spec={SUB}>{words.note}</Txt>
      </View>
      <View marginTop={12} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={8}>
        {words.rows.map((row, i) => (
          <View
            key={row.key}
            paddingVertical={6}
            paddingHorizontal={10}
            {...(i > 0 ? { borderTopWidth: 1, borderStyle: "solid", borderTopColor: t.v("line") as never } : {})}
          >
            <Txt spec={{ voice: "app", scale: 1 }} numberOfLines={1} {...(isWeb ? { title: row.title } : {})}>
              {row.title}
            </Txt>
            <Txt spec={SUB} numberOfLines={1}>
              {row.detail}
              {row.status !== "running" ? ` · ${row.status}` : ""}
            </Txt>
          </View>
        ))}
        {words.more > 0 ? (
          <View paddingVertical={6} paddingHorizontal={10} borderTopWidth={1} borderStyle="solid" borderTopColor={t.v("line") as never}>
            <Txt spec={SUB}>and {words.more} more</Txt>
          </View>
        ) : null}
      </View>
      <View flexDirection="row" flexWrap="wrap" gap={8} marginTop={14}>
        <FocusRing radius={radius} autoFocus={!staged}>
          <Button kind="primary" onPress={() => onChoose("wait")} testID="quit-wait">
            {words.buttons[0]!.label}
          </Button>
        </FocusRing>
        <Button kind="danger" onPress={() => onChoose("now")} testID="quit-now">
          {words.buttons[1]!.label}
        </Button>
        <Button kind="ghost" onPress={() => onChoose("cancel")} testID="quit-cancel">
          {words.buttons[2]!.label}
        </Button>
      </View>
    </ModalBox>
  );
}

/**
 * While the quit waits: a strip at the window's foot, over everything, above where the toast stands.
 * How it looks:
 *
 *   the strip    fixed, 96 above the foot, centred, row, gap 9, padding 6 8 6 13, 1px --line, radius
 *                --card-radius, --panel, --lift; z 60
 *   the words    app 11.5/12.5, --dim
 *   the buttons  Quit now `danger`, Don't quit `ghost`
 */
export function QuitWaiting({ work, onChoose, staged = false }: { work: readonly RunningWork[]; onChoose: (choice: QuitChoice) => void; staged?: boolean }): JSX.Element {
  const t = useTokens();
  const strip = (
    <View
      flexDirection="row"
      alignItems="center"
      gap={9}
      paddingTop={6}
      paddingRight={8}
      paddingBottom={6}
      paddingLeft={13}
      borderWidth={1}
      borderStyle="solid"
      borderRadius={lengthToken(t, "card-radius", 10)}
      borderColor={t.v("line") as never}
      backgroundColor={t.v("panel") as never}
      testID="quit-waiting"
      {...((staged ? {} : { boxShadow: t.v("lift") }) as object)}
      {...((isWeb ? { role: "status" } : {}) as object)}
    >
      <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>{quitWaitingWords(work)}</Txt>
      <Button kind="danger" onPress={() => onChoose("now")}>
        Quit now
      </Button>
      <Button kind="ghost" onPress={() => onChoose("cancel")}>
        Don&apos;t quit
      </Button>
    </View>
  );
  if (staged) return strip;
  if (isWeb) {
    return (
      <View position={"fixed" as never} left="50%" bottom={96} zIndex={60} maxWidth="90vw" {...({ transform: [{ translateX: "-50%" }] } as object)}>
        {strip}
      </View>
    );
  }
  return (
    <View position="absolute" left={0} right={0} bottom={96} zIndex={60} alignItems="center" pointerEvents="box-none">
      {strip}
    </View>
  );
}
