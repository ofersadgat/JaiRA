/**
 * A workflow that exercises every built-in UI component (SPEC §8.1).
 *
 * Its purpose is verification and demonstration: the five gates run one at a time
 * with no LLM involved, so the components can be driven — by a script, or by hand
 * in the app — without spending anything. Each state declares outputs matching its
 * component's result contract, which is also how those contracts stay honest.
 *
 * **Why each gate takes the previous one's output as an input.** A `sequence` is a
 * *cursor*, not a barrier: the engine enters the next member as soon as the
 * previous one has a record, so children with no data dependency between them run
 * concurrently and every gate would park at once. Ordering is dataflow-driven
 * (SPEC §10.4) — a child whose inputs reference an unresolved sibling's outputs
 * parks until they resolve. Threading `previous` through the chain is therefore
 * what makes these gates strictly sequential, and it is the same mechanism the
 * SPEC §9 planning workflow relies on (context needs goals).
 */
export const COMPONENTS_ID = "components";

export function componentsWorkflowFiles(): Record<string, unknown> {
  const artifact = { kind: "blob", schema: { type: "string", contentMediaType: "markdown" } };
  return {
    components: {
      label: "UI Components",
      inputs: { doc: artifact },
      outputs: {
        decision: { schema: { type: "string" }, binding: { child: "choose", output: "decision" } },
        review: { schema: { type: "string" }, binding: { child: "review", output: "decision" } },
        edited: { ...artifact, binding: { child: "edit", output: "content" } },
        severity: { schema: { type: "string" }, binding: { child: "form", output: "severity" } },
        confirmed: { schema: { type: "boolean" }, binding: { child: "confirm", output: "confirmed" } },
      },
      children: {
        choose: { state: "components/choose" },
        review: {
          state: "components/review",
          inputs: { plan_doc: { input: "doc" }, previous: { child: "choose", output: "decision" } },
        },
        edit: {
          state: "components/edit",
          inputs: { plan_doc: { input: "doc" }, previous: { child: "review", output: "decision" } },
        },
        form: { state: "components/form", inputs: { previous: { child: "edit", output: "content" } } },
        confirm: { state: "components/confirm", inputs: { previous: { child: "form", output: "severity" } } },
      },
      sequence: ["choose", "review", "edit", "form", "confirm"],
    },
    "components/choose": {
      label: "Choose an option",
      outputs: {
        decision: { schema: { type: "string", enum: ["approve", "request_changes", "block"] } },
        comments: { schema: { type: "string" }, optional: true },
      },
      operation: {
        kind: "function",
        function: "choose_option",
        config: {
          prompt: "Pick a direction for the plan.",
          options: ["approve", "request_changes", { value: "block", tone: "danger" }],
          comments: true,
        },
      },
    },
    "components/review": {
      label: "Review the artifact",
      inputs: { plan_doc: artifact, previous: { schema: { type: "string" } } },
      outputs: {
        decision: { schema: { type: "string", enum: ["approve", "reject"] } },
        comments: { schema: { type: "string" }, optional: true },
      },
      operation: {
        kind: "function",
        function: "review_artifact",
        config: {
          prompt: "Review the plan document.",
          artifact: "plan_doc",
          decisions: ["approve", { value: "reject", tone: "danger" }],
          comments: true,
        },
      },
    },
    "components/edit": {
      label: "Edit the markdown",
      inputs: { plan_doc: artifact, previous: { schema: { type: "string" } } },
      outputs: { content: artifact },
      operation: {
        kind: "function",
        function: "edit_markdown",
        config: { prompt: "Tidy up the plan.", source: "plan_doc" },
      },
    },
    "components/form": {
      label: "Fill in the form",
      inputs: { previous: artifact },
      outputs: {
        title: { schema: { type: "string" } },
        severity: { schema: { type: "string", enum: ["minor", "significant", "critical"] } },
        estimate: { schema: { type: "number" } },
        blocking: { schema: { type: "boolean" }, optional: true },
        notes: { schema: { type: "string" }, optional: true },
      },
      operation: {
        kind: "function",
        function: "fill_form",
        config: {
          prompt: "Describe the follow-up.",
          fields: [
            { name: "title", label: "Title" },
            { name: "severity", type: "enum", enum: ["minor", "significant", "critical"], label: "Severity" },
            { name: "estimate", type: "number", label: "Estimate (days)" },
            { name: "blocking", type: "boolean", label: "Blocking?", optional: true },
            { name: "notes", type: "string", multiline: true, optional: true, description: "Anything else" },
          ],
        },
      },
    },
    "components/confirm": {
      label: "Confirm",
      inputs: { previous: { schema: { type: "string" } } },
      outputs: { confirmed: { schema: { type: "boolean" } } },
      operation: {
        kind: "function",
        function: "confirm_action",
        config: { prompt: "Merge the plan into main?", confirmLabel: "Merge", cancelLabel: "Not yet" },
      },
    },
  };
}
