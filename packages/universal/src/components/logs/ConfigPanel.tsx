import { useState, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import type { LogLevel, LogOverride, LogPolicy } from "@jaira/shared/browser";
import { LEVELS, dropOverride, putOverride, sampledOverride } from "@jaira/ui/logsModel";
import { Press, Txt, edge, type FontSpec } from "../../primitives";
import { useTokens } from "../../tokens";
import { Button } from "../settings/Button";
import { BarInput } from "./Field";
import { Select, SourceSelect } from "./Select";

/**
 * The Logs room's Configure panel: what the app KEEPS, as distinct from what the bar filters — the level
 * kept everywhere, the rules that override it, and a row to add one. How it looks:
 *
 *   the panel          a --line under it, --panel-2, padding 8 10 10, column, gap 8
 *   its head           row, gap 10, baseline, wrapping: "Keep" and its select (gap 6, centred), then
 *                      the sentence (--dim, app at 11/12.5)
 *   the rules' table   the whole width, app at 12/12.5; a head left, 600, --dim, app at 10/12.5,
 *                      uppercase, 0.4px spacing, padding 2 8 4 0, a --line under it; a cell padding
 *                      3 8 3 0, middle
 *   a rule             its key the data face; its sampling field 62 wide
 *   the add row        row, gap 8, centred, wrapping; its second select and its input at least 240
 *
 * The table's columns are fixed shares of the width (a table's layout is not in React Native): the
 * shares an auto-layout table settles on with no rules in it (274.92, 169.53, 206.94, 303.49 and 49.13
 * of 1004), which is where the panel opens. They do not move to fit a rule's controls, as such a
 * table's would.
 */
const COLUMNS = [274.92, 169.53, 206.94, 303.49, 49.13].map((w) => w / 1004);

export function ConfigPanel({ policy, onPolicy, sources }: { policy: LogPolicy; onPolicy: (policy: LogPolicy) => void; sources: string[] }): JSX.Element {
  const t = useTokens();
  const [match, setMatch] = useState<LogOverride["match"]>("scope");
  const [key, setKey] = useState("");
  const [minLevel, setMinLevel] = useState<LogLevel>("debug");
  const put = (next: LogOverride): void => onPolicy(putOverride(policy, next));
  const drop = (o: LogOverride): void => onPolicy(dropOverride(policy, o));
  const cellText: FontSpec = { voice: "app", scale: 12 / 12.5 };
  const sub: FontSpec = { voice: "app", scale: 11 / 12.5, color: "dim" };
  const cell = (i: number, children: ReactNode, head = false): JSX.Element => (
    <View key={i} width={`${(COLUMNS[i] ?? 0) * 100}%`} flexShrink={0} minWidth={0} paddingRight={8} {...(head ? { paddingTop: 2, paddingBottom: 4 } : { paddingVertical: 3, justifyContent: "center" })}>
      {children}
    </View>
  );
  return (
    <View flexDirection="column" gap={8} paddingTop={8} paddingHorizontal={10} paddingBottom={10} backgroundColor={t.v("panel-2") as never} {...(edge(t, { bottom: 1 }) as object)}>
      <View flexDirection="row" gap={10} alignItems="baseline" flexWrap="wrap">
        <View flexDirection="row" gap={6} alignItems="center">
          <Txt spec={{ voice: "app", scale: 13 / 12.5 }}>Keep</Txt>
          <Select value={policy.minLevel} label="Minimum level kept" options={LEVELS.map((l) => ({ label: `${l} and worse`, value: l }))} onChange={(v) => onPolicy({ ...policy, minLevel: v as LogLevel })} />
        </View>
        <Txt spec={sub}>everywhere, unless a rule below says otherwise. An error is kept whatever this says.</Txt>
      </View>
      <View flexDirection="column">
        <View flexDirection="row" {...(edge(t, { bottom: 1 }) as object)}>
          {["match", "key", "keep", "sample", ""].map((name, i) =>
            cell(
              i,
              <Txt spec={{ voice: "app", scale: 10 / 12.5, weight: 600, color: "dim", upper: true, ls: 0.04 }} numberOfLines={1}>
                {name}
              </Txt>,
              true,
            ),
          )}
        </View>
        {policy.overrides.length === 0 ? (
          <View paddingVertical={3} paddingRight={8}>
            <Txt spec={sub}>No rules — the level above applies everywhere.</Txt>
          </View>
        ) : null}
        {policy.overrides.map((o) => (
          <View key={`${o.match}:${o.key}`} flexDirection="row" alignItems="center">
            {cell(0, <Txt spec={sub}>{o.match}</Txt>)}
            {cell(1, <Txt spec={{ voice: "data", scale: 12 / 12 }}>{o.key}</Txt>)}
            {cell(
              2,
              <View alignSelf="flex-start">
                <Select value={o.minLevel} label={`Minimum level for ${o.key}`} font={cellText} options={LEVELS.map((l) => ({ label: l, value: l }))} onChange={(v) => put({ ...o, minLevel: v as LogLevel })} />
              </View>,
            )}
            {cell(
              3,
              <SampleField
                rate={o.samplingRate ?? 1}
                label={`Sampling for ${o.key}`}
                onRate={(typed) => {
                  const next = sampledOverride(o, typed);
                  if (next !== undefined) put(next);
                }}
              />,
            )}
            {cell(
              4,
              <Press onPress={() => drop(o)} alignSelf="flex-start">
                {({ hovered }) => (
                  <Txt spec={{ voice: "data", scale: 11 / 12, color: "accent" }} {...(hovered ? { textDecorationLine: "underline" } : {})}>
                    remove
                  </Txt>
                )}
              </Press>,
            )}
          </View>
        ))}
      </View>
      <View flexDirection="row" gap={8} alignItems="center" flexWrap="wrap">
        <Select
          value={match}
          label="Rule kind"
          options={[
            { label: "scope", value: "scope" },
            { label: "tag", value: "tag" },
          ]}
          onChange={(v) => {
            setMatch(v as LogOverride["match"]);
            setKey("");
          }}
        />
        {match === "scope" ? <SourceSelect value={key} sources={sources} onChange={setKey} label="Rule scope" minWidth={240} /> : <BarInput value={key} onChange={setKey} placeholder="tag (e.g. llm)" label="Rule tag" width={240} />}
        <Select value={minLevel} label="Rule level" options={LEVELS.map((l) => ({ label: l, value: l }))} onChange={(v) => setMinLevel(v as LogLevel)} />
        <Button
          disabled={key.trim() === ""}
          onPress={() => {
            put({ match, key: key.trim(), minLevel });
            setKey("");
          }}
        >
          Add rule
        </Button>
      </View>
    </View>
  );
}

/** The sampling rate: a number field 62 wide, written through as it is typed. */
function SampleField({ rate, label, onRate }: { rate: number; label: string; onRate: (typed: string) => void }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <BarInput
      value={draft ?? String(rate)}
      numeric
      label={label}
      width={62}
      spec={{ voice: "app", scale: 12 / 12.5 }}
      onChange={(typed) => {
        setDraft(typed);
        onRate(typed);
      }}
    />
  );
}
