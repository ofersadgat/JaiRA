import { useState, type JSX } from "react";
import { View } from "@tamagui/core";
import { choicesOfConfig, isComponentName, type Choice, type PendingInteraction } from "@jaira/shared/browser";
import { EMPTY_ANSWER, answerOf, initialAnswers, submitsOnClick, type Answer } from "@jaira/ui/choices";
import { COMPONENT_ICON } from "@jaira/ui/gateModel";
import { PATHS } from "@jaira/ui/icons";
import { Press, Txt, edge, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { Uncopied } from "../../app/Uncopied";
import { Icon } from "./Icon";

/**
 * A parked gate, universal (decision 0015): `components.tsx`'s `GateSurface` inside the panel's
 * `section.inline-gate` (`panelFaces.tsx`'s `TaskConversation`), with `choices.tsx`'s `ChoiceList` for
 * a `choose_option` of one question. The other components (a review, an edit, a form, a multi-part
 * question) are drawn {@link Uncopied} for now. The rules, from `styles.css`:
 *
 *   .pv-convo > .inline-gate   flex none, at most 55% tall, scrolls; padding 10 12, a --line on top;
 *                              .inline-gate's margin-top 12
 *   .inline-gate h3            700 (h3), --size-app × 17/12.5, line 1.35, --text, margin 0 0 8; the
 *                              glyph 16, --dim, 4 right, 2 below the baseline, then a space
 *   .gate-resumes              --size-app × 11/12.5, --dim, margin 4 0 0 (collapses into the h3's 8)
 *   .question-block            margin-top 14; .question-options row, wrapping, gap 8, margin-top 12
 *                              (collapses into the block's 14)
 *   .question-option           padding 8 12, 1px --line, radius 8, --bg; the label the body's font
 *                              (--size-app × 13/12.5, 1.5), --text. Hover: an --accent edge.
 *   .question-option.primary   --fill-accent ground and edge, --sheen; the label 600 --on-accent.
 *                              Hover: --fill-accent-hover.
 *   .question-option.danger    the label --bad; the edge --bad 45% into --line; no ground (`button.danger`)
 *   .question-option-desc      a `small`: the body's size ÷ 1.2, --dim, 2 under the label
 */
export function InlineGate({ pending, onGate, maxHeight }: { pending: PendingInteraction; onGate: (value: unknown) => void; maxHeight?: number }): JSX.Element {
  const t = useTokens();
  return (
    <View testID="inline-gate" flexShrink={0} {...(maxHeight !== undefined ? { maxHeight } : {})} marginTop={12} paddingVertical={10} paddingHorizontal={12} {...({ overflow: "auto" } as object)} {...(scrollbarProps(t) as object)} {...(edge(t, { top: 1 }) as object)}>
      <GateSurface pending={pending} onSubmit={onGate} />
    </View>
  );
}

/** `GateSurface`: the author's question, whether answering it resumes the task, and its control. */
export function GateSurface({ pending, onSubmit }: { pending: PendingInteraction; onSubmit: (value: unknown) => void }): JSX.Element {
  const t = useTokens();
  const config = pending.config;
  const size = t.scaled("size-app", 17 / 12.5);
  const body = ((): JSX.Element => {
    if (pending.configError !== undefined) {
      return (
        <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }}>
          This state&apos;s {pending.component} config is invalid: {pending.configError}
        </Txt>
      );
    }
    if (config?.component === "choose_option" && config.questions === undefined) return <ChooseOption choices={choicesOfConfig(config)} onSubmit={onSubmit} />;
    return <Uncopied name={`the ${pending.component} gate`} />;
  })();
  return (
    <>
      {/* The glyph sits 2px under the baseline (`vertical-align: -2px`): DM Sans' ascent (0.992) and
          descent (0.31) in a 1.35 line put its top at 1.016 × the size − 14. */}
      <View flexDirection="row" alignItems="flex-start" marginBottom={8}>
        {isComponentName(pending.component) ? <Icon name={COMPONENT_ICON[pending.component]} size={16} color={String(t.v("dim"))} box={{ marginTop: typeof size === "number" ? size * 1.016 - 14 : 3.27, marginRight: 4 }} /> : null}
        <Txt spec={{ voice: "app", scale: 17 / 12.5, weight: 700, lineHeight: 1.35 }} flex={1} minWidth={0}>
          {` ${config?.prompt ?? pending.component}`}
        </Txt>
      </View>
      {pending.resumes ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>Answering this continues the task.</Txt> : null}
      {/* Without the line above, the block's 14 collapses into the heading's 8 in the DOM. */}
      <View marginTop={pending.resumes ? 0 : -8}>{body}</View>
    </>
  );
}

/** `ChooseOption` for one question: its options, answered on the click (or held for Confirm). */
function ChooseOption({ choices, onSubmit }: { choices: readonly Choice[]; onSubmit: (value: unknown) => void }): JSX.Element {
  const [answers, setAnswers] = useState<Record<string, Answer>>(() => initialAnswers(choices));
  const only = choices[0];
  if (only === undefined) return <></>;
  if (only.freeText !== undefined || choices.length > 1) return <Uncopied name="a question with words of its own" />;
  const answer = answers[only.question] ?? EMPTY_ANSWER;
  const send = (picked: string | string[]): void => onSubmit({ decision: picked });
  const immediate = submitsOnClick(choices, answers);
  const bare = only.options.every((o) => o.description === undefined);
  const toggle = (value: string): void => {
    if (immediate) {
      send(value);
      return;
    }
    const had = answer.picked;
    const picked = only.multiple === true ? (had.includes(value) ? had.filter((v) => v !== value) : [...had, value]) : [value];
    setAnswers((prev) => ({ ...prev, [only.question]: { ...answer, picked, own: false } }));
  };
  return (
    <View marginTop={14}>
      <View flexDirection={bare ? "row" : "column"} flexWrap="wrap" gap={8}>
        {only.options.map((option, index) => (
          <Option
            key={option.value}
            label={option.label ?? option.value}
            {...(option.icon !== undefined && option.icon in PATHS ? { icon: option.icon as keyof typeof PATHS } : {})}
            {...(option.description !== undefined ? { description: option.description } : {})}
            primary={index === 0 && option.tone !== "danger" && bare}
            danger={option.tone === "danger"}
            selected={answer.own !== true && answer.picked.includes(option.value)}
            onPress={() => toggle(option.value)}
          />
        ))}
      </View>
      {immediate ? null : (
        <View flexDirection="row" marginTop={12}>
          <Option label="Confirm" primary disabled={answerOf(only, answer) === undefined} onPress={() => send(answerOf(only, answer)!)} />
        </View>
      )}
    </View>
  );
}

/** One `.question-option`. */
function Option({ label, icon, description, primary = false, danger = false, selected = false, disabled = false, onPress }: { label: string; icon?: keyof typeof PATHS; description?: string; primary?: boolean; danger?: boolean; selected?: boolean; disabled?: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  const accentOr = t.replayed ? t.v("accent") : "var(--accent, var(--text))";
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      {...(description !== undefined ? { title: description } : { title: "" })}
      flexShrink={0}
      paddingVertical={8}
      paddingHorizontal={12}
      borderRadius={8}
      borderWidth={1}
      borderStyle="solid"
      {...(disabled ? { opacity: 0.45 } : {})}
      box={({ hovered }) => ({
        // A danger option is also `button.danger`, whose `background: none` outranks `.question-option`'s --bg.
        backgroundColor: primary ? (hovered ? t.v("fill-accent-hover") : t.v("fill-accent")) : danger ? "transparent" : t.v("bg"),
        borderColor: primary ? (hovered ? t.v("fill-accent-hover") : t.v("fill-accent")) : hovered || selected ? accentOr : danger ? t.mix(t.v("bad"), 45, t.v("line")) : t.v("line"),
        ...(primary ? { boxShadow: t.v("sheen") } : selected ? { boxShadow: `inset 0 0 0 1px ${String(accentOr)}` } : {}),
      })}
    >
      <View flexDirection="row" alignItems="center">
        {icon !== undefined ? <Icon name={icon} size={Number(t.scaled("size-app", 13 / 12.5)) || 13} color={String(primary ? t.v("on-accent") : danger ? t.v("bad") : t.v("text"))} box={{ marginRight: 4 }} /> : null}
        <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: primary ? 600 : 400, color: primary ? "on-accent" : danger ? "bad" : "text" }} numberOfLines={1}>
          {label}
        </Txt>
      </View>
      {/* `small.question-option-desc`: the UA's `smaller` (the body's size ÷ 1.2) on the inherited 1.5, 2 below. */}
      {description !== undefined && description.length > 0 ? (
        <Txt spec={{ voice: "app", scale: 13 / 12.5 / 1.2, color: "dim" }} marginTop={2}>
          {description}
        </Txt>
      ) : null}
    </Press>
  );
}
