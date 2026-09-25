/**
 * Settings → Executors → Presets, as nested vertical tabs.
 *
 * The renderer has no DOM test infrastructure, so this is held down in two layers: the pure functions
 * that decide what the rail lists and which tab is chosen after a save, an add or a remove, and the
 * render function drawn to static markup in each state it can be in. `PresetTabs` takes every piece
 * of its state as a prop for exactly this reason.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { railMoveOf, railStep } from "../src/renderer/llmConfigForm";
import {
  PresetTabs,
  choiceAfterRemove,
  isDirty,
  presetNameProblem,
  presetSummary,
  presetTabsOf,
  resolveChoice,
  type PresetChoice,
  type PresetTabsProps,
} from "../src/renderer/presetTabs";
import { PresetModelSection, presetModelLine, presetModelProblem, type CandidateStatus } from "../src/renderer/presetModel";

const HERE = { fast: { temperature: 0.2, maxOutputTokens: 1200 }, review: { reasoning: { effort: "high" }, maxOutputTokens: 4000 } };
const EFFECTIVE = { ...HERE, thorough: { reasoning: { effort: "xhigh" }, providerOptions: {} } };
const TABS = presetTabsOf(HERE, EFFECTIVE);

const draw = (choice: PresetChoice, extra: Partial<PresetTabsProps> = {}): string =>
  renderToStaticMarkup(
    createElement(PresetTabs, {
      tabs: TABS,
      choice,
      onChoice: () => undefined,
      section: "sampling",
      onSection: () => undefined,
      drafts: {},
      onDraft: () => undefined,
      newName: "",
      onNewName: () => undefined,
      locked: false,
      originOf: () => "Shared (all projects)",
      layerWord: "shared",
      lookup: () => ({ state: "unchecked" as const }),
      suggestions: [],
      onSave: () => undefined,
      onRemove: () => undefined,
      onAdd: () => undefined,
      ...extra,
    }),
  );

/** Every tab of one rail, as `[text, selected, tabindex]`. */
function tabsOf(html: string, label: string): Array<[string, boolean, string]> {
  const rail = new RegExp(`<nav[^>]*aria-label="${label}"[^>]*>(.*?)</nav>`, "s").exec(html)?.[1] ?? "";
  return Array.from(rail.matchAll(/<button([^>]*)>(.*?)<\/button>/gs)).map((m) => [
    m[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    /aria-selected="true"/.test(m[1]!),
    /tabindex="(-?\d)"/.exec(m[1]!)?.[1] ?? "",
  ]);
}

/** The controls a person could type into or choose from, and whether each is inert. */
const controlsOf = (html: string): string[] => Array.from(html.matchAll(/<(input|select|textarea)\b[^>]*>/g)).map((m) => m[0]);

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

describe("the editor, drawn", () => {
  it("is ONE box holding two tablists and a panel: the presets, the open preset's sections, its fields", () => {
    const html = draw({ preset: "fast" });
    expect(html.match(/class="llm-config/g)).toHaveLength(1);
    expect(html).toContain('class="llm-config preset-config"');
    expect(html.match(/role="tablist"/g)).toHaveLength(2);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(1);
    // The outer rail comes first, and is the one marked as such.
    expect(html.indexOf('aria-label="Presets"')).toBeLessThan(html.indexOf('aria-label="Sections"'));
    expect(html).toContain('class="llm-rail preset-rail"');
  });

  it("lists every preset with its summary, closed by + preset, and only the chosen tab is a tab stop", () => {
    expect(tabsOf(draw({ preset: "review" }), "Presets")).toEqual([
      ["fast temperature 0.2 · ≤1200 tokens", false, "-1"],
      ["review reasoning high · ≤4000 tokens", true, "0"],
      ["thorough inherited · reasoning xhigh · +1 more", false, "-1"],
      ["+ preset", false, "-1"],
    ]);
  });

  it("marks with a dot the presets the layer being edited states, and not the inherited one", () => {
    const html = draw({ preset: "fast" });
    expect(html.match(/set-here-dot/g)).toHaveLength(2);
    expect(html).toMatch(/thorough<\/span>/);
  });

  it("opens the section the host names, with the sections' own summaries", () => {
    const html = draw({ preset: "fast" }, { section: "limits" });
    expect(tabsOf(html, "Sections")).toEqual([
      // The preset's Model comes first — it is what makes `coder` coder.
      ["Model not set", false, "-1"],
      ["Sampling temperature", false, "-1"],
      ["Reasoning off", false, "-1"],
      ["Output limits 1200 tokens", true, "0"],
      ["Advanced none", false, "-1"],
    ]);
    expect(html).toContain("Max output tokens");
  });

  it("ends a preset stated here in Save and Revert, with Remove <name> at the far end", () => {
    const html = draw({ preset: "fast" });
    const actions = /<div class="pane-actions">(.*?)<\/div>/s.exec(html)![1]!;
    expect(actions.replace(/<[^>]+>/g, "|").split("|").filter((s) => s.length > 0)).toEqual(["Save", "Revert", "Remove fast"]);
    // The spacer is what puts Remove away from the other two.
    expect(actions).toMatch(/Revert<\/button><span class="grow"><\/span><button[^>]*class="ghost danger"/);
    // Untouched: nothing to save or put back. Remove is always there.
    expect(actions).toMatch(/<button[^>]*disabled=""[^>]*>Save/);
    expect(actions).toMatch(/<button[^>]*disabled=""[^>]*>Revert/);
    expect(actions).not.toMatch(/<button[^>]*disabled=""[^>]*>Remove/);
  });

  it("draws the draft once there is one, and Save and Revert come alive", () => {
    const html = draw({ preset: "fast" }, { drafts: { fast: { temperature: 0.7 } } });
    expect(html).toContain('value="0.7"');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Save/);
    expect(tabsOf(html, "Presets")[0]![0]).toBe("fast unsaved · temperature 0.7");
  });

  it("opens an INHERITED preset in the same editor, editable, saying its first save is the copy", () => {
    const html = draw({ preset: "thorough" }, { section: "reasoning" });
    expect(html.match(/role="tablist"/g)).toHaveLength(2);
    expect(tabsOf(html, "Sections")[2]).toEqual(["Reasoning xhigh", true, "0"]);

    const controls = controlsOf(html);
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.some((control) => !control.includes('disabled=""'))).toBe(true);

    // `set here` means the layer being edited states it, which is false of everything in this one.
    expect(html).not.toContain("cfg-set");
    expect(draw({ preset: "review" }, { section: "reasoning" })).toContain("cfg-set");

    expect(html.replace(/<[^>]+>/g, "")).toContain("inherited from Shared (all projects). Saving a change copies it into");
    // No Override here: Save is the copy. Nothing of this layer's to remove yet.
    // The pane's ACTIONS — not its tabs, and not the set/not-set switches SchemaForm draws beside each field.
    const buttons = Array.from(html.matchAll(/<button(?![^>]*role="(?:tab|switch)")[^>]*>(.*?)<\/button>/gs)).map((m) => m[1]);
    expect(buttons).toEqual(["Save", "Revert"]);
    expect(html).not.toContain("Override here");
  });

  it("asks only for a Name under + preset, with no section rail until it has one", () => {
    const html = draw("new", { newName: "cheap" });
    expect(html).toContain('class="llm-config preset-config preset-new"');
    expect(html.match(/role="tablist"/g)).toHaveLength(1);
    expect(tabsOf(html, "Presets").at(-1)).toEqual(["+ preset", true, "0"]);
    expect(html).toContain("A new preset");
    expect(controlsOf(html)).toHaveLength(1);
    expect(html).toContain('value="cheap"');
    // The key tag reads as the path the name is written to.
    expect(html).toContain("models.presets.&lt;name&gt;");
    expect(html).toMatch(/<button[^>]*class="primary"[^>]*>Add it/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Add it/);
  });

  it("will not add a name it would have to refuse: inert while empty, and the reason under the box once typed", () => {
    const empty = draw("new");
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>Add it/);
    expect(empty).not.toContain("can&#x27;t be empty");

    const taken = draw("new", { newName: "fast" });
    expect(taken).toMatch(/<button[^>]*disabled=""[^>]*>Add it/);
    expect(taken).toContain("there is already a preset called &#x27;fast&#x27;");
  });

  it("opens on + preset when there is nothing else to open", () => {
    const html = draw(resolveChoice([], undefined), { tabs: [] });
    expect(tabsOf(html, "Presets")).toEqual([["+ preset", true, "0"]]);
    expect(html).toContain("A new preset");
  });

  it("goes inert while the layer is being written, but the rails still move", () => {
    const html = draw({ preset: "fast" }, { locked: true, drafts: { fast: { temperature: 0.7 } } });
    for (const control of controlsOf(html)) expect(control).toContain('disabled=""');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Remove fast/);
    // Revert only touches the draft, so it stays.
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Revert/);
    expect(html).not.toMatch(/<button[^>]*role="tab"[^>]*disabled/);
  });
});

describe("the presets that ship built in", () => {
  const SHIPPED = {
    coder: { model: { candidates: ["claude-opus-5-5", "gpt-5.6-terra"], choose: "first-available" }, reasoning: { effort: "high" } },
    simple: { model: { candidates: ["claude-haiku-4-5", "gpt-5.6-luna"], choose: "first-available" } },
  };
  /** claude-cli signed in on a max plan; codex signed out; no OpenAI key. */
  const lookup = (model: string): CandidateStatus =>
    model.startsWith("claude")
      ? { state: "available", route: "claude-cli", plan: "max" }
      : { state: "unavailable", why: "codex-cli is not signed in" };

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

  it("tags the rail: built in, and '<layer> · copied from built in' once edited", () => {
    const tabs = presetTabsOf({ coder: SHIPPED.coder }, SHIPPED, SHIPPED);
    const html = draw({ preset: "simple" }, { tabs, lookup });
    expect(tabsOf(html, "Presets")).toEqual([
      ["coder shared · copied from built in first available: opus · gpt-5.6-terra · reasoning high", false, "-1"],
      ["simple built in first available: haiku · gpt-5.6-luna", true, "0"],
      ["+ preset", false, "-1"],
    ]);
    expect(html).toMatch(/<span class="cx-src">built in<\/span>/);
  });

  it("opens a built-in preset EDITABLE, with Save and no Remove — a save writes it into this layer", () => {
    const tabs = presetTabsOf({}, SHIPPED, SHIPPED);
    const html = draw({ preset: "coder" }, { tabs, lookup, section: "reasoning" });
    for (const control of controlsOf(html)) expect(control).not.toContain('disabled=""');
    expect(html.replace(/<[^>]+>/g, "")).toContain("What JaiRA ships. Saving a change copies it into shared, where it wins");
    const actions = /<div class="pane-actions">(.*?)<\/div>/s.exec(html)![1]!;
    expect(actions.replace(/<[^>]+>/g, "|").split("|").filter((s) => s.length > 0)).toEqual(["Save", "Revert"]);
    // An edit to it is a draft like any other.
    expect(isDirty(tabs[0]!, { ...SHIPPED.coder, reasoning: { effort: "xhigh" } })).toBe(true);
  });

  it("offers 'Put back the built-in' — not a red Remove — on this layer's copy of one", () => {
    const tabs = presetTabsOf({ coder: SHIPPED.coder }, SHIPPED, SHIPPED);
    const html = draw({ preset: "coder" }, { tabs, lookup });
    const actions = /<div class="pane-actions">(.*?)<\/div>/s.exec(html)![1]!;
    expect(actions).toMatch(/<button[^>]*class="ghost"[^>]*>Put back the built-in<\/button>/);
    expect(actions).not.toContain("Remove");
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
  const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

  it("comes first in the sections, summarised as its rule and its models", () => {
    const tabs = presetTabsOf({ coder }, { coder });
    const html = draw({ preset: "coder" }, { tabs, lookup, section: "model" });
    expect(tabsOf(html, "Sections")[0]).toEqual(["Model first available: opus · gpt-5.6-terra", true, "0"]);
  });

  it("shows the rule pressed, then each candidate with its route, whether it can run, and the one picked now", () => {
    const html = renderToStaticMarkup(
      createElement(PresetModelSection, { value: coder.model, onChange: () => undefined, disabled: false, lookup, suggestions: ["claude-opus-5-5", "gpt-5.6-terra"] }),
    );
    expect(html).toMatch(
      /<div class="set-seg" role="group" aria-label="How a candidate is chosen"><button[^>]*aria-pressed="true"[^>]*>The first available<\/button><button[^>]*aria-pressed="false"[^>]*>The most left<\/button><\/div>/,
    );
    // One row per candidate, through the schema form's list editor — in order, movable.
    expect(html.match(/class="cfg-list-row"/g)).toHaveLength(2);
    expect(html).toContain('value="claude-opus-5-5"');
    expect(html).toContain('value="gpt-5.6-terra"');
    expect(html).toContain('title="move up"');
    const rows = Array.from(html.matchAll(/<div class="preset-candidate">(.*?)<\/div>/gs)).map((m) => text(m[1]!).trim());
    expect(rows).toEqual(["not available — claude-cli is not signed in", "via codex-cli · ChatGPT available picked now"]);
    expect(text(html)).toContain("+ another model");
  });

  it("says when nothing has been checked yet, and picks nothing", () => {
    const html = renderToStaticMarkup(
      createElement(PresetModelSection, { value: coder.model, onChange: () => undefined, disabled: false, lookup: (): CandidateStatus => ({ state: "unchecked" }), suggestions: [] }),
    );
    expect(text(html)).toContain("not checked yet");
    expect(html).not.toContain("picked now");
  });

  it("is switched off when the preset states no model, and summarised as not set", () => {
    const html = renderToStaticMarkup(createElement(PresetModelSection, { value: undefined, onChange: () => undefined, disabled: false, lookup, suggestions: [] }));
    expect(html).toContain('class="cfg-field wide off"');
    expect(presetModelLine(undefined)).toBe("not set");
  });

  it("will not save a candidate list the parser would refuse, and says why once nothing is still being typed", () => {
    const bad = { candidates: ["gpt-5"], choose: "most-budget-left" };
    expect(presetModelProblem(bad)).toBe('model.choose must be "first-available" or "most-left"');
    const html = draw({ preset: "coder" }, { tabs: presetTabsOf({ coder }, { coder }), lookup, drafts: { coder: { ...coder, model: bad } } });
    expect(html).toMatch(/<button[^>]*class="primary"[^>]*disabled=""[^>]*>Save/);
  });
});
