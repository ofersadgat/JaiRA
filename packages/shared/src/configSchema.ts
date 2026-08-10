/**
 * The rest of `config.json`, declared — so the settings screen is a FORM rather than a JSON box.
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
 * The policy block is deliberately NOT here: it is an ordered rule list over command matchers, which
 * a flat property walk cannot express, and it gets its own editor.
 */
import type { JsonValue } from "@declarative-ai/json";

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
 * it is the one that is wrong most often on Windows; memo and workflows after, because most projects
 * never touch them.
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
            "Content smaller than this rides along in bindings and prompts rather than being read back from disk. Larger is fewer reads and bigger prompts.",
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
