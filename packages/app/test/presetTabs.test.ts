/**
 * Settings → Executors → Presets, as nested vertical tabs.
 *
 * What is held down here is the pure functions: what the rail lists, and which tab is chosen after a
 * save, an add or a remove (`presetTabsModel.ts`); what the open preset's sections say of themselves
 * (`llmConfigModel.ts`); and where its Model section's candidates stand, which one is picked now and
 * what the parser would refuse (`presetCandidates.ts`). The page that draws them is the universal tree's.
 */
import { describe, expect, it } from "vitest";
import type { LimitsView } from "@jaira/shared";
import { LIMIT_FIELDS, llmCategoriesOf, llmSummariesOf, railMoveOf, railStep } from "../src/renderer/llmConfigModel";
import { PRESET_RULES, candidatesSchema, candidatesViewOf, presetModelLine, presetModelProblem, type CandidateStatus } from "../src/renderer/presetCandidates";
import {
  choiceAfterRemove,
  isDirty,
  presetNameProblem,
  presetSummary,
  presetTabsOf,
  resolveChoice,
} from "../src/renderer/presetTabsModel";

const HERE = { fast: { temperature: 0.2, maxOutputTokens: 1200 }, review: { reasoning: { effort: "high" }, maxOutputTokens: 4000 } };
const EFFECTIVE = { ...HERE, thorough: { reasoning: { effort: "xhigh" }, providerOptions: {} } };
const TABS = presetTabsOf(HERE, EFFECTIVE);

describe("what the presets rail lists", () => {
  it("puts the presets this layer states first, then the ones it only inherits", () => {
    expect(TABS.map((t) => [t.name, t.origin])).toEqual([
      ["fast", "here"],
      ["review", "here"],
      ["thorough", "inherited"],
    ]);
  });

  it("shows the layer's OWN document for a preset stated here, not the merged one", () => {
    const tabs = presetTabsOf({ fast: { temperature: 0.9 } }, { fast: { temperature: 0.9, topP: 0.5 } });
    expect(tabs).toEqual([{ name: "fast", origin: "here", value: { temperature: 0.9 } }]);
  });

  it("says what each preset holds without opening it — the line the row used to show", () => {
    expect(presetSummary(TABS[0]!)).toBe("temperature 0.2 · ≤1200 tokens");
    expect(presetSummary(TABS[2]!)).toBe("inherited · reasoning xhigh · +1 more");
  });

  it("follows an unsaved draft and says that it is one, so an edit left on another tab is not invisible", () => {
    expect(presetSummary(TABS[0]!, { temperature: 0.7 })).toBe("unsaved · temperature 0.7");
    // A draft that says what is saved is not an edit.
    expect(isDirty(TABS[0]!, { temperature: 0.2, maxOutputTokens: 1200 })).toBe(false);
    expect(presetSummary(TABS[0]!, { temperature: 0.2, maxOutputTokens: 1200 })).toBe("temperature 0.2 · ≤1200 tokens");
  });
});

describe("which tab is chosen", () => {
  it("opens on the first preset, and on + preset when there are none", () => {
    expect(resolveChoice(TABS, undefined)).toEqual({ preset: "fast" });
    expect(resolveChoice([], undefined)).toBe("new");
  });

  it("keeps the selection across a Save: the document is re-read and the name still resolves", () => {
    const saved = presetTabsOf({ ...HERE, review: { reasoning: { effort: "low" } } }, EFFECTIVE);
    expect(resolveChoice(saved, { preset: "review" })).toEqual({ preset: "review" });
  });

  it("stays on + preset until an added preset has been written, then moves to it", () => {
    expect(resolveChoice(TABS, { preset: "cheap" }, "cheap")).toBe("new");
    const landed = presetTabsOf({ ...HERE, cheap: {} }, { ...EFFECTIVE, cheap: {} });
    expect(resolveChoice(landed, { preset: "cheap" }, "cheap")).toEqual({ preset: "cheap" });
  });

  it("falls to the first preset when the chosen one is simply gone", () => {
    expect(resolveChoice(TABS, { preset: "deleted-by-hand" })).toEqual({ preset: "fast" });
  });

  it("after a remove takes the next preset down, the one above when it was last, and + preset when it was the only one", () => {
    expect(choiceAfterRemove(TABS, "fast", false)).toEqual({ preset: "review" });
    expect(choiceAfterRemove(TABS.slice(0, 2), "review", false)).toEqual({ preset: "fast" });
    expect(choiceAfterRemove(TABS.slice(0, 1), "fast", false)).toBe("new");
  });

  it("STAYS on a removed preset the other layer also states — the tab turns inherited, it does not go", () => {
    expect(choiceAfterRemove(TABS, "fast", true)).toEqual({ preset: "fast" });
  });
});

describe("a new preset's name", () => {
  it("is refused when empty, dotted, or already in the rail — and says which", () => {
    expect(presetNameProblem("  ", TABS)).toBe("can't be empty");
    expect(presetNameProblem("cheap", TABS)).toBeUndefined();
    // `presets.gpt.fast` would be written as a preset called `gpt` holding a setting called `fast` —
    // and a name with a dot, a dash or a slash could be read as a model id where a model field names it.
    expect(presetNameProblem("gpt.fast", TABS)).toContain("a preset's name is a word");
    expect(presetNameProblem("my-fast", TABS)).toContain("a preset's name is a word");
    // A word a model family claims is refused too: `o3` in a model field must mean the model.
    expect(presetNameProblem("o3", TABS)).toContain("reads as a model id of the openai family");
    // Adding a name the layer already states used to REPLACE it with an empty preset.
    expect(presetNameProblem(" fast ", TABS)).toBe("there is already a preset called 'fast'");
    expect(presetNameProblem("thorough", TABS)).toBe("'thorough' is inherited here — open it and edit it, and the edit is saved here");
  });
});

describe("arrow keys on a rail", () => {
  it("move ALONG a column with up and down, and ACROSS to the rail beside it with left and right", () => {
    expect(railMoveOf("ArrowDown", false)).toBe("next");
    expect(railMoveOf("ArrowUp", false)).toBe("prev");
    expect(railMoveOf("ArrowRight", false)).toBe("in");
    expect(railMoveOf("ArrowLeft", false)).toBe("out");
    expect(railMoveOf("Home", false)).toBe("first");
    expect(railMoveOf("End", false)).toBe("last");
    expect(railMoveOf("a", false)).toBeUndefined();
  });

  it("swap the pairs when the rail has become a row, so the next tab is the one the eye finds next", () => {
    expect(railMoveOf("ArrowRight", true)).toBe("next");
    expect(railMoveOf("ArrowLeft", true)).toBe("prev");
    expect(railMoveOf("ArrowDown", true)).toBe("in");
    expect(railMoveOf("ArrowUp", true)).toBe("out");
  });

  it("wrap at the ends", () => {
    expect(railStep(0, 4, "next")).toBe(1);
    expect(railStep(3, 4, "next")).toBe(0);
    expect(railStep(0, 4, "prev")).toBe(3);
    expect(railStep(2, 4, "first")).toBe(0);
    expect(railStep(2, 4, "last")).toBe(3);
    expect(railStep(0, 0, "next")).toBe(-1);
  });
});

/** The open preset's lead section, as the page hands it to the call-settings form: its Model, first. */
const MODEL_LEAD = { key: "model", label: "Model", hint: "Which model a state that picks this preset runs on, and how it is chosen." } as const;

describe("the editor's rails", () => {
  it("lists every preset with its summary", () => {
    expect(TABS.map((tab) => [tab.name, presetSummary(tab)])).toEqual([
      ["fast", "temperature 0.2 · ≤1200 tokens"],
      ["review", "reasoning high · ≤4000 tokens"],
      ["thorough", "inherited · reasoning xhigh · +1 more"],
    ]);
  });

  it("gives the open preset its sections, the Model first, with the sections' own summaries", () => {
    const fast = TABS[0]!.value;
    const summaries = llmSummariesOf(fast, presetModelLine(fast["model"]));
    // The preset's Model comes first — it is what makes `coder` coder.
    expect(llmCategoriesOf(MODEL_LEAD).map((category) => [category.label, summaries[category.key]])).toEqual([
      ["Model", "not set"],
      ["Sampling", "temperature"],
      ["Reasoning", "off"],
      ["Output limits", "1200 tokens"],
      ["Advanced", "none"],
    ]);
    expect(LIMIT_FIELDS.map((field) => field.label)).toContain("Max output tokens");
  });

  it("has nothing to save or put back on an untouched preset, and something once there is a draft", () => {
    expect(isDirty(TABS[0]!, undefined)).toBe(false);
    expect(isDirty(TABS[0]!, { temperature: 0.7 })).toBe(true);
    expect(presetSummary(TABS[0]!, { temperature: 0.7 })).toBe("unsaved · temperature 0.7");
  });

  it("opens an INHERITED preset in the same sections, saying what it holds", () => {
    expect(llmSummariesOf(TABS[2]!.value).reasoning).toBe("xhigh");
  });
});

describe("the presets that ship built in", () => {
  const SHIPPED = {
    coder: { model: { candidates: ["claude-opus-5-5", "gpt-5.6-terra"], choose: "first-available" }, reasoning: { effort: "high" } },
    simple: { model: { candidates: ["claude-haiku-4-5", "gpt-5.6-luna"], choose: "first-available" } },
  };

  it("tags the rail's tabs: built in, and this layer's copy of what ships once edited", () => {
    const tabs = presetTabsOf({ coder: SHIPPED.coder }, SHIPPED, SHIPPED);
    // `shipped` on a preset stated here is what the page reads as "<layer> · copied from built in".
    expect(tabs.map((tab) => [tab.name, tab.origin, tab.shipped === true, presetSummary(tab)])).toEqual([
      ["coder", "here", true, "first available: opus · gpt-5.6-terra · reasoning high"],
      ["simple", "built-in", false, "first available: haiku · gpt-5.6-luna"],
    ]);
  });

  it("opens a built-in preset EDITABLE — an edit to it is a draft like any other", () => {
    const tabs = presetTabsOf({}, SHIPPED, SHIPPED);
    expect(tabs[0]).toMatchObject({ name: "coder", origin: "built-in" });
    expect(isDirty(tabs[0]!, { ...SHIPPED.coder, reasoning: { effort: "xhigh" } })).toBe(true);
  });

  it("lists a built-in preset untouched by any layer as built in, and one a layer states as that layer's copy", () => {
    const tabs = presetTabsOf({ coder: { ...SHIPPED.coder, reasoning: { effort: "low" } } }, { ...SHIPPED, coder: { ...SHIPPED.coder, reasoning: { effort: "low" } } }, SHIPPED);
    expect(tabs.map((t) => [t.name, t.origin, t.shipped === true])).toEqual([
      ["coder", "here", true],
      ["simple", "built-in", false],
    ]);
    // A shared layer that changed one field of what ships makes it an inherited preset, not a built-in one.
    const touched = presetTabsOf({}, { ...SHIPPED, simple: { ...SHIPPED.simple, maxOutputTokens: 10 } }, SHIPPED);
    expect(touched.find((t) => t.name === "simple")!.origin).toBe("inherited");
  });

  it("will not name a new preset after a built-in one", () => {
    const tabs = presetTabsOf({}, SHIPPED, SHIPPED);
    expect(presetNameProblem("coder", tabs)).toBe("'coder' ships built in — open it and edit it, and the edit is saved here");
  });
});

describe("the Model section", () => {
  const coder = { model: { candidates: ["claude-opus-5-5", "gpt-5.6-terra"], choose: "first-available" }, reasoning: { effort: "high" } };
  const lookup = (model: string): CandidateStatus =>
    model === "gpt-5.6-terra" ? { state: "available", route: "codex-cli", plan: "ChatGPT" } : { state: "unavailable", why: "claude-cli is not signed in" };
  /** No reading of any account's allowance: what the limits board holds before the first one arrives. */
  const NO_LIMITS: LimitsView = { accounts: [], routeAccounts: {} };

  it("comes first in the sections, summarised as its rule and its models", () => {
    expect(llmCategoriesOf(MODEL_LEAD)[0]).toMatchObject({ key: "model", label: "Model" });
    expect(llmSummariesOf(coder, presetModelLine(coder.model)).model).toBe("first available: opus · gpt-5.6-terra");
  });

  it("has the rule, then each candidate with its route, whether it can run, and the one picked now", () => {
    const view = candidatesViewOf(coder.model, lookup, NO_LIMITS);
    // The two rules the choice offers, in order, and the one this preset states.
    expect(PRESET_RULES.map(([label]) => label)).toEqual(["The first available", "The most left"]);
    expect(view.rule).toBe("first-available");
    // One row per candidate, in order, each box offering the models the host suggests.
    expect(view.candidates).toEqual(["claude-opus-5-5", "gpt-5.6-terra"]);
    expect(candidatesSchema(["claude-opus-5-5", "gpt-5.6-terra"])).toMatchObject({ type: "array", items: { type: "string", examples: ["claude-opus-5-5", "gpt-5.6-terra"] } });
    expect(view.statuses).toEqual([
      { state: "unavailable", why: "claude-cli is not signed in" },
      { state: "available", route: "codex-cli", plan: "ChatGPT" },
    ]);
    // The first that can run is the one picked now — the second here.
    expect(view.picked).toBe(1);
    expect(view.problem).toBeUndefined();
  });

  it("says when nothing has been checked yet, and picks nothing", () => {
    const view = candidatesViewOf(coder.model, (): CandidateStatus => ({ state: "unchecked" }), NO_LIMITS);
    expect(view.statuses).toEqual([{ state: "unchecked" }, { state: "unchecked" }]);
    expect(view.picked).toBe(-1);
  });

  it("has no rows and no complaint when the preset states no model, and is summarised as not set", () => {
    expect(candidatesViewOf(undefined, lookup, NO_LIMITS)).toMatchObject({ candidates: [], picked: -1, problem: undefined });
    expect(presetModelLine(undefined)).toBe("not set");
  });

  it("will not save a candidate list the parser would refuse, and says why once nothing is still being typed", () => {
    const bad = { candidates: ["gpt-5"], choose: "most-budget-left" };
    expect(presetModelProblem(bad)).toBe('model.choose must be "first-available" or "most-left"');
    expect(candidatesViewOf(bad, lookup, NO_LIMITS).problem).toBe('model.choose must be "first-available" or "most-left"');
    // A row still being typed is not a mistake yet.
    expect(candidatesViewOf({ ...bad, candidates: ["gpt-5", ""] }, lookup, NO_LIMITS).problem).toBeUndefined();
  });
});

