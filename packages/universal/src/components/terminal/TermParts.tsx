import { useMemo, type JSX } from "react";
import { Platform } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import type { CommandDialect } from "@jaira/shared/browser";
import { hueOf, lineSegments } from "@jaira/ui/approvalModel";
import { TERM_INK, type TermLine } from "@jaira/ui/terminalModel";
import { takenApartOf } from "@jaira/ui/transcript";
import { Press, Txt, font } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { colorOf } from "../Sidebar";
import { Icon } from "../panel/Icon";

/**
 * The pieces of a terminal's screen (decision 0028), shared by the agents' terminal (`TerminalView`)
 * and the logs drawn as one (`TermLog.tsx`): the command line taken apart,
 * a line of the screen in its colours, and the Following and Copy buttons over it.
 */

/** The command line taken apart by the approval's parser, on the terminal's ground. */
export function CommandLine({ command, dialect, t }: { command: string; dialect: CommandDialect; t: Tokens }): JSX.Element {
  const segments = useMemo(() => lineSegments(command, takenApartOf(command, dialect).requests.map((request) => ({ span: request.span, matched: [] }))), [command, dialect]);
  return (
    <>
      {segments.map((segment, at) =>
        segment.kind === "glue" ? (
          <Text key={at} color={TERM_INK.hint}>
            {segment.text}
          </Text>
        ) : (
          <Text
            key={at}
            color={TERM_INK.text}
            backgroundColor={t.mix(colorOf(t, hueOf(segment.part)), 22, "transparent") as never}
            {...((Platform.OS === "web" ? { paddingHorizontal: 3, borderRadius: 4, style: { boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" } } : {}) as object)}
          >
            {segment.pieces.map((piece) => piece.text).join("")}
          </Text>
        ),
      )}
    </>
  );
}

/** One line of the screen, its spans in their colours: clipped at the edge as a terminal's, or (`wrap`) wrapped. */
export function ScreenLine({ line, t, wrap = false }: { line: TermLine; t: Tokens; wrap?: boolean }): JSX.Element {
  const base = font(t, { voice: "data", scale: 11.5 / 12, lineHeight: { px: 19 } }) as object;
  const shape = wrap ? (isWeb ? { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } } : {}) : isWeb ? { style: { whiteSpace: "pre", overflow: "hidden" } } : { numberOfLines: 1 };
  return (
    <Text {...base} color={TERM_INK.text} minWidth={0} {...(shape as object)}>
      {line.length === 0
        ? " "
        : line.map((span, i) => (
            <Text
              key={i}
              color={span.you === true ? TERM_INK.accent : (span.fg ?? TERM_INK.text)}
              {...(span.you === true ? { backgroundColor: "rgba(179,182,255,0.16)" } : span.bg !== undefined ? { backgroundColor: span.bg } : {})}
              {...(span.bold === true || span.you === true ? { fontWeight: "600" } : {})}
              {...(span.dim === true ? { opacity: 0.6 } : {})}
              {...(span.italic === true ? { fontStyle: "italic" } : {})}
              {...(span.underline === true ? { textDecorationLine: "underline" } : {})}
            >
              {span.text}
            </Text>
          ))}
    </Text>
  );
}

export function Following({ on, onPress }: { on: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      {...({ "aria-pressed": on } as object)}
      title={on ? "following the end — press to stop" : "follow the end"}
      flexDirection="row"
      alignItems="center"
      gap={5}
      height={24}
      paddingHorizontal={9}
      borderRadius={6}
      box={({ hovered }) => ({ backgroundColor: on ? t.v("tint-accent") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      <View transform={[{ rotate: "90deg" }]}>
        <Icon name="arrow" size={12} color={String(t.v(on ? "accent" : "dim"))} />
      </View>
      <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: on ? "accent" : "dim" }}>Following</Txt>
    </Press>
  );
}

export function IconButton({ icon, label, onPress }: { icon: "copy"; label: string; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press onPress={onPress} label={label} title={label} width={26} height={24} alignItems="center" justifyContent="center" borderRadius={5} box={({ hovered }) => (hovered ? { backgroundColor: t.v("fill-ghost-hover") } : {})}>
      {({ hovered }: { hovered: boolean }) => <Icon name={icon} size={13} color={String(t.v(hovered ? "text" : "dim"))} />}
    </Press>
  );
}
