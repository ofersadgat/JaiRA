import { useMemo, type JSX } from "react";
import { ScrollView } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import type { CommandDialect } from "@jaira/shared/browser";
import { TERM_INK, TermScreen } from "@jaira/ui/terminalModel";
import { Txt, font, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { useLiveEdge } from "../panel/RunTranscript";
import { CommandLine, ScreenLine } from "./TermParts";

/** One command a log shows, and what it printed — raw, escapes and carriage returns as they came. */
export interface TermLogBlock {
  /** What it ran; absent for what was said before the first command. */
  command?: string;
  /** Of several steps, which this is: `Step 2 of 3: Node.js (fnm)`. */
  step?: string;
  text: string;
}

/**
 * Output that is not one of the agents' terminals, drawn as one (decision 0028): an install in Settings →
 * Connections (`InstallLog.tsx`), a workspace being made in Open (`OpenProject.tsx`). How it looks:
 *
 *   the screen      the terminal's ground (#0f1120), radius 8, padding 8 14 10; at most `maxHeight`
 *                   tall then it scrolls, or (`fill`) as tall as what holds it — pinned to the newest
 *                   line until the reader scrolls up, and pinned again at the bottom
 *   a command       its step (app 11, --hint ink) where there are several, then `❯` and the command
 *                   taken apart as the approval takes it, wrapping, then its lines (data 11.5/12 on
 *                   19px), a line too long for the box wrapping rather than running past it; 10
 *                   between commands
 */
export function TermLog({
  blocks,
  dialect = "posix",
  reset,
  maxHeight,
  fill = false,
  minHeight,
}: {
  blocks: readonly TermLogBlock[];
  dialect?: CommandDialect;
  /** A new log: pinned to its end again. */
  reset: unknown;
  maxHeight?: number;
  fill?: boolean;
  minHeight?: number;
}): JSX.Element {
  const t = useTokens();
  const live = useLiveEdge(reset);
  return (
    <ScrollView
      ref={live.ref}
      onScroll={live.onScroll}
      scrollEventThrottle={live.scrollEventThrottle}
      onContentSizeChange={live.onContentSizeChange}
      onLayout={live.onLayout}
      style={{
        backgroundColor: TERM_INK.ground,
        borderRadius: 8,
        minWidth: 0,
        ...(maxHeight !== undefined ? { maxHeight } : {}),
        ...(minHeight !== undefined ? { minHeight } : {}),
        ...(fill ? { flexGrow: 1, flexShrink: 1 } : {}),
      }}
      contentContainerStyle={{ paddingTop: 8, paddingBottom: 10, paddingHorizontal: 14, gap: 10 }}
      {...(scrollbarProps(t) as object)}
    >
      {blocks.length === 0 ? <Txt spec={{ voice: "app", scale: 11.5 / 12.5, italic: true, color: TERM_INK.dim }}>starting…</Txt> : blocks.map((block, i) => <Block key={i} block={block} dialect={dialect} />)}
    </ScrollView>
  );
}

/** A block's raw output as a terminal is left showing it, as text — what Copy takes. */
export function plainOf(raw: string): string {
  const screen = new TermScreen();
  screen.write(raw);
  return screen.plain();
}

/** One command: its step, the command, and what it printed in its colours. */
function Block({ block, dialect }: { block: TermLogBlock; dialect: CommandDialect }): JSX.Element {
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
