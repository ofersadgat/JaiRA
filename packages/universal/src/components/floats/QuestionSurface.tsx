import { useState, type JSX } from "react";
import { View } from "@tamagui/core";
import { choicesOfQuestions } from "@jaira/shared/browser";
import type { QuestionSurfaceProps } from "@jaira/ui/questionSurfaceTypes";
import { EMPTY_ANSWER, answerOf, submitsOnClick, type Answer } from "@jaira/ui/choicesModel";
import { Txt } from "../../primitives";
import { Button } from "../settings/Button";
import { ChoiceList, ChoiceSteps } from "./Choices";
import { GateTitle } from "./GateTitle";

/**
 * A running agent's question (`AskUserQuestion`) — the same control as an authored gate, answered
 * rather than approved, with the one affordance a gate never gets: "Let the agent decide". One question
 * prints itself under the heading (the body's 13/12.5, --text; its 8 below collapses into the block's
 * 14); several are asked one at a time. It looks as `Choices.tsx` says, and:
 *
 *   the heading              `GateTitle`, the comment glyph
 *   the buttons              row, wrapping, gap 8, 14 above: Answer (`primary`, while the click is not
 *                            the answer) and the dismissal (`danger`)
 *   the error                --bad, app 11/12.5
 */
export function QuestionSurface({ pending, error, onSubmit }: QuestionSurfaceProps): JSX.Element {
  const choices = choicesOfQuestions(pending.questions);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const onAnswer = (question: string, next: Answer): void => setAnswers((prev) => ({ ...prev, [question]: next }));
  const complete = choices.every((c) => answerOf(c, answers[c.question] ?? EMPTY_ANSWER) !== undefined);
  const submit = (): void => {
    const out: Record<string, string | string[]> = {};
    for (const choice of choices) {
      const answer = answerOf(choice, answers[choice.question] ?? EMPTY_ANSWER);
      if (answer !== undefined) out[choice.question] = answer;
    }
    onSubmit(out);
  };
  const immediate = submitsOnClick(choices, answers);
  const dismiss = (
    <Button kind="danger" onPress={() => onSubmit(undefined)}>
      Let the agent decide
    </Button>
  );
  return (
    <View testID="question" flexDirection="column">
      <GateTitle icon="comment">{choices.length === 1 ? "The agent has a question" : "The agent has questions"}</GateTitle>
      {choices.length === 1 ? <Txt spec={{ voice: "app", scale: 13 / 12.5 }}>{choices[0]!.question}</Txt> : null}
      {choices.length > 1 ? (
        <ChoiceSteps choices={choices} answers={answers} onAnswer={onAnswer} onSubmit={submit} extra={dismiss} />
      ) : (
        <>
          <ChoiceList choices={choices} answers={answers} onAnswer={onAnswer} onImmediate={(question, value) => onSubmit({ [question]: value })} />
          <View flexDirection="row" flexWrap="wrap" gap={8} marginTop={14}>
            {immediate ? null : (
              <Button kind="primary" disabled={!complete} onPress={submit}>
                Answer
              </Button>
            )}
            {dismiss}
          </View>
        </>
      )}
      {error ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }} marginTop={11}>
          {error}
        </Txt>
      ) : null}
    </View>
  );
}
