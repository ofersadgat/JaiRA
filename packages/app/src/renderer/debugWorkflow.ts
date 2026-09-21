/**
 * The self-test workflow: two prompt states, the second reading the first's output.
 *
 * This is the smallest workflow that exercises the whole machine end to end — a real LLM call, a
 * structured output, a sibling binding, a derived output on the root — and it exists so the Debug
 * view can run it on demand and show every part of it working (or not).
 *
 * The three state files SHIP, in the built-in layer (`packages/shared/builtin/workflows/debug/`,
 * decision 0006) — ordinary files the Files tree lists under "Built in", so nothing about the
 * self-test is privileged and nothing has to be installed before it can run. This module used to
 * generate them and the Debug view used to write them into the shared root; what is left here is
 * what the VIEW needs to know about them: their ids, and the scripted replies that match their
 * prompts. A copy in `~/.jaira` or the project still wins, as an override of any built-in does.
 *
 * Two states, and the second is the point:
 *
 *  - `say`   asks for a greeting and publishes it as a typed `string`.
 *  - `check` takes that string as an INPUT — wired `.children.say.output.greeting` on the mount —
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
 * The phrase `say` is asked for and the scripted `say` answers with.
 *
 * It also stands in `debug/hello_world/say.json`, and the two have to agree: a self-test whose
 * halves disagree about what it is testing reports its own typo as a provider failure.
 * `debugWorkflow.test.ts` holds them together — it runs this script against the shipped files.
 */
const PHRASE = "Hello, world!";

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
