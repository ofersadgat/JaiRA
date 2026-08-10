/**
 * The self-test workflow: two prompt states, the second reading the first's output.
 *
 * This is the smallest workflow that exercises the whole machine end to end — a real LLM call, a
 * structured output, a sibling binding, a derived output on the root — and it exists so the Debug
 * view can run it on demand and show every part of it working (or not).
 *
 * Authored HERE, in the renderer, rather than in `@jaira/runtime` beside `specPlanningFiles()`: the
 * runtime module reaches for `node:fs` to write its files, and the Debug view installs these through
 * the ordinary `workflow:write` channel instead — the same path the Files tree writes on, so the
 * files it lands are files you can then open, read and edit like any others. Nothing about the
 * self-test is privileged.
 *
 * Two states, and the second is the point:
 *
 *  - `say`   asks for a greeting and publishes it as a typed `string`.
 *  - `check` takes that string as an INPUT — wired `.children.say.outputs.greeting` on the mount —
 *    and reports whether it was a hello-world greeting.
 *
 * So a pass means more than "the provider answered". It means the first call's structured output was
 * validated, bound, carried across the sequence, and interpolated into the second call's prompt. If
 * the wiring were broken, `check` would be judging an empty string and would say so.
 */
import type { JsonValue } from "@declarative-ai/json";

/** The root state id, and what a Debug run creates its task against. */
export const SELF_TEST_ROOT = "debug/hello_world";

/** Every state the self-test is made of, in the order the pane lists them. */
export const SELF_TEST_STATES = [SELF_TEST_ROOT, `${SELF_TEST_ROOT}/say`, `${SELF_TEST_ROOT}/check`];

/**
 * The phrase `say` is asked for and `check` is asked about.
 *
 * One constant because three places need to agree on it: the two prompts, and the scripted reply
 * below. A self-test whose halves disagree about what it is testing reports its own typo as a
 * provider failure.
 */
const PHRASE = "Hello, world!";

/**
 * The state files, keyed by state id — the same shape `writeWorkflowFiles` takes.
 *
 * No `model` anywhere on purpose. Every prompt state inherits `models.default` from the effective
 * configuration, so the self-test asks whatever this machine is actually set up to ask. Pinning a
 * model here would make it a test of a model rather than a test of the installation.
 */
export function selfTestFiles(): Record<string, JsonValue> {
  return {
    [SELF_TEST_ROOT]: {
      label: "Hello-world self-test",
      description:
        "Two prompt states: one says hello world, the next reads what it said and judges it. Run from the Debug view.",
      // Both children are one structured LLM call, so the kind is declared once here and the leaves
      // say only what differs (WORKFLOWS.md §5). A pure composite does not inherit an operation, so
      // this root stays a composite.
      environment: { kind: "prompt" },
      outputs: {
        greeting: { schema: { type: "string" }, binding: ".children.say.outputs.greeting" },
        passed: { schema: { type: "boolean" }, binding: ".children.check.outputs.passed" },
        verdict: { schema: { type: "string" }, binding: ".children.check.outputs.verdict" },
      },
      children: {
        say: {},
        // THE WIRE. `check` declares a required `greeting` input; this is where it comes from.
        check: { inputs: { greeting: ".children.say.outputs.greeting" } },
      },
      sequence: ["say", "check"],
    },

    [`${SELF_TEST_ROOT}/say`]: {
      label: "Say hello",
      // A produced output: the call must return `{ "greeting": … }`, which is also the structured
      // output contract the model is held to (WORKFLOWS.md §4.4).
      outputs: { greeting: { schema: { type: "string" } } },
      operation: {
        prompt: `Reply with exactly this and nothing else: ${PHRASE}`,
      },
    },

    [`${SELF_TEST_ROOT}/check`]: {
      label: "Check the greeting",
      inputs: {
        greeting: {
          schema: { type: "string" },
          description: "What the previous state's model actually replied.",
        },
      },
      outputs: {
        passed: { schema: { type: "boolean" } },
        verdict: { schema: { type: "string" } },
      },
      operation: {
        // `{{.inputs.greeting}}` interpolates the value the mount bound — so an empty hole here is
        // itself a finding, and the judging prompt is written to report it rather than to guess.
        prompt: [
          "Another model was asked to say hello world. Its reply is between the markers below.",
          "",
          "---",
          "{{.inputs.greeting}}",
          "---",
          "",
          "Set `passed` to true only if the text between the markers is a hello-world greeting.",
          "Set it to false if the text is empty, missing, or says something else.",
          "Set `verdict` to one short sentence quoting what you saw and saying why you decided that.",
        ].join("\n"),
      },
    },
  };
}

/**
 * A scripted reply for each state — the `--fake` surface, as the Debug view's "scripted" run uses it.
 *
 * This is the half of the self-test that needs no provider and costs nothing: it exercises the
 * engine, the bindings, the journal, the board and every panel in this app, with the LLM replaced.
 * Running it first is how you tell a broken workflow apart from a missing API key.
 *
 * The rules match on the rendered prompt, so they are matched by the same text the states declare.
 */
export function selfTestScript(): JsonValue {
  return [
    { promptIncludes: "Reply with exactly", output: { greeting: PHRASE } },
    {
      promptIncludes: "Set `passed` to true",
      output: { passed: true, verdict: `The reply was "${PHRASE}", which greets the world.` },
    },
  ];
}
