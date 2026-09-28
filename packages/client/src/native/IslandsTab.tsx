import { useState, type JSX } from "react";
import { ScrollView } from "react-native";
import { Text, View } from "@tamagui/core";
import { Island, useTokens } from "@jaira/universal";

/**
 * The island test on a device (decision 0015, S5): the three islands on one screen, each reporting
 * what it measured about itself — ready, drawn, the inks the grammars produced, its heap, and any
 * warning (Monaco says so when it falls back to the main thread). The same scenarios `shots/islands.mts`
 * runs in a browser; the readouts are plain text, so an emulator's accessibility dump can read them.
 */
const MARKDOWN = [
  "# Review notes",
  "",
  "The critique found **three** weaknesses. See `feature/plan/critique` for the full report.",
  "",
  "| Weakness | Severity |",
  "| --- | --- |",
  "| The sync lint ignores renames | high |",
  "| No test for an empty board | medium |",
  "",
  "```ts",
  "export function laneOf(card: BoardCard): Lane {",
  '  return card.endedAt !== undefined ? "finished" : "running";',
  "}",
  "```",
].join("\n");

/** A TypeScript file of `lines` lines and the same with every tenth line changed. */
function sources(lines: number): { original: string; modified: string } {
  const seed = [
    "export interface Card {",
    "  readonly taskId: string;",
    "  readonly title: string;",
    "  readonly status: \"running\" | \"completed\" | \"failed\";",
    "}",
    "",
    "export function laneOf(card: Card): string {",
    '  if (card.status === "completed") return "finished";',
    '  return card.status === "failed" ? "finished" : "running";',
    "}",
  ];
  const original: string[] = [];
  while (original.length < lines) original.push(...seed);
  const cut = original.slice(0, lines);
  return { original: cut.join("\n"), modified: cut.map((l, i) => (i % 10 === 5 ? `${l} // changed ${i}` : l)).join("\n") };
}
const DIFF = sources(2000);

type Report = { ready?: number; drawn?: number; inks?: number; heap?: number; height?: number; warnings: number; events: number; lastEvent?: string };

export function IslandsTab(): JSX.Element {
  const t = useTokens();
  const [reports, setReports] = useState<Record<string, Report>>({});
  const report = (id: string) => (m: { kind: string; [k: string]: unknown }) =>
    setReports((all) => {
      const r: Report = { ...(all[id] ?? { warnings: 0, events: 0 }) };
      if (m.kind === "ready") r.ready = Number(m["ms"]);
      if (m.kind === "drawn") Object.assign(r, { drawn: Number(m["ms"]), inks: Number(m["colours"]), heap: Math.round(Number(m["heap"] ?? 0) / 1048576) });
      if (m.kind === "height") r.height = Number(m["px"]);
      if (m.kind === "log" && m["level"] === "warn") r.warnings++;
      if (m.kind === "event") {
        r.events++;
        r.lastEvent = String(m["value"]).slice(0, 40);
      }
      return { ...all, [id]: r };
    });
  const line = (id: string): string => {
    const r = reports[id];
    if (r === undefined) return `${id}: loading`;
    return `${id}: ready ${r.ready ?? "-"} ms, drawn ${r.drawn ?? "-"} ms, inks ${r.inks ?? "-"}, heap ${r.heap ?? "-"} MB, height ${r.height ?? "-"}, warnings ${r.warnings}, events ${r.events}${r.lastEvent !== undefined ? ` (${r.lastEvent})` : ""}`;
  };
  const label = (text: string): JSX.Element => (
    <Text fontSize={12} color={t.v("dim") as never} paddingHorizontal={12} paddingTop={10} paddingBottom={4}>
      {text}
    </Text>
  );
  return (
    <ScrollView style={{ flex: 1 }}>
      <View padding={12} gap={2} backgroundColor={t.v("panel") as never}>
        {["markdown", "diff", "editor"].map((id) => (
          <Text key={id} fontSize={11} color={t.v("text") as never} testID={`report-${id}`}>
            {line(id)}
          </Text>
        ))}
      </View>
      {label("Markdown (sized to its content)")}
      <Island component="markdown" props={{ text: MARKDOWN }} onReport={report("markdown")} />
      {label("Monaco diff, 2,000 lines (fixed height, scrolls inside)")}
      <Island component="diff" props={{ ...DIFF, mime: "text/x-typescript", file: "board.ts", readOnly: true }} height={320} onReport={report("diff")} />
      {label("CodeMirror markdown editor, editable (v2)")}
      <Island component="markdownEditor" props={{ text: "# notes\n\nfirst line\n", readOnly: false }} height={220} onReport={report("editor")} />
    </ScrollView>
  );
}
