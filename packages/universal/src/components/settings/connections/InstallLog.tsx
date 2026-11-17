import { useMemo, type JSX } from "react";
import { ScrollView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { installLogHeadOf, terminalText, type InstallLog } from "@jaira/ui/installLog";
import { Txt, edge, scrollbarProps } from "../../../primitives";
import { useTokens } from "../../../tokens";
import { useLiveEdge } from "../../panel/RunTranscript";
import { SmallButton, Spin } from "./Row";

/**
 * What an install pressed in Connections printed, under the row it installs — an agent's
 * (`AgentRows.tsx`) or a git program's (`GitRows.tsx`) — as it prints it, and after it, until Hide.
 * The text is the service's raw output (`install:output`) as a terminal would be left showing it
 * (`terminalText`): a progress bar redrawn is its last drawing. How it looks:
 *
 *   the whole       30 in, under the sentence, as the install panel and "Runs as" are
 *   the head        row, centred, gap 6: running, the spinner, "installing…" (--dim) and Cancel;
 *                   after, "installed" in --ok, "… cancelled" in --dim, or the reason it failed in
 *                   --bad, and Hide
 *   the box         under the head, 6 apart: --bg, 1px --line, radius 8, padding 8 10; the data face
 *                   11/12 at 1.45, pre-wrap, selectable; at most 220 tall, then it scrolls — pinned to
 *                   the newest line until the reader scrolls up, and pinned again at the bottom
 */
export function InstallLogBox({ log, onCancel, onHide }: { log: InstallLog; onCancel: () => void; onHide: () => void }): JSX.Element {
  const t = useTokens();
  const text = useMemo(() => terminalText(log.text), [log.text]);
  const head = installLogHeadOf(log);
  // Pinned again for a new install: its output starts empty.
  const live = useLiveEdge(log.text.length === 0);
  const color = head.tone === "ok" ? "ok" : head.tone === "failed" ? "bad" : "dim";
  return (
    <View marginLeft={30} flexDirection="column" gap={6} minWidth={0} {...({ role: "log", "aria-live": "polite", "aria-label": "install output" } as object)}>
      <View flexDirection="row" alignItems="center" gap={6} minHeight={22}>
        {log.running ? <Spin /> : null}
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, lineHeight: 1.4, color }} flexShrink={1} minWidth={0} {...((isWeb ? { style: { overflowWrap: "anywhere" } } : {}) as object)}>
          {head.words}
        </Txt>
        {log.running ? (
          <SmallButton kind="ghost" title="stop the installer" onPress={onCancel}>
            Cancel
          </SmallButton>
        ) : (
          <SmallButton kind="ghost" title="put the output away" onPress={onHide}>
            Hide
          </SmallButton>
        )}
      </View>
      <ScrollView
        ref={live.ref}
        onScroll={live.onScroll}
        scrollEventThrottle={live.scrollEventThrottle}
        onContentSizeChange={live.onContentSizeChange}
        onLayout={live.onLayout}
        style={{
          maxHeight: 220,
          backgroundColor: t.v("bg") as string,
          borderRadius: 8,
          ...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object),
        }}
        contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 10 }}
        {...(scrollbarProps(t) as object)}
      >
        <Txt
          spec={{ voice: "data", scale: 11 / 12, lineHeight: 1.45, color: text.length > 0 ? "text" : "dim" }}
          selectable
          {...((isWeb ? { whiteSpace: "pre-wrap", style: { overflowWrap: "anywhere" } } : {}) as object)}
        >
          {text.length > 0 ? text : "starting…"}
        </Txt>
      </ScrollView>
    </View>
  );
}
