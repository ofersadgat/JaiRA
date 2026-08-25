/**
 * Every human-facing surface the app can put on screen, as data (DESIGN §11.3).
 *
 * The Debug view runs a workflow against itself; this is the other half of the same question — *does
 * the thing a workflow parks at actually render?* A UI state's whole visible behaviour comes from a
 * config an author wrote inside a state file, and until now the only way to see one was to author
 * that file, start a run and wait for the engine to reach it. Three steps, any of which can be the
 * broken one, to answer a question about the last.
 *
 * So each surface is described here once: what it is called, what it is for, the schema its config
 * answers to, and a config that exercises it. The gallery in the renderer walks this list, hands
 * each entry's config through `parseComponentConfig` — the same call main makes — and renders the
 * real dialog with the result. Nothing is mocked but the run.
 *
 * ## Why the schemas are registered but not pickable
 *
 * A component config is a FRAGMENT of a state file (`operation.args`, flat — see `components.ts`),
 * never a file of its own. It still needs to be in the registry, because that is what
 * `schema:validate` resolves an id through; it must not be in the picker, because none of these is
 * ever the answer to "what schema is this `.json` file". Hence {@link SchemaEntry.pickable}.
 *
 * ## Three kinds, because there are three ways a person is interrupted
 *
 * An `interaction` is an authored gate — a workflow state whose operation names a component. An
 * `approval` is policy escalating a tool call, and a `question` is a running agent asking one. Only
 * the first is a component in hw's sense; the other two are dialogs JaiRA raises on its own, share
 * the same inbox, and belong in a gallery of "what can appear in front of you" for that reason.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { Changeset } from "./changeset";
import { COMPONENT_NAMES, type ComponentName } from "./components";
import { registerSchema, type SchemaDoc } from "./schemas";

/** What raises the surface — see the module note. */
export type GalleryKind = "interaction" | "approval" | "question";

export interface GallerySurface {
  /** Stable id: the registered function name for a component, else what the dialog is called. */
  id: string;
  kind: GalleryKind;
  /** Heading, in the app's own words rather than the wire's. */
  title: string;
  /** One or two sentences: what it is for, and what an answer to it means. */
  blurb: string;
  /**
   * The registered function name, for `interaction` surfaces.
   *
   * Deliberately a plain string rather than {@link ComponentName}: one entry exists precisely to
   * name a function that is NOT built in, which is how the raw-JSON fallback gets on screen.
   */
  component?: string;
  /** The schema its editable document answers to. `null` ⇒ freeform JSON, no contract to hold. */
  schemaId: string | null;
  /**
   * The editable document, seeded.
   *
   * For an `interaction` this is the authored config — `operation.args`, flat, exactly as it would
   * appear in a state file. For the other two it is the request the dialog was raised with, minus
   * the routing fields (`requestId`, `project`, `at`) which the gallery supplies.
   */
  sample: JsonValue;
  /**
   * The state's other resolved inputs — what the component reads BESIDES its config.
   *
   * `review_artifact` shows one, `edit_artifact` seeds an editor from one, and the changeset gate
   * finds its changeset among them by shape. A component that reads none declares none.
   */
  inputs?: Record<string, JsonValue>;
}

// --- schema helpers ----------------------------------------------------------

/**
 * These are ordinary JSON Schema, and unlike `schemas.ts`'s they are strict.
 *
 * The reason the state schemas are permissive does not apply here: a state file's every value may
 * arrive as a `$ref` or an `expr`, so a leaf that demanded a string would flag the format's own
 * idiom. A gallery document is literal by construction — nothing resolves it — so a wrong type is
 * simply a wrong type, and saying so is the whole point of attaching a schema.
 */
const str = (title: string, description?: string): SchemaDoc => ({
  type: "string",
  title,
  ...(description === undefined ? {} : { description }),
});

const bool = (title: string, description?: string): SchemaDoc => ({
  type: "boolean",
  title,
  ...(description === undefined ? {} : { description }),
});

/** The `option` shape both decision components take (`components.ts`'s {@link ComponentOption}). */
const OPTION: SchemaDoc = {
  type: "object",
  title: "option",
  properties: {
    value: str("value", "what the state's declared output receives"),
    label: str("label", "what the button says; absent ⇒ the value"),
    description: str("description", "what choosing it means — a line under the label"),
    icon: str("icon", "a glyph beside the label, by name; an unknown name draws nothing"),
    tone: {
      type: "string",
      enum: ["default", "danger"],
      title: "tone",
      description: "danger draws it as the destructive choice",
    },
  },
  required: ["value"],
  additionalProperties: false,
};

/**
 * A list of options, in either of the two authored spellings.
 *
 * A bare string IS an option whose label is its value (`parseComponentConfig` normalizes it), and
 * that is the spelling the demo workflow and most states use — so a schema that admitted only the
 * object form would report an error against the idiom.
 */
const OPTIONS: SchemaDoc = {
  type: "array",
  title: "options",
  description: "the decision buttons, in order; a bare string is an option whose label is its value",
  minItems: 1,
  items: { anyOf: [{ type: "string" }, OPTION] },
};

const FORM_FIELD: SchemaDoc = {
  type: "object",
  title: "field",
  properties: {
    name: str("name", "the key this field's answer lands on"),
    type: {
      type: "string",
      enum: ["string", "number", "boolean", "enum"],
      title: "type",
      description: "absent ⇒ string",
    },
    label: str("label", "what the field is called on screen; absent ⇒ the name"),
    description: str("description", "a line of help under the control"),
    enum: { type: "array", title: "choices", description: "enum fields only", items: { type: "string" } },
    optional: bool("optional", "an empty answer is allowed"),
    multiline: bool("multiline", "string fields only: render a textarea"),
    default: { title: "default", description: "the value the control starts on" },
  },
  required: ["name"],
  additionalProperties: false,
};

/** A component config schema: `prompt` is universal, the rest is the component's own. */
function configSchema(title: string, description: string, properties: Record<string, SchemaDoc>): SchemaDoc {
  return {
    type: "object",
    title,
    description,
    properties: {
      prompt: str("prompt", "the question, as the person reads it — the dialog's heading"),
      ...properties,
    },
    additionalProperties: false,
  };
}

const CONFIG_SCHEMAS: Record<ComponentName, { hint: string; document: SchemaDoc; expected: readonly string[] }> = {
  choose_option: {
    hint: "a decision with named outcomes — `choose_option`'s args",
    document: configSchema("choose_option", "one decision, taken from a named set", {
      options: OPTIONS,
      comments: bool("comments", "offer a free-text note alongside the choice"),
      multiple: bool("multiple", "several options may be chosen; the answer is then a list"),
      require_confirm: bool("require_confirm", "picking holds the choice; a Confirm button sends it"),
      icon: str("icon", "a glyph beside the question; absent ⇒ a message bubble"),
    }),
    expected: ["prompt", "options"],
  },
  review_artifact: {
    hint: "a decision about something produced — `review_artifact`'s args",
    document: configSchema("review_artifact", "the same decision, shown beside what it is about", {
      artifact: str("artifact", "which of the state's inputs holds the thing to show"),
      options: OPTIONS,
      decisions: { ...OPTIONS, title: "decisions", description: "an alias for options — it reads better in a review state" },
      comments: bool("comments", "offer a free-text note alongside the choice"),
      icon: str("icon", "a glyph beside the question"),
      editable: bool("editable", "let the reviewer change the artifact; the edit rides back as content"),
    }),
    expected: ["prompt", "artifact", "options"],
  },
  edit_artifact: {
    hint: "hand the text back edited — `edit_artifact`'s args",
    document: configSchema("edit_artifact", "a person edits a document the run produced", {
      source: str("source", "the input whose content seeds the editor; absent ⇒ start empty"),
    }),
    expected: ["prompt"],
  },
  fill_form: {
    hint: "collect structured values — `fill_form`'s args",
    document: configSchema("fill_form", "several typed answers, submitted together", {
      fields: {
        type: "array",
        title: "fields",
        description: "the controls, in order — each answer lands on the field's name",
        minItems: 1,
        items: FORM_FIELD,
      },
    }),
    expected: ["prompt", "fields"],
  },
  confirm_action: {
    hint: "a yes/no with named buttons — `confirm_action`'s args",
    document: configSchema("confirm_action", "one irreversible-looking step, confirmed or not", {
      confirmLabel: str("confirmLabel", "the affirmative button; absent ⇒ Confirm"),
      cancelLabel: str("cancelLabel", "the other one; absent ⇒ Cancel"),
    }),
    expected: ["prompt"],
  },
  review_artifacts: {
    hint: "the changeset gate — `review_artifacts`'s args (CHANGESETS.md §4.1)",
    document: configSchema("review_artifacts", "every change decided, one at a time", {
      tree: {
        type: "string",
        enum: ["base", "proposal"],
        title: "tree",
        description:
          "what the files currently hold: `proposal` for a worktree an agent already edited, `base` for a sync whose edits exist only as data",
      },
    }),
    expected: ["prompt", "tree"],
  },
};

/** `schemaId` for a component's config — the id the JSON editor validates through. */
export function componentConfigSchemaId(component: ComponentName): string {
  return `component-${component}`;
}

for (const component of COMPONENT_NAMES) {
  const entry = CONFIG_SCHEMAS[component];
  registerSchema({
    id: componentConfigSchemaId(component),
    label: `${component} config`,
    hint: entry.hint,
    document: entry.document,
    expected: entry.expected,
    pickable: false,
  });
}

registerSchema({
  id: "gallery-approval",
  label: "Command approval",
  hint: "a tool call policy escalated — DESIGN §10.2",
  document: {
    type: "object",
    title: "approval",
    properties: {
      tool: str("tool", "the tool whose call was escalated"),
      command: str("command", "the command line, when the tool takes one"),
      reason: str("reason", "why policy escalated it"),
      input: { type: "object", title: "input", description: "the call's arguments, shown when there is no command line" },
    },
    required: ["tool"],
    additionalProperties: false,
  },
  expected: ["tool"],
  pickable: false,
});

registerSchema({
  id: "gallery-question",
  label: "Agent question",
  hint: "what a running agent asked (`AskUserQuestion`)",
  document: {
    type: "object",
    title: "question",
    properties: {
      questions: {
        type: "array",
        title: "questions",
        description: "asked together, answered together — a batch is one tool call",
        minItems: 1,
        items: {
          type: "object",
          title: "question",
          properties: {
            question: str("question", "the complete question"),
            header: str("header", "a short chip beside it, e.g. Library"),
            multiSelect: bool("multiSelect", "several options may be chosen; the answer is then a list"),
            options: {
              type: "array",
              title: "options",
              minItems: 1,
              items: {
                type: "object",
                title: "option",
                properties: {
                  label: str("label", "what the button says — and what the agent receives"),
                  description: str("description", "what choosing it means"),
                },
                required: ["label"],
                additionalProperties: false,
              },
            },
          },
          required: ["question", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
  expected: ["questions"],
  pickable: false,
});

registerSchema({
  id: "gallery-unknown-function",
  label: "An unrecognised gate",
  hint: "a function that is not a built-in component — what the fallback renders for",
  document: {
    type: "object",
    title: "gate",
    properties: {
      function: str("function", "the state's `operation.function`, as authored"),
    },
    required: ["function"],
    additionalProperties: false,
  },
  expected: ["function"],
  pickable: false,
});

// --- the fixtures ------------------------------------------------------------

/** The document `review_artifact` shows and `edit_artifact` seeds its editor from. */
export const GALLERY_DOCUMENT = [
  "# Plan: cache the availability probe",
  "",
  "The probe runs on open, on every configuration write, and on demand. The third is the only one a",
  "person waits for, so the other two should not be able to make it slow.",
  "",
  "1. Keep the last snapshot with the time it was taken.",
  "2. Answer from it while it is younger than the interval.",
  "3. Re-probe in the background when it is not.",
].join("\n");

/**
 * A changeset the gate can be shown without a run behind it.
 *
 * Content lives INLINE on each change (`before`/`after`), which is what makes an offline preview
 * honest rather than a mock: the reviewer reads exactly what it reads in a real review. The only
 * thing it cannot do here is the drift check, which reads the files through `readUri` — and a
 * read that fails is already the silent case (see `readCurrent`), so a gallery host supplying no
 * reader gets no badges rather than a wrong one.
 */
export const GALLERY_CHANGESET: Changeset = {
  // A real address, pinned — `changesetOf` refuses one nothing could resolve, and a gallery that
  // dodged that check would be demonstrating a value the engine would reject.
  source: "git:4f3a2b1c9d8e7f60a1b2c3d4e5f60718293a4b5c",
  changes: [
    {
      id: "c1",
      path: "src/availability.ts",
      action: "update",
      reason: "answer from the cached snapshot while it is young enough",
      before: [
        "export async function availability(): Promise<Snapshot> {",
        "  return await probeEverything();",
        "}",
      ].join("\n"),
      after: [
        "export async function availability(): Promise<Snapshot> {",
        "  if (cached !== null && Date.now() - cached.checkedAt < INTERVAL) return cached;",
        "  cached = await probeEverything();",
        "  return cached;",
        "}",
      ].join("\n"),
      // Real hunks, because the reviewer renders the STORED ones and derives nothing. Without them
      // the offline preview showed the before-text with no marks at all — a picture of a diff
      // viewer that cannot show a diff, which is the one thing the gallery exists to catch.
      hunks: [
        {
          id: "h1",
          start: 58,
          end: 91,
          text: [
            "  if (cached !== null && Date.now() - cached.checkedAt < INTERVAL) return cached;",
            "  cached = await probeEverything();",
            "  return cached;",
          ].join("\n"),
        },
      ],
    },
    {
      id: "c2",
      path: "src/availabilityCache.ts",
      action: "create",
      reason: "somewhere to keep it",
      after: ["let cached: Snapshot | null = null;", "", "export const INTERVAL = 30_000;"].join("\n"),
    },
    {
      id: "c3",
      path: "docs/legacy-probe.md",
      action: "delete",
      reason: "describes the probe that no longer exists",
      before: "The probe runs on every read.\n",
    },
    {
      id: "c4",
      path: "assets/icon.png",
      action: "update",
      unshowable: "binary",
      reason: "a change you can decide but not read — the case worth seeing in a gallery",
    },
  ],
};

// --- the surfaces ------------------------------------------------------------

export const GALLERY_SURFACES: readonly GallerySurface[] = [
  {
    id: "choose_option",
    kind: "interaction",
    component: "choose_option",
    title: "Choose an option",
    blurb:
      "One decision, taken from a set the state names. The answer lands as `decision`, which is why the state's declared output usually carries the same enum. The SAME control draws a running agent's question — the two differ in where the answer goes and in nothing you can see (decision 0002).",
    schemaId: componentConfigSchemaId("choose_option"),
    sample: {
      prompt: "Pick a direction for the plan.",
      options: [
        { value: "approve", description: "the plan goes forward as written", icon: "check" },
        { value: "request_changes", description: "back to the model with your note", icon: "comment" },
        { value: "block", description: "nothing downstream is built", tone: "danger", icon: "cross" },
      ],
      comments: true,
    },
  },
  {
    id: "review_artifact",
    kind: "interaction",
    component: "review_artifact",
    title: "Review an artifact",
    blurb:
      "The same decision, shown beside the thing it is about. `artifact` names the input to display — a decision about something you cannot see is the failure this component exists to prevent.",
    schemaId: componentConfigSchemaId("review_artifact"),
    sample: {
      prompt: "Review the plan document.",
      artifact: "plan_doc",
      decisions: ["approve", { value: "reject", tone: "danger" }],
      comments: true,
      editable: true,
    },
    inputs: { plan_doc: GALLERY_DOCUMENT },
  },
  {
    id: "edit_artifact",
    kind: "interaction",
    component: "edit_artifact",
    title: "Edit an artifact",
    blurb:
      "A person edits what the run produced and hands it back as `content`. `source` seeds the editor from an input; without one the editor starts empty.",
    schemaId: componentConfigSchemaId("edit_artifact"),
    sample: { prompt: "Tidy up the plan.", source: "plan_doc" },
    inputs: { plan_doc: GALLERY_DOCUMENT },
  },
  {
    id: "fill_form",
    kind: "interaction",
    component: "fill_form",
    title: "Fill in a form",
    blurb:
      "Several typed answers, submitted together. Each answer lands on its field's name, so the field list and the state's declared outputs are two spellings of one contract.",
    schemaId: componentConfigSchemaId("fill_form"),
    sample: {
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
  {
    id: "confirm_action",
    kind: "interaction",
    component: "confirm_action",
    title: "Confirm an action",
    blurb: "A yes/no whose buttons say what they do. The answer is `confirmed`, and nothing else.",
    schemaId: componentConfigSchemaId("confirm_action"),
    sample: { prompt: "Merge the plan into main?", confirmLabel: "Merge", cancelLabel: "Not yet" },
  },
  {
    id: "review_artifacts",
    kind: "interaction",
    component: "review_artifacts",
    title: "Review a set of artifacts",
    blurb:
      "N artifacts, each decided — today's case being a changeset (CHANGESETS.md §4.1). It finds its changeset among the state's inputs BY SHAPE — no config field names it — and returns a decision per change.",
    schemaId: componentConfigSchemaId("review_artifacts"),
    sample: { prompt: "Review the proposed changes.", tree: "proposal" },
    inputs: { changeset: GALLERY_CHANGESET as unknown as JsonValue },
  },
  {
    id: "unknown-function",
    kind: "interaction",
    component: "unknown_function",
    title: "A gate JaiRA does not know",
    blurb:
      "The fallback, and NOT a real component: `unknown_function` is a name nothing implements. A UI state whose function is not a built-in still parks and still has to be answerable, so you get a JSON box — the honest offer when nothing declares what the answer should look like, and what a typo in `operation.function` looks like from here.",
    schemaId: "gallery-unknown-function",
    sample: { function: "unknown_function" },
  },
  {
    id: "approval",
    kind: "approval",
    title: "Approve a command",
    blurb:
      "Not a workflow gate: policy escalated a tool call, so what is judged is a command and the answer carries a SCOPE — the reason you are not asked again on the next call (DESIGN §10.2).",
    schemaId: "gallery-approval",
    sample: {
      tool: "Bash",
      command: "rm -rf build && npm run build",
      reason: "`rm -rf` is not on the allow list for this profile",
      input: { command: "rm -rf build && npm run build", cwd: "/repo" },
    },
  },
  {
    id: "question",
    kind: "question",
    title: "Answer an agent's question",
    blurb:
      "A running agent asked something (`AskUserQuestion`). Nothing is being authorized — the options are the agent's own and the answer travels back as its tool input, so a question is answered, never approved.",
    schemaId: "gallery-question",
    sample: {
      questions: [
        {
          question: "Which cache interval should the probe use?",
          header: "Interval",
          options: [
            { label: "30 seconds", description: "Fresh enough that a settings change is visible almost at once." },
            { label: "5 minutes", description: "Cheaper, at the cost of a stale badge after a write." },
          ],
        },
      ],
    },
  },
];
