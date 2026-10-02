import { createContext, useContext, useRef, useState, type JSX, type ReactNode } from "react";
import { TextInput } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { Choice } from "@jaira/shared/browser";
import { EMPTY_ANSWER, answerOf, settled, submitsOnClick, useTypedStep, type Answer } from "@jaira/ui/choicesModel";
import { PATHS } from "@jaira/ui/iconPaths";
import { ENTER_KEEPS_FOCUS, Press, Txt, appCh, font, lengthToken, placeholderColor, type FontSpec } from "../../primitives";
import { useTokens } from "../../tokens";
import { Chip } from "../files/Chip";
import { Icon } from "../panel/Icon";
import { Svg } from "../panel/Svg";
import { InlineGlyph } from "./InlineGlyph";
import { Button } from "../settings/Button";

/**
 * `ChoiceList` and `ChoiceSteps`: the ONE control behind an authored gate (`choose_option`) and an
 * agent's question — its options, the own-answer block said in words (`instead`), the comment beside a
 * decision (`alongside`), several at once, and several questions one at a time. What an answer IS
 * (`answerOf`, `submitsOnClick`, `settled`, `readAnswer`) is `choicesModel.ts`'s and `@jaira/shared`'s.
 * How it looks:
 *
 *   a question's block       14 above (it collapses with the heading's 8, or the step line's 6)
 *   the question             the body's 13/12.5, --text, 8 below; a header chip 6 before the words
 *   its description          app 12/12.5, line 1.5, --dim, ≤ 80ch; −4 above (so 4 under the question),
 *                            8 below
 *   the options              12 above; a wrapping row, gap 8, while no option explains itself, else a
 *                            column of cards, gap 8
 *   an option                padding 8 12, --bg, 1px --line, radius 8; the label the body's 13/12.5 in
 *                            --text; hovered and selected an --accent edge, selected an inset --accent ring
 *   the affirmative          --fill-accent ground and edge, --sheen; its label --on-accent at 600;
 *                            hovered --fill-accent-hover
 *   a dangerous one          the label --bad, the edge --bad 45% into --line, no ground
 *   an option's description  the body's size ÷ 1.2, --dim, 2 under the label
 *   one of several to tick   the label (and its description) beside a box: 16 square, 1px --rule, radius 3;
 *                            on, --fill-accent with an 11 tick in --on-accent
 *   an answer of one's own   the whole row wide; the label, then a textarea of the option's own face, 4
 *                            above, padding 2 0, no edge, as tall as its words
 *   the comment's field      12 above, column, gap 4; its label (the body's size ÷ 1.2) --dim; its
 *                            textarea: data 12/12, --bg, 1px --line, radius --control-radius, padding 5 9
 *   the step line            --dim, 6 below;  the buttons  row, wrapping, gap 8, 14 above
 */
export function ChoiceList({
  choices,
  answers,
  onAnswer,
  onImmediate,
  readOnly = false,
  stepped = false,
  flat = false,
  top = 14,
}: {
  choices: readonly Choice[];
  answers: Record<string, Answer>;
  onAnswer: (question: string, answer: Answer) => void;
  onImmediate?: ((question: string, value: string) => void) | undefined;
  readOnly?: boolean;
  stepped?: boolean;
  /**
   * The block is a flex item (its host a flex column, as the gallery's wide modal is): a formatting
   * context of its own, so the options' 12 stays inside it rather than collapsing into its 14.
   */
  flat?: boolean;
  /** The first block's margin above: 14, or a transcript's asked question's 6. */
  top?: number;
}): JSX.Element {
  const t = useTokens();
  const immediate = submitsOnClick(choices, answers);
  const several = choices.length > 1 || stepped;
  const toggle = (choice: Choice, value: string): void => {
    if (readOnly) return;
    if (immediate && onImmediate !== undefined) {
      onImmediate(choice.question, value);
      return;
    }
    const answer = answers[choice.question] ?? EMPTY_ANSWER;
    const had = answer.picked;
    const picked = choice.multiple === true ? (had.includes(value) ? had.filter((v) => v !== value) : [...had, value]) : [value];
    onAnswer(choice.question, { ...answer, picked, own: false });
  };
  return (
    <>
      {choices.map((choice, index) => {
        const answer = answers[choice.question] ?? EMPTY_ANSWER;
        const lit = (value: string): boolean => answer.own !== true && answer.picked.includes(value);
        const bare = choice.options.every((o) => o.description === undefined);
        const heading = several || choice.header !== undefined;
        const own = choice.freeText?.role === "instead" ? <OwnAnswer choice={choice} answer={answer} onAnswer={onAnswer} readOnly={readOnly} /> : null;
        const comment = choice.freeText?.role === "alongside" ? <FreeText choice={choice} answer={answer} onAnswer={onAnswer} readOnly={readOnly} /> : null;
        // What stands above the options: nothing (their 12 collapses into the block's 14), or the
        // question (8 under it, so 4 more) or its description (8 under it too).
        const above = heading || choice.description !== undefined || (choice.freeText?.first === true && comment !== null);
        return (
          <View key={choice.question} flexDirection="column" marginTop={index === 0 ? top : 14}>
            {heading ? (
              <Txt spec={BODY} marginBottom={8}>
                {/* The " " after the chip is written only with one: a `Text` keeps a space at the line's start. */}
                {choice.header !== undefined ? (
                  <>
                    <ChipInline>{choice.header}</ChipInline>{" "}
                  </>
                ) : null}
                {several ? choice.question : null}
              </Txt>
            ) : null}
            {choice.description !== undefined ? (
              <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim", lineHeight: 1.5 }} marginTop={heading ? -4 : 0} marginBottom={8} maxWidth={appCh(t, 12 / 12.5, 80) as number}>
                {choice.description}
              </Txt>
            ) : null}
            {choice.freeText?.first === true ? comment : null}
            <View
              flexDirection={bare ? "row" : "column"}
              {...(bare ? { flexWrap: "wrap" } : {})}
              gap={8}
              marginTop={above ? (choice.freeText?.first === true && comment !== null && !heading && choice.description === undefined ? 12 : 4) : flat ? 12 : 0}
            >
              {choice.freeText?.first === true ? own : null}
              {choice.options.map((option, i) => (
                <OptionButton
                  key={option.value}
                  label={option.label ?? option.value}
                  {...(option.icon !== undefined && option.icon in PATHS ? { icon: option.icon as keyof typeof PATHS } : {})}
                  {...(option.description !== undefined ? { description: option.description } : {})}
                  // Read-only is a record: only the chosen option keeps its emphasis — an unchosen
                  // affirmative is drawn plain.
                  primary={i === 0 && option.tone !== "danger" && bare && !(readOnly && !lit(option.value))}
                  danger={option.tone === "danger"}
                  selected={lit(option.value)}
                  checkable={choice.multiple === true}
                  disabled={readOnly}
                  onPress={() => toggle(choice, option.value)}
                />
              ))}
              {choice.freeText?.first === true ? null : own}
            </View>
            {choice.freeText?.first === true ? null : comment}
          </View>
        );
      })}
    </>
  );
}

const BODY: FontSpec = { voice: "app", scale: 13 / 12.5 };

/**
 * Whether a field stands in a gate's frame — a dialog or an inline gate (12 above, its label --dim) —
 * or bare, as in a state's panel, where it has neither.
 */
export const FieldFrame = createContext(true);

/** A chip inside a line of the body's text. */
function ChipInline({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  // On web an inline box in the line: its edge round the words' own height, on their baseline. A
  // phone's `Text` draws no edge on a run of words, so there it is the chip's box.
  if (isWeb) {
    return (
      <Txt
        spec={{ voice: "app", scale: 10 / 12.5, color: "dim" }}
        marginRight={6}
        paddingHorizontal={6}
        borderWidth={1}
        borderStyle="solid"
        borderColor={t.v("line") as never}
        borderRadius={999}
        whiteSpace="nowrap"
      >
        {children}
      </Txt>
    );
  }
  return (
    <Chip spec={{ lineHeight: 1.5 }} marginRight={6}>
      {children}
    </Chip>
  );
}

/** One option to pick, or (with `checkable`) one of several to tick. */
export function OptionButton({
  label,
  icon,
  description,
  primary = false,
  danger = false,
  selected = false,
  checkable = false,
  disabled = false,
  onPress,
}: {
  label: string;
  icon?: keyof typeof PATHS;
  description?: string;
  primary?: boolean;
  danger?: boolean;
  selected?: boolean;
  checkable?: boolean;
  disabled?: boolean;
  onPress: () => void;
}): JSX.Element {
  const t = useTokens();
  const accentOr = t.replayed ? t.v("accent") : "var(--accent, var(--text))";
  const ink = primary ? "on-accent" : danger ? "bad" : "text";
  const words = (
    <View flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
      <Txt spec={{ ...BODY, weight: primary ? 600 : 400, color: ink }}>
        {icon !== undefined ? (
          <>
            <InlineGlyph size={13} drop={2}>
              <Icon name={icon} size={13} color={String(t.v(ink))} />
            </InlineGlyph>{" "}
          </>
        ) : null}
        {label}
      </Txt>
      {description !== undefined && description.length > 0 ? (
        <Txt spec={{ voice: "app", scale: 13 / 12.5 / 1.2, color: "dim" }} marginTop={2}>
          {description}
        </Txt>
      ) : null}
    </View>
  );
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      title={description ?? ""}
      {...((isWeb && checkable ? { role: "checkbox", "aria-checked": selected } : {}) as object)}
      flexShrink={0}
      paddingVertical={8}
      paddingHorizontal={12}
      borderRadius={8}
      borderWidth={1}
      borderStyle="solid"
      box={({ hovered }) => {
        const hover = hovered && !disabled;
        return {
          backgroundColor: primary ? (hover ? t.v("fill-accent-hover") : t.v("fill-accent")) : danger ? "transparent" : t.v("bg"),
          // A chosen affirmative takes the accent edge and ring rather than its fill's (only its hovered
          // edge outranks that) — but a record's keeps its sheen.
          borderColor: primary ? (hover ? t.v("fill-accent-hover") : selected ? accentOr : t.v("fill-accent")) : hover || selected ? accentOr : danger ? t.mix(t.v("bad"), 45, t.v("line")) : t.v("line"),
          ...(primary && (disabled || !selected) ? { boxShadow: t.v("sheen") } : selected ? { boxShadow: `inset 0 0 0 1px ${String(accentOr)}` } : {}),
        };
      }}
    >
      {checkable ? (
        <View flexDirection="row" alignItems="center" gap={10}>
          {words}
          <View
            width={16}
            height={16}
            flexShrink={0}
            borderWidth={1}
            borderStyle="solid"
            borderRadius={3}
            alignItems="center"
            justifyContent="center"
            borderColor={t.v(selected ? "fill-accent" : "rule") as never}
            backgroundColor={(selected ? t.v("fill-accent") : "transparent") as never}
          >
            {selected ? <CheckTick color={String(t.v("on-accent"))} /> : null}
          </View>
        </View>
      ) : (
        words
      )}
    </Press>
  );
}

/** The box's tick: `check` at 11, stroked at 3. */
function CheckTick({ color }: { color: string }): JSX.Element {
  return <Svg width={11} height={11} color={color} strokeWidth={3} shapes={PATHS.check.map((d) => ({ kind: "path" as const, d }))} />;
}

/** A textarea: data 12/12 on the body's 1.5, --bg, 1px --line (--rule hovered), radius --control-radius, padding 5 9. */
function TextArea({ value, onChange, rows, placeholder, readOnly, own = false, onFocus }: { value: string; onChange: (text: string) => void; rows: number; placeholder: string; readOnly: boolean; own?: boolean; onFocus?: () => void }): JSX.Element {
  const t = useTokens();
  const [hovered, setHovered] = useState(false);
  const spec: FontSpec = own ? BODY : { voice: "data", scale: 12 / 12 };
  const line = (Number(t.scaled(`size-${spec.voice}`, spec.scale)) || 13) * 1.5;
  return (
    <TextInput {...(ENTER_KEEPS_FOCUS as object)}
      value={value}
      onChangeText={onChange}
      multiline
      numberOfLines={rows}
      placeholder={placeholder}
      placeholderTextColor={placeholderColor("light")}
      editable={!readOnly}
      // A record is not a box to type in: out of the tab order (`tabIndex -1`), and no text cursor
      // over it.
      focusable={!readOnly}
      {...(onFocus !== undefined ? { onFocus } : {})}
      {...({ onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false), rows, spellCheck: undefined } as object)}
      style={
        {
          ...(font(t, spec) as object),
          width: "100%",
          ...(own
            ? { marginTop: 4, paddingVertical: 2, paddingHorizontal: 0, borderWidth: 0, backgroundColor: "transparent", ...(isWeb ? { fieldSizing: "content", resize: "none", overflow: "hidden", outlineStyle: "none" } : { minHeight: line + 4 }) }
            : {
                paddingVertical: 5,
                paddingHorizontal: 9,
                borderWidth: 1,
                borderStyle: "solid",
                borderColor: t.v(hovered && !readOnly ? "rule" : "line"),
                borderRadius: lengthToken(t, "control-radius", 7),
                backgroundColor: t.v("bg"),
                ...(isWeb ? { resize: "vertical" } : { height: rows * line + 12 }),
              }),
          textAlignVertical: "top",
          ...(isWeb && readOnly ? { cursor: "default" } : {}),
        } as never
      }
    />
  );
}

/** The `alongside` free text: a comment, drawn before or after the decision. */
function FreeText({ choice, answer, onAnswer, readOnly }: { choice: Choice; answer: Answer; onAnswer: (question: string, answer: Answer) => void; readOnly: boolean }): JSX.Element | null {
  const framed = useContext(FieldFrame);
  const field = choice.freeText;
  if (field === undefined) return null;
  return (
    <View flexDirection="column" gap={4} marginTop={framed ? 12 : 0}>
      <Txt spec={{ voice: "app", scale: 13 / 12.5 / 1.2, color: framed ? "dim" : "text" }}>{field.label}</Txt>
      <TextArea value={answer.text} rows={3} placeholder={readOnly ? "" : (field.placeholder ?? "")} readOnly={readOnly} onChange={(text) => onAnswer(choice.question, { ...answer, text })} />
    </View>
  );
}

/** The `instead` free text: one more option, said in words — chosen by pressing it or typing in it. */
function OwnAnswer({ choice, answer, onAnswer, readOnly }: { choice: Choice; answer: Answer; onAnswer: (question: string, answer: Answer) => void; readOnly: boolean }): JSX.Element | null {
  const t = useTokens();
  const [hovered, setHovered] = useState(false);
  const field = choice.freeText;
  const box = useRef<unknown>(null);
  if (field === undefined) return null;
  const selected = answer.own === true;
  const select = (): void => {
    if (!readOnly && !selected) onAnswer(choice.question, { ...answer, own: true });
  };
  const accentOr = t.replayed ? t.v("accent") : "var(--accent, var(--text))";
  return (
    <View
      ref={box as never}
      {...((isWeb
        ? {
            role: "radio",
            "aria-checked": selected,
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
            onClick: () => {
              select();
              (box.current as HTMLElement | null)?.querySelector("textarea")?.focus();
            },
            cursor: "text",
          }
        : {}) as object)}
      flexBasis="100%"
      flexShrink={0}
      paddingVertical={8}
      paddingHorizontal={12}
      borderRadius={8}
      borderWidth={1}
      borderStyle="solid"
      backgroundColor={t.v("bg") as never}
      borderColor={(hovered || selected ? accentOr : t.v("line")) as never}
      {...((selected ? { boxShadow: `inset 0 0 0 1px ${String(accentOr)}` } : {}) as object)}
    >
      <Txt spec={BODY}>{field.label}</Txt>
      <TextArea own value={answer.text} rows={1} placeholder={readOnly ? "" : (field.placeholder ?? "")} readOnly={readOnly} onFocus={select} onChange={(text) => onAnswer(choice.question, { ...answer, text, own: true })} />
    </View>
  );
}

/**
 * Several questions, one at a time: "Question n of m" (and "· optional"), the question, a typed step's
 * refusal, then Back, Next (or Skip) and Confirm on the last, and whatever the host puts beside them.
 */
export function ChoiceSteps({
  choices,
  answers,
  onAnswer,
  onSubmit,
  extra,
  readOnly = false,
  asked = false,
}: {
  choices: readonly Choice[];
  answers: Record<string, Answer>;
  onAnswer: (question: string, answer: Answer) => void;
  onSubmit: () => void;
  extra?: JSX.Element | undefined;
  readOnly?: boolean;
  /** Under a transcript's row: the block 6 above, Back and Next 8, a size down from a gate's. */
  asked?: boolean;
}): JSX.Element {
  const [step, setStep] = useState(0);
  const at = Math.min(step, choices.length - 1);
  const choice = choices[at]!;
  const last = at === choices.length - 1;
  const answer = answers[choice.question] ?? EMPTY_ANSWER;
  const given = answerOf(choice, answer);
  const passing = given === undefined && choice.optional === true;
  const typed = useTypedStep(choice, readOnly ? undefined : given);
  return (
    <>
      <Txt spec={{ ...BODY, color: "dim" }}>
        Question {at + 1} of {choices.length}
        {choice.optional === true ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}> · optional</Txt> : null}
      </Txt>
      {/* The step line's 6 below it collapses into the block's 14. */}
      <ChoiceList choices={[choice]} answers={answers} onAnswer={onAnswer} stepped readOnly={readOnly} top={asked ? 6 : 14} />
      {typed.problem !== undefined ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }} marginTop={8}>
          {typed.problem}
        </Txt>
      ) : null}
      <View flexDirection="row" flexWrap="wrap" gap={8} marginTop={asked ? 8 : 14}>
        {at > 0 ? (
          <Button kind="ghost" onPress={() => setStep(at - 1)}>
            Back
          </Button>
        ) : null}
        {readOnly ? (
          last ? null : (
            <Button kind="ghost" onPress={() => setStep(at + 1)}>
              Next
            </Button>
          )
        ) : (
          <Button kind={passing ? "ghost" : "primary"} disabled={!settled(choice, answer) || typed.holds} onPress={() => (last ? onSubmit() : setStep(at + 1))}>
            {last ? (passing ? "Skip and confirm" : "Confirm") : passing ? "Skip" : "Next"}
          </Button>
        )}
        {readOnly ? null : extra}
      </View>
    </>
  );
}
