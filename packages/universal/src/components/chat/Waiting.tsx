import type { JSX } from "react";
import { Pressable } from "react-native";
import { View } from "@tamagui/core";
import { formatResetAt, type WaitingItem } from "@jaira/shared/browser";
import { actOnWaiting, useLimits, useNow } from "@jaira/ui/limitsStore";
import { Press, Txt, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { Icon } from "../panel/Icon";
import { Button } from "../settings/Button";

/**
 * A message waiting for the allowance (`WaitingLine`, `WaitingMessage`), drawn as the bubble it will
 * be — faded and dashed — with the line under it that says when it goes, and the verbs (send now, try
 * again, delete). What they do is `limitsStore.ts`'s `actOnWaiting`. How it looks:
 *
 *   the host           column, gap 6, padding 0 16 6, 900 at most, centred
 *   the message        at the end, at most 78%, margin 14 0 10; its bubble at .7, its edge dashed
 *   the line under     row, wrapping, centred, to the end, gap 6 12, 6 above, app 12.5/12.5
 *   its reason         row, gap 6, --dim (refused: --bad); the time 600 --text; the clock 1em
 *   the retry tick     row, gap 7, a 14 checkbox in --accent
 *   a small button     ghost, app 12/12.5, padding 3 9
 *   the rail           shown: "Delete", padding 4, app 11/12.5 on 1, --dim
 */
export function WaitingHost({ items }: { items: readonly WaitingItem[] }): JSX.Element {
  return (
    <View flexDirection="column" gap={6} paddingHorizontal={16} paddingBottom={6} width="100%" maxWidth={900} alignSelf="center">
      {items.map((item) => (item.state === "waiting" ? <WaitingMessage key={item.id} item={item} /> : <WaitingLine key={item.id} item={item} />))}
    </View>
  );
}

const SMALL = { voice: "app" as const, scale: 12 / 12.5 };

export function WaitingLine({ item, run = false, onStop }: { item: WaitingItem; run?: boolean; onStop?: (() => void) | undefined }): JSX.Element {
  const t = useTokens();
  const limits = useLimits();
  const now = useNow();
  const account = limits.accounts.find((a) => a.key === item.account);
  const who = account?.brand ?? item.account;
  const at = item.until !== null ? formatResetAt(item.until, now) : undefined;
  const words = { voice: "app" as const, scale: 1 };
  const b = { ...words, weight: 600, color: "text" };
  const why = (ink: string, children: JSX.Element | string): JSX.Element => (
    <View flexDirection="row" alignItems="center" gap={6} flexShrink={1}>
      <Icon name="clock" size={Number(t.scaled("size-app", 1)) || 12.5} color={String(t.v(ink))} />
      <Txt spec={{ ...words, color: ink }} flexShrink={1}>
        {children}
      </Txt>
    </View>
  );
  const small = (label: string, onPress: () => void): JSX.Element => (
    <Button kind="ghost" onPress={onPress} font={SMALL} paddingVertical={3} paddingHorizontal={9}>
      {label}
    </Button>
  );
  return (
    <View flexDirection="row" flexWrap="wrap" alignItems="center" justifyContent={run ? "flex-start" : "flex-end"} rowGap={6} columnGap={12} marginTop={run ? 4 : 6} {...(run ? { marginBottom: 4 } : {})}>
      {item.state === "waiting" ? (
        why(
          "dim",
          <>
            Waiting: sends{at !== undefined ? <> at <Txt spec={b}>{at}</Txt></> : " when the limit resets"}, when {who}&apos;s limit resets
          </>,
        )
      ) : item.credit === true ? (
        why("bad", `${run ? "Refused mid-turn" : "Refused"}: ${who}'s balance is empty. Add credit, then send it again.`)
      ) : (
        <>
          {why("bad", `${run ? "Refused mid-turn" : "Refused"}: ${who} has no usage left.`)}
          <Pressable onPress={() => actOnWaiting(item.id, "retry", !item.retry)} role="checkbox" aria-checked={item.retry} style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
            <View width={14} height={14} borderRadius={3} borderWidth={1} borderStyle="solid" borderColor={t.v(item.retry ? "accent" : "rule") as never} backgroundColor={(item.retry ? t.v("accent") : t.v("panel")) as never} alignItems="center" justifyContent="center">
              {item.retry ? <Icon name="check" size={10} color="#fff" /> : null}
            </View>
            <Txt spec={words} numberOfLines={1}>
              {at !== undefined ? (
                <>
                  Try again at <Txt spec={{ ...words, weight: 600 }}>{at}</Txt>
                </>
              ) : (
                "Try again when the limit resets"
              )}
            </Txt>
          </Pressable>
        </>
      )}
      {small("Send now anyway", () => actOnWaiting(item.id, "sendNow"))}
      {run && onStop !== undefined ? small("Stop the run", onStop) : null}
    </View>
  );
}

/** A waiting message, drawn as the bubble it will be — faded and dashed — with its line under it. */
export function WaitingMessage({ item }: { item: WaitingItem }): JSX.Element {
  const t = useTokens();
  return (
    <View alignSelf="flex-end" maxWidth="78%" minWidth={0} marginTop={14} marginBottom={10}>
      <View
        paddingVertical={8}
        paddingHorizontal={13}
        borderTopLeftRadius={16}
        borderTopRightRadius={16}
        borderBottomLeftRadius={16}
        borderBottomRightRadius={5}
        borderWidth={1}
        borderStyle="dashed"
        borderColor={t.mix(t.v("accent"), 24, t.v("line")) as never}
        backgroundColor={t.mix(t.v("accent"), 13, t.v("panel")) as never}
        opacity={0.7}
      >
        <Txt spec={{ voice: "app", scale: 13 / 12.5, lineHeight: 1.6, color: "text" }} whiteSpace="pre-wrap">
          {item.message ?? ""}
        </Txt>
      </View>
      <WaitingLine item={item} />
      <View flexDirection="row" alignItems="center" marginTop={4} minHeight={22} paddingHorizontal={1}>
        <View flex={1} />
        <Press
          onPress={() => actOnWaiting(item.id, "drop")}
          title="Delete this message — it will not be sent"
          padding={4}
          borderRadius={lengthToken(t, "control-radius-sm", 6)}
          box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
        >
          {({ hovered }) => (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: hovered ? "text" : "dim", lineHeight: 1 }} numberOfLines={1}>
              Delete
            </Txt>
          )}
        </Press>
      </View>
    </View>
  );
}

