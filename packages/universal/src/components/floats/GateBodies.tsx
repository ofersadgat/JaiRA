import { Fragment, useMemo, useState, type JSX } from "react";
import { TextInput } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { JsonValue } from "@declarative-ai/json";
import { choicesOfConfig, fillFormSchema, readAnswer, type ChooseOptionConfig, type ConfirmActionConfig, type FillFormConfig, type PendingInteraction } from "@jaira/shared/browser";
import { pendingOfPrompt } from "@jaira/ui/approvalModel";
import { EMPTY_ANSWER, answerOf, initialAnswers, submitsOnClick, type Answer } from "@jaira/ui/choices";
import { formStartsWith } from "@jaira/ui/gateForms";
import { useSchemaCheck, useTouched } from "@jaira/ui/schemaForm/check";
import { checkBlocker } from "@jaira/ui/schemaForm/model";
import type { Schema } from "@jaira/ui/schemaForm/types";
import { Txt, font, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { SchemaForm } from "../form/SchemaForm";
import { Button } from "../settings/Button";
import { ApprovalSurface } from "./ApprovalSurface";
import { ChoiceList, ChoiceSteps } from "./Choices";

/**
 * `components.tsx`'s gate bodies, universal (decision 0015) — what `GateSurface` draws under the author's
 * question for each built-in component, with `panel/Gate.tsx` drawing the heading around them:
 *
 *  - `choose_option` — one question (its options, a comment beside it, an answer of one's own, several
 *    at once, Confirm when the click is not the answer) or several, one at a time (`Choices.tsx`);
 *  - `confirm_action` — the details (`dl.publish-what`) and the buttons that say what they do;
 *  - `fill_form` — the one form (`form/SchemaForm`) and Submit, held while the run's check refuses it;
 *  - `approve_tool_call` — the approval it is (`ApprovalSurface`);
 *  - anything else — the JSON box (`RawJson`).
 *
 * The body's first block stands 14 below the heading; the host has already taken the heading's 8 off
 * (`GateSurface`), so `top` is what the body adds above something with no margin of its own (a step
 * line, the details, the form): 8 under the heading, or 0 under "Answering this continues the task."
 */
export function gateBodyOf(pending: PendingInteraction, onSubmit: (value: unknown) => void, top: number): JSX.Element | null {
  const config = pending.config;
  const inputs = pending.inputs as Record<string, unknown>;
  switch (config?.component) {
    case "choose_option":
      return <ChooseOptionGate config={config} onSubmit={onSubmit} top={top} />;
    case "confirm_action":
      return <ConfirmActionGate config={config} onSubmit={onSubmit} top={top} />;
    case "fill_form":
      return <FillFormGate config={config} onSubmit={onSubmit} top={top} />;
    case "approve_tool_call":
      return (
        <View marginTop={top}>
          <ApprovalSurface pending={pendingOfPrompt(pending.requestId, config.prompt, inputs["request"])} onDecide={(decision) => onSubmit({ decision })} />
        </View>
      );
    case "review_artifact":
    case "edit_artifact":
    case "review_artifacts":
      return null;
    default:
      return <RawJson onSubmit={onSubmit} />;
  }
}

/** `ChooseOption`: one authored question or several, answered as the desktop's is. */
function ChooseOptionGate({ config, onSubmit, top }: { config: ChooseOptionConfig; onSubmit: (value: unknown) => void; top: number }): JSX.Element {
  const choices = choicesOfConfig(config);
  const [answers, setAnswers] = useState<Record<string, Answer>>(() => initialAnswers(choices));
  const onAnswer = (question: string, next: Answer): void => setAnswers((prev) => ({ ...prev, [question]: next }));
  if (config.questions !== undefined) {
    const submit = (): void => {
      const out: Record<string, JsonValue> = {};
      for (const choice of choices) {
        const value = answerOf(choice, answers[choice.question] ?? EMPTY_ANSWER);
        if (value === undefined) continue;
        const read = choice.schema !== undefined ? readAnswer(choice.schema, value) : undefined;
        if (read !== undefined && !read.ok) return;
        out[choice.name ?? choice.question] = read !== undefined && read.ok ? read.value : value;
      }
      onSubmit({ answers: out });
    };
    return (
      <View marginTop={top}>
        <ChoiceSteps choices={choices} answers={answers} onAnswer={onAnswer} onSubmit={submit} />
      </View>
    );
  }
  const only = choices[0]!;
  const answer = answers[only.question] ?? EMPTY_ANSWER;
  const send = (picked: string | string[]): void => {
    const comments = only.freeText?.role === "alongside" ? answer.text.trim() : "";
    onSubmit({ decision: picked, ...(comments === "" ? {} : { comments }) });
  };
  return (
    <>
      <ChoiceList choices={choices} answers={answers} onAnswer={onAnswer} onImmediate={(_question, value) => send(value)} />
      {submitsOnClick(choices, answers) ? null : (
        <View flexDirection="row" flexWrap="wrap" gap={8} marginTop={14}>
          <Button kind="primary" disabled={answerOf(only, answer) === undefined} onPress={() => send(answerOf(only, answer)!)}>
            Confirm
          </Button>
        </View>
      )}
    </>
  );
}

/**
 * `ConfirmAction`: what it will do (`dl.publish-what` — a grid of the label, --dim, and the value in the
 * data face; gap 3 12, 10 below) and the buttons: the confirm (filled when it has alternatives beside
 * it), each alternative, and the cancel (`ghost`).
 */
function ConfirmActionGate({ config, onSubmit, top }: { config: ConfirmActionConfig; onSubmit: (value: unknown) => void; top: number }): JSX.Element {
  const several = (config.options ?? []).length > 0;
  const details = config.details ?? [];
  return (
    <View marginTop={top}>
      {details.length > 0 ? <Details rows={details} /> : null}
      {/* `.options`' 14 collapses with the details' 10 below them. */}
      <View flexDirection="row" flexWrap="wrap" gap={8} marginTop={details.length > 0 ? 4 : 14 - top}>
        <Button kind={several ? "primary" : "plain"} onPress={() => onSubmit({ confirmed: true })}>
          {config.confirmLabel}
        </Button>
        {(config.options ?? []).map((option) => (
          <Button key={option.value} {...(option.description !== undefined ? { title: option.description } : {})} onPress={() => onSubmit({ confirmed: true, choice: option.value })}>
            {option.label ?? option.value}
          </Button>
        ))}
        <Button kind="ghost" onPress={() => onSubmit({ confirmed: false })}>
          {config.cancelLabel}
        </Button>
      </View>
    </View>
  );
}

/** `dl.publish-what`: label and value a row each, the labels' column as wide as the widest. */
function Details({ rows }: { rows: ReadonlyArray<{ label: string; value: string }> }): JSX.Element {
  const [widths, setWidths] = useState<Record<number, number>>({});
  const column = Math.max(0, ...Object.values(widths));
  return (
    <View flexDirection="column" gap={3} marginBottom={10}>
      {rows.map((row, i) => (
        <Fragment key={row.label}>
          <View flexDirection="row" gap={12} alignItems="baseline">
            <View flexShrink={0} {...(column > 0 ? { width: column } : {})}>
              <Txt
                spec={{ voice: "app", scale: 1, color: "dim" }}
                alignSelf="flex-start"
                onLayout={(e: { nativeEvent: { layout: { width: number } }; target?: unknown }) => {
                  const el = e.target as { getBoundingClientRect?: () => DOMRect } | undefined;
                  const w = isWeb && typeof el?.getBoundingClientRect === "function" ? el.getBoundingClientRect().width : e.nativeEvent.layout.width;
                  setWidths((was) => (Math.abs((was[i] ?? 0) - w) < 0.01 ? was : { ...was, [i]: w }));
                }}
              >
                {row.label}
              </Txt>
            </View>
            <Txt spec={{ voice: "data", scale: 1 }} flexGrow={1} flexShrink={1} minWidth={0} {...((isWeb ? { overflowWrap: "anywhere" } : {}) as object)}>
              {row.value}
            </Txt>
          </View>
        </Fragment>
      ))}
    </View>
  );
}

/** `FillForm`: the form a state declared, and Submit — held, with the reason beside it, while the check refuses it. */
function FillFormGate({ config, onSubmit, top }: { config: FillFormConfig; onSubmit: (value: unknown) => void; top: number }): JSX.Element {
  const schema = useMemo(() => fillFormSchema(config.fields) as Schema, [config.fields]);
  const [value, setValue] = useState<Record<string, unknown>>(() => formStartsWith(config.fields, schema));
  const { touched, touch } = useTouched("fill_form");
  const check = useSchemaCheck([{ path: "", schema, value: value as JsonValue }]);
  const blocked = checkBlocker(check);
  return (
    <View marginTop={top}>
      <SchemaForm
        schema={schema}
        value={value}
        onChange={(next) => setValue(next as Record<string, unknown>)}
        ctx={{ path: "", hidePaths: true, errors: check.errors, touched, touch, unsetNote: () => "not set — left out of the answer" }}
      />
      <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={8} marginTop={14}>
        <Button kind="primary" disabled={blocked !== null} {...(blocked !== null ? { title: blocked } : {})} onPress={() => onSubmit(value)}>
          Submit
        </Button>
        {blocked !== null && blocked.length > 0 ? (
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} ellip flexShrink={1} minWidth={0}>
            {blocked}
          </Txt>
        ) : null}
      </View>
    </View>
  );
}

/**
 * `RawJson`: the fallback for a function nothing implements — `label.field` ("RESPONSE (JSON)": app
 * 11/12.5, --dim, 0.04em, uppercase, 4 over the box; 12 above) with a six-row `textarea`, and Submit.
 */
function RawJson({ onSubmit }: { onSubmit: (value: unknown) => void }): JSX.Element {
  const t = useTokens();
  const [text, setText] = useState("");
  const [hovered, setHovered] = useState(false);
  const line = (Number(t.scaled("size-data", 1)) || 12) * 1.5;
  return (
    <View>
      {/* The field's 12 collapses with the heading's 8. */}
      <View flexDirection="column" gap={4} marginTop={12}>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim", ls: 0.04, upper: true }}>Response (JSON)</Txt>
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          numberOfLines={6}
          {...({ rows: 6, spellCheck: false, onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) } as object)}
          style={
            {
              ...(font(t, { voice: "data", scale: 1 }) as object),
              width: "100%",
              paddingVertical: 5,
              paddingHorizontal: 9,
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: t.v(hovered ? "rule" : "line"),
              borderRadius: lengthToken(t, "control-radius", 7),
              backgroundColor: t.v("bg"),
              textAlignVertical: "top",
              ...(isWeb ? { resize: "vertical" } : { height: 6 * line + 12 }),
            } as never
          }
        />
      </View>
      <View flexDirection="row" flexWrap="wrap" gap={8} marginTop={14}>
        <Button
          onPress={() => {
            try {
              onSubmit(JSON.parse(text) as unknown);
            } catch {
              onSubmit(text);
            }
          }}
        >
          Submit
        </Button>
      </View>
    </View>
  );
}
