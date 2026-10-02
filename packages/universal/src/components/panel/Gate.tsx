import { useState, type JSX } from "react";
import { View } from "@tamagui/core";
import { choicesOfConfig, fillFormSchema, isComponentName, type Choice, type PendingInteraction } from "@jaira/shared/browser";
import type { Schema } from "@jaira/ui/schemaForm/types";
import { SchemaForm } from "../form/SchemaForm";
import { Button } from "../settings/Button";
import { EMPTY_ANSWER, answerOf, answersOfValue, initialAnswers, submitsOnClick, type Answer } from "@jaira/ui/choicesModel";
import { ChoiceList, ChoiceSteps, FieldFrame } from "../floats/Choices";
import { COMPONENT_ICON } from "@jaira/ui/gateModel";
import { PATHS } from "@jaira/ui/iconPaths";
import { Press, Txt, edge, scrollbarProps, viewScrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { Icon, type IconName } from "./Icon";
import { gateBodyOf, subjectOf } from "../floats/GateBodies";
import { ApprovalSurface } from "../floats/ApprovalSurface";
import { pendingOfPrompt } from "@jaira/ui/approvalModel";
import { ChangesetGate, EditArtifactGate, ReviewArtifactGate, serveOfGate } from "../artifact/ArtifactGates";
import type { ComponentServices } from "@jaira/ui/changesetReviewModel";
import { GateTitle } from "../floats/GateTitle";
import { InlineGlyph } from "../floats/InlineGlyph";

/** One question, picked from its options alone: what this file's `ChooseOption` draws. */
const plainChoice = (choices: readonly Choice[]): boolean => choices.length === 1 && choices[0]!.freeText === undefined && choices[0]!.multiple !== true && choices[0]!.requireConfirm !== true;

/**
 * A parked gate in the panel: `GateSurface` in a section under a task's conversation
 * (`TaskConversation.tsx`). A `choose_option` of one plain question is this file's `ChooseOption`; every
 * other body is `floats/GateBodies.tsx`'s. How it looks:
 *
 *   the section                flex none, at most 55% tall, scrolls; padding 10 12, a --line on top;
 *                              12 above
 *   the heading                700, --size-app × 17/12.5, line 1.35, --text, 8 under; the glyph 16,
 *                              --dim, 4 right, 2 below the baseline, then a space
 *   the resumes line           --size-app × 11/12.5, --dim, 4 above (collapses into the heading's 8)
 *   the question               14 above; its options a row, wrapping, gap 8, 12 above (collapses into
 *                              the question's 14 — except in a state's panel, a flex column whose items
 *                              keep their children's margins)
 *   an option                  padding 8 12, 1px --line, radius 8, --bg; the label the body's font
 *                              (--size-app × 13/12.5, 1.5), --text. Hover: an --accent edge.
 *   the primary option         --fill-accent ground and edge, --sheen; the label 600 --on-accent.
 *                              Hover: --fill-accent-hover.
 *   a danger option            the label --bad; the edge --bad 45% into --line; no ground
 *   an option's description    the body's size ÷ 1.2, --dim, 2 under the label
 */
export function InlineGate({ pending, onGate, maxHeight, services }: { pending: PendingInteraction; onGate: (value: unknown) => void; maxHeight?: number; services?: Partial<ComponentServices> | undefined }): JSX.Element {
  const t = useTokens();
  return (
    <View testID="inline-gate" flexShrink={0} {...(maxHeight !== undefined ? { maxHeight } : {})} marginTop={12} paddingVertical={10} paddingHorizontal={12} {...({ overflow: "auto" } as object)} {...(viewScrollbarProps(t) as object)} {...(edge(t, { top: 1 }) as object)}>
      <GateSurface pending={pending} onSubmit={onGate} services={services} />
    </View>
  );
}

/**
 * `GateSurface`: the author's question, whether answering it resumes the task, and its control — or,
 * `settled`, the control as it was answered, with "Never answered." over a question nobody got to
 * answer; `error` is the reason under it, in --bad.
 */
export function GateSurface({
  pending,
  onSubmit,
  settled,
  error,
  plain = false,
  flex = false,
  services,
}: {
  pending: PendingInteraction;
  onSubmit: (value: unknown) => void;
  settled?: { value: unknown } | undefined;
  error?: string | undefined;
  /** Hosted in a state's panel rather than an `InlineGate`: the heading is `PlainTitle`. */
  plain?: boolean;
  /** Hosted in a flex column (the gallery's wide modal), where no margin collapses. */
  flex?: boolean;
  /** The host's own reach for a gate that mounts the changeset reviewer (`ChangesetGate`'s `services`). */
  services?: Partial<ComponentServices> | undefined;
}): JSX.Element {
  const config = pending.config;
  // A flex column collapses no margin: the body's first block keeps all of its own, under the heading's 8.
  const flat = plain || flex;
  // A form field's frame (in a modal or an `InlineGate`): 12 above and a --dim label — not in a state's panel.
  if (settled !== undefined)
    return (
      <FieldFrame.Provider value={!plain}>
        <SettledGateSurface pending={pending} settled={settled} error={error} plain={plain} services={services} />
      </FieldFrame.Provider>
    );
  const body = ((): JSX.Element => {
    if (pending.configError !== undefined) {
      return (
        <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }}>
          This state&apos;s {pending.component} config is invalid: {pending.configError}
        </Txt>
      );
    }
    if (config?.component === "choose_option" && config.questions === undefined && plainChoice(choicesOfConfig(config))) return <ChooseOption choices={choicesOfConfig(config)} onSubmit={onSubmit} inFlex={plain} />;
    // Every other body (`floats/GateBodies.tsx`): a choice with words or several questions, a
    // confirmation, a form, a tool call, a review or an edit of an artifact, the JSON box.
    return gateBodyOf(pending, onSubmit, pending.resumes || flat ? 0 : 8, flat, services);
  })();
  return (
    <FieldFrame.Provider value={!plain}>
      {/* The heading and its glyph, placed as Chromium places an inline one (`floats/GateTitle`). */}
      {plain ? <PlainTitle {...(isComponentName(pending.component) ? { icon: COMPONENT_ICON[pending.component] } : {})}>{config?.prompt ?? pending.component}</PlainTitle> : <GateTitle {...(isComponentName(pending.component) ? { icon: COMPONENT_ICON[pending.component] } : {})}>{config?.prompt ?? pending.component}</GateTitle>}
      {/* The resumes line: 4 above, which collapses into the heading's 8 except in a flex column. */}
      {pending.resumes ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} marginTop={flat ? 4 : 0}>
          Answering this continues the task.
        </Txt>
      ) : null}
      {/* Without the line above, the block's 14 collapses into the heading's 8 in an `InlineGate`; in a
          state's panel or a wide modal (a flex column) nothing collapses. */}
      {/* In a flex column capped in height (the wide modal), the body gives way: a reviewer in it scrolls. */}
      <View marginTop={pending.resumes || flat ? 0 : -8} {...(flex ? { flexShrink: 1, minHeight: 0 } : {})}>
        {body}
      </View>
    </FieldFrame.Provider>
  );
}

/**
 * `ChooseOption` for one question: its options, answered on the click (or held for Confirm). `inFlex`:
 * the block is an item of a flex column (a state's panel), so it is a formatting context of its own and
 * the options' 12 stays inside its 14 rather than collapsing into it.
 */
function ChooseOption({ choices, onSubmit, inFlex = false }: { choices: readonly Choice[]; onSubmit: (value: unknown) => void; inFlex?: boolean }): JSX.Element {
  const [answers, setAnswers] = useState<Record<string, Answer>>(() => initialAnswers(choices));
  const only = choices[0];
  if (only === undefined) return <></>;
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
      <View flexDirection={bare ? "row" : "column"} flexWrap="wrap" gap={8} marginTop={inFlex ? 12 : 0}>
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

/** One option of a question. */
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
        // A danger option has no ground of its own, where the others stand on --bg.
        backgroundColor: primary ? (hovered ? t.v("fill-accent-hover") : t.v("fill-accent")) : danger ? "transparent" : t.v("bg"),
        borderColor: primary ? (hovered ? t.v("fill-accent-hover") : t.v("fill-accent")) : hovered || selected ? accentOr : danger ? t.mix(t.v("bad"), 45, t.v("line")) : t.v("line"),
        ...(primary ? { boxShadow: t.v("sheen") } : selected ? { boxShadow: `inset 0 0 0 1px ${String(accentOr)}` } : {}),
      })}
    >
      <View flexDirection="row" alignItems="center">
        {/* The authored glyph (13, 2 under the baseline) inline in the label, a space after it. */}
        <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: primary ? 600 : 400, color: primary ? "on-accent" : danger ? "bad" : "text" }} numberOfLines={1}>
          {icon !== undefined ? (
            <>
              <InlineGlyph size={13} drop={2}>
                <Icon name={icon} size={13} color={String(primary ? t.v("on-accent") : danger ? t.v("bad") : t.v("text"))} />
              </InlineGlyph>{" "}
            </>
          ) : null}
          {label}
        </Txt>
      </View>
      {/* The description: the body's size ÷ 1.2 on the same 1.5, 2 below the label. */}
      {description !== undefined && description.length > 0 ? (
        <Txt spec={{ voice: "app", scale: 13 / 12.5 / 1.2, color: "dim" }} marginTop={2}>
          {description}
        </Txt>
      ) : null}
    </Press>
  );
}

/**
 * A gate as it was answered (`GateSurface` with `settled`): the heading, "Never answered." (the body's
 * font, italic, --dim, 10 under) when nothing answered it, and the chooser, inert, with what was picked
 * lit; every other gate's body as it was answered is {@link SettledBody}'s.
 */
function SettledGateSurface({ pending, settled, error, plain, services }: { pending: PendingInteraction; settled: { value: unknown }; error?: string | undefined; plain: boolean; services?: Partial<ComponentServices> | undefined }): JSX.Element {
  const t = useTokens();
  const config = pending.config;
  const choices = config?.component === "choose_option" ? choicesOfConfig(config) : undefined;
  const [answers, setAnswers] = useState<Record<string, Answer>>(() => (choices === undefined ? {} : answersOfValue(choices, settled.value as never)));
  const never = settled.value === undefined;
  const onAnswer = (question: string, next: Answer): void => setAnswers((prev) => ({ ...prev, [question]: next }));
  return (
    <>
      {plain ? <PlainTitle {...(isComponentName(pending.component) ? { icon: COMPONENT_ICON[pending.component] } : {})}>{config?.prompt ?? pending.component}</PlainTitle> : <GateTitle {...(isComponentName(pending.component) ? { icon: COMPONENT_ICON[pending.component] } : {})}>{config?.prompt ?? pending.component}</GateTitle>}
      {never ? (
        <Txt spec={{ voice: "app", scale: 13 / 12.5, italic: true, color: "dim" }} marginBottom={10}>
          Never answered.
        </Txt>
      ) : null}
      {/* The block's 14 collapses with the heading's 8 (or the line's 10) in an `InlineGate`; in a state's
          panel (a flex column) nothing collapses, and the answered control is a block of its own. */}
      <View marginTop={plain ? 0 : never ? -10 : -8}>
        {choices === undefined ? (
          <SettledBody pending={pending} value={settled.value} lift={plain ? 0 : never ? 10 : 8} plain={plain} services={services} />
        ) : config?.component === "choose_option" && config.questions !== undefined ? (
          <ChoiceSteps choices={choices} answers={answers} onAnswer={onAnswer} onSubmit={() => undefined} readOnly />
        ) : (
          <ChoiceList choices={choices} answers={answers} onAnswer={onAnswer} readOnly />
        )}
      </View>
      {error !== undefined ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }} marginTop={Number(t.scaled("size-app", 11 / 12.5)) || 11}>
          {error}
        </Txt>
      ) : null}
    </>
  );
}

/**
 * A state's panel's own heading, where a gate stands there rather than in an `InlineGate`: a row, the
 * glyph (13) at one end and the words at the other (`space-between`), gap 8; app 700 11/12.5, 0.09em,
 * upper case, --dim; 8 under.
 */
function PlainTitle({ icon, children }: { icon?: IconName; children: string }): JSX.Element {
  const t = useTokens();
  return (
    <View role="heading" flexDirection="row" alignItems="center" justifyContent="space-between" gap={8} marginBottom={8}>
      {icon !== undefined ? <Icon name={icon} size={13} color={String(t.v("dim"))} /> : <View />}
      <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 700, ls: 0.09, upper: true, color: "dim" }} flexShrink={1} textAlign="right">
        {children}
      </Txt>
    </View>
  );
}

/** What a settled record answered, as a record (`recordOf`). */
const recordOf = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/**
 * The settled bodies other than `choose_option`'s: a form as it was submitted (a field it did not name is
 * "not answered"), a confirmation with the button that was pressed filled, a tool call's approval as it
 * was asked (the same surface: nothing it presses goes anywhere), an artifact reviewed or edited as it
 * was decided (`artifact/ArtifactGates.tsx` with `settled`), and anything else's JSON (--bg, 1px --line,
 * radius 8, padding 8, data 11/12, pre-wrap, at most 220). The changeset reviewer answered
 * (`review_artifacts`) is the reviewer read-only (`ChangesetGate` with `settled`), given the host's
 * services.
 *
 * `lift` is what the wrapper above took back (the heading's 8, or "Never answered."'s 10, in an
 * `InlineGate`): a body with no margin of its own above it — the approval, whose heading has none —
 * gives it back.
 */
function SettledBody({ pending, value, lift, plain, services }: { pending: PendingInteraction; value: unknown; lift: number; plain: boolean; services?: Partial<ComponentServices> | undefined }): JSX.Element {
  const t = useTokens();
  const config = pending.config;
  if (config?.component === "fill_form") {
    const schema = fillFormSchema(config.fields) as Schema;
    return <SchemaForm schema={schema} value={{ ...recordOf(value) }} onChange={() => undefined} ctx={{ path: "", hidePaths: true, disabled: true, unsetNote: () => "not answered" }} />;
  }
  if (config?.component === "confirm_action") {
    const confirmed = recordOf(value)["confirmed"];
    const chosen = recordOf(value)["choice"];
    const details = config.details ?? [];
    return (
      <View>
        {details.length > 0 ? (
          <View flexDirection="column" gap={3} marginBottom={10}>
            {details.map((row) => (
              <View key={row.label} flexDirection="row" gap={12} alignItems="baseline">
                <Txt spec={{ voice: "app", scale: 1, color: "dim" }} flexShrink={0} numberOfLines={1}>
                  {row.label}
                </Txt>
                <Txt spec={{ voice: "data", scale: 1 }} flexShrink={1} minWidth={0}>
                  {row.value}
                </Txt>
              </View>
            ))}
          </View>
        ) : null}
        {/* The record keeps its colours: a pressed button filled, none of them live. */}
        <View flexDirection="row" flexWrap="wrap" gap={8} marginTop={details.length > 0 ? 4 : 14}>
          <Button kind={confirmed === true && chosen === undefined ? "primary" : "plain"}>{config.confirmLabel}</Button>
          {(config.options ?? []).map((option) => (
            <Button key={option.value} kind={chosen === option.value ? "primary" : "plain"} {...(option.description !== undefined ? { title: option.description } : {})}>
              {option.label ?? option.value}
            </Button>
          ))}
          <Button kind={confirmed === false ? "primary" : "ghost"}>{config.cancelLabel}</Button>
        </View>
      </View>
    );
  }
  if (config?.component === "approve_tool_call") {
    return (
      <View marginTop={lift}>
        {/* In a state's panel its heading is the panel's plain one too (the surface's own is the dialog's). */}
        {plain ? <PlainTitle icon="shield">Approve this command?</PlainTitle> : null}
        <ApprovalSurface pending={pendingOfPrompt(pending.requestId, config.prompt, (pending.inputs as Record<string, unknown>)["request"])} onDecide={() => undefined} heading={!plain} />
      </View>
    );
  }
  if (config?.component === "review_artifact") {
    return <ReviewArtifactGate config={config} inputs={pending.inputs as Record<string, unknown>} onSubmit={() => undefined} requestId={pending.requestId} project={subjectOf(pending)} flat={false} settled={{ value }} serve={serveOfGate(pending)} />;
  }
  if (config?.component === "edit_artifact") {
    return <EditArtifactGate config={config} inputs={pending.inputs as Record<string, unknown>} onSubmit={() => undefined} requestId={pending.requestId} project={subjectOf(pending)} settled={{ value }} serve={serveOfGate(pending)} />;
  }
  if (config?.component === "review_artifacts") {
    // The reviewer stands under the heading with no margin of its own: it gives back what the wrapper took.
    return (
      <View marginTop={lift}>
        <ChangesetGate pending={pending} config={config} inputs={pending.inputs as Record<string, unknown>} onSubmit={() => undefined} project={subjectOf(pending)} host={services} settled={{ value }} />
      </View>
    );
  }
  return (
    <View marginTop={14} padding={8} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={8} backgroundColor={t.v("bg") as never} maxHeight={220} {...({ overflow: "auto" } as object)} {...(viewScrollbarProps(t) as object)}>
      <Txt spec={{ voice: "data", scale: 11 / 12 }} whiteSpace="pre-wrap">
        {value === undefined ? "" : JSON.stringify(value, null, 2)}
      </Txt>
    </View>
  );
}
