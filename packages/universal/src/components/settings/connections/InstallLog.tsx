import { useMemo, type JSX } from "react";
import { ScrollView } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import type { CommandDialect } from "@jaira/shared/browser";
import { installLogHeadOf, installLogPlain, type InstallBlock, type InstallLog } from "@jaira/ui/installLog";
import { TERM_INK, TermScreen } from "@jaira/ui/terminalModel";
import { copyText } from "../../../clipboard";
import { Txt, font, scrollbarProps } from "../../../primitives";
import { useTokens } from "../../../tokens";
import { useLiveEdge } from "../../panel/RunTranscript";
import { CommandLine, IconButton, ScreenLine } from "../../terminal/TermParts";
import { SmallButton, Spin } from "./Row";

/**
 * What an install pressed in Connections printed, under the row it installs — an agent's
 * (`AgentRows.tsx`) or a git program's (`GitRows.tsx`) — as it prints it, and after it, until Hide.
 * Drawn as the agents' terminal draws a command (decision 0028, `TermParts.tsx`): each command the
 * install ran on the terminal's ground — of several steps, which step it is — then what it printed in
 * its colours, a progress bar redrawn as its last drawing. How it looks:
 *
 *   the whole       30 in, under the sentence, as "Runs as" is
 *   the head        row, centred, gap 6: running, the spinner, "installing…" (--dim) and Cancel;
 *                   after, "installed" in --ok, "… cancelled" in --dim, or the reason it failed in
 *                   --bad, and Hide; Copy at its end
 *   the screen      under the head, 6 apart: the terminal's ground (#0f1120), radius 8, padding 8 14 10;
 *                   at most 260 tall, then it scrolls — pinned to the newest line until the reader
 *                   scrolls up, and pinned again at the bottom
 *   a command       its step (app 11, --hint ink) where there are several, then `❯` and the command
 *                   taken apart as the approval takes it, then its lines (data 11.5/12 on 19px); 10
 *                   between commands
 */
export function InstallLogBox({ log, dialect = "posix", onCancel, onHide }: { log: InstallLog; dialect?: CommandDialect; onCancel: () => void; onHide: () => void }): JSX.Element {
  const t = useTokens();
  const head = installLogHeadOf(log);
  // Pinned again for a new install: its output starts empty.
  const live = useLiveEdge(log.blocks.length === 0);
  const color = head.tone === "ok" ? "ok" : head.tone === "failed" ? "bad" : "dim";
  return (
    <View marginLeft={30} flexDirection="column" gap={6} minWidth={0} {...({ role: "log", "aria-live": "polite", "aria-label": "install output" } as object)}>
      <View flexDirection="row" alignItems="center" gap={6} minHeight={24}>
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
        <View flex={1} />
        <IconButton icon="copy" label="Copy the output" onPress={() => void copyText(installLogPlain(log, plainOf))} />
      </View>
      <ScrollView
        ref={live.ref}
        onScroll={live.onScroll}
        scrollEventThrottle={live.scrollEventThrottle}
        onContentSizeChange={live.onContentSizeChange}
        onLayout={live.onLayout}
        style={{ maxHeight: 260, backgroundColor: TERM_INK.ground, borderRadius: 8 }}
        contentContainerStyle={{ paddingTop: 8, paddingBottom: 10, paddingHorizontal: 14, gap: 10 }}
        {...(scrollbarProps(t) as object)}
      >
        {log.blocks.length === 0 ? <Txt spec={{ voice: "app", scale: 11.5 / 12.5, italic: true, color: TERM_INK.dim }}>starting…</Txt> : log.blocks.map((block, i) => <Block key={i} block={block} dialect={dialect} />)}
      </ScrollView>
    </View>
  );
}

/** A block's raw output as a terminal is left showing it, as text — what Copy takes. */
function plainOf(raw: string): string {
  const screen = new TermScreen();
  screen.write(raw);
  return screen.plain();
}

/** One command the install ran: its step, the command, and what it printed in its colours. */
function Block({ block, dialect }: { block: InstallBlock; dialect: CommandDialect }): JSX.Element {
  const t = useTokens();
  const lines = useMemo(() => {
    const screen = new TermScreen();
    screen.write(block.text);
    const all = screen.lines();
    // The newline that ends the output opens no line of its own.
    return all.length > 0 && all[all.length - 1]!.length === 0 ? all.slice(0, -1) : all;
  }, [block.text]);
  const data = font(t, { voice: "data", scale: 11.5 / 12, lineHeight: { px: 19 } }) as object;
  return (
    <View flexDirection="column" minWidth={0}>
      {block.step !== undefined ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: TERM_INK.hint }}>{block.step}</Txt> : null}
      {block.command !== undefined ? (
        <View flexDirection="row" alignItems="flex-start" gap={8} minWidth={0}>
          <Text {...data} color={TERM_INK.accent}>
            ❯
          </Text>
          <Text {...data} color={TERM_INK.text} flex={1} minWidth={0} {...((isWeb ? { style: { overflowWrap: "anywhere" } } : {}) as object)}>
            <CommandLine command={block.command} dialect={dialect} t={t} />
          </Text>
        </View>
      ) : null}
      {lines.map((line, i) => (
        <ScreenLine key={i} line={line} t={t} />
      ))}
    </View>
  );
}
