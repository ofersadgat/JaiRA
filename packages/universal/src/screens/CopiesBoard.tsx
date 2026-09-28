import type { JSX } from "react";
import { ScrollView } from "react-native";
import { Text, View } from "@tamagui/core";
import type { BoardView } from "@jaira/shared/browser";
import { lanesOf } from "@jaira/ui/boardModel";
import { nestUnder } from "@jaira/ui/connectDrag";
import { TaskCard } from "../components/TaskCard";
import { useTokens } from "../tokens";

/**
 * The board, drawn natively from the copies that exist (decision 0015): today, only the cards (and
 * their pills and chips) are copies, so the columns around them here are PLACEHOLDERS — plain
 * headed stacks, not the desktop's `.column`. What this screen proves is the native path: the store
 * over the socket, the replayed tokens, and the copies drawing live data on a phone. The screen a
 * person sees is the desktop UI itself (`NativeApp`'s whole-app island) until the frame is copied.
 */
export function CopiesBoard({ boards }: { boards: readonly { name: string; board: BoardView | null }[] }): JSX.Element {
  const t = useTokens();
  const drawn = boards.filter((b): b is { name: string; board: BoardView } => b.board !== null);
  if (drawn.length === 0) {
    return (
      <View padding={16}>
        <Text fontFamily={t.v("font-app") as never} color={t.v("dim") as never}>
          No board yet — open a project on the desktop.
        </Text>
      </View>
    );
  }
  return (
    <ScrollView style={{ flex: 1 }}>
      {drawn.map(({ name, board }) => (
        <View key={name} paddingTop={8}>
          <Text fontFamily={t.v("font-data") as never} fontSize={13} color={t.v("dim") as never} paddingHorizontal={12}>
            {name}
          </Text>
          <Board board={board} />
        </View>
      ))}
    </ScrollView>
  );
}

/**
 * One project's board: its columns wrapped into rows, as the desktop's board wraps them — not scrolled
 * sideways, which on a phone hid every column past the second.
 */
function Board({ board }: { board: BoardView }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" flexWrap="wrap" padding={12} gap={12}>
      {board.columns.map((column) => {
        const { top, beneath } = nestUnder(column.cards);
        const ordered = lanesOf(top).flatMap(({ cards }) => cards.flatMap((card) => [card, ...(beneath.get(card.taskId) ?? [])]));
        return (
          <View key={column.key} flexGrow={1} flexBasis={170} minWidth={170} gap={0}>
            <Text fontFamily={t.v("font-data") as never} fontWeight="600" fontSize={13} color={t.v("text") as never} marginBottom={8}>
              {column.label ?? column.key} · {column.cards.length}
            </Text>
            {ordered.map((card, i) => (
              <TaskCard key={card.taskId} card={card} selected={false} onSelect={() => undefined} last={i === ordered.length - 1} />
            ))}
          </View>
        );
      })}
    </View>
  );
}
