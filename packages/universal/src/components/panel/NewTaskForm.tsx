import type { JSX, ReactNode } from "react";
import { View } from "@tamagui/core";
import type { JsonValue } from "@declarative-ai/json";
import type { InputSourcesResponse, WorkflowEntry } from "@jaira/shared/browser";
import { useNewTaskForm } from "@jaira/ui/newTaskModel";
import { runInputsOf, type RunField, type RunSources, type RunValues } from "@jaira/ui/runForm";
import { Txt, type FontSpec } from "../../primitives";
import { useTokens } from "../../tokens";
import { useEnterSubmits } from "../form/useEnterSubmits";
import { Button } from "../settings/Button";
import { SelectInput } from "../settings/fields";
import { RunInputs } from "./RunPanel";

/**
 * The New-task form, a panel root in the Tasks room — pick a workflow, fill in what it declares, create.
 * What it decides is `newTaskModel.ts`'s (`useNewTaskForm`). How it looks:
 *
 *   the form           column, gap 10, padding 2 2 12
 *   a field            column, gap 4; its name app 11/12.5, --dim, 0.04em, upper
 *   the inputs         column, gap 8
 *   a notice           bad or warn: --tint-bad / --tint-warn, radius --control-radius, padding 7 9,
 *                      app 11/12.5
 *   the actions        row, centred, wrapping, gap 6: Create (primary), Cancel (ghost), why it is off
 */
export function NewTaskForm({
  workflows,
  forms,
  values,
  sources,
  busy,
  onPick,
  onChange,
  onCreate,
  onDone,
}: {
  workflows: WorkflowEntry[];
  forms: Record<string, RunField[] | null>;
  values: Record<string, RunValues>;
  sources: Record<string, InputSourcesResponse>;
  busy: boolean;
  onPick: (stateId: string) => void;
  onChange: (stateId: string, values: RunValues) => void;
  onCreate: (workflow: string, inputs: Record<string, JsonValue>, sources: RunSources) => void;
  onDone: () => void;
}): JSX.Element {
  const { workflow, pick, picked, errors, fields, form, from, fromTask, check, touched, touch, blocked, filled } = useNewTaskForm({ workflows, forms, values, sources, busy, onPick });
  const sub: FontSpec = { voice: "app", scale: 11 / 12.5, color: "dim" };
  const create = (): void => {
    if (blocked !== null) return;
    onCreate(workflow, runInputsOf(fields ?? [], form, from), from);
    // The boxes are held in the store per state id, so starting another finds what was typed.
    onDone();
  };
  // A form's implicit submission: Enter in one of its boxes creates the task.
  const box = useEnterSubmits(create);
  return (
    <View ref={box as never} flexDirection="column" gap={10} paddingTop={2} paddingHorizontal={2} paddingBottom={12}>
      <View flexDirection="column" gap={4}>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, ls: 0.04, upper: true, color: "dim" }}>Workflow</Txt>
        <SelectInput value={workflow} options={[["choose a workflow…", ""], ...workflows.map((entry): [string, string] => [entry.label ?? entry.rootId, entry.rootId])]} onChange={pick} />
      </View>
      {picked?.loadError !== undefined ? (
        <Notice tone="bad">{picked.loadError}</Notice>
      ) : errors > 0 ? (
        <Notice tone="warn">
          {errors} validation error{errors === 1 ? "" : "s"} — it will start, and probably fail.
        </Notice>
      ) : null}
      {workflow.length === 0 ? (
        <Txt spec={sub}>Its inputs appear here.</Txt>
      ) : fields === undefined ? (
        <Txt spec={sub}>reading its inputs…</Txt>
      ) : fields === null ? (
        <Notice tone="bad">That workflow&apos;s file does not parse, so its inputs cannot be read.</Notice>
      ) : fields.length === 0 ? (
        <Txt spec={sub}>This workflow declares no inputs.</Txt>
      ) : (
        <View flexDirection="column" gap={8}>
          <RunInputs fields={fields} values={form} check={check} touched={touched} touch={touch} onChange={(next) => onChange(workflow, next)} sources={fromTask} />
        </View>
      )}
      <View flexDirection="row" alignItems="center" gap={6} flexWrap="wrap">
        <Button kind="primary" disabled={blocked !== null} title={blocked !== null && blocked.length > 0 ? blocked : `creates ${workflow}`} onPress={create}>
          Create
        </Button>
        <Button kind="ghost" onPress={onDone}>
          Cancel
        </Button>
        {blocked !== null ? (
          blocked.length > 0 ? (
            <Txt spec={sub} ellip flexShrink={1} minWidth={0}>
              {blocked}
            </Txt>
          ) : null
        ) : filled.length > 0 ? (
          <Txt spec={sub} ellip flexShrink={1} minWidth={0}>
            {filled.length} input{filled.length === 1 ? "" : "s"}
          </Txt>
        ) : null}
      </View>
    </View>
  );
}

/** A notice, bad or warn: a sentence on a tinted ground. */
function Notice({ tone, children }: { tone: "warn" | "bad"; children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View backgroundColor={t.v(tone === "bad" ? "tint-bad" : "tint-warn") as never} borderRadius={t.v("control-radius") as never} paddingVertical={7} paddingHorizontal={9}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: tone }}>{children}</Txt>
    </View>
  );
}
