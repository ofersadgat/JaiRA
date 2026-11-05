import type { JSX, ReactNode } from "react";
import { View } from "@tamagui/core";
import type { LiveStatus } from "@jaira/ui/transcript";
import { useLook, useTokens } from "../../tokens";
import { Press, Txt, edge } from "../../primitives";
import { statusFigureOf, statusToneOf, statusVerbOf, statusWhatOf } from "@jaira/ui/liveStatusModel";
import { useElapsed } from "@jaira/ui/runActivityModel";
import { Icon } from "../panel/Icon";
import { Pulse } from "./Pulse";

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
 * What the model is doing right now, in one of two places (`appearance.conversation.liveStatus`): a
 * pill over the thread's end (`LiveStatusPill`), or the composer's first line (`LiveStatusLine`). The
 * words, and who it waits on, are `liveStatusModel.ts`'s; both draw the same ones. Neither stands
 * between the thread and the box, so the thread's fade into the ground is its own.
 *
 *   the words           row, centred, gap 8, app 11.5/12.5, --dim, tabular
 *   the mark            the pulse; waiting for you: the pause mark (13, --warn); checking with auto: the
 *                       star (13, --accent)
 *   the verb            600, --accent (waiting for you: --warn)
 *   what it is on       the data voice, one line
 *   the jump            --accent, pressed to go back to the live edge
 */
function LiveStatusWords({ status, grow }: { status: LiveStatus; grow: boolean }): JSX.Element {
  const t = useTokens();
  const since = status.kind === "writing" || status.kind === "working" ? undefined : status.since;
  const elapsed = useElapsed(since, true);
  const figure = statusFigureOf(status, elapsed);
  const tone = statusToneOf(status);
  const what = statusWhatOf(status);
  return (
    <>
      {tone === "you" ? <Icon name="pause" size={13} color={String(t.v("warn"))} /> : tone === "check" ? <Icon name="star" size={13} color={String(t.v("accent"))} /> : <Pulse />}
      <Txt spec={{ ...LIVE_FACE, weight: 600, color: tone === "you" ? "warn" : "accent" }} flexShrink={0}>
        {statusVerbOf(status)}
      </Txt>
      {what !== "" || grow ? (
        <Txt spec={{ ...LIVE_FACE, voice: "data" }} fontSize={t.scaled("size-app", 11.5 / 12.5)} ellip minWidth={0} {...(grow ? { flex: 1 } : { flexShrink: 1 })}>
          {what}
        </Txt>
      ) : null}
      {figure !== undefined ? (
        <Txt spec={LIVE_FACE} flexShrink={0}>
          {figure}
        </Txt>
      ) : null}
    </>
  );
}

const LIVE_FACE = { voice: "app" as const, scale: 11.5 / 12.5, color: "dim", tabular: true };

/** How tall the status pill stands over the thread, with the 8 under it: what the thread leaves free. */
export const LIVE_PILL_HEIGHT = 40;

/**
 * `LiveStatusPill`: the words on a pill, in the row the waits' pills stand in over the box
 * (`WaitPills`, design W3), first of them.
 *
 *   the pill            row, at most 560, radius 999, --panel, a 1px --line ring, 0 4 14
 *                       rgba(15,20,30,.12); waiting for you: --warn 10% into --panel, a --warn 30% into
 *                       --line ring, as a wait's pill
 *   its words           padding 5 14 5 12
 *   the jump            away from the live edge: a second compartment, a 1px --line before it, padding
 *                       0 12 0 10, app 11.5/12.5 --accent; hovered --fill-ghost-hover
 */
export function LiveStatusPill({ status, onJump }: { status: LiveStatus; onJump?: (() => void) | undefined }): JSX.Element {
  const t = useTokens();
  const you = statusToneOf(status) === "you";
  return (
    <View
      flexDirection="row"
      alignItems="stretch"
      minWidth={0}
      flexShrink={1}
      maxWidth={560}
      borderRadius={999}
      overflow="hidden"
      backgroundColor={(you ? t.mix(t.v("warn"), 10, t.v("panel")) : t.v("panel")) as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, you ? t.mix(t.v("warn"), 30, t.v("line")) : undefined) as object)}
      {...({ boxShadow: "0px 4px 14px rgba(15, 20, 30, 0.12)" } as object)}
    >
      <View role="status" flexDirection="row" alignItems="center" gap={8} minWidth={0} flexShrink={1} paddingVertical={5} paddingLeft={12} paddingRight={14}>
        <LiveStatusWords status={status} grow={false} />
      </View>
      {onJump !== undefined ? (
        <Press
          onPress={onJump}
          flexShrink={0}
          flexDirection="row"
          alignItems="center"
          paddingLeft={10}
          paddingRight={12}
          {...(edge(t, { left: 1 }) as object)}
          box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" }) as never}
        >
          <Txt spec={{ ...LIVE_FACE, color: "accent" }} numberOfLines={1}>
            Jump to live ↓
          </Txt>
        </Press>
      ) : null}
    </View>
  );
}

/**
 * `LiveStatusLine`: the words as the composer's first line, over what is being typed.
 *
 *   the line            row, padding 7 15 0; what it is on takes the room, the jump hard right
 *   waiting for you     padding 7 15, --warn 10% into --panel, the shell's top corners (21)
 */
export function LiveStatusLine({ status, onJump }: { status: LiveStatus; onJump?: (() => void) | undefined }): JSX.Element {
  const t = useTokens();
  const you = statusToneOf(status) === "you";
  return (
    <View
      role="status"
      flexDirection="row"
      alignItems="center"
      gap={8}
      minWidth={0}
      paddingTop={7}
      paddingHorizontal={15}
      {...(you ? { paddingBottom: 7, borderTopLeftRadius: 21, borderTopRightRadius: 21, backgroundColor: t.mix(t.v("warn"), 10, t.v("panel")) as never } : {})}
    >
      <LiveStatusWords status={status} grow />
      {onJump !== undefined ? (
        <Press onPress={onJump} flexShrink={0} paddingHorizontal={2}>
          <Txt spec={{ ...LIVE_FACE, color: "accent" }} numberOfLines={1}>
            Jump to live ↓
          </Txt>
        </Press>
      ) : null}
    </View>
  );
}
