import { useEffect, useState, type JSX } from "react";
import { Linking, TextInput } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { ProcessSummary } from "@jaira/shared/browser";
import { factsLineOf } from "@jaira/ui/processTaskModel";
import { portLinksOf, tellOf, type CardTone } from "@jaira/ui/processCardModel";
import { processes } from "@jaira/ui/processStore";
import { ENTER_KEEPS_FOCUS, Press, Txt, edge, font } from "../../primitives";
import { useTokens } from "../../tokens";
import { Icon } from "../panel/Icon";

/**
 * The process card's own parts (decision 0032, "The view", ruling 1; round 1, board 7), shared by the
 * card drawn through a terminal (`TerminalView` given a process) and the one drawn without (`ProcessCard`):
 * the stats line and "Tell Claude when it prints…". How they look:
 *
 *   the stats line  row, centred, gap 8, wrapping: (the status, when it dropped from the title bar), each
 *                   port a chip (data 10.5/12 600, --accent on its tint, a 6 dot of --ok, radius 4, padding
 *                   0 6), the first also `localhost:N ↗` (app 11.5, --accent, a link); pushed right, `pid ·
 *                   CPU · MB` (data 11/12 --dim) and the load trace (60×14, --accent at 70%)
 *   Tell Claude     a chip, 24 tall, padding 0 8, radius 6, 1px dashed --line: `alert` (12), `Tell Claude
 *                   when it prints` (app 11.5) and the example `error` (data 11 --accent); pressed, a field
 *                   for the pattern in its place (⏎ arms it, Esc leaves); armed, on --tint-accent in
 *                   --accent, solid: `Telling Claude when it prints /pattern/` and ×; told, a --tint-bad
 *                   chip `told Claude` beside, the line in its tooltip
 */

/** While a card is drawn, the engine samples its readings every couple of seconds (`process:sampling`). */
export function useSampling(on = true): void {
  useEffect(() => {
    if (!on) return;
    processes.sampling(true);
    return () => processes.sampling(false);
  }, [on]);
}

const TONE: Record<CardTone, string> = { accent: "accent", warn: "warn", ok: "dim", bad: "bad", dim: "dim" };

export function openPort(url: string): void {
  if (isWeb) window.open(url, "_blank", "noopener");
  else void Linking.openURL(url);
}

/** The status in its tone (app 12/12.5). */
export function StatusText({ status, flex = true }: { status: { text: string; tone: CardTone }; flex?: boolean }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 12 / 12.5, color: TONE[status.tone], weight: status.tone === "warn" ? 600 : 400 }} ellip {...(flex ? { flexShrink: 1, minWidth: 0 } : { flexShrink: 0 })}>
      {status.text}
    </Txt>
  );
}

/** A port, boxed with a dot of --ok: `● :8145`. */
export function PortChip({ port }: { port: number }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" alignItems="center" gap={4} height={18} paddingHorizontal={6} borderRadius={4} flexShrink={0} backgroundColor={t.tint("accent", 12) as never}>
      <View width={6} height={6} borderRadius={3} backgroundColor={t.v("ok") as never} />
      <Txt spec={{ voice: "data", scale: 10.5 / 12, weight: 600, color: "accent", lineHeight: { px: 16 } }}>{`:${port}`}</Txt>
    </View>
  );
}

/** The stats line: the ports as chips and links, then the pid, CPU, memory and the load trace. */
export function StatsLine({ process, status, padded = true }: { process: ProcessSummary; status?: { text: string; tone: CardTone } | undefined; padded?: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={8} rowGap={4} minWidth={0} {...(padded ? { paddingLeft: 12, paddingRight: 10, paddingBottom: 8 } : {})} testID="process-stats">
      {status !== undefined ? <StatusText status={status} flex={false} /> : null}
      {portLinksOf(process.ports).map(({ port, url, link }, i) => (
        <View key={port} flexDirection="row" alignItems="center" gap={8} flexShrink={0}>
          {/* With the status here, the title bar already shows the first port. */}
          {status !== undefined && i === 0 ? null : <PortChip port={port} />}
          {link ? (
            <Press onPress={() => openPort(url)} label={`Open localhost:${port}`} title={url}>
              {({ hovered }) => (
                <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "accent" }} {...(hovered ? { textDecorationLine: "underline" } : {})}>
                  {`localhost:${port} ↗`}
                </Txt>
              )}
            </Press>
          ) : null}
        </View>
      ))}
      <View flex={1} minWidth={8} />
      <View flexDirection="row" alignItems="center" gap={8} flexShrink={0}>
        <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim", tabular: true }}>{factsLineOf(process)}</Txt>
        <LoadTrace load={process.load} colour={String(t.mix(t.v("accent"), 70, "transparent"))} />
      </View>
    </View>
  );
}

/** The last readings of its CPU as bars, oldest first: 60 wide, 14 tall. */
export function LoadTrace({ load, colour }: { load: readonly number[]; colour: string }): JSX.Element | null {
  if (load.length === 0) return null;
  const top = Math.max(5, ...load);
  const bars = load.slice(-30);
  return (
    <View flexDirection="row" alignItems="flex-end" gap={1} width={60} height={14} flexShrink={0} {...((isWeb ? { title: `CPU over the last ${bars.length} readings` } : {}) as object)}>
      {bars.map((v, i) => (
        <View key={i} width={1} flexGrow={1} height={Math.max(1, Math.round((v / top) * 14))} backgroundColor={colour as never} />
      ))}
    </View>
  );
}

/**
 * "Tell Claude when it prints…" (ruling 1): a pattern, armed on the engine (`process:tellWhen`), that sends
 * the conversation the line it matched and a few around it, once. Armed, it says so and can be cancelled
 * (`process:tellCancel`); once it fired, `told Claude` stays beside it.
 */
export function TellClaude({ process, project }: { process: ProcessSummary; project: string | undefined }): JSX.Element | null {
  const t = useTokens();
  const tell = tellOf(process);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [why, setWhy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!tell.offered && tell.told === undefined) return null;
  const arm = (): void => {
    const pattern = text.trim();
    if (pattern.length === 0) {
      setEditing(false);
      return;
    }
    setBusy(true);
    processes.tellWhen(process.key, pattern, project ?? process.project).then(
      () => {
        setBusy(false);
        setEditing(false);
        setText("");
        setWhy(null);
      },
      (e: unknown) => {
        setBusy(false);
        setWhy(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : String(e));
      },
    );
  };
  const told =
    tell.told !== undefined ? (
      <View height={20} paddingHorizontal={7} borderRadius={999} justifyContent="center" flexShrink={0} backgroundColor={t.v("tint-bad") as never} {...((isWeb ? { title: `matched /${tell.told.pattern}/: ${tell.told.line}` } : {}) as object)}>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600, color: "bad" }}>told Claude</Txt>
      </View>
    ) : null;
  if (tell.armed !== undefined) {
    return (
      <View flexDirection="row" alignItems="center" gap={6} flexShrink={1} minWidth={0}>
        <View flexDirection="row" alignItems="center" gap={6} height={24} paddingLeft={8} paddingRight={2} borderRadius={6} flexShrink={1} minWidth={0} backgroundColor={t.v("tint-accent") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, String(t.mix(t.v("accent"), 40, "transparent"))) as object)}>
          <Icon name="alert" size={12} color={String(t.v("accent"))} />
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "accent" }} ellip flexShrink={1} minWidth={0}>
            Telling Claude when it prints
          </Txt>
          <Txt spec={{ voice: "data", scale: 11 / 12, weight: 600, color: "accent" }} ellip flexShrink={1} minWidth={0}>{`/${tell.armed}/`}</Txt>
          <Press onPress={() => void processes.tellCancel(process.key, project ?? process.project)} label="Stop waiting for it" title="Don't tell Claude" width={20} height={20} alignItems="center" justifyContent="center" borderRadius={4} box={({ hovered }) => (hovered ? { backgroundColor: t.v("fill-ghost-hover") } : {})}>
            <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "accent" }}>×</Txt>
          </Press>
        </View>
        {told}
      </View>
    );
  }
  if (editing) {
    return (
      <View flexDirection="row" alignItems="center" gap={6} flexShrink={1} minWidth={0}>
        <View flexDirection="row" alignItems="center" gap={6} height={24} paddingHorizontal={8} borderRadius={6} flexShrink={1} minWidth={140} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, String(t.mix(t.v("accent"), 55, "transparent"))) as object)}>
          <Icon name="alert" size={12} color={String(t.v("accent"))} />
          <TextInput
            {...(ENTER_KEEPS_FOCUS as object)}
            autoFocus
            value={text}
            editable={!busy}
            onChangeText={(v) => {
              setText(v);
              setWhy(null);
            }}
            onSubmitEditing={arm}
            onKeyPress={(e) => {
              if ((e.nativeEvent as { key?: string }).key === "Escape") setEditing(false);
            }}
            placeholder="when it prints… (a pattern: ready|error)"
            placeholderTextColor={String(t.v("dim"))}
            accessibilityLabel="Tell Claude when it prints a line matching"
            autoCapitalize="none"
            autoCorrect={false}
            style={{ ...(font(t, { voice: "data", scale: 11 / 12, color: "text" }) as object), flex: 1, minWidth: 0, ...(isWeb ? { outlineStyle: "none" } : {}) } as never}
          />
        </View>
        {why !== null ? (
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }} ellip flexShrink={1} minWidth={0} {...((isWeb ? { title: why } : {}) as object)}>
            {why}
          </Txt>
        ) : null}
      </View>
    );
  }
  return (
    <View flexDirection="row" alignItems="center" gap={6} flexShrink={1} minWidth={0}>
      {tell.offered ? (
        <Press
          onPress={() => setEditing(true)}
          label="Tell Claude when it prints…"
          title="Tell Claude when a line it prints matches a pattern: the line and a few around it are sent to the conversation, once"
          flexDirection="row"
          alignItems="center"
          gap={6}
          height={24}
          paddingHorizontal={8}
          borderRadius={6}
          flexShrink={1}
          minWidth={0}
          {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, "line", "dashed") as object)}
          box={({ hovered }) => (hovered ? { backgroundColor: t.v("fill-ghost-hover") } : {})}
        >
          <Icon name="alert" size={12} color={String(t.v("dim"))} />
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "text" }} ellip flexShrink={1} minWidth={0}>
            Tell Claude when it prints
          </Txt>
          <Txt spec={{ voice: "data", scale: 11 / 12, color: "accent" }} flexShrink={0}>
            error
          </Txt>
        </Press>
      ) : null}
      {told}
    </View>
  );
}
