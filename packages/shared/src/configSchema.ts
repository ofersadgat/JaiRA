/**
 * The rest of `settings.json`, declared — so the settings screen is a FORM rather than a JSON box.
 *
 * Providers and Executors have purpose-built screens because they are what people configure daily.
 * Everything else — where artifacts go, whether calls are memoized, which distro commands run in,
 * where workflows are looked up — was left to a raw JSON editor, which is the same failure the LLM
 * config box had: it makes the user the parser. You had to already know the field is `inlineMaxBytes`
 * and not `maxInlineBytes`, that `execEnvironment` takes either a string or an object, and that
 * `artifacts.destination` is a template over a closed variable set — none of which the box told you,
 * and all of which it would accept and then refuse on save.
 *
 * So each setting is declared here with its type, its label and what it is FOR, and the same
 * signature-driven renderer that draws the executor steps draws these. One declaration, read by the
 * form and by anyone reading the config.
 *
 * What a command may run is NOT here: that is each permission set's `bash` line and its command lines, edited
 * in Settings → Permission sets. What is here is each shipped function's defaults, under `functions`.
 */
import type { JsonValue } from "@declarative-ai/json";
import { DEFAULT_SMART_PROMPT } from "./config";
import { DEFAULT_PUBLISH_MODE, DEFAULT_SETTLE_AFTER, PUBLISH_MODES } from "./forge";

/** A JSON Schema node, the same shape the executor steps use. */
export type ConfigSchema = Record<string, JsonValue>;

export interface ConfigSectionSpec {
  /** The config key this section edits — also the dotted path a field is written under. */
  key: string;
  title: string;
  /** One line, addressed to someone deciding whether they care about this section at all. */
  hint: string;
  schema: ConfigSchema;
}

/**
 * The sections, in the order the screen offers them.
 *
 * Artifacts first because it is the one with a real decision in it; the exec environment next because
 * it is the one that is wrong most often on Windows; storage after those, because it is the decision
 * a project makes once when it decides whether its run history is shared; memo and workflows last,
 * because most projects never touch them.
 */
export const CONFIG_SECTIONS: ConfigSectionSpec[] = [
  {
    key: "artifacts",
    title: "Artifacts",
    hint: "Where a file an agent produces actually lands, and how much of it is kept inline.",
    schema: {
      $type: "artifacts",
      type: "object",
      properties: {
        destination: {
          $type: "artifact-destination",
          type: "string",
          title: "destination",
          description:
            "A path template, not a mode: WHICH backend and HOW the path is derived are independent questions. $DEFAULT is the workspace; virtual: keeps content in memory and writes nothing.",
        },
        dir: {
          type: "string",
          title: "artifact directory",
          description: "What $ARTIFACT_DIR expands to, relative to the workspace.",
        },
        inlineMaxBytes: {
          type: "number",
          title: "keep inline below (bytes)",
          description:
            "Content smaller than this rides along in bindings and prompts rather than being read back from disk. Larger is fewer reads and bigger prompts. Not a limit: a bigger artifact still succeeds.",
        },
        askAboveBytes: {
          type: "number",
          title: "ask above (bytes)",
          description:
            "Producing an artifact bigger than this asks you first. There is no ceiling on size — this is a question, not a refusal. 0 turns it off.",
        },
      },
    },
  },
  {
    key: "execEnvironment",
    title: "Where commands run",
    hint: "Natively on Windows, or inside a WSL distro — which is where git and every agent then run too.",
    schema: {
      $type: "exec-environment",
      type: "object",
      properties: {
        wsl: {
          type: "string",
          title: "WSL distro",
          description:
            "Empty runs everything natively. Named, git and agents run INSIDE that distro — deliberately not Windows git against \\\\wsl$, which is slow and permission-fragile.",
        },
      },
    },
  },
  {
    key: "storage",
    title: "Storage",
    hint: "Which run state lives in files and which in the database — files merge in git, SQLite does not.",
    schema: {
      $type: "storage",
      type: "object",
      properties: {
        journal: {
          type: "string",
          enum: ["file", "db", "both"],
          title: "journal",
          description:
            "The engine's event stream. In a file it is one JSONL per run, which two people can append to on one branch without conflicting; in the database it is one table nobody can merge.",
        },
        conversations: {
          type: "string",
          enum: ["file", "db", "both"],
          title: "conversations",
          description:
            "Every model call and the transcripts they make up. In files these are readable by tooling JaiRA did not write, which is most of the reason to choose it.",
        },
        tasks: {
          type: "string",
          enum: ["file", "db", "both"],
          title: "tasks",
          description: "What was asked for, and where each run of it got to.",
        },
        artifacts: {
          type: "string",
          enum: ["file", "db", "both"],
          title: "artifact map",
          description:
            "The map from what a producer said it wrote to where the bytes went. The bytes themselves are already files and are not affected by this.",
        },
        format: {
          type: "string",
          enum: ["claude", "codex"],
          title: "session line shape",
          description:
            "Which agent's JSONL a file-backed conversation is WRITTEN in. Reading accepts either whatever this says, because a repository outlives a preference.",
        },
      },
    },
  },
  {
    key: "memo",
    title: "Memoization",
    hint: "Remember what a model answered and reuse it. Off by default, because it changes what a re-run observes.",
    schema: {
      $type: "memo",
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          title: "remember model answers",
          description:
            "It saves real money, and it is not a pure optimization: a re-run returns the first run's answer rather than asking again — surprising if you re-ran precisely because you wanted a fresh one.",
        },
      },
    },
  },
  {
    key: "autopilot",
    title: "Fast-forward",
    hint: "When a fast-forward lets the conversation answer a question for you, and when it leaves it.",
    schema: {
      $type: "autopilot",
      type: "object",
      properties: {
        askBelow: {
          type: "number",
          title: "leave it to me below",
          description:
            "A fast-forward runs the states between where the work stands and where you sent it, and the conversation steering it answers the questions that come up — each marked, and each a point you can rewind to. Under this confidence it does not: the question waits for you, as it would have. 1 means never answer for me; 0 means always. It has nothing to do with any threshold a workflow of your own declares.",
        },
      },
    },
  },
  {
    key: "limits",
    title: "When usage runs out",
    hint: "What a message or a run does when an account has no usage left.",
    schema: {
      $type: "limits",
      type: "object",
      properties: {
        retryOnReset: {
          type: "boolean",
          title: "try again when the limit resets",
          description:
            "Whether \"Try again at …\" starts checked on a message or a run the provider refused because the account ran out. Checked, it is tried again when the window resets; each one can still be changed where it is shown. A message sent while the account is already known to be out always waits for the reset.",
        },
      },
    },
  },
  {
    key: "functions",
    title: "Functions",
    hint: "The defaults of the functions JaiRA ships — each function's settings, in one place.",
    schema: {
      $type: "functions",
      type: "object",
      properties: {
        smart: {
          type: "object",
          title: "smart",
          description:
            "The permission function a permission set line names as { \"function\": \"smart\" }: one model call judges each tool call allow, deny or unsure, and unsure asks you through the approval prompt.",
          properties: {
            model: {
              type: "string",
              title: "model",
              description:
                "Which model judges each call, written as a state's model is — claude-haiku-4-5, or claude-cli/haiku to insist on a route — or a preset's name, which means the model that preset chooses (JaiRA ships simple here). Empty uses whatever this machine's default executor answers with. A fast, cheap model is the point: it runs once per call.",
            },
            prompt: {
              type: "string",
              title: "prompt",
              contentMediaType: "text/markdown",
              default: DEFAULT_SMART_PROMPT,
              description:
                "What the judge is told. The call it judges — the tool, the part of a shell line, the state, the task — is added below this, as JSON. Empty uses the prompt JaiRA ships.",
            },
          },
        },
        review_artifacts: {
          type: "object",
          title: "review_artifacts",
          description:
            "The review gate, when a workflow also opens its review on a forge (a state's remote block): what it may send there, and how long it waits for more comments.",
          properties: {
            publish: {
              type: "string",
              enum: [...PUBLISH_MODES],
              title: "publish",
              default: DEFAULT_PUBLISH_MODE,
              description: `Whether a workflow may push a branch and open a merge request from here without asking. ask — once per task, saying exactly what will be sent and as whom; allow — without asking; deny — never. A remote in a workflow file is a request, never the authorization. Default ${DEFAULT_PUBLISH_MODE}.`,
            },
            settleAfter: {
              type: "string",
              title: "wait after a comment",
              default: DEFAULT_SETTLE_AFTER,
              description: `How long a review stays open after the last comment on the forge before it goes back with everything said — a duration like 10m, 90s or 2h, and 0 settles on the first comment. A decision, a merge or a close never waits. A state's own remote.settle_after overrides it. Default ${DEFAULT_SETTLE_AFTER}.`,
            },
          },
        },
        bash: {
          type: "object",
          title: "bash",
          description:
            "The shell tool. What a line may run is each permission set's bash line and the command lines under it (git push, npm install); this is what stands above every permission set.",
          properties: {
            builtins: {
              type: "boolean",
              title: "built-in refusals",
              default: true,
              description:
                "JaiRA's own floor, above every permission set: destructive git (a force push, a hard reset, a rebase) and removing .git are refused; a push, an install, a package publish, a network program or a credentials path asks. Turn it off only for a disposable workspace.",
            },
          },
        },
      },
    },
  },
  {
    key: "workflows",
    title: "Workflow lookup",
    hint: "The roots a bare workflow reference is searched along — shell PATH semantics, first match wins.",
    schema: {
      $type: "workflows",
      type: "object",
      properties: {
        path: {
          $type: "path-list",
          type: "array",
          title: "search path",
          description:
            "Empty means the layers in order, generated from the roots — which is what almost every project wants. Setting it REPLACES that list rather than extending it, so a project that sets it takes on naming every root it wants.",
        },
      },
    },
  },
];

/** The artifact destinations worth offering as a starting point. Anything else is a template. */
export const ARTIFACT_DESTINATIONS: Array<{ value: string; label: string; what: string }> = [
  { value: "$DEFAULT", label: "the workspace", what: "beside the code the run is working on" },
  { value: "$CENTRAL", label: "one directory per task", what: "outside the repo, grouped by task" },
  { value: "$CENTRAL_FLAT", label: "one flat directory", what: "outside the repo, filenames derived" },
  { value: "virtual:", label: "memory only", what: "recorded, but nothing is written to disk" },
];

/** The variables an artifact destination template may use. Shown beside the box, not enforced here. */
export const ARTIFACT_VARIABLES = ["$JAIRA", "$PROJECT", "$TASK_ID", "$RELPATH", "$ARTIFACT_DIR"];
