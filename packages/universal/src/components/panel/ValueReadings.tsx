import { useState, type JSX, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { Change, MediaKind, PatchFile } from "@jaira/shared/browser";
import { changeStats, mimeOfPath, patchStats, totalStats } from "@jaira/shared/browser";
import { Island } from "../../islands";
import { Press, Txt, edge, font, scrollbarProps, viewScrollbarProps } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { Picture } from "../Picture";
import { Icon } from "./Icon";

/**
 * The value view's readings that are more than a run of text: `Stats`, `ChangesView`, `PatchView`,
 * `TableView` and `Media`. `ValueView.tsx` picks which; these draw them. How they look:
 *
 *   the counts       inline row, gap 5, data 11/12: added --ok, removed --bad, "no change" --tok-hint
 *   the changes' head  row, baseline, gap 8, padding 2 0 5; its count app 11/12.5, --dim
 *   a change         a --line on top; its line a row, centred, gap 4; the fold a row, centred, gap 7,
 *                    grows, padding 4 2, radius 4, app 12/12.5 (hover --panel-2): the chevron's box 14
 *                    wide, --tok-hint, its 13px chevron turned 90° while open; the action a chip (app
 *                    10/12.5, --dim, a 1px --line, round, padding 0 6); the path data 11.5/12, one line,
 *                    …; the counts; the outcome's mark 14 (✓ --ok, ✕ --bad)
 *   a change's body  padding 4 0 8: the layout toggle's bar (right, 4 under), the diff (the `diff`
 *                    island, which draws its ring, as tall as its text: 120 to 620), the reason app
 *                    11/12.5 --dim, 5 2 0 around it
 *   a patch          at most 460 tall, scrolls; a file after a file 8 above
 *   a file's head    a row, centred, gap 7, the whole width, padding 4 6, a 1px --line (hover: --accent
 *                    40% into --line), radius 5, in the body's font (app 13/12.5); its chevron 1em --dim,
 *                    turned -90° while closed; the action app 10.5/12.5, upper, 0.04em, --dim
 *                    (create --tok-string, delete --bad); the path data 11.5/12, breaking anywhere
 *   a file's hunks   data 11.5/12 on 1.5, scrolls sideways; a hunk after a hunk: a dashed --line on top
 *   a hunk's head    row, gap 10, padding 3 6, --dim on --dim at 8%; its section at 0.75, one line, …
 *   a patch's line   a row, `pre`; add on --tok-string at 14%, del on --bad at 13% (the sign in each)
 *   a line number    4.2em, 8 right, right-aligned, --dim at 0.6, tabular; the sign 1.4em, centred
 *   an empty note    --dim, padding 8 0 (in a patch's body, 6 0 0 8 around it)
 *   the table's box  at most 340 tall, scrolls both ways
 *   the table        collapsed, data 11.5/12 on 1.5; cells a 1px --line, padding 2 7, one line (`pre`),
 *                    at most 320, …; the header sticky, --panel, --dim, 500; the cut's note app 11/12.5
 *                    --dim, 6 above
 *   a picture, a clip  a block, at most the width and 420 tall, radius 6, on --panel-2
 *   a track          the width, at most 420, 36 tall
 */

/** `Stats`: `+12` in green and `−3` in red, or the honest nothing for a change that moved no lines. */
export function Stats({ added, removed }: { added: number; removed: number }): JSX.Element {
  const ink = (color: string) => ({ voice: "data" as const, scale: 11 / 12, color });
  return (
    <View flexDirection="row" flexShrink={0} gap={5}>
      {added > 0 ? (
        <Txt spec={ink("ok")}>
          +{added}
        </Txt>
      ) : null}
      {removed > 0 ? (
        <Txt spec={ink("bad")}>
          −{removed}
        </Txt>
      ) : null}
      {added === 0 && removed === 0 ? <Txt spec={ink("tok-hint")}>no change</Txt> : null}
    </View>
  );
}

/** The head over a set of changes: how many files, and the counts. */
export function ChangesHead({ count, added, removed }: { count: number; added: number; removed: number }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="baseline" gap={8} paddingTop={2} paddingBottom={5}>
      {/* The count and its word as separate text nodes (`{n} {files}`), which Blink shapes apart. */}
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>
        {count} {count === 1 ? "file" : "files"}
      </Txt>
      <Stats added={added} removed={removed} />
    </View>
  );
}

/** A box that scrolls past `maxHeight`: on web the element itself (`overflow: auto`), on a phone scroll views. */
export function Scroll({ maxHeight, both, children, t }: { maxHeight: number; both?: boolean; children: ReactNode; t: Tokens }): JSX.Element {
  if (isWeb) {
    return (
      <View maxHeight={maxHeight} minWidth={0} {...({ overflow: "auto" } as object)} {...viewScrollbarProps(t)}>
        {children}
      </View>
    );
  }
  return (
    <ScrollView style={{ maxHeight }} nestedScrollEnabled>
      {both === true ? (
        <ScrollView horizontal nestedScrollEnabled>
          {children}
        </ScrollView>
      ) : (
        children
      )}
    </ScrollView>
  );
}

/** A sentence saying there is nothing to draw. */
export function EmptyNote({ children, voice = "app", ...rest }: { children: ReactNode; voice?: "app" | "data" } & Record<string, unknown>): JSX.Element {
  return (
    <Txt spec={{ voice, scale: voice === "app" ? 13 / 12.5 : 11.5 / 12, color: "dim" }} paddingVertical={8} {...rest}>
      {children}
    </Txt>
  );
}

/** `PatchView`: the whole patch — a heading with the totals, then one block per file, open. */
export function PatchView({ files }: { files: readonly PatchFile[] }): JSX.Element {
  const t = useTokens();
  if (files.length === 0) return <EmptyNote marginVertical={13}>Nothing in this patch could be read.</EmptyNote>;
  const total = patchStats(files);
  return (
    <Scroll maxHeight={460} t={t}>
      <ChangesHead count={files.length} {...total} />
      {files.map((file, i) => (
        <PatchFileView key={`${file.path}:${i}`} file={file} first={i === 0} t={t} />
      ))}
    </Scroll>
  );
}

/**
 * A dim aside inside the data face (a renamed file's old path, "no newline at end of file"): the app's
 * 11/12.5 size in the data family around it, on a line 1.5 × its own size.
 */
function subInDataOf(t: Tokens): Record<string, unknown> {
  const size = t.scaled("size-app", 11 / 12.5);
  return { ...font(t, { voice: "data", scale: 1, color: "dim" }), fontSize: size, lineHeight: typeof size === "number" ? size * 1.5 : "1.5" };
}

/** A size of the patch's data face (11.5/12 of `--size-data`), times `em`, in pixels. */
const dataEm = (t: Tokens, em: number): number => (Number(t.scaled("size-data", 11.5 / 12)) || 11.5) * em;

/** `PatchFileView`: one file's head (a fold), and its hunks with both gutters. */
function PatchFileView({ file, first, t }: { file: PatchFile; first: boolean; t: Tokens }): JSX.Element {
  const [open, setOpen] = useState(true);
  const data = { voice: "data" as const, scale: 11.5 / 12 };
  const subInData = subInDataOf(t);
  const actColor = file.action === "create" ? "tok-string" : file.action === "delete" ? "bad" : "dim";
  return (
    <View {...(first ? {} : { marginTop: 8 })}>
      <Press
        onPress={() => setOpen(!open)}
        {...({ "aria-expanded": open } as object)}
        flexDirection="row"
        alignItems="center"
        gap={7}
        paddingVertical={4}
        paddingHorizontal={6}
        borderWidth={1}
        borderStyle="solid"
        borderRadius={5}
        box={({ hovered }) => ({ borderColor: hovered ? t.mix(t.v("accent"), 40, t.v("line")) : t.v("line") })}
      >
        <View flexShrink={0} {...(open ? {} : { transform: [{ rotate: "-90deg" }] })}>
          <Icon name="chevron" size={Number(t.scaled("size-app", 13 / 12.5)) || 13} color={String(t.v("dim"))} />
        </View>
        <Txt spec={{ voice: "app", scale: 10.5 / 12.5, upper: true, ls: 0.04, color: actColor }} flexShrink={0}>
          {file.action}
        </Txt>
        <Txt spec={data} flexShrink={1} minWidth={0} style={isWeb ? ({ overflowWrap: "anywhere" } as never) : undefined}>
          {file.fromPath !== undefined && file.fromPath !== file.path ? (
            <>
              <Txt {...(subInData as object)}>{file.fromPath}</Txt> →{" "}
            </>
          ) : null}
          {file.path === "" ? <Txt {...(subInData as object)}>(no file named)</Txt> : file.path}
        </Txt>
        <View flex={1} minWidth={0} />
        <Stats added={file.added} removed={file.removed} />
      </Press>
      {!open ? null : file.binary !== undefined ? (
        <EmptyNote marginTop={6} marginLeft={8}>
          {file.binary}
        </EmptyNote>
      ) : (
        <PatchBody file={file} t={t} />
      )}
    </View>
  );
}

/** A file's hunks, which scroll sideways inside the patch rather than widen what holds it. */
function PatchBody({ file, t }: { file: PatchFile; t: Tokens }): JSX.Element {
  const data = { voice: "data" as const, scale: 11.5 / 12, lineHeight: 1.5 };
  const subInData = subInDataOf(t);
  const no = dataEm(t, 4.2);
  const sign = dataEm(t, 1.4);
  const hunks = (
    <View minWidth="100%">
      {file.hunks.map((hunk, h) => (
        <View key={h} {...(h > 0 ? (edge(t, { top: 1 }, "line", "dashed") as object) : {})}>
          <View flexDirection="row" gap={10} paddingVertical={3} paddingHorizontal={6} backgroundColor={t.mix(t.v("dim"), 8, "transparent") as never}>
            <Txt spec={{ ...data, color: "dim" }} flexShrink={0} {...(isWeb ? { whiteSpace: "pre" } : {})}>
              {hunk.header}
            </Txt>
            {hunk.section !== undefined ? (
              <Txt spec={{ ...data, color: "dim" }} opacity={0.75} flexShrink={1} minWidth={0} numberOfLines={1} ellipsizeMode="tail">
                {hunk.section}
              </Txt>
            ) : null}
          </View>
          {hunk.lines.map((line, l) => (
            <View
              key={l}
              flexDirection="row"
              {...(line.kind === "add" ? { backgroundColor: t.mix(t.v("tok-string"), 14, "transparent") } : line.kind === "del" ? { backgroundColor: t.mix(t.v("bad"), 13, "transparent") } : {})}
            >
              {/* Both gutters always, so the columns line up down the whole hunk. */}
              <Txt spec={{ ...data, color: "dim", tabular: true }} width={no} flexShrink={0} paddingRight={8} textAlign="right" opacity={0.6} {...UNSELECTABLE}>
                {line.oldLine ?? ""}
              </Txt>
              <Txt spec={{ ...data, color: "dim", tabular: true }} width={no} flexShrink={0} paddingRight={8} textAlign="right" opacity={0.6} {...UNSELECTABLE}>
                {line.newLine ?? ""}
              </Txt>
              <Txt spec={{ ...data, color: line.kind === "add" ? "tok-string" : line.kind === "del" ? "bad" : "text" }} width={sign} flexShrink={0} textAlign="center" {...UNSELECTABLE}>
                {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
              </Txt>
              <Txt spec={data} flexShrink={0} {...(isWeb ? { whiteSpace: "pre" } : {})}>
                {line.text}
                {line.noNewline === true ? <Txt {...(subInData as object)}> ⏎̸ no newline at end of file</Txt> : null}
              </Txt>
            </View>
          ))}
        </View>
      ))}
      {file.hunks.length === 0 ? (
        <EmptyNote voice="data" marginTop={6} marginLeft={8}>
          No lines change — a rename or a mode change.
        </EmptyNote>
      ) : null}
    </View>
  );
  if (isWeb) return <View minWidth={0} {...({ overflowX: "auto" } as object)} {...viewScrollbarProps(t)}>{hunks}</View>;
  return (
    <ScrollView horizontal nestedScrollEnabled contentContainerStyle={{ minWidth: "100%" }}>
      {hunks}
    </ScrollView>
  );
}

/** `user-select: none`: a gutter a selection passes over. */
const UNSELECTABLE: Record<string, unknown> = isWeb ? { userSelect: "none" } : { selectable: false };

/** `TABLE_ROW_LIMIT`: how many rows are drawn before the reading stops being a reading. */
const TABLE_ROW_LIMIT = 500;

/**
 * `TableView`: rows and columns, the first row the header. `border-collapse: collapse` drawn column by
 * column, so each column is as wide as its widest cell (up to 320) as the browser's automatic layout
 * makes it: every cell has its right and bottom rule, the first row its top one and the first column its
 * left one. A ragged row stays ragged — a missing cell is a gap of the row's height with no rules of its
 * own, but the rules its neighbours below and to the right need.
 */
export function TableView({ rows }: { rows: readonly string[][] }): JSX.Element {
  const t = useTokens();
  if (rows.length === 0) return <EmptyNote marginVertical={13}>No rows.</EmptyNote>;
  const [head, ...body] = rows;
  const shown = [head!, ...body.slice(0, TABLE_ROW_LIMIT)];
  const columns = Math.max(0, ...shown.map((r) => r.length));
  const cut = body.length - (shown.length - 1);
  return (
    <View minWidth={0}>
      <Scroll maxHeight={340} both t={t}>
        <View flexDirection="row" alignSelf="flex-start">
          {Array.from({ length: columns }, (_, col) => (
            <View key={col} flexDirection="column" flexShrink={0} maxWidth={320}>
              {shown.map((row, r) => (
                <Cell key={r} text={row[col]} head={r === 0} top={r === 0} left={col === 0} below={shown[r + 1]?.[col] !== undefined} right={row[col + 1] !== undefined} t={t} />
              ))}
            </View>
          ))}
        </View>
      </Scroll>
      {cut > 0 ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} marginTop={6}>
          {cut} more {cut === 1 ? "row" : "rows"} — the whole file is under Source.
        </Txt>
      ) : null}
    </View>
  );
}

function Cell({ text, head, top, left, below, right, t }: { text: string | undefined; head: boolean; top: boolean; left: boolean; below: boolean; right: boolean; t: Tokens }): JSX.Element {
  const here = text !== undefined;
  // A missing cell draws the rules its neighbours need, and keeps the space of the ones they do not.
  const rule = (on: boolean): string => (on ? String(t.v("line")) : "transparent");
  const sides = {
    borderTopWidth: top ? 1 : 0,
    borderLeftWidth: left ? 1 : 0,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderStyle: "solid",
    borderTopColor: rule(here),
    borderLeftColor: rule(here),
    borderRightColor: rule(here || right),
    borderBottomColor: rule(here || below),
  };
  return (
    <View
      paddingVertical={2}
      paddingHorizontal={7}
      {...(sides as object)}
      {...(head ? { backgroundColor: here ? (t.v("panel") as never) : "transparent", ...(isWeb ? { position: "sticky" as never, top: 0, zIndex: 1 } : {}) } : {})}
    >
      <Txt spec={{ voice: "data", scale: 11.5 / 12, lineHeight: 1.5, weight: head ? 500 : 400, color: head ? "dim" : "text" }} numberOfLines={1} ellipsizeMode="tail" {...(isWeb ? { whiteSpace: "pre" } : {})}>
        {/* An empty cell is still a line tall: a zero-width space holds it open. */}
        {text === undefined || text === "" ? "​" : text}
      </Txt>
    </View>
  );
}

/**
 * `Media`: a picture at its own size — no wider than the column, no taller than 420 — or, on web, a
 * clip or a track in the browser's own player. A phone has no player here yet: it says so, and the
 * source is under Source.
 */
export function Media({ src, kind }: { src: string; kind: MediaKind }): JSX.Element {
  const t = useTokens();
  if (kind === "image") return <Picture src={src} maxHeight={420} box={{ borderRadius: 6, backgroundColor: t.v("panel-2") }} />;
  if (isWeb) {
    const style = { display: "block", maxWidth: "100%", maxHeight: 420, borderRadius: 6, background: String(t.v("panel-2")), ...(kind === "audio" ? { width: "100%", maxWidth: 420, height: 36 } : {}) };
    return kind === "video" ? <video src={src} controls style={style} /> : <audio src={src} controls style={style} />;
  }
  return <EmptyNote>{kind === "video" ? "A clip" : "A track"} — played on the desktop. Its source is under Source.</EmptyNote>;
}

/** How a change fared after it was produced: the mark at the end of its row. */
export interface ChangeOutcome {
  ok: boolean;
  /** Why, when it is not ok. */
  note?: string;
}

type DiffLayout = "inline" | "split";

/** A phone's diff island's height: on web the pane takes its text's, 120 to 620 (`MonacoDiffPane`); here it is estimated by lines. */
const diffHeight = (change: Change): number => Math.min(Math.max(((change.before ?? "").split("\n").length + (change.after ?? "").split("\n").length) * 19 + 8, 120), 620);

/**
 * `ChangesView`: a set of file changes, collapsed — the list first, a file's diff (the `diff` island)
 * when its row is opened. Inline or side by side is held by the list: one choice for every file's diff.
 */
export function ChangesView({
  changes,
  outcomes,
  rowAction,
  empty,
}: {
  changes: readonly Change[];
  outcomes?: Record<string, ChangeOutcome> | undefined;
  /** An extra control per row, beside its fold (the sync's "Open"). */
  rowAction?: ((change: Change) => ReactNode) | undefined;
  empty?: string;
}): JSX.Element {
  const [layout, setLayout] = useState<DiffLayout>("inline");
  if (changes.length === 0) return <EmptyNote marginVertical={13}>{empty ?? "No files change."}</EmptyNote>;
  const total = totalStats(changes);
  return (
    <View minWidth={0}>
      <ChangesHead count={changes.length} {...total} />
      {changes.map((change) => (
        <ChangeRow key={change.id} change={change} outcome={outcomes?.[change.path]} layout={layout} onLayout={setLayout} action={rowAction?.(change)} />
      ))}
    </View>
  );
}

const LAYOUTS = [
  ["inline", "Inline", "One column: removals above additions"],
  ["split", "Side by side", "Two columns: before and after"],
] as const;

/** `ChangeRow`: one file's row, and its diff underneath when opened (mounted only while open). */
function ChangeRow({ change, outcome, layout, onLayout, action }: { change: Change; outcome: ChangeOutcome | undefined; layout: DiffLayout; onLayout: (next: DiffLayout) => void; action?: ReactNode }): JSX.Element {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const stats = changeStats(change);
  return (
    <View {...(edge(t, { top: 1 }) as object)}>
      <View flexDirection="row" alignItems="center" gap={4} minWidth={0}>
        <Press
          onPress={() => setOpen((v) => !v)}
          {...({ "aria-expanded": open } as object)}
          flex={1}
          minWidth={0}
          flexDirection="row"
          alignItems="center"
          gap={7}
          paddingVertical={4}
          paddingHorizontal={2}
          borderRadius={4}
          box={({ hovered }) => ({ backgroundColor: hovered ? t.v("panel-2") : "transparent" })}
        >
          <View width={14} flexShrink={0} {...(open ? { transform: [{ rotate: "90deg" }] } : {})}>
            <Icon name="chevron" size={13} color={String(t.v("tok-hint"))} />
          </View>
          <View flexShrink={0} paddingHorizontal={6} borderRadius={999} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never}>
            <Txt spec={{ voice: "app", scale: 10 / 12.5, color: "dim" }} numberOfLines={1}>
              {change.action}
            </Txt>
          </View>
          <Txt spec={{ voice: "data", scale: 11.5 / 12 }} flex={1} minWidth={0} ellip {...(isWeb ? { title: change.path } : {})}>
            {change.path}
          </Txt>
          <Stats {...stats} />
          {outcome === undefined ? null : (
            <View width={14} height={14} flexShrink={0} {...(isWeb ? { title: outcome.ok ? "applied" : (outcome.note ?? "not applied") } : {})}>
              <Icon name={outcome.ok ? "check" : "cross"} size={14} color={String(t.v(outcome.ok ? "ok" : "bad"))} />
            </View>
          )}
        </Press>
        {/* Beside the fold rather than inside it: opening the diff and acting on the file are two intentions. */}
        {action ?? null}
      </View>
      {open ? (
        <View paddingTop={4} paddingBottom={8}>
          {change.unshowable !== undefined ? (
            <EmptyNote marginVertical={13}>{change.unshowable}</EmptyNote>
          ) : (
            <>
              <View flexDirection="row" justifyContent="flex-end" paddingBottom={4}>
                <View role="group" aria-label="How to lay the diff out" flexDirection="row" flexShrink={0} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={6} overflow="hidden">
                  {LAYOUTS.map(([id, word, title], i) => (
                    <Press
                      key={id}
                      onPress={() => onLayout(id)}
                      title={title}
                      {...({ "aria-pressed": layout === id } as object)}
                      paddingVertical={1}
                      paddingHorizontal={7}
                      {...(edge(t, { left: i === 0 ? 0 : 1 }) as object)}
                      box={({ hovered }) => ({ backgroundColor: layout === id ? t.v("fill-ghost-selected") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
                    >
                      {({ hovered }) => (
                        <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: layout === id ? 600 : 400, color: layout === id || hovered ? "text" : "tok-hint" }} textAlign="center" numberOfLines={1}>
                          {word}
                        </Txt>
                      )}
                    </Press>
                  ))}
                </View>
              </View>
              {/* Read-only: this view takes no decisions. The pane takes its text's height, 120 to 620
                  (`MonacoDiffPane`'s fit); a phone's island is told it. */}
              <Island component="diff" {...(isWeb ? {} : { height: diffHeight(change) })} props={{ original: change.before ?? "", modified: change.after ?? "", mime: mimeOfPath(change.path), sideBySide: layout === "split", readOnly: true }} />
            </>
          )}
          {change.reason !== undefined ? (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} marginTop={5} marginHorizontal={2}>
              {change.reason}
            </Txt>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
