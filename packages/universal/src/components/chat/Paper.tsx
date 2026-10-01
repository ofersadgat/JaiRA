import type { JSX, ReactNode } from "react";
import { View } from "@tamagui/core";
import type { LiveStatus } from "@jaira/ui/transcript";
import { useLook, useTokens } from "../../tokens";
import { Press, Txt, edge } from "../../primitives";
import { statusFigureOf, statusVerbOf, statusWhatOf } from "@jaira/ui/liveStatusModel";
import { useElapsed } from "@jaira/ui/runActivityModel";

/**
 * The sheet a conversation is printed on, on the grey it floats over. How it looks:
 *
 *   the page    at least the scroller's height, padding 14 16 22, --bg
 *   the sheet   900 at most, centred, --panel, 1px --line, radius 12, clipped;
 *               a shadow 0 1 3 rgba(15,20,30,.06) (dark: rgba(0,0,0,.35))
 */
export function Paper({ children, minHeight }: { children: ReactNode; minHeight?: number | undefined }): JSX.Element {
  const t = useTokens();
  const look = useLook();
  return (
    <View paddingTop={14} paddingHorizontal={16} paddingBottom={22} backgroundColor={t.v("bg") as never} {...(minHeight !== undefined ? { minHeight } : {})}>
      <Sheet dark={look.scheme === "dark"}>{children}</Sheet>
    </View>
  );
}

/** The sheet alone — the second and third pages of a thread with a seam, which sit on the same page. */
export function Sheet({ children, dark }: { children: ReactNode; dark: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <View
      width="100%"
      maxWidth={900}
      alignSelf="center"
      backgroundColor={t.v("panel") as never}
      borderRadius={12}
      overflow="hidden"
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
      {...({ boxShadow: dark ? "0px 1px 3px rgba(0, 0, 0, 0.35)" : "0px 1px 3px rgba(15, 20, 30, 0.06)" } as object)}
    >
      {children}
    </View>
  );
}

/**
 * `Pulse`: three dots in the colour given, 4 round, 3 apart, at .55. Drawn still: they do not
 * breathe.
 */
export function Pulse({ color = "accent" }: { color?: string }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" alignItems="center" gap={3} flexShrink={0}>
      {[0, 1, 2].map((i) => (
        <View key={i} width={4} height={4} borderRadius={999} opacity={0.55} backgroundColor={t.v(color) as never} />
      ))}
    </View>
  );
}

/**
 * `LiveStatusBar`: what the model is doing right now, in one fixed place between the record and the
 * box. The words are `liveStatusModel.ts`'s.
 *
 *   the bar             row, centred, gap 8, padding 5 14, a --line above, --accent 5% over transparent,
 *                       app 11.5/12.5, --dim, tabular
 *   the verb            600, --accent
 *   what it is on       the data voice, flex 1, one line
 *   the jump            --accent, pressed to go back to the live edge
 */
export function LiveStatusBar({ status, onJump }: { status: LiveStatus; onJump?: (() => void) | undefined }): JSX.Element {
  const t = useTokens();
  const since = status.kind === "writing" || status.kind === "working" ? undefined : status.since;
  const elapsed = useElapsed(since, true);
  const figure = statusFigureOf(status, elapsed);
  const face = { voice: "app" as const, scale: 11.5 / 12.5, color: "dim", tabular: true };
  return (
    <View
      flexShrink={0}
      flexDirection="row"
      alignItems="center"
      gap={8}
      minWidth={0}
      paddingVertical={5}
      paddingHorizontal={14}
      backgroundColor={t.mix(t.v("accent"), 5, "transparent") as never}
      {...(edge(t, { top: 1 }) as object)}
    >
      <Pulse />
      <Txt spec={{ ...face, weight: 600, color: "accent" }} flexShrink={0}>
        {statusVerbOf(status)}
      </Txt>
      <Txt spec={{ ...face, voice: "data" }} fontSize={t.scaled("size-app", 11.5 / 12.5)} ellip flex={1} minWidth={0}>
        {statusWhatOf(status)}
      </Txt>
      {figure !== undefined ? (
        <Txt spec={face} flexShrink={0}>
          {figure}
        </Txt>
      ) : null}
      {onJump !== undefined ? (
        <Press onPress={onJump} marginLeft="auto" flexShrink={0} paddingHorizontal={2}>
          <Txt spec={{ ...face, color: "accent" }} numberOfLines={1}>
            Jump to live ↓
          </Txt>
        </Press>
      ) : null}
    </View>
  );
}
