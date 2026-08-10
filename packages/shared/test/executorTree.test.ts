/**
 * The executor TREE as configuration — parsed against the step schemas, and resolved adaptively.
 *
 * Two properties carry the weight, and they are the two the design turns on:
 *
 *  - **Absent means DERIVED.** An empty config still yields a complete tree — an operation executor
 *    over a function executor and a router across everything available — so a fresh machine has a
 *    default executor without configuring one.
 *  - **A change pins only what changed.** Writing a rate limit onto one route must not stop an agent
 *    installed tomorrow from getting a route by itself. That is why the stored shape is an overlay
 *    and not the resolved tree.
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { EXECUTOR_STEPS, EXECUTOR_STEP_ORDER, executorStep } from "../src/executorStack";
import {
  BUILTIN_FUNCTIONS,
  DEFAULT_EXECUTOR,
  EXECUTOR_NODES,
  functionAllowed,
  isPinned,
  parseFunctionRule,
  pin,
  resolveExecutorTree,
  unnamedModelAnswer,
  unnamedRouteOf,
  type JairaOperationNode,
  type JairaRouterNode,
} from "../src/executorTree";

const available = { providers: ["anthropic", "local"], agents: ["claude-cli", "codex-cli"] };
const routerOf = (tree: JairaOperationNode): JairaRouterNode => tree.prompt as JairaRouterNode;

describe("the step catalogue", () => {
  it("lists every step in composition order, each with a schema and a placement", () => {
    expect(EXECUTOR_STEPS.map((s) => s.name)).toEqual(EXECUTOR_STEP_ORDER);
    for (const step of EXECUTOR_STEPS) {
      expect(step.schema["$type"]).toBe(step.name);
      expect(step.placement.length).toBeGreaterThan(0);
    }
    expect(executorStep("retry")?.title).toBe("Retry");
    expect(executorStep("nope")).toBeUndefined();
  });
});

describe("the node hierarchy", () => {
  it("names every level and the upstream class it builds", () => {
    expect(EXECUTOR_NODES.map((n) => n.kind)).toEqual(["operation", "function", "router", "provider", "agent"]);
    for (const node of EXECUTOR_NODES) expect(node.builds.length).toBeGreaterThan(0);
  });

  /**
   * Which functions EXIST is the run's business — a workflow's states decide that, and the registry
   * is assembled per run from what they name. Marking it unconfigurable is a claim, not an omission.
   */
  it("says the function level is not something configuration defines", () => {
    expect(EXECUTOR_NODES.find((n) => n.kind === "function")?.configurable).toBe(true);
    expect(EXECUTOR_NODES.find((n) => n.kind === "operation")?.configurable).toBe(false);
  });
});

describe("resolveExecutorTree — absent means derived", () => {
  it("builds a whole tree from nothing at all", () => {
    const tree = resolveExecutorTree(undefined, available);

    expect(tree.kind).toBe("operation");
    expect(tree.function?.kind).toBe("function");
    expect(routerOf(tree).kind).toBe("router");
    // Every provider and every agent, without any of them being configured.
    expect(Object.keys(routerOf(tree).routes ?? {})).toEqual([
      "anthropic",
      "local",
      "claude-cli",
      "codex-cli",
    ]);
    // The provider path owns every prefix the model-route vocabulary knows, so it is the fallback.
    expect(routerOf(tree).fallback).toEqual({ kind: "provider" });
  });

  it("gives each derived route the identity of what it routes to", () => {
    const routes = routerOf(resolveExecutorTree(undefined, available)).routes ?? {};
    expect(routes["anthropic"]).toEqual({ kind: "provider", provider: "anthropic" });
    expect(routes["claude-cli"]).toEqual({ kind: "agent", agent: "claude-cli" });
  });

  /** The adaptive property, stated as directly as it can be. */
  it("adds a route for something installed later, even with an unrelated override pinned", () => {
    const overlay: JairaOperationNode = {
      prompt: { kind: "router", routes: { anthropic: { kind: "provider", steps: { rateLimit: { rpm: 60 } } } } },
    };

    const before = routerOf(resolveExecutorTree(overlay, { providers: ["anthropic"], agents: [] }));
    const after = routerOf(resolveExecutorTree(overlay, { providers: ["anthropic"], agents: ["claude-cli"] }));

    expect(Object.keys(before.routes ?? {})).toEqual(["anthropic"]);
    expect(Object.keys(after.routes ?? {})).toEqual(["anthropic", "claude-cli"]);
    // …and the pinned override survived the change.
    expect((after.routes?.["anthropic"] as { steps?: unknown }).steps).toEqual({ rateLimit: { rpm: 60 } });
  });

  it("REFINES a derived route rather than replacing it", () => {
    const overlay: JairaOperationNode = {
      prompt: { kind: "router", routes: { "claude-cli": { kind: "agent", model: "opus" } } },
    };

    const route = routerOf(resolveExecutorTree(overlay, available)).routes?.["claude-cli"];

    // The identity came from what was derived; only the model was stated.
    expect(route).toEqual({ kind: "agent", agent: "claude-cli", model: "opus" });
  });

  it("takes a route the overlay invents, which is how a project names its own", () => {
    const overlay: JairaOperationNode = {
      prompt: { kind: "router", routes: { review: { kind: "agent", agent: "claude-cli", model: "opus" } } },
    };

    expect(routerOf(resolveExecutorTree(overlay, available)).routes?.["review"]).toEqual({
      kind: "agent",
      agent: "claude-cli",
      model: "opus",
    });
  });

  /**
   * Someone who pinned the prompt half to a single agent meant to. Deriving a router around it would
   * be overruling them, and would quietly restore the routes they removed.
   */
  it("does not wrap a prompt half that was deliberately pinned to one leaf", () => {
    const tree = resolveExecutorTree({ prompt: { kind: "agent", agent: "claude-cli" } }, available);
    expect(tree.prompt).toEqual({ kind: "agent", agent: "claude-cli" });
  });

  it("carries the router's default call settings through", () => {
    const tree = resolveExecutorTree({ prompt: { kind: "router", defaults: { temperature: 0 } } }, available);
    expect(routerOf(tree).defaults).toEqual({ temperature: 0 });
  });
});

/**
 * How a state that names NO model gets routed at all.
 *
 * `PromptRouterExecutor` dispatches on the model id's prefix, so a state with no model has nothing to
 * dispatch on and lands in the fallback — the provider path — which reports an empty model from deep
 * inside the SDK. That is what a machine with `claude` installed and no API key hit on every workflow
 * JaiRA itself ships, all of which name no model on purpose.
 *
 * The rule: a call that named no route has chosen none, so the router is free to answer it with any
 * route that can. Nothing is written into the tree to say so — a synthesized `<prefix>/default` would
 * sit on the settings screen looking like a decision somebody made, and would go stale the moment
 * another route appeared.
 */
describe("a state that names no model", () => {
  it("writes no default into the tree, whether there is one route or several", () => {
    const one = resolveExecutorTree(undefined, { providers: [], agents: ["claude-cli"] });
    const several = resolveExecutorTree(undefined, available);

    expect(routerOf(one).defaults).toBeUndefined();
    expect(routerOf(several).defaults).toBeUndefined();
    expect(unnamedModelAnswer(one.prompt)).toEqual({ answers: true });
    expect(unnamedModelAnswer(several.prompt)).toEqual({ answers: true });
  });

  it("goes to the only route there is", () => {
    const tree = resolveExecutorTree(undefined, { providers: [], agents: ["claude-cli"] });
    expect(unnamedRouteOf(routerOf(tree).routes)).toBe("claude-cli");
  });

  it("goes to any route that can answer it when there are several — the first", () => {
    const tree = resolveExecutorTree(undefined, { providers: [], agents: ["claude-cli", "codex-cli"] });
    expect(unnamedRouteOf(routerOf(tree).routes)).toBe("claude-cli");
  });

  /** The one preference in here that anyone stated: a route somebody gave a model to. */
  it("prefers a route that was given a model over an agent that picks its own", () => {
    const overlay: JairaOperationNode = {
      prompt: { kind: "router", routes: { anthropic: { kind: "provider", model: "claude-haiku-4-5" } } },
    };
    const tree = resolveExecutorTree(overlay, { providers: ["anthropic"], agents: ["claude-cli"] });
    expect(unnamedRouteOf(routerOf(tree).routes)).toBe("anthropic");
  });

  it("skips a bare provider route, which has no model of its own to fall back on", () => {
    // Derived order is providers first, so `anthropic` comes before `claude-cli` and is passed over.
    const tree = resolveExecutorTree(undefined, { providers: ["anthropic"], agents: ["claude-cli"] });
    expect(unnamedRouteOf(routerOf(tree).routes)).toBe("claude-cli");
  });

  it("leaves a stated default alone", () => {
    const overlay: JairaOperationNode = { prompt: { kind: "router", defaults: { model: "anthropic/claude-opus-4-5" } } };
    const tree = resolveExecutorTree(overlay, available);
    expect(routerOf(tree).defaults).toEqual({ model: "anthropic/claude-opus-4-5" });
  });

  /**
   * A remote fleet has no default: asking one for a model called "default" is asking for a model that
   * does not exist. So a machine whose only routes are bare provider ones answers nothing, and
   * `defaultExecutorTree` says so at the start of a run rather than four layers down at the first call.
   */
  it("is not answered by bare provider routes, however many there are", () => {
    const tree = resolveExecutorTree(undefined, { providers: ["anthropic", "local"], agents: [] });

    expect(unnamedRouteOf(routerOf(tree).routes)).toBeUndefined();
    expect(unnamedModelAnswer(tree.prompt)).toEqual({ answers: false, routes: ["anthropic", "local"] });
  });

  it("is answered by a prompt half pinned to an agent, which picks its own", () => {
    const tree = resolveExecutorTree({ prompt: { kind: "agent", agent: "claude-cli" } }, available);
    expect(unnamedModelAnswer(tree.prompt)).toEqual({ answers: true });
  });

  it("names the pin when the prompt half was pinned to a provider that states no model", () => {
    const tree = resolveExecutorTree({ prompt: { kind: "provider", provider: "anthropic" } }, available);
    expect(unnamedModelAnswer(tree.prompt)).toEqual({ answers: false, routes: [], pinned: "anthropic" });
  });
});

describe("the overlay — what a change actually writes", () => {
  it("pins one dotted path and nothing else", () => {
    const overlay = pin(undefined, "prompt.routes.anthropic.model", "claude-haiku-4-5");

    expect(overlay).toEqual({ prompt: { routes: { anthropic: { model: "claude-haiku-4-5" } } } });
    expect(isPinned(overlay, "prompt.routes.anthropic.model")).toBe(true);
    expect(isPinned(overlay, "prompt.routes.local.model")).toBe(false);
  });

  /**
   * Clearing a box UN-PINS rather than writing an empty value, and the containers the removal emptied
   * go with it — so an untouched branch leaves no trace in the file at all.
   */
  it("un-pins on undefined, collapsing every container it emptied", () => {
    const pinned = pin(undefined, "prompt.routes.anthropic.model", "opus");
    expect(pin(pinned, "prompt.routes.anthropic.model", undefined)).toEqual({});
  });

  it("leaves a sibling alone when one path is un-pinned", () => {
    let overlay = pin(undefined, "prompt.routes.anthropic.model", "opus");
    overlay = pin(overlay, "prompt.routes.local.model", "qwen");
    overlay = pin(overlay, "prompt.routes.anthropic.model", undefined);

    expect(overlay).toEqual({ prompt: { routes: { local: { model: "qwen" } } } });
  });

  it("does not mutate the overlay it was given", () => {
    const before: JairaOperationNode = { prompt: { kind: "router", defaults: { temperature: 0 } } };
    pin(before, "prompt.defaults.temperature", 1);
    expect((before.prompt as JairaRouterNode).defaults).toEqual({ temperature: 0 });
  });
});

describe("parsing an executor tree", () => {
  const parse = (executors: unknown) => parseConfig({ executors }).executors;

  it("reads a whole tree — the levels, their settings and their steps", () => {
    const parsed = parse({
      [DEFAULT_EXECUTOR]: {
        description: "the one every UI operation uses",
        function: { rules: ["everything", "-run_command"] },
        prompt: {
          kind: "router",
          defaults: { model: "claude-cli/sonnet", temperature: 0 },
          routes: {
            anthropic: { kind: "provider", model: "claude-haiku-4-5", steps: { rateLimit: { rpm: 60 } } },
            "claude-cli": { kind: "agent", model: "opus", allow: ["opus", "sonnet"] },
          },
        },
        steps: { retry: { validation: { turns: 2, feedback: true } } },
      },
    });

    const tree = parsed[DEFAULT_EXECUTOR]!;
    expect(tree.function?.rules).toEqual(["everything", "-run_command"]);
    expect((tree.prompt as JairaRouterNode).defaults).toEqual({ model: "claude-cli/sonnet", temperature: 0 });
    expect((tree.prompt as JairaRouterNode).routes?.["anthropic"]).toMatchObject({ steps: { rateLimit: { rpm: 60 } } });
    expect(tree.steps?.retry).toEqual({ validation: { turns: 2, feedback: true } });
  });

  it("defaults to no overlay at all, which still means a whole derived tree", () => {
    expect(parseConfig({}).executors).toEqual({});
    expect(resolveExecutorTree(parseConfig({}).executors[DEFAULT_EXECUTOR], available).prompt).toBeDefined();
  });

  it("treats a prompt node with no kind as the router, so nobody writes the obvious", () => {
    expect(parse({ x: { prompt: { defaults: { temperature: 0 } } } })["x"]?.prompt?.kind).toBe("router");
  });

  it("refuses a field a level does not have, naming the ones it does", () => {
    expect(() => parse({ x: { provider: "anthropic" } })).toThrow(/is not a setting/);
    expect(() => parse({ x: { prompt: { kind: "agent", provider: "anthropic" } } })).toThrow(/is not a setting/);
    expect(() => parse({ x: { function: { allow: [] } } })).toThrow(/is not a setting/);
  });

  it("refuses a kind that is not one of the levels", () => {
    expect(() => parse({ x: { prompt: { kind: "wizard" } } })).toThrow(/router, provider, agent/);
    expect(() => parse({ x: { kind: "router" } })).toThrow(/must be "operation"/);
  });

  it("recurses: a route may itself be a router", () => {
    const parsed = parse({
      x: { prompt: { routes: { tiered: { kind: "router", routes: { a: { kind: "agent", agent: "claude-cli" } } } } } },
    });
    const tiered = (parsed["x"]?.prompt as JairaRouterNode).routes?.["tiered"] as JairaRouterNode;
    expect(tiered.routes?.["a"]).toEqual({ kind: "agent", agent: "claude-cli" });
  });

  it("validates a node's steps against the same schemas the form renders from", () => {
    expect(() => parse({ x: { prompt: { steps: { rateLimit: { maxConcurrancy: 4 } } } } })).toThrow(/maxConcurrency/);
    expect(() => parse({ x: { steps: { deadline: {} } } })).toThrow(/maxDurationMs is required/);
  });

  /** A route key and an executor name are both model PREFIXES, and a prefix ends at the first slash. */
  it("refuses a slash in a name or a route key", () => {
    expect(() => parse({ "a/b": {} })).toThrow(/must not contain/);
    expect(() => parse({ x: { prompt: { routes: { "a/b": { kind: "agent" } } } } })).toThrow(/must not contain/);
  });

  it("refuses a model that repeats its own node's prefix, and says what it meant", () => {
    expect(() => parse({ x: { prompt: { kind: "agent", agent: "claude-cli", model: "claude-cli/opus" } } })).toThrow(
      /'opus'/,
    );
  });
});

/**
 * Function rules — an ORDERED list, not an allow list.
 *
 * The useful statements are subtractive: "everything this workflow registers, except the one that
 * runs commands" is one rule after a baseline, where an allow list would have to name every function
 * that exists and be edited again whenever a workflow gains a state.
 */
describe("function rules", () => {
  it("allows everything when nothing is said, which is what an unconfigured project gets", () => {
    expect(functionAllowed(undefined, "run_command")).toBe(true);
    expect(functionAllowed([], "run_command")).toBe(true);
  });

  it("subtracts from a baseline — the statement the whole shape exists for", () => {
    const rules = ["everything", "-run_command"];
    expect(functionAllowed(rules, "read_file")).toBe(true);
    expect(functionAllowed(rules, "run_command")).toBe(false);
  });

  it("reads a list of only additions as an allow list", () => {
    // Otherwise `+read_file` would be a no-op — "everything, plus read_file" — which is the opposite
    // of what anyone typing it means.
    const rules = ["+read_file", "+choose_option"];
    expect(functionAllowed(rules, "read_file")).toBe(true);
    expect(functionAllowed(rules, "run_command")).toBe(false);
  });

  it("takes the LAST matching rule, so order is the meaning", () => {
    expect(functionAllowed(["everything", "-read_file", "+read_file"], "read_file")).toBe(true);
    expect(functionAllowed(["everything", "+read_file", "-read_file"], "read_file")).toBe(false);
  });

  it("starts from nothing when told to", () => {
    const rules = ["nothing", "+choose_option"];
    expect(functionAllowed(rules, "choose_option")).toBe(true);
    expect(functionAllowed(rules, "read_file")).toBe(false);
  });

  it("matches a glob, so a family of functions is one rule", () => {
    expect(functionAllowed(["everything", "-ui_*"], "ui_confirm")).toBe(false);
    expect(functionAllowed(["everything", "-ui_*"], "read_file")).toBe(true);
  });

  it("reads a bare name as an addition, because nobody types the sign first", () => {
    expect(parseFunctionRule("read_file")).toEqual({ kind: "allow", pattern: "read_file" });
    expect(parseFunctionRule("+read_file")).toEqual({ kind: "allow", pattern: "read_file" });
    expect(parseFunctionRule("-read_file")).toEqual({ kind: "deny", pattern: "read_file" });
    expect(parseFunctionRule("everything")).toEqual({ kind: "everything" });
    expect(parseFunctionRule("nothing")).toEqual({ kind: "nothing" });
  });

  it("refuses a rule that is not one, naming the forms that are", () => {
    expect(() => parseConfig({ executors: { x: { function: { rules: ["  "] } } } })).toThrow(/non-empty string/);
  });

  /** The dropdown's starting point — never a list the parser validates against. */
  it("offers the built-ins it knows, each with what it is for", () => {
    expect(BUILTIN_FUNCTIONS.map((f) => f.name)).toContain("run_command");
    expect(BUILTIN_FUNCTIONS.every((f) => f.what.length > 0)).toBe(true);
    // A workflow registers a sub-workflow under its own state id, so an unknown name must be legal.
    expect(() => parseConfig({ executors: { x: { function: { rules: ["+my_workflow/step"] } } } })).not.toThrow();
  });
});
