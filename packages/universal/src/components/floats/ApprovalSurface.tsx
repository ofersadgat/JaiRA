import { Fragment, useRef, useState, type JSX, type ReactNode } from "react";
import { View, Text, isWeb } from "@tamagui/core";
import { toolDisplayOf } from "@jaira/shared/browser";
import type { ApprovalAnswerExtras, ApprovalSurfaceProps } from "@jaira/ui/approvalSurface";
import {
  answerMenu,
  approvalAnswerOf,
  hueOf,
  lineSegments,
  partRows,
  reasonLines,
  verdictLabel,
  type ChosenWidths,
  type PartRow,
  type Piece,
  type Reach,
  type ReasonLine,
} from "@jaira/ui/approvalModel";
import { Press, Txt, edge, lengthToken, padToken } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { colorOf } from "../Sidebar";
import { Icon } from "../panel/Icon";
import { Button } from "../settings/Button";
import { anchorRectOf } from "./anchor";
import { AnswerMenuCard } from "./AnswerMenu";
import { GateTitle } from "./GateTitle";

/**
 * `approvalSurface.tsx`'s `ApprovalSurface`, universal (decision 0015): a command awaiting approval, as
 * the requests its line is made of — the line in its parts' colours, a row per part, why it asks, and
 * one Allow and one Deny, each a split button whose caret asks what the answer covers and how far it
 * reaches (`AnswerMenu.tsx`). What it draws is `approvalModel.ts`'s, shared with the desktop's. The
 * rules, from `styles.css`:
 *
 *   .approval-surface > h3   the dialog heading (`GateTitle`): app 17/12.5 700, line 1.35, the shield 16
 *                            --dim; 8 below
 *   .sub                     app 11/12.5, --dim; the tool's title, " · asked by " and `FunctionBy`
 *   .approval-surface .mono  data 11.5/12
 *   pre.artifact.shell-line  --bg, 1px --line, radius 8, padding 10, 12 above (its UA 1em below
 *                            collapses with what follows), data 12/12, pre-wrap, at most 320 tall
 *   .shell-line .part-c      the part's hue at 13% (26% hot), radius 4, padding 1 3, cloned per line;
 *                            .part-m 600 with a 2px inset underline of the hue at 75%; .op --tok-hint
 *   .approval-parts          column, gap 2, 8 above; app 11.5/12.5
 *   .approval-parts .part    a row on the baseline, gap 8, padding 4 8, radius --control-radius-sm, 17 in
 *                            per depth: swatch (9, radius 3, centred) | the part's text (data 11/12, one
 *                            line, 1.2fr) | → (--tok-hint) | the subject (data 600, one line) over its note
 *                            (app 10.5/12.5, --tok-hint), 1fr | the verdict pill (app 10.5/12.5 600 on a
 *                            line of 1.6, padding 0 7, --panel-2, --dim); hot: the hue at 9%; asks
 *                            (later, so it wins): --tint-warn, the pill --warn on --warn 18% into --panel;
 *                            denied: the pill --bad on --tint-bad
 *   .reason-note             app 12/12.5, --warn, 10 above (3 between two)
 *   .options                 row, wrapping, gap 8, 14 above; `Split`s; .reason (--bad, app 11/12.5)
 */
export function ApprovalSurface({ pending, error, onDecide, initialMenu }: ApprovalSurfaceProps): JSX.Element {
  const t = useTokens();
  // One of the two menus open at a time, anchored to its own split button (`usePopover` in the DOM).
  const [open, setOpen] = useState<{ which: "allow" | "deny"; at: ReturnType<typeof anchorRectOf> } | null>(initialMenu !== undefined ? { which: initialMenu, at: null } : null);
  const [chosen, setChosen] = useState<ChosenWidths>({});
  /** The part under the pointer, lit on the line and in its row. */
  const [hot, setHot] = useState<number | null>(null);

  const decide = (decision: "allow" | "deny", reach: Reach): void => {
    const { scope, remember, addTo } = approvalAnswerOf(pending, reach, chosen);
    setOpen(null);
    const extras: ApprovalAnswerExtras | undefined =
      remember !== undefined || addTo !== undefined ? { ...(remember !== undefined ? { remember } : {}), ...(addTo !== undefined ? { addTo } : {}) } : undefined;
    onDecide(decision, scope, extras);
  };

  const approval = pending.parts;
  const drawn = approval !== undefined && approval.parts.length > 0 && pending.command !== undefined;
  const rows = drawn ? partRows(approval) : [];
  const hover = (index: number): Record<string, unknown> => (isWeb ? { onMouseEnter: () => setHot(index), onMouseLeave: () => setHot(null) } : {});
  const em = Number(t.scaled("size-data", 12 / 12)) || 12;
  const reasons = reasonLines(pending);

  return (
    <View testID="approval" flexDirection="column">
      <GateTitle icon="shield">Approve this command?</GateTitle>
      <View flexDirection="row" flexWrap="wrap" alignItems="baseline" {...((isWeb ? { title: pending.tool } : {}) as object)}>
        <Txt spec={SUB}>
          {toolDisplayOf(pending.tool).title}
          {pending.asker !== undefined ? " · asked by " : null}
        </Txt>
        {pending.asker !== undefined ? <FunctionBy name={pending.asker} /> : null}
      </View>

      {drawn ? (
        <>
          <Artifact t={t} testID="approval-command">
            {lineSegments(approval.line, approval.parts).map((segment, at) =>
              segment.kind === "glue" ? (
                <Text key={at} color={t.v("tok-hint") as never}>
                  {segment.text}
                </Text>
              ) : (
                <Text
                  key={at}
                  {...hover(segment.part)}
                  color={t.v("text") as never}
                  backgroundColor={t.mix(colorOf(t, hueOf(segment.part)), hot === segment.part ? 26 : 13, "transparent") as never}
                  {...((isWeb ? { paddingVertical: 1, paddingHorizontal: 3, borderRadius: 4, style: { boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" } } : {}) as object)}
                >
                  <Pieces t={t} pieces={segment.pieces} hue={colorOf(t, hueOf(segment.part))} />
                </Text>
              ),
            )}
          </Artifact>
          {/* The pre's 1em below collapses with the list's 8 above. */}
          <View testID="approval-parts" flexDirection="column" gap={2} marginTop={Math.max(em, 8)}>
            {rows.map((row) => {
              const hue = colorOf(t, row.hue);
              const asks = row.verdict === "asks";
              return <PartRowView key={row.index} row={row} hue={hue} asks={asks} hot={hot === row.index} hover={hover(row.index)} />;
            })}
          </View>
        </>
      ) : (
        <Artifact t={t} testID="approval-command">
          {pending.command !== undefined ? pending.command : JSON.stringify(pending.input, null, 2)}
        </Artifact>
      )}

      {reasons.map((line, at) => (
        // 10 above the first — or the pre's 1em, which collapses with it — and 3 between two.
        <Reason key={at} line={line} marginTop={at > 0 ? 3 : drawn ? 10 : Math.max(em, 10)} />
      ))}

      <View flexDirection="row" flexWrap="wrap" gap={8} marginTop={reasons.length === 0 && !drawn ? Math.max(em, 14) : 14}>
        {(["allow", "deny"] as const).map((decision) => (
          <Split
            key={decision}
            decision={decision}
            // A function's question is answered for this call alone, so there is no reach to choose.
            caret={pending.asker === undefined}
            open={open?.which === decision}
            onMain={() => decide(decision, "once")}
            // Placed against the whole split, as the desktop's `pop.anchor` is (the caret's parent on web).
            onCaret={(from) => setOpen(open?.which === decision ? null : { which: decision, at: anchorRectOf((from as { parentElement?: unknown } | undefined)?.parentElement) })}
          />
        ))}
      </View>
      {open !== null ? (
        <AnswerMenuCard
          anchor={open.at}
          menu={answerMenu(pending, open.which, chosen)}
          onChoose={(key, width) => setChosen({ ...chosen, [key]: width })}
          onReach={(reach) => decide(open.which, reach)}
          onClose={() => setOpen(null)}
          testIdOf={(reach) => `approval-${open.which}-${reach}`}
        />
      ) : null}
      {error ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }} marginTop={Number(t.scaled("size-app", 11 / 12.5)) || 11}>
          {error}
        </Txt>
      ) : null}
    </View>
  );
}

const SUB = { voice: "app", scale: 11 / 12.5, color: "dim" } as const;

/**
 * One `.approval-parts .part`: row 1 on the baseline — swatch, the part's text (1.2fr), →, the subject
 * (1fr), the verdict — and the note in row 2 under the subject, in its column: where the subject was laid
 * out in row 1 is measured, and the note is placed there at its width.
 */
function PartRowView({ row, hue, asks, hot, hover }: { row: PartRow; hue: string; asks: boolean; hot: boolean; hover: Record<string, unknown> }): JSX.Element {
  const t = useTokens();
  const [column, setColumn] = useState<{ x: number; width: number } | null>(null);
  const line = useRef<HTMLElement | null>(null);
  const subject = useRef<HTMLElement | null>(null);
  const words = useRef<HTMLElement | null>(null);
  const [wants, setWants] = useState(0);
  const measure =(e: { nativeEvent: { layout: { x: number; width: number } } }): void => {
    // On web off the elements themselves, to the sub-pixel (`onLayout` rounds there).
    const a = line.current;
    const b = subject.current;
    const next =
      isWeb && a !== null && b !== null && typeof b.getBoundingClientRect === "function"
        ? { x: b.getBoundingClientRect().left - a.getBoundingClientRect().left, width: b.getBoundingClientRect().width }
        : { x: e.nativeEvent.layout.x, width: e.nativeEvent.layout.width };
    setColumn((was) => (was !== null && Math.abs(was.x - next.x) < 0.01 && Math.abs(was.width - next.width) < 0.01 ? was : next));
    // What the row's grid asks of a box sized to its content (a dialog, a stage's card): each fr column
    // as wide as the widest of its words per fr, the others as they are (web; a phone's rows fill).
    const text = words.current;
    if (!isWeb || a === null || b === null || text === null || typeof document === "undefined") return;
    const full = (el: HTMLElement): number => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().width;
    };
    const kids = [...a.children] as HTMLElement[];
    const fixed = kids.filter((k) => k !== text && k !== b).reduce((sum, k) => sum + k.getBoundingClientRect().width, 0) + 8 * (kids.length - 1);
    const want = fixed + 2.2 * Math.max(full(text) / 1.2, full(b));
    setWants((was) => (Math.abs(was - want) < 0.01 ? was : want));
  };
  return (
    <View
      {...hover}
      flexDirection="column"
      paddingVertical={4}
      paddingHorizontal={8}
      marginLeft={row.depth * 17}
      borderRadius={lengthToken(t, "control-radius-sm", 6) as never}
      backgroundColor={(asks ? t.v("tint-warn") : hot ? t.mix(hue, 9, "transparent") : "transparent") as never}
    >
      {/* Measured again when the row itself changes (web: its elements are read, so either event will do). */}
      <View ref={line as never} {...((isWeb ? { onLayout: measure } : {}) as object)} flexDirection="row" alignItems="baseline" gap={8}>
        <View width={9} height={9} borderRadius={3} backgroundColor={hue as never} alignSelf="center" flexShrink={0} />
        <Txt ref={words as never} spec={{ voice: "data", scale: 11 / 12 }} ellip flexGrow={1.2} flexShrink={1} flexBasis={0} minWidth={0} {...((isWeb ? { title: row.pieces.map((p) => p.text).join("") } : {}) as object)}>
          <Pieces t={t} pieces={row.pieces} hue={hue} />
        </Txt>
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "tok-hint" }} flexShrink={0}>
          →
        </Txt>
        <Txt ref={subject as never} onLayout={measure} spec={{ voice: "data", scale: 11.5 / 12, weight: 600 }} ellip flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0}>
          {row.subject}
        </Txt>
        <Verdict t={t} verdict={row.verdict} {...(row.by !== undefined ? { by: row.by } : {})} />
      </View>
      {row.note !== undefined ? (
        <Txt
          spec={{ voice: "app", scale: 10.5 / 12.5, color: "tok-hint" }}
          marginLeft={column?.x ?? 0}
          width={column?.width ?? 0}
          {...((isWeb ? { title: row.note, style: { overflowWrap: "anywhere" } } : {}) as object)}
        >
          {row.note}
        </Txt>
      ) : null}
      {wants > 0 ? <View height={0} width={wants} maxWidth="100%" /> : null}
    </View>
  );
}

/** `pre.artifact`: the line (or the command, or the input) in the data face. */
function Artifact({ t, testID, children }: { t: Tokens; testID: string; children: ReactNode }): JSX.Element {
  return (
    <View
      testID={testID}
      marginTop={12}
      padding={10}
      maxHeight={320}
      backgroundColor={t.v("bg") as never}
      borderRadius={8}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
      {...((isWeb ? { overflow: "auto" } : { overflow: "hidden" }) as object)}
    >
      <Txt spec={{ voice: "data", scale: 12 / 12 }} {...((isWeb ? { whiteSpace: "pre-wrap" } : {}) as object)}>
        {children}
      </Txt>
    </View>
  );
}

/** A part's words, the ones its permission-set line matched underlined in its hue (`.part-m`). */
function Pieces({ t, pieces, hue }: { t: Tokens; pieces: readonly Piece[]; hue: string }): JSX.Element {
  return (
    <>
      {pieces.map((piece, at) =>
        piece.matched ? (
          <Text
            key={at}
            fontWeight="600"
            {...((isWeb
              ? { boxShadow: `inset 0 -2px 0 ${t.mix(hue, 75, "transparent")}` }
              : { textDecorationLine: "underline", textDecorationColor: t.mix(hue, 75, "transparent") }) as object)}
          >
            {piece.text}
          </Text>
        ) : (
          <Fragment key={at}>{piece.text}</Fragment>
        ),
      )}
    </>
  );
}

/** The verdict pill at a row's end, with the function that decided it where one did. */
function Verdict({ t, verdict, by }: { t: Tokens; verdict: PartRow["verdict"]; by?: string }): JSX.Element {
  const ink = verdict === "asks" ? "warn" : verdict === "denied" ? "bad" : "dim";
  const ground = verdict === "asks" ? t.mix(t.v("warn"), 18, t.v("panel")) : verdict === "denied" ? t.v("tint-bad") : t.v("panel-2");
  const spec = { voice: "app", scale: 10.5 / 12.5, weight: 600, lineHeight: 1.6, color: ink } as const;
  return (
    <View flexDirection="row" alignItems="baseline" flexShrink={0} paddingHorizontal={7} borderRadius={999} backgroundColor={ground as never}>
      {by !== undefined ? <FunctionBy name={by} inVerdict spec={spec} /> : null}
      <Txt spec={spec}>{verdictLabel(verdict)}</Txt>
    </View>
  );
}

/**
 * `FunctionBy`: which function decided — a star and its name. In the `.sub` line it is inline (the star
 * 1em of the line's 11, a space, the name in the data face); in a verdict pill `.part-by`, a row, gap 3,
 * 6 before the verdict, at 500.
 */
export function FunctionBy({ name, inVerdict = false, spec }: { name: string; inVerdict?: boolean; spec?: { voice: "app"; scale: number; weight: number; lineHeight: number; color: string } }): JSX.Element {
  const t = useTokens();
  const size = Number(t.scaled("size-app", inVerdict ? 10.5 / 12.5 : 11 / 12.5)) || 11;
  const ink = String(t.v(inVerdict ? (spec?.color ?? "dim") : "dim"));
  return (
    <View flexDirection="row" alignItems={inVerdict ? "center" : "baseline"} {...(inVerdict ? { gap: 3, marginRight: 6 } : {})} {...((isWeb ? { title: `decided by the function ${name}` } : {}) as object)}>
      <Icon name="star" size={size} color={ink} />
      {inVerdict ? null : <Txt spec={SUB}> </Txt>}
      {/* In the pill the name inherits the verdict's line of 1.6. */}
      <Txt spec={{ voice: "data", scale: 11.5 / 12, color: inVerdict ? (spec?.color ?? "dim") : "dim", ...(inVerdict ? { weight: 500, lineHeight: 1.6 } : {}) }}>{name}</Txt>
    </View>
  );
}

function Reason({ line, marginTop }: { line: ReasonLine; marginTop: number }): JSX.Element {
  const spec = { voice: "app", scale: 12 / 12.5, color: "warn" } as const;
  const mono = { voice: "data", scale: 11.5 / 12, color: "warn" } as const;
  if (line.kind === "policy" || line.kind === "function") {
    return (
      <Txt spec={spec} marginTop={marginTop}>
        {line.kind === "policy" ? <>Policy: {line.text}</> : line.text}
      </Txt>
    );
  }
  const names = line.kind === "permissionSet" ? line.entries : line.subjects;
  return (
    <Txt spec={spec} marginTop={marginTop}>
      {line.permissionSet !== undefined ? (
        <>
          Permission set <Txt spec={mono}>{line.permissionSet}</Txt>
        </>
      ) : (
        <>This state{"’"}s permission set</>
      )}
      {line.kind === "permissionSet" ? ": " : " holds no line for "}
      {names.map((name, at) => (
        <Fragment key={name}>
          {at > 0 ? (at === names.length - 1 ? " and " : ", ") : null}
          <Txt spec={{ ...spec, weight: 700 }}>{name}</Txt>
        </Fragment>
      ))}
      {line.kind === "permissionSet" ? (
        <>
          {" "}
          {names.length === 1 ? "asks" : "ask"}
        </>
      ) : (
        <>
          , so {names.length === 1 ? "it asks" : "they ask"}
        </>
      )}
    </Txt>
  );
}

/**
 * `.split.primary` / `.split.danger`: the answer, and the caret that opens its menu — `button.primary`
 * (or `button.danger`) square on the inside; the caret 7 either side, 1 over the main button, its chevron
 * 12, and under primary a 1px edge of white at 35% on its left.
 */
function Split({ decision, caret, open, onMain, onCaret }: { decision: "allow" | "deny"; caret: boolean; open: boolean; onMain: () => void; onCaret: (from: unknown) => void }): JSX.Element {
  const t = useTokens();
  const primary = decision === "allow";
  const verb = primary ? "Allow" : "Deny";
  const kind = primary ? "primary" : "danger";
  const ink = String(primary ? t.v("on-accent") : t.v("bad"));
  return (
    <View flexDirection="row" position="relative">
      <Button kind={kind} onPress={onMain} testID={`approval-${decision}`} {...(caret ? { borderTopRightRadius: 0, borderBottomRightRadius: 0 } : {})}>
        {verb}
      </Button>
      {caret ? (
        <CaretButton kind={kind} verb={verb} ink={ink} open={open} testID={`approval-${decision}-more`} onPress={onCaret} />
      ) : null}
    </View>
  );
}

function CaretButton({ kind, verb, ink, open, testID, onPress }: { kind: "primary" | "danger"; verb: string; ink: string; open: boolean; testID: string; onPress: (from: unknown) => void }): JSX.Element {
  const t = useTokens();
  const primary = kind === "primary";
  const radius = lengthToken(t, "control-radius", 7);
  const [padV] = padToken(t, "control-pad", [3, 10]);
  return (
    <Press
      onPress={(e) => onPress(isWeb ? (e as unknown as { currentTarget: unknown }).currentTarget : undefined)}
      label={`${verb}: what it covers and how far it reaches`}
      testID={testID}
      {...((isWeb ? { "aria-expanded": open, "aria-haspopup": "menu" } : {}) as object)}
      marginLeft={-1}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      paddingVertical={padV}
      paddingHorizontal={7}
      // As tall as the answer beside it: the split's row stretches it, as `.split`'s inline-flex does.
      alignSelf="stretch"
      borderWidth={1}
      borderStyle="solid"
      borderTopRightRadius={radius}
      borderBottomRightRadius={radius}
      box={({ hovered }) =>
        primary
          ? {
              backgroundColor: t.v(hovered ? "fill-accent-hover" : "fill-accent"),
              borderColor: t.v(hovered ? "fill-accent-hover" : "fill-accent"),
              borderLeftColor: "rgba(255, 255, 255, 0.35)",
              boxShadow: t.v("sheen"),
            }
          : { backgroundColor: hovered ? t.v("tint-bad") : "transparent", borderColor: t.mix(t.v("bad"), hovered ? 60 : 40, t.v("line")) }
      }
    >
      <Icon name="chevron" size={12} color={ink} />
    </Press>
  );
}
