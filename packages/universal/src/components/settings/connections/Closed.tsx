import type { JSX, ReactNode } from "react";
import { View } from "@tamagui/core";
import type { AgentChip, ProviderState } from "@jaira/ui/connectionsModel";
import { Txt, edge } from "../../../primitives";
import { useTokens } from "../../../tokens";
import { Disclosure } from "../../form/Field";
import { Icon } from "../../panel/Icon";
import { Button } from "../Button";
import { SettingsLayerContext } from "../layers";
import { SmallButton, Spin, Wide } from "./Row";

/**
 * A Connections row closed to one line (the person, 2026-11-16, for the agents; 2026-11-17 for every
 * section): the line, the one button that would make it work or a chip of who it connects as, then its
 * switch and chevron. Opened, a row says its sentence whole and lays the rest across it. How they look:
 *
 *   the line             one line 30 in, app 11.5/12.5, --dim, cut with …: the state's word (--bad not
 *                        working, --warn not signed in, else --text), then " · " and what it is when it
 *                        works, or " — " and what the check found
 *   the button           app 12/12.5, primary; while it runs, the spinner, what it waits on (--dim) and
 *                        Cancel
 *   the chip             row, centred, gap 7, padding 3 10 3 3, round, 1px --line on --panel, at most
 *                        300; the mark 20 round, --panel-3 (a login's initial app 600 10px --dim, a key's
 *                        lock 11); who in the data face 11/12, cut with …; the fact app 11/12.5 --dim. A
 *                        key not found: --bad 40% into --line on --tint-bad, the fact --bad
 *   a label over boxes   app 600 11/12.5 --dim, 6 above the boxes; the boxes left-aligned, wrapping, 8
 *                        apart, 30 in
 *   the folded settings  `Disclosure`: "Settings" and what it holds, across the opened row's body
 */

const LINE = { voice: "app", scale: 11.5 / 12.5, color: "dim" } as const;

/** A closed row's one line: the state's word, then what it is or what the check found. */
export function RowLine({ state, word, rest }: { state: ProviderState; word: string; rest: string | undefined }): JSX.Element {
  const whole = rest !== undefined ? `${word}${state === "available" ? " · " : " — "}${rest}` : word;
  return (
    <Txt spec={LINE} paddingLeft={30} numberOfLines={1} {...({ title: whole } as object)}>
      <Txt spec={{ ...LINE, color: state === "unavailable" ? "bad" : state === "needs-sign-in" ? "warn" : "text" }}>{word}</Txt>
      {rest !== undefined ? (state === "available" ? " · " : " — ") : null}
      {rest !== undefined ? rest : null}
    </Txt>
  );
}

/** The closed row's button — or, while what it started runs, the spinner, what it waits on, and Cancel. */
export function ActionSlot({ action, waiting, disabled, onPress }: { action: { label: string; title: string }; waiting: { words: string; onCancel: () => void } | undefined; disabled: boolean; onPress: () => void }): JSX.Element {
  if (waiting !== undefined) {
    return (
      <View flexDirection="row" alignItems="center" gap={6} role="status" paddingTop={1}>
        <Spin />
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{waiting.words}</Txt>
        <SmallButton kind="ghost" onPress={waiting.onCancel}>
          Cancel
        </SmallButton>
      </View>
    );
  }
  return (
    <Button kind="primary" disabled={disabled} title={action.title} onPress={onPress} font={{ scale: 12 / 12.5 }} paddingVertical={2}>
      {action.label}
    </Button>
  );
}

/**
 * Check again, beside a row's fix (`agentChecksAgain`): every check run again — after signing in from a
 * terminal, or installing elsewhere. A ghost, so the fix beside it stays the one that stands out.
 */
export function CheckAgain({ checking, disabled, onPress }: { checking: boolean; disabled: boolean; onPress: () => void }): JSX.Element {
  return (
    <Button kind="ghost" disabled={disabled || checking} title="check it again — after signing in from a terminal" onPress={onPress} font={{ scale: 12 / 12.5 }} paddingVertical={2}>
      {checking ? "checking…" : "Check again"}
    </Button>
  );
}

/** Who a closed row connects as: the login in use, or the key and where it was found. */
export function RunsAs({ chip }: { chip: AgentChip }): JSX.Element {
  const t = useTokens();
  const missing = chip.kind === "key" && chip.missing;
  const fact = chip.kind === "login" ? [chip.fact, chip.more > 0 ? `+${chip.more}` : undefined].filter((part) => part !== undefined).join(" · ") : chip.where;
  const who = chip.kind === "login" ? chip.who : chip.name;
  return (
    <View
      flexDirection="row"
      alignItems="center"
      gap={7}
      paddingVertical={3}
      paddingLeft={3}
      paddingRight={10}
      borderRadius={999}
      maxWidth={300}
      minWidth={0}
      backgroundColor={t.v(missing ? "tint-bad" : "panel") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, missing ? t.mix(t.v("bad"), 40, t.v("line")) : "line") as object)}
    >
      <View width={20} height={20} flexShrink={0} borderRadius={999} alignItems="center" justifyContent="center" backgroundColor={t.v("panel-3") as never}>
        {chip.kind === "login" ? (
          <Txt spec={{ voice: "app", scale: 10 / 12.5, weight: 600, color: "dim", lineHeight: { px: 14 } }} textAlign="center">
            {chip.who.charAt(0).toUpperCase()}
          </Txt>
        ) : (
          <Icon name="lock" size={11} color={String(t.v("dim"))} />
        )}
      </View>
      <Txt spec={{ voice: "data", scale: 11 / 12 }} numberOfLines={1} flexShrink={1} minWidth={0} {...({ title: who } as object)}>
        {who}
      </Txt>
      {fact !== undefined && fact !== "" ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: missing ? "bad" : "dim" }} numberOfLines={1} flexShrink={0}>
          {fact}
        </Txt>
      ) : null}
    </View>
  );
}

/** Across an opened row: a label over its boxes — "Runs as", "Sends", "Signed in as", "Key". */
export function LabelledBoxes({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <View marginLeft={30} flexDirection="column" gap={6}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600, color: "dim" }}>{label}</Txt>
      <View flexDirection="row" flexWrap="wrap" gap={8}>
        {children}
      </View>
    </View>
  );
}

/** The opened row's settings, folded: "Settings" and what it holds, the form drawn once it opens. */
export function SettingsFold({ gist, children }: { gist?: string | undefined; children: ReactNode }): JSX.Element {
  return (
    <SettingsLayerContext.Provider value={null}>
      <Wide body>
        <Disclosure summary="Settings" {...(gist !== undefined ? { desc: gist } : {})}>
          {children}
        </Disclosure>
      </Wide>
    </SettingsLayerContext.Provider>
  );
}
