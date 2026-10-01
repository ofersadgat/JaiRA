import { useState, type JSX, type ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { JsonValue } from "@declarative-ai/json";
import { SYSTEM_DIR_NAME, type ConfigLayer, type ConfigView, type HiddenRuleReport } from "@jaira/shared/browser";
import { filesTreeOf, groupSummary, previewSentence, useFilesTree, whyParts, type HidPart, type RuleGroup } from "@jaira/ui/filesTreeModel";
import { Press, Txt, edge, lengthToken, useHover } from "../../primitives";
import { useTokens } from "../../tokens";
import { Field, FieldGrid } from "../form/Field";
import { FormInput } from "../form/inputs";
import { Button } from "./Button";
import { Switch } from "./controls";
import { SettingsSection } from "./SettingsPage";

/**
 * Settings → Appearance → Files tree: what the Files tree leaves out, rule by rule, with what each rule
 * does HERE — the layer's own list, the table of rules in the groups they apply in (each with its
 * count, first matches and switch), the add line with its preview, "Why is a path hidden?" and "Show
 * system/". What it says, writes and asks main is `filesTreeModel.ts`'s. How it looks:
 *
 *   the body             column, gap 10, padding 13 16
 *   the table            1px --line, radius --control-radius, --panel, clipped; columns 8–12rem | 1fr |
 *                        6.5rem | 2.6rem, gap 4 12
 *   its head             padding 6 10, app 600 at 0.8, 0.04em, upper, --dim, --panel-2, a --line under
 *   a group              a --line between two
 *   its fold             row, baseline, gap 8, padding 7 10, the body's 13/12.5; hovered
 *                        --fill-ghost-hover; the chevron › at 1.25 on a line of 1, 0.8em wide, --dim,
 *                        turned a quarter when open; the name 600 --text; the sum app-secondary
 *   its lines            4 under the last line; a line padding 6 10, centred, a --line at 60%
 *                        between two, hovered --fill-ghost-hover
 *   a line's pattern     row, wraps, gap 6, 0.8em + 8 in; the pattern data-text (struck, --dim, off);
 *                        its `!` 700 --ok
 *   what it hides        column, gap 2: the count app 0.95 --text, the samples data-secondary on one
 *                        line; "nothing here" app-absent at 0.92, 0.85 opacity; the off note 0.92
 *                        --dim; a note padding 1 6, radius --control-radius-sm, --warn on --tint-warn,
 *                        0.86
 *   a chip               padding 0 6, 1px --line, round, app 0.8 on 1.6, --dim, one line; "puts back"
 *                        --ok on --tint-ok, its ring --ok 40%; the layer being edited --accent on
 *                        --tint-accent, its ring --accent 45%
 *   code in words        data at 0.92em, --text
 *   the add line         row, wraps, centred, gap 6 8: the box (flex 1 1 16rem), Add, and the preview
 *                        on a line of its own (data-secondary, one line)
 *   the question         column, gap 6; its answer app 0.95 --dim (a failure --bad)
 *   520 wide or less     the head goes, and a line is the pattern, its chip and its switch, what it
 *                        hides under them, 0.8em + 8 in
 */
export function FilesTreeSection(props: {
  view: ConfigView;
  layer: ConfigLayer;
  project: string | null;
  busy: boolean;
  onWrite: (layer: ConfigLayer, doc: JsonValue) => void;
}): JSX.Element {
  return <FilesTreeView {...useFilesTree(props)} />;
}

/** `rem`: the page's root size (Chromium's 16). */
const REM = 16;
/** The body's size and `0.8em + 8` of it — the pattern's inset under the chevron. */
const INSET = 0.8 * 13 + 8;

function FilesTreeView(props: ReturnType<typeof useFilesTree>): JSX.Element {
  const t = useTokens();
  const { view, layer, report, busy, onWrite } = props;
  const tree = filesTreeOf(view, layer, report, onWrite);
  const { own, groups, rules, capped, showsSystem, toggleSystem } = tree;
  const add = (pattern: string): void => {
    if (tree.add(pattern)) props.onType("");
  };
  const [width, setWidth] = useState<number | undefined>(undefined);
  const narrow = width !== undefined && width <= 520;
  // The columns: 8–12rem (as wide as it may get before the 1fr has to give), 1fr, 6.5rem, 2.6rem.
  const inner = width === undefined ? 0 : width - 20 - 36;
  const cols = { pattern: Math.min(12 * REM, 8 * REM + Math.max(0, inner - 8 * REM - 6.5 * REM - 2.6 * REM)), from: 6.5 * REM, switch: 2.6 * REM };
  const extra = props.preview?.extra;
  const typed = props.typed.trim();
  return (
    <SettingsSection
      id="files-tree"
      title="Files tree"
      info="What the Files tree leaves out, and why. Built-in rules come first, then what Shared, this project and you add; the last rule to match a path decides."
    >
      <FieldGrid>
        <Field
          label="Hidden in the tree"
          param="files.hidden"
          hint="Later rules win, so a !pattern puts back something an earlier rule hid. A folder that matches takes its contents with it."
          layer={{ stated: own !== null, disabled: busy, label: tree.clearLabel, onInherit: tree.clear }}
        >
          <Txt register="app-secondary">{tree.ownWords}</Txt>
        </Field>
      </FieldGrid>

      <View flexDirection="column" gap={10} paddingVertical={13} paddingHorizontal={16}>
        <View
          borderRadius={lengthToken(t, "control-radius", 7)}
          backgroundColor={t.v("panel") as never}
          overflow="hidden"
          {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
          onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
          role="table"
          aria-label="Hidden-path rules"
        >
          {narrow ? null : (
            <View flexDirection="row" alignItems="baseline" gap={12} paddingVertical={6} paddingHorizontal={10} backgroundColor={t.v("panel-2") as never} {...(edge(t, { bottom: 1 }) as object)} role="row">
              {(["Pattern", "What it hides here", "From"] as const).map((head, i) => (
                <Txt key={head} spec={{ voice: "app", scale: 0.8, weight: 600, ls: 0.04, upper: true, color: "dim" }} {...(i === 1 ? { flex: 1, flexBasis: 0, minWidth: 0 } : { width: i === 0 ? cols.pattern : cols.from, flexShrink: 0 })} role="columnheader">
                  {head}
                </Txt>
              ))}
              <View width={cols.switch} flexShrink={0} aria-label="in effect" role="columnheader" />
            </View>
          )}
          {report === null ? (
            <Txt register="app-absent" padding={10}>
              {props.error !== undefined ? props.error : "reading the tree…"}
            </Txt>
          ) : (
            groups.map((group, i) => (
              <Group key={group.id} group={group} first={i === 0} open={tree.openOf(group, props.open)} summary={groupSummary(group, rules, capped)} onFold={(next) => props.onFold(group.id, next)}>
                {group.lines.map((entry, k) => (
                  <Line key={`${entry.index}-${entry.rule.pattern}`} entry={entry} first={k === 0} tree={tree} capped={capped} busy={busy} narrow={narrow} cols={cols} />
                ))}
              </Group>
            ))
          )}
        </View>

        <View flexDirection="row" flexWrap="wrap" alignItems="center" rowGap={6} columnGap={8}>
          <View flexGrow={1} flexShrink={1} flexBasis={16 * REM} minWidth={0}>
            <FormInput value={props.typed} mono placeholder="pattern, or !pattern to put something back" disabled={busy} label="add a rule" onChange={props.onType} onSubmit={() => add(props.typed)} onEscape={() => props.onType("")} />
          </View>
          <Button disabled={busy || typed.length === 0 || typed === "!"} onPress={() => add(props.typed)}>
            Add
          </Button>
          {typed.length > 0 && extra !== undefined && extra.pattern === typed ? (
            <Txt register="data-secondary" ellip flexBasis="100%" minWidth={0}>
              {previewSentence(extra, props.preview?.capped === true)}
            </Txt>
          ) : null}
        </View>
      </View>

      <FieldGrid>
        <Field label="Why is a path hidden?" hint="A path inside the tree's root, or a full path from a file manager." wide>
          <View flexDirection="column" flexGrow={1} flexShrink={1} flexBasis="auto" gap={6} minWidth={0}>
            <FormInput value={props.asked} mono placeholder="packages/cli/dist/index.js" label="path to explain" onChange={props.onAsk} />
            {props.answer !== null && props.asked.trim().length > 0 ? (
              <Txt spec={{ voice: "app", scale: 0.95, color: typeof props.answer === "string" ? "bad" : "dim" }} aria-live="polite">
                {typeof props.answer === "string" ? props.answer : <HidWords parts={whyParts(props.answer)} scale={0.95} />}
              </Txt>
            ) : null}
          </View>
        </Field>
        <Field
          label={`Show ${SYSTEM_DIR_NAME}/`}
          hint={showsSystem ? "Shown, for you alone: a !system rule in your own list." : "Hidden — the default. It holds the database, tasks, snapshots and logs, which nobody authors."}
        >
          <Switch on={showsSystem} label={showsSystem ? "shown" : "hidden"} disabled={busy} onChange={toggleSystem} />
        </Field>
      </FieldGrid>
    </SettingsSection>
  );
}

/** Words, and a pattern or path in them as code (the data face at 0.92 of the words around it, --text). */
function HidWords({ parts, scale }: { parts: readonly HidPart[]; scale: number }): JSX.Element {
  return (
    <>
      {parts.map((part, i) =>
        "code" in part ? (
          <Txt key={i} spec={{ voice: "data", scale: (scale * 12.5 * 0.92) / 12, color: "text" }}>
            {part.code}
          </Txt>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/** One fold of the table: a default group, or what one layer adds. */
function Group({ group, first, open, summary, onFold, children }: { group: RuleGroup; first: boolean; open: boolean; summary: string; onFold: (open: boolean) => void; children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View {...(first ? {} : (edge(t, { top: 1 }) as object))}>
      <Press
        onPress={() => onFold(!open)}
        {...({ "aria-expanded": open } as object)}
        width="100%"
        flexDirection="row"
        alignItems="baseline"
        gap={8}
        paddingVertical={7}
        paddingHorizontal={10}
        box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
      >
        <View width={0.8 * Number(t.scaled("size-app", 1.25))} alignItems="center" transform={[{ rotate: open ? "90deg" : "0deg" }]}>
          <Txt spec={{ voice: "app", scale: 1.25, lineHeight: 1, color: "dim" }} textAlign="center" aria-hidden>
            ›
          </Txt>
        </View>
        <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600 }} {...(isWeb ? { whiteSpace: "nowrap" } : {})}>
          {group.name}
        </Txt>
        <Txt register="app-secondary">{summary}</Txt>
      </Press>
      {open ? <View paddingBottom={4}>{children}</View> : null}
    </View>
  );
}

/** One rule: its pattern, what it hides here, where it came from, and its switch. */
function Line({
  entry,
  first,
  tree,
  capped,
  busy,
  narrow,
  cols,
}: {
  entry: { rule: HiddenRuleReport; index: number };
  first: boolean;
  tree: ReturnType<typeof filesTreeOf>;
  capped: boolean;
  busy: boolean;
  narrow: boolean;
  cols: { pattern: number; from: number; switch: number };
}): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  const { rule } = entry;
  const { mine, off, put, amount, notes, switchLabel, toggle, offNote, samples, origin, later } = tree.lineOf(entry);
  const chip = (words: string, tone: "plain" | "ok" | "accent"): JSX.Element => (
    <Txt
      spec={{ voice: "app", scale: 0.8, lineHeight: 1.6, color: tone === "plain" ? "dim" : tone }}
      paddingHorizontal={6}
      borderRadius={999}
      alignSelf="center"
      flexShrink={0}
      numberOfLines={1}
      {...(tone === "plain" ? {} : { backgroundColor: t.v(`tint-${tone}`) as never })}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, tone === "plain" ? "line" : t.mix(t.v(tone), tone === "ok" ? 40 : 45, "transparent")) as object)}
    >
      {words}
    </Txt>
  );
  const pattern = (
    <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={6} minWidth={0} paddingLeft={INSET}>
      <Txt register="data-text" minWidth={0} flexShrink={1} {...(off ? { color: t.v("dim"), textDecorationLine: "line-through" } : {})} {...((isWeb ? { style: { overflowWrap: "anywhere" } } : {}) as object)}>
        {put ? (
          <>
            <Txt register="data-text" spec={{ weight: 700, color: "ok" }}>
              !
            </Txt>
            {rule.pattern.slice(1)}
          </>
        ) : (
          rule.pattern
        )}
      </Txt>
      {put ? chip("puts back", "ok") : null}
    </View>
  );
  const what = (
    <View flexDirection="column" gap={2} minWidth={0} {...(narrow ? { paddingLeft: INSET } : { flex: 1, flexBasis: 0 })}>
      {off ? (
        <Txt spec={{ voice: "app", scale: 0.92, color: "dim" }}>
          <HidWords parts={offNote} scale={0.92} />
        </Txt>
      ) : amount !== null ? (
        <>
          <Txt spec={{ voice: "app", scale: 0.95 }}>{`${capped ? "at least " : ""}${amount}`}</Txt>
          <Txt register="data-secondary" ellip>
            {samples}
          </Txt>
        </>
      ) : (
        <Txt register="app-absent" spec={{ scale: 0.92 }} opacity={0.85}>
          nothing here
        </Txt>
      )}
      {notes.map((note) => (
        <Txt key={note} spec={{ voice: "app", scale: 0.86, color: "warn" }} alignSelf="flex-start" paddingVertical={1} paddingHorizontal={6} borderRadius={lengthToken(t, "control-radius-sm", 5)} backgroundColor={t.v("tint-warn") as never}>
          {note}
        </Txt>
      ))}
    </View>
  );
  // The switch's cell is the height of the body's line holding it on its baseline (20.5), the switch at its top.
  const toggleCell = (
    <View width={narrow ? undefined : cols.switch} height={20.5} flexShrink={0} alignItems="flex-end">
      <Switch on={!off} label={switchLabel} disabled={busy || later} onChange={toggle} />
    </View>
  );
  const originChip = <View width={narrow ? undefined : cols.from} flexShrink={0} flexDirection="row">{chip(origin, mine ? "accent" : "plain")}</View>;
  return (
    <View
      paddingVertical={6}
      paddingHorizontal={10}
      backgroundColor={hovered ? (t.v("fill-ghost-hover") as never) : "transparent"}
      {...(first ? {} : (edge(t, { top: 1 }, t.mix(t.v("line"), 60, "transparent")) as object))}
      {...hover}
    >
      {narrow ? (
        <View flexDirection="column" gap={4}>
          <View flexDirection="row" alignItems="center" gap={12}>
            <View flex={1} flexBasis={0} minWidth={0}>
              {pattern}
            </View>
            {originChip}
            {toggleCell}
          </View>
          {what}
        </View>
      ) : (
        <View flexDirection="row" alignItems="center" gap={12}>
          <View width={cols.pattern} flexShrink={0} minWidth={0}>
            {pattern}
          </View>
          {what}
          {originChip}
          {toggleCell}
        </View>
      )}
    </View>
  );
}
