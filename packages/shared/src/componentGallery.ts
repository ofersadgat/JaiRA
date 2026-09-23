/**
 * Every human-facing surface the app can put on screen, as data (DESIGN §11.4).
 *
 * The Debug view runs a workflow against itself; the Components view is the other half of the same
 * question — *does the thing a workflow parks at actually render?* A UI state's whole visible
 * behaviour comes from a config an author wrote inside a state file, and until now the only way to
 * see one was to author that file, start a run and wait for the engine to reach it. Three steps,
 * any of which can be the broken one, to answer a question about the last.
 *
 * So each surface is described here once: what it is called, what it is for, the schema its config
 * answers to, and the configs that exercise it — a GROUP per surface, a VARIANT per thing its
 * config can express, because one sample of a `fill_form` shows one form and the contract is a
 * small language. The gallery in the renderer walks this list, hands each variant's config through
 * `parseComponentConfig` — the same call main makes — and renders the real dialog with the result.
 * Nothing is mocked but the run.
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
import type { ReviewNote } from "./reviewNotes";
import { registerSchema, type SchemaDoc } from "./schemas";

/** What raises the surface — see the module note. */
export type GalleryKind = "interaction" | "approval" | "question";

/** One configuration of a surface — a card, and the thing a variant's `note` is about. */
export interface GalleryVariant {
  /** Stable within its group: `plain`, `comments`, `custom`… */
  id: string;
  /** What this variation is, in a few words. */
  title: string;
  /** What it turns on that the others do not, and what to look for. */
  note: string;
  /** The editable document, seeded — see {@link GallerySurface.sample}. */
  sample: JsonValue;
  /** The state's other resolved inputs — see {@link GallerySurface.inputs}. */
  inputs?: Record<string, JsonValue>;
  /** What the forge has said, for a gate with a second door — see {@link GallerySurface.forge}. */
  forge?: GalleryForge;
}

/**
 * What a forge has said about a gate's merge request, as the gallery pretends it.
 *
 * A live gate hears this from main, which polls the forge; the gallery has no main to ask (its
 * project is a placeholder), so the card answers the gate's `remote.status` from this instead.
 */
export interface GalleryForge {
  /** Who has commented there, in order of first appearance. */
  commenters: string[];
  /** The threads the forge holds, by change id — laid over the reviewer's own notes. */
  notes?: Record<string, ReviewNote[]>;
  /** A quiet window is running: it ends `settle_after` after the card is drawn. */
  settling?: boolean;
}

/** One surface and everything its config can express. */
export interface GalleryGroup {
  /** Stable id: the registered function name for a component, else what the dialog is called. */
  id: string;
  kind: GalleryKind;
  /** Heading, in the app's own words rather than the wire's. */
  title: string;
  /** One or two sentences: what it is for, and what an answer to it means. */
  blurb: string;
  /** The registered function name, for `interaction` groups — see {@link GallerySurface.component}. */
  component?: string;
  /** The schema every variant's document answers to. `null` ⇒ freeform JSON. */
  schemaId: string | null;
  variants: readonly GalleryVariant[];
}

/**
 * One card: a group's variant, flattened with what the card needs from the group.
 *
 * The unit the renderer draws and the tests walk. {@link GALLERY_SURFACES} is derived from
 * {@link GALLERY_GROUPS}, so nothing is declared twice.
 */
export interface GallerySurface {
  /** `group/variant` — unique across the gallery, and readable in a request id. */
  id: string;
  group: string;
  variant: string;
  kind: GalleryKind;
  /** The variant's heading. */
  title: string;
  /** What this variation shows — the variant's note. */
  note: string;
  /** The group's one or two sentences: what the surface is for, and what an answer to it means. */
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
  /** What the forge has said about the request, for a card whose gate has a `remote`. */
  forge?: GalleryForge;
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
    custom: bool("custom", "enum fields only: the values are suggestions — the box offers them and takes any other text"),
    default: { title: "default", description: "the value the control starts on" },
  },
  required: ["name"],
  additionalProperties: false,
};

/** One part of a multi-part `choose_option` (`components.ts`'s {@link ChoiceQuestion}). */
const CHOICE_QUESTION: SchemaDoc = {
  type: "object",
  title: "question",
  properties: {
    name: str("name", "the key this question's answer lands on, under `answers`"),
    question: str("question", "the complete question, as the person reads it"),
    header: str("header", "a short chip beside it, e.g. Library"),
    description: str("description", "why it is asked, or what each answer would change — a line under the question"),
    options: { ...OPTIONS, description: "the choices, in order; absent only with custom — the question is then answered in the person's own words" },
    multiple: bool("multiple", "several options may be chosen; the answer is then a list"),
    custom: bool("custom", "offer an own-answer box; any non-empty string is then accepted"),
    optional: bool("optional", "may be left unanswered; the key is then absent"),
    default: str("default", "the option pre-picked when the question appears; must be one of the options"),
    schema: {
      type: ["object", "boolean"],
      title: "schema",
      description:
        "the answer is a VALUE of this JSON Schema: a pick or an own answer is read as one (text where it takes text, JSON otherwise) and must satisfy it before the step confirms; an option's value is the value's words",
    },
  },
  required: ["name", "question"],
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
    document: configSchema("choose_option", "one decision, taken from a named set — or several, asked in steps", {
      options: OPTIONS,
      comments: bool("comments", "offer a free-text note alongside the choice"),
      multiple: bool("multiple", "several options may be chosen; the answer is then a list"),
      require_confirm: bool("require_confirm", "picking holds the choice; a Confirm button sends it"),
      custom: bool("custom", "offer an own-answer box instead of the options; exclusive with comments"),
      questions: {
        type: "array",
        title: "questions",
        description:
          "several questions in one gate, asked one at a time; replaces options, and the answer is { answers } keyed by name",
        minItems: 1,
        items: CHOICE_QUESTION,
      },
      follow_up: bool(
        "follow_up",
        "with questions only: after each round of answers a model asks what they opened, as another round of this gate, until it has nothing to ask; the state gets every round's answers in one answers",
      ),
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
      details: {
        type: "array",
        title: "details",
        description: "what EXACTLY is being confirmed, as label/value rows under the prompt — for an action whose consequences are not in its name",
        items: { type: "object", properties: { label: str("label"), value: str("value") }, required: ["label", "value"], additionalProperties: false },
      },
      options: {
        ...OPTIONS,
        description: "other ways of saying YES, each a button between confirm and cancel; choosing one answers `confirmed: true` with `choice` set to its value",
      },
    }),
    expected: ["prompt"],
  },
  approve_tool_call: {
    hint: "the approval prompt a permission function calls — `approve_tool_call`'s args",
    document: configSchema("approve_tool_call", "a tool call, allowed or denied by the person — what it shows is its `request` input", {}),
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
      // The review-level vocabulary, on the plural exactly as on the singular (decision 0002). The
      // schema lacked it while the parser took it — which the gallery's routed card is what caught.
      options: {
        ...OPTIONS,
        description: "the review-level decision beside the per-change ones; absent ⇒ one Submit and the changes carry the answer",
      },
      decisions: { ...OPTIONS, title: "decisions", description: "an alias for options — it reads better in a review state" },
      // The gate's second door (decision 0004). Usually not written here at all: a root state makes one
      // the default for every review below it, under `environment.functions.review_artifacts.args`.
      remote: {
        type: ["object", "null"],
        title: "remote",
        description:
          "also open this review as a merge request, and let whichever side settles first answer the state. `null` opts out of a remote the environment would otherwise supply. `{ \"$ref\": \"review\", … }` carries the same request across a loop's rounds (NAMES.md)",
        properties: {
          to: str("to", "which git remote to push to; its host picks the connection. Absent ⇒ the project's only remote"),
          target: str("target", "the branch the request asks to merge into. Absent ⇒ the task's base branch"),
          settle_after: str("settle_after", "the quiet window after a comment — 10m, 2h, 0. Absent ⇒ Settings → Integrations"),
          draft: bool("draft", "open the request as a draft"),
          title: str("title", "what the request is called. Absent ⇒ the task's title"),
          description: str("description", "what the request says. Absent ⇒ the prompt and what is in the set"),
          workspace: str("workspace", "which worktree is pushed. Absent ⇒ the state's own"),
          // Filled in by the host once the gate has parked — where the request lives.
          provider: str("provider"),
          host: str("host"),
          project: str("project"),
          branch: str("branch"),
          number: { type: "number", title: "number" },
          url: str("url"),
          id: str("id"),
          key: str("key"),
        },
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
      parts: { type: "object", title: "parts", description: "a shell line as the requests it is made of: `CommandApproval`, exactly as the policy produces it (decision 0007 §4)" },
      toolset: { type: "object", title: "toolset", description: "the toolset that asked and the layers a line could be written into: `ApprovalToolset`" },
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

/** The questions a phase's `ask` state puts to a person, in the multi-part gate's own shape. */
const PRODUCT_QUESTIONS: JsonValue[] = [
  {
    name: "chat-run-order__canceled-sort",
    question: "Should a conversation you stopped yourself sort with the unsettled ones, or with the finished ones?",
    header: "Sort",
    description:
      'The brief says "uncompleted first", which puts it above; the spec puts it below, on the argument that you already know about a thread you ended.',
    options: [
      { value: "above, as the brief says", description: "one predicate member; the brief is honoured to the letter" },
      { value: "below, with the finished", description: "you ended it, so you can find it by name" },
    ],
    default: "below, with the finished",
    custom: true,
    optional: true,
  },
  {
    name: "chat-run-order__group-boundary",
    question: "Should the Chat list draw a visible boundary between the unsettled and settled rows, or only re-sort them?",
    header: "Boundary",
    description: "Drawn, it needs a rule line and two group names the board has no word for; undrawn, one design decision disappears.",
    options: ["draw a boundary", "sort only, draw nothing"],
    default: "draw a boundary",
    custom: true,
    optional: true,
  },
  {
    name: "tasks-workflow-index__row-counts",
    question: "Should each workflow row carry a task count and status roll-up, or just the workflow's name?",
    header: "Rows",
    options: [
      { value: "count and status roll-up", description: 'a row answers "where does my work stand" without opening it' },
      { value: "name only", description: "the board one click away carries the numbers" },
    ],
    custom: true,
    optional: true,
  },
];

/**
 * The variant ids, in the order the gallery's top bar lists them — and the vocabulary they come from.
 *
 * A variant id is SHARED across groups on purpose: `comments` on a chooser and `comments` on a
 * review are the same knob seen from two components, and `steps` is an agent's batch and a gate's
 * `questions` — the same stepper. That is what lets one button slide every row to the same
 * variation, which is how the two are compared. `basic` is every group's plainest form, so the bar
 * always has somewhere to send every row.
 */
export const GALLERY_VARIANT_ORDER: readonly string[] = [
  "basic",
  "comments",
  "custom",
  "multiple",
  "steps",
  "follow_up",
  "typed",
  "confirm",
  "defaults",
  "editable",
  "routed",
  "base",
  // A review that is also a merge request (decision 0004), seen from the two components it touches:
  // the gate with its second door, and the question that door asks before anything is published.
  "remote",
  // A shell line some of whose parts a permission FUNCTION decided (decision 0007, amended 2026-09-22).
  "function",
  "input",
  "empty",
];

/**
 * Every surface, grouped by what raises it, each with the VARIATIONS its config can express.
 *
 * One group per component (and per dialog), because that is the unit an author reasons in; several
 * cards per group, because a component's config is a small language and a single sample shows one
 * sentence of it. The variants are chosen to cover the knobs rather than to be pretty: each one
 * turns on something `basic` left off, so reading a group across is reading the contract.
 */
export const GALLERY_GROUPS: readonly GalleryGroup[] = [
  {
    id: "choose_option",
    kind: "interaction",
    component: "choose_option",
    title: "Choose an option",
    blurb:
      "One decision, taken from a set the state names. The answer lands as `decision`, which is why the state's declared output usually carries the same enum. The SAME control draws a running agent's question — the two differ in where the answer goes and in nothing you can see (decision 0002).",
    schemaId: componentConfigSchemaId("choose_option"),
    variants: [
      {
        id: "basic",
        title: "One tap",
        note: "A single-select with no free text answers on the click. Descriptions, icons and a `danger` tone are the option's own to declare.",
        sample: {
          prompt: "Pick a direction for the plan.",
          options: [
            { value: "approve", description: "the plan goes forward as written", icon: "check" },
            { value: "request_changes", description: "back to the model with your note", icon: "comment" },
            { value: "block", description: "nothing downstream is built", tone: "danger", icon: "cross" },
          ],
        },
      },
      {
        id: "comments",
        title: "With a comment",
        note: "`comments: true` adds an ALONGSIDE box: said in addition to the pick, so the click still answers even with text in it.",
        sample: {
          prompt: "Pick a direction for the plan.",
          options: ["approve", "request_changes", { value: "block", tone: "danger" }],
          comments: true,
        },
      },
      {
        id: "custom",
        title: "With an answer of your own",
        note: '`custom: true` adds an INSTEAD box — the agent caller\'s "Other", on a gate. Typing overrides the pick, the answer waits for Confirm, and `decision` may then be any non-empty string.',
        sample: {
          prompt: "Which cache interval should the probe use?",
          options: [
            { value: "30 seconds", description: "fresh enough that a settings change is visible almost at once" },
            { value: "5 minutes", description: "cheaper, at the cost of a stale badge after a write" },
          ],
          custom: true,
        },
      },
      {
        id: "multiple",
        title: "Several at once",
        note: "`multiple: true` makes each option a checkbox and `decision` a list — checked for declared members, no repeats, and never empty.",
        sample: {
          prompt: "Which lenses should the critique apply?",
          options: [
            { value: "product", description: "does it serve the person named in the brief" },
            { value: "engineering", description: "can it be built as described" },
            { value: "documentation", description: "does the doc say what the thing does" },
          ],
          multiple: true,
        },
      },
      {
        id: "confirm",
        title: "Held until confirmed",
        note: "`require_confirm: true` keeps a single-select from answering on the click — for the decision where a mis-click is expensive.",
        sample: {
          prompt: "Delete the worktree and everything in it?",
          icon: "alert",
          options: [{ value: "keep" }, { value: "delete", tone: "danger", description: "not recoverable" }],
          require_confirm: true,
        },
      },
      {
        id: "steps",
        title: "Several questions, one at a time",
        note: "`questions` replaces `options`: each part is its own question with its own options, asked in steps, and the answer is `{ answers }` keyed by `name`. A `default` is pre-picked, `custom` offers an own answer, and `optional` lets a step be passed — the shape a phase's product questions take.",
        sample: {
          prompt: "The product questions the spec cannot answer from the repo.",
          questions: PRODUCT_QUESTIONS,
        },
      },
      {
        id: "follow_up",
        title: "With follow-up questions",
        note: "`follow_up: true` is the state's decision, not the person's: nothing on screen differs. On submit the gate is held while a model reads the answers (and the state's other inputs as context) and asks what they opened; those come back as another round of this same gate, until the model has nothing to ask, and the state gets every round's answers in one `answers`.",
        sample: {
          prompt: "The product questions the spec cannot answer from the repo.",
          questions: PRODUCT_QUESTIONS,
          follow_up: true,
        },
      },
      {
        id: "typed",
        title: "Typed answers",
        note: "`schema` on a question makes its answer a VALUE of that schema rather than a word: a pick or an own answer is read as one (text where the schema takes text, JSON otherwise), and the step holds, saying why, until the schema accepts it. A question with `custom` and no `options` is answered in the person's own words alone — the shape a move's input question takes.",
        sample: {
          prompt: "Moving 'Forge event sources' to explore needs 3 inputs",
          questions: [
            { name: "question", header: "question", question: "What to find out, in a sentence.", custom: true, schema: { type: "string", minLength: 1 } },
            { name: "depth", header: "depth", question: "How many rounds of looking before a verdict.", options: ["1", "2", "3"], default: "2", schema: { type: "integer", enum: [1, 2, 3] } },
            { name: "sources", header: "sources", question: "Where to look, as a list of forge names.", custom: true, optional: true, schema: { type: "array", items: { type: "string" } } },
          ],
        },
      },
    ],
  },
  {
    id: "review_artifact",
    kind: "interaction",
    component: "review_artifact",
    title: "Review an artifact",
    blurb:
      "The same decision, shown beside the thing it is about. `artifact` names the input to display — a decision about something you cannot see is the failure this component exists to prevent.",
    schemaId: componentConfigSchemaId("review_artifact"),
    variants: [
      {
        id: "basic",
        title: "Read and decide",
        note: "The artifact above, a decision row at the bottom, and nothing to type. Select a passage to leave an anchored note.",
        sample: { prompt: "Review the plan document.", artifact: "plan_doc", decisions: ["approve", { value: "reject", tone: "danger" }] },
        inputs: { plan_doc: GALLERY_DOCUMENT },
      },
      {
        id: "comments",
        title: "With a review-level comment",
        note: "`comments: true` puts the box FIRST here — the options are a row at the very bottom, and a comment under them would be typed after the click that already submitted. Text in it changes the footer: a review with something to say goes back.",
        sample: { prompt: "Review the plan document.", artifact: "plan_doc", decisions: ["approve", "reject"], comments: true },
        inputs: { plan_doc: GALLERY_DOCUMENT },
      },
      {
        id: "editable",
        title: "Editable",
        note: '`editable: true` turns the same pane writable: "approve this, but with that word fixed" is one gesture, and the edit rides back as `content` only when it differs from what arrived.',
        sample: {
          prompt: "Review the plan document.",
          artifact: "plan_doc",
          decisions: ["approve", { value: "reject", tone: "danger" }],
          comments: true,
          editable: true,
        },
        inputs: { plan_doc: GALLERY_DOCUMENT },
      },
    ],
  },
  {
    id: "edit_artifact",
    kind: "interaction",
    component: "edit_artifact",
    title: "Edit an artifact",
    blurb:
      "A person edits what the run produced and hands it back as `content`. `source` seeds the editor from an input; without one the editor starts empty.",
    schemaId: componentConfigSchemaId("edit_artifact"),
    variants: [
      {
        id: "basic",
        title: "Seeded from an input",
        note: 'The app\'s own editor for the type, Revert meaning "throw away what I typed", and a Changes reading of what you did.',
        sample: { prompt: "Tidy up the plan.", source: "plan_doc" },
        inputs: { plan_doc: GALLERY_DOCUMENT },
      },
      {
        id: "empty",
        title: "From nothing",
        note: "No `source`: the editor starts empty, and submitting it empty is still an answer — the run is parked until one arrives.",
        sample: { prompt: "Write the release note." },
      },
    ],
  },
  {
    id: "fill_form",
    kind: "interaction",
    component: "fill_form",
    title: "Fill in a form",
    blurb:
      "Several typed answers, submitted together. Each answer lands on its field's name, so the field list and the state's declared outputs are two spellings of one contract.",
    schemaId: componentConfigSchemaId("fill_form"),
    variants: [
      {
        id: "basic",
        title: "Every type once",
        note: "The JSON-Schema subset a form can honestly render: `string` (with `multiline`), `number`, `boolean`, `enum` — with `optional` where an empty answer is allowed.",
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
        id: "defaults",
        title: "Pre-answered, all optional",
        note: "`default` seeds each control and `description` says what the answer changes — so answering is confirming or overruling, and a person with no view can submit it untouched.",
        sample: {
          prompt: "Confirm the readings the draft took.",
          fields: [
            {
              name: "canceled_sort",
              type: "enum",
              label: "Where does a conversation you stopped yourself sort?",
              description: 'The brief says "uncompleted first"; the spec puts it with the finished ones.',
              enum: ["above, as the brief says", "below, with the finished", "no view"],
              default: "below, with the finished",
              optional: true,
            },
            {
              name: "row_counts",
              type: "enum",
              label: "Does a workflow row carry counts?",
              description: 'Counts answer "where does my work stand" without opening the row.',
              enum: ["count and status roll-up", "name only", "no view"],
              default: "count and status roll-up",
              optional: true,
            },
            { name: "blocking", type: "boolean", label: "Blocking?", default: true, optional: true },
          ],
        },
      },
      {
        id: "custom",
        title: "An enum with a way out",
        note: "`custom: true` on an enum field makes its values suggestions: the box offers them and takes any other text, and the contract accepts any non-empty string on that field.",
        sample: {
          prompt: "Where should the cache live?",
          fields: [
            {
              name: "store",
              type: "enum",
              label: "Store",
              enum: ["memory", "sqlite", "the existing blob store"],
              custom: true,
              description: "Pick one, or name somewhere else.",
            },
            { name: "interval", type: "number", label: "Interval (seconds)", default: 30 },
          ],
        },
      },
    ],
  },
  {
    id: "confirm_action",
    kind: "interaction",
    component: "confirm_action",
    title: "Confirm an action",
    blurb: "A yes/no whose buttons say what they do. The answer is `confirmed`, and nothing else.",
    schemaId: componentConfigSchemaId("confirm_action"),
    variants: [
      {
        id: "basic",
        title: "Buttons that say what they do",
        note: "`confirmLabel` and `cancelLabel` are the whole of the config: a yes/no whose buttons are verbs.",
        sample: { prompt: "Merge the plan into main?", confirmLabel: "Merge", cancelLabel: "Not yet" },
      },
      {
        id: "defaults",
        title: "Defaults",
        note: "With no labels the buttons read Confirm and Cancel, and with no prompt the heading is the component's own.",
        sample: {},
      },
      {
        id: "remote",
        title: "Before anything leaves the machine",
        note: "`details` says what EXACTLY is being confirmed, and `options` adds other ways of saying yes. This is the question `remote.publish` asks once per task (decision 0004): the confirm button is the filled one because it has alternatives beside it, and `Always for this project` answers `confirmed: true, choice: \"always\"`.",
        sample: {
          prompt: "Push this review to GitLab and open a merge request?",
          confirmLabel: "Push and open",
          cancelLabel: "Review here only",
          details: [
            { label: "to", value: "origin · gitlab.com/mistlabs/jaira" },
            { label: "branch", value: "jaira/t-qfr49rm80m/review → main" },
            { label: "commits as", value: "Ofer Sadgat (git config)" },
            { label: "request opened by", value: "@ofer (the GitLab connection's token)" },
          ],
          options: [{ value: "always", label: "Always for this project" }],
        },
      },
    ],
  },
  {
    id: "review_artifacts",
    kind: "interaction",
    component: "review_artifacts",
    title: "Review a set of artifacts",
    blurb:
      "N artifacts, each decided — today's case being a changeset (CHANGESETS.md §4.1). It finds its changeset among the state's inputs BY SHAPE — no config field names it — and returns a decision per change.",
    schemaId: componentConfigSchemaId("review_artifacts"),
    variants: [
      {
        id: "basic",
        title: "A proposal in a worktree",
        note: "`tree: proposal` — the files already hold the agent's edits, so `merged` is a no-op on disk and `reverted` is the change. One Submit; the per-change decisions carry the whole answer.",
        sample: { prompt: "Review the proposed changes.", tree: "proposal" },
        inputs: { changeset: GALLERY_CHANGESET as unknown as JsonValue },
      },
      {
        id: "routed",
        title: "With a review-level decision",
        note: "`decisions` adds the routing question beside the per-change ones: `approve` / `revise` / `cut`, where `cut` is a direction for the run rather than a disposition on any file.",
        sample: {
          prompt: "Review the proposed changes.",
          tree: "proposal",
          decisions: ["approve", "revise", { value: "cut", tone: "danger" }],
        },
        inputs: { changeset: GALLERY_CHANGESET as unknown as JsonValue },
      },
      {
        id: "base",
        title: "A sync against the base",
        note: "`tree: base` — the edits exist only as data, so the files column reads the other way round: `merged` is the write and `reverted` leaves the tree alone.",
        sample: { prompt: "Review the sync.", tree: "base" },
        inputs: { changeset: GALLERY_CHANGESET as unknown as JsonValue },
      },
      {
        id: "remote",
        title: "Also open on the forge",
        note: "`remote` gives the gate a second door (decision 0004): the review is pushed, a merge request is opened, and whichever side settles first answers the state. The strip under the base line says where the request lives, who has commented there and when the quiet window sends it back; a thread written on the forge sits on its change, marked as such. This is the gate AS PARKED — the host has already filled in the request's number and link. What the forge has said is the gallery's own fixture: nothing here reaches a forge, so Check now reads it again and a reply stays on this card.",
        sample: {
          prompt: "Review the probe cache before it merges.",
          tree: "proposal",
          decisions: ["approve", "revise", { value: "cut", tone: "danger" }],
          remote: {
            to: "origin",
            target: "main",
            settle_after: "10m",
            provider: "gitlab",
            host: "gitlab.com",
            project: "mistlabs/jaira",
            branch: "jaira/t-qfr49rm80m/review",
            number: 41,
            url: "https://gitlab.com/mistlabs/jaira/-/merge_requests/41",
            key: "review",
          },
        },
        inputs: { changeset: GALLERY_CHANGESET as unknown as JsonValue },
        forge: {
          commenters: ["mara"],
          settling: true,
          notes: {
            c1: [
              {
                artifact: "c1",
                quote: "  cached = await probeEverything();",
                side: "after",
                body: "Two readers arriving together both probe here. Worth a single in-flight promise?",
                author: "mara",
                at: "2026-09-19T10:42:00Z",
                source: "gitlab",
                thread: "gallery-thread-1",
              },
            ],
          },
        },
      },
    ],
  },
  {
    id: "approve_tool_call",
    kind: "interaction",
    component: "approve_tool_call",
    title: "Approve a tool call, for a function",
    blurb:
      "The approval prompt as a FUNCTION: what a permission function calls when it wants the person to decide — the shipped `smart` does when it is unsure. It shows the request the function was handed (the tool, the part of the shell line, where it runs) and answers allow or deny, nothing else; what, if anything, is remembered is the function's business. An approval, so a fast-forward's conversation is never offered it.",
    schemaId: componentConfigSchemaId("approve_tool_call"),
    variants: [
      {
        id: "basic",
        title: "One part of a shell line",
        note: "`smart` was unsure about `git push`, so it asked. The line is drawn whole with the part being asked about tinted; the rows under it say what the function is deciding and for which toolset line.",
        sample: { prompt: "smart is unsure — allow this?" },
        inputs: {
          request: {
            tool: "bash",
            subject: "git push",
            function: "smart",
            input: { command: "npm test && git push origin feature/probe", cwd: "/repo" },
            line: "npm test && git push origin feature/probe",
            part: {
              text: "git push origin feature/probe",
              kind: "command",
              subject: "git push",
              span: { start: 12, end: 41 },
              program: "git",
              subcommand: "push",
              args: ["origin", "feature/probe"],
              flags: [],
            },
            cwd: "/repo",
            state: "feature/implementation/build",
            task: "t-qfr49rm80m",
            toolset: "$/toolsets/chat/auto",
          },
        },
      },
      {
        id: "input",
        title: "A tool that is not the shell",
        note: "A file tool has no line to take apart, so the prompt shows its arguments — the whole of what the call would do.",
        sample: { prompt: "Allow this tool call?" },
        inputs: {
          request: {
            tool: "write_file",
            subject: "write_file",
            function: "smart",
            input: { path: "deploy/production.env", content: "API_URL=https://api.internal" },
            state: "feature/implementation/build",
            task: "t-qfr49rm80m",
            toolset: "$/toolsets/chat/auto",
          },
        },
      },
    ],
  },
  {
    id: "unknown-function",
    kind: "interaction",
    component: "unknown_function",
    title: "A gate JaiRA does not know",
    blurb:
      "The fallback, and NOT a real component: `unknown_function` is a name nothing implements. A UI state whose function is not a built-in still parks and still has to be answerable, so you get a JSON box — the honest offer when nothing declares what the answer should look like, and what a typo in `operation.function` looks like from here.",
    schemaId: "gallery-unknown-function",
    variants: [
      {
        id: "basic",
        title: "The JSON box",
        note: "Type any function name: whatever it is, this is what a state calling it parks at.",
        sample: { function: "unknown_function" },
      },
    ],
  },
  {
    id: "approval",
    kind: "approval",
    title: "Approve a command",
    blurb:
      "Not a workflow gate: policy escalated a tool call, so what is judged is a command and the answer carries a REACH — the reason you are not asked again on the next call (DESIGN §10.2). A shell line is drawn as the requests it is made of (decision 0007 §4).",
    schemaId: "gallery-approval",
    variants: [
      {
        id: "basic",
        title: "One line, two requests",
        note: "Each part is tinted in its own hue and only the words that matched the toolset's line are underlined. The arrow beside Allow asks what the answer covers, then how far it reaches — once, this run, or a line written into the toolset.",
        sample: {
          tool: "Bash",
          command: "rm foo.txt && git commit -m wip",
          parts: {
            line: "rm foo.txt && git commit -m wip",
            dialect: "posix",
            verdict: "asks",
            toolset: "$/toolsets/feature/implementation/writes-asking",
            parts: [
              {
                span: { start: 0, end: 10 },
                matched: [{ start: 0, end: 2 }],
                text: "rm foo.txt",
                kind: "tool",
                subject: "write_file",
                paths: ["foo.txt"],
                verdict: "allowed",
                decidedBy: { source: "toolset", entry: "write_file", reason: "the toolset's 'write_file' is allow" },
                widths: ["rm"],
              },
              {
                span: { start: 14, end: 31 },
                matched: [{ start: 14, end: 24 }],
                text: "git commit -m wip",
                kind: "command",
                subject: "git commit",
                verdict: "asks",
                decidedBy: { source: "toolset", entry: "git commit", reason: "the toolset's 'git commit' is ask" },
                widths: ["git commit", "git"],
              },
            ],
          },
          toolset: {
            id: "feature/implementation/writes-asking",
            targets: [
              { layer: "project", file: ".jaira/toolsets/feature/implementation/writes-asking.json" },
              { layer: "base", file: "~/.jaira/toolsets/feature/implementation/writes-asking.json" },
            ],
          },
          input: { command: "rm foo.txt && git commit -m wip" },
        },
      },
      {
        id: "function",
        title: "Parts a function decided",
        note: "The toolset gives `bash` to the `smart` function, which allowed `npm test`; `git push` still asks, because the built-in ask on a push is stricter than a function. A part a function decided says which function and what it answered — and it is not asked about again.",
        sample: {
          tool: "Bash",
          command: "npm test && git push origin feature/probe",
          parts: {
            line: "npm test && git push origin feature/probe",
            dialect: "posix",
            verdict: "asks",
            toolset: "$/toolsets/chat/auto",
            parts: [
              {
                span: { start: 0, end: 8 },
                matched: [{ start: 0, end: 3 }],
                text: "npm test",
                kind: "command",
                subject: "npm test",
                verdict: "allowed",
                decidedBy: { source: "function", entry: "bash", function: "smart", reason: "'smart' allowed it" },
                widths: ["npm test", "npm"],
              },
              {
                span: { start: 12, end: 41 },
                matched: [{ start: 12, end: 20 }],
                text: "git push origin feature/probe",
                kind: "command",
                subject: "git push",
                verdict: "asks",
                decidedBy: { source: "builtin", reason: "pushes publish work" },
                widths: ["git push", "git"],
              },
            ],
          },
          input: { command: "npm test && git push origin feature/probe" },
        },
      },
      {
        id: "empty",
        title: "A line nobody took apart",
        note: "A request with no parts shows the command and the policy's reason, and the same two split buttons: once, or for this run.",
        sample: {
          tool: "Bash",
          command: "rm -rf build && npm run build",
          reason: "`rm -rf` is not on the allow list for this profile",
          input: { command: "rm -rf build && npm run build", cwd: "/repo" },
        },
      },
      {
        id: "input",
        title: "Structured input",
        note: "A tool with no command line shows its arguments instead — the whole of what the call would do, since there is nothing shorter that is honest.",
        sample: {
          tool: "write_file",
          reason: "writes outside the worktree",
          input: { path: "/etc/hosts", content: "127.0.0.1 registry.internal" },
        },
      },
    ],
  },
  {
    id: "question",
    kind: "question",
    title: "Answer an agent's question",
    blurb:
      "A running agent asked something (`AskUserQuestion`). Nothing is being authorized — the options are the agent's own and the answer travels back as its tool input, so a question is answered, never approved.",
    schemaId: "gallery-question",
    variants: [
      {
        id: "basic",
        title: "One question",
        note: "One question with a single choice answers on the click; the Other box is INSTEAD text, so typing in it waits for Answer. Dismissal is the one affordance a gate never gets.",
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
      {
        id: "steps",
        title: "Several, in steps",
        note: "A batch is one tool call, so the questions are asked one at a time — Next until the last, Confirm on it, Back to change an earlier answer — and half an answer never travels.",
        sample: {
          questions: [
            {
              question: "Which cache interval should the probe use?",
              header: "Interval",
              options: [{ label: "30 seconds" }, { label: "5 minutes" }],
            },
            {
              question: "Where should the snapshot be kept?",
              header: "Store",
              options: [
                { label: "In memory", description: "Lost on restart, which is fine for a probe." },
                { label: "On disk", description: "Survives a restart; costs a write per probe." },
              ],
            },
          ],
        },
      },
      {
        id: "multiple",
        title: "Pick several",
        note: "`multiSelect` draws a box on each option and answers with a list — the person learns it is multi-select from the options, not by clicking twice and being surprised.",
        sample: {
          questions: [
            {
              question: "Which providers should the probe check?",
              header: "Providers",
              multiSelect: true,
              options: [{ label: "anthropic" }, { label: "openai" }, { label: "local" }],
            },
          ],
        },
      },
    ],
  },
];

/**
 * The groups flattened: one surface per variant, which is the unit a card renders and a test checks.
 *
 * The id is `group/variant`, so a request minted from it (`gallery-choose_option/custom`) says which
 * fixture raised it, and a caller that wants one group's cards can filter on the prefix.
 */
export function surfacesOfGroups(groups: readonly GalleryGroup[]): GallerySurface[] {
  return groups.flatMap((group) =>
    group.variants.map((variant) => ({
      id: `${group.id}/${variant.id}`,
      group: group.id,
      variant: variant.id,
      kind: group.kind,
      title: variant.title,
      note: variant.note,
      blurb: group.blurb,
      ...(group.component === undefined ? {} : { component: group.component }),
      schemaId: group.schemaId,
      sample: variant.sample,
      ...(variant.inputs === undefined ? {} : { inputs: variant.inputs }),
      ...(variant.forge === undefined ? {} : { forge: variant.forge }),
    })),
  );
}

export const GALLERY_SURFACES: readonly GallerySurface[] = surfacesOfGroups(GALLERY_GROUPS);
