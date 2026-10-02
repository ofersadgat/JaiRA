import type { JSX } from "react";
import { View } from "@tamagui/core";
import { secondsOf } from "@jaira/ui/workSummary";
import { useNow } from "@jaira/ui/workSummaryContext";
import { Press, Txt, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { Icon } from "../panel/Icon";

/**
 * The message that opens a conversation, while it has not been sent: the conversation is being placed,
 * or waits for a workspace with room (decision 0013 §5, ruled 2026-10-02). Drawn as the bubble it will
 * be, under the summary of what is being done to place it (`PlacementSummary.tsx`). How it looks:
 *
 *   the message        at the end, at most 78%, margin 14 0 10
 *   being placed       its bubble at .7, its edge dashed (--accent 24% into --line), as a message
 *                      waiting for the allowance is
 *   waiting            the bubble --warn 8% into --panel, 1px dashed --warn 50% into --line
 *   the pill           under it, at the end, 6 above: row, gap 4, padding 1 8, round, --warn 13% into
 *                      --panel; a clock 11 and "queued · 2 min 14 s" app 11/12.5 --warn, tabular
 *   the rail           4 above, at least 22 tall, at the end: "Edit" and "Delete", padding 4, app
 *                      11/12.5 on 1, --dim (hovered --text on --fill-ghost-hover)
 */
export function QueuedMessage({ message, since, waiting, onEdit, onDelete, at }: { message: string; /** When placing began. */ since: number; /** Nothing had room: it waits. Otherwise it is being placed now. */ waiting: boolean; onEdit?: (() => void) | undefined; onDelete?: (() => void) | undefined; /** The moment it is drawn as of, for a still picture; absent, now. */ at?: number }): JSX.Element {
  const t = useTokens();
  const ticking = useNow(waiting && at === undefined);
  const now = at ?? ticking;
  const act = (label: string, title: string, onPress: () => void): JSX.Element => (
    <Press onPress={onPress} title={title} padding={4} borderRadius={lengthToken(t, "control-radius-sm", 6)} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}>
      {({ hovered }) => (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: hovered ? "text" : "dim", lineHeight: 1 }} numberOfLines={1}>
          {label}
        </Txt>
      )}
    </Press>
  );
  return (
    <View testID="queued-message" alignSelf="flex-end" alignItems="flex-end" maxWidth="78%" minWidth={0} marginTop={14} marginBottom={10}>
      <View
        paddingVertical={8}
        paddingHorizontal={13}
        borderTopLeftRadius={16}
        borderTopRightRadius={16}
        borderBottomLeftRadius={16}
        borderBottomRightRadius={5}
        borderWidth={1}
        borderStyle="dashed"
        borderColor={(waiting ? t.mix(t.v("warn"), 50, t.v("line")) : t.mix(t.v("accent"), 24, t.v("line"))) as never}
        backgroundColor={(waiting ? t.mix(t.v("warn"), 8, t.v("panel")) : t.mix(t.v("accent"), 13, t.v("panel"))) as never}
        {...(waiting ? {} : { opacity: 0.7 })}
      >
        <Txt spec={{ voice: "app", scale: 13 / 12.5, lineHeight: 1.6, color: "text" }} whiteSpace="pre-wrap">
          {message}
        </Txt>
      </View>
      {waiting ? (
        <>
          <View flexDirection="row" alignItems="center" gap={4} marginTop={6} paddingVertical={1} paddingHorizontal={8} borderRadius={999} backgroundColor={t.mix(t.v("warn"), 13, t.v("panel")) as never}>
            <Icon name="clock" size={11} color={String(t.v("warn"))} />
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn", tabular: true }} numberOfLines={1}>
              {`queued · ${secondsOf(Math.max(0, now - since))}`}
            </Txt>
          </View>
          {onEdit !== undefined || onDelete !== undefined ? (
            <View flexDirection="row" alignItems="center" gap={2} marginTop={4} minHeight={22} paddingHorizontal={1}>
              {onEdit !== undefined ? act("Edit", "Take this message back to change it — the conversation has not started", onEdit) : null}
              {onDelete !== undefined ? act("Delete", "Delete this message — the conversation has not started, and will not", onDelete) : null}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
