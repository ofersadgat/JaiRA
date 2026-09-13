/**
 * The Conversation section of Settings: how a run's transcript is laid out.
 *
 * One person's reading preferences, kept beside the theme and the typography in `user-settings.json`
 * rather than in a project's `settings.json` — how you read a transcript is a fact about you, and
 * it must not arrive through a pull request. Built from the `Level` / `Field` chrome the other
 * sections use: each setting is a statement on the left and its control on the right, which is the
 * right shape for a list that will grow a line per question a conversation can be asked about its
 * drawing.
 */
import type { JSX } from "react";
import type { ConversationLook, SequentialBatchLayout } from "@jaira/shared/browser";
import { Field, FieldGrid, Level, SelectInput } from "./controls";

const BATCH_LAYOUTS: Array<[label: string, value: SequentialBatchLayout]> = [
  ["One after another", "stacked"],
  ["Tabbed band", "band"],
];

export function ConversationPane({
  look,
  busy,
  onChange,
}: {
  look: ConversationLook;
  busy: boolean;
  onChange: (patch: Partial<ConversationLook>) => void;
}): JSX.Element {
  return (
    <Level title="Conversation" hint="How a run's transcript is drawn. Yours alone — a reading preference, not a fact about any project.">
      <FieldGrid>
        <Field
          label="Sequential batch elements"
          hint="A fan-out whose elements ran one after another. One after another draws them down the page in the order they ran, as any sequence of states is drawn; a band draws them across — two columns, or tabs from three up — the way elements that ran at the same time already are."
        >
          <SelectInput
            value={look.sequentialBatches}
            options={BATCH_LAYOUTS}
            disabled={busy}
            onChange={(value) => onChange({ sequentialBatches: value as SequentialBatchLayout })}
          />
        </Field>
      </FieldGrid>
    </Level>
  );
}
