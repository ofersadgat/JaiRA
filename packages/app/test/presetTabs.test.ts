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
      onSave: () => undefined,
      onRemove: () => undefined,
      onOverride: () => undefined,
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
    // `presets.gpt.fast` would be written as a preset called `gpt` holding a setting called `fast`.
    expect(presetNameProblem("gpt.fast", TABS)).toContain("can't contain a dot");
    // Adding a name the layer already states used to REPLACE it with an empty preset.
    expect(presetNameProblem(" fast ", TABS)).toBe("there is already a preset called 'fast'");
    expect(presetNameProblem("thorough", TABS)).toBe("'thorough' is inherited here — open it and choose Override here");
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

  it("opens an INHERITED preset in the same editor, read-only, saying where it comes from", () => {
    const html = draw({ preset: "thorough" }, { section: "reasoning" });
    expect(html.match(/role="tablist"/g)).toHaveLength(2);
    expect(tabsOf(html, "Sections")[1]).toEqual(["Reasoning xhigh", true, "0"]);

    const controls = controlsOf(html);
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(control).toContain('disabled=""');

    // `set here` means the layer being edited states it, which is false of everything in this one.
    expect(html).not.toContain("cfg-set");
    expect(draw({ preset: "review" }, { section: "reasoning" })).toContain("cfg-set");

    expect(html.replace(/<[^>]+>/g, "")).toContain("inherited from Shared (all projects). Nothing here can be changed in this layer until it is overridden.");
    // Override here is the only action: nothing to save, nothing of this layer's to remove.
    const buttons = Array.from(html.matchAll(/<button(?![^>]*role="tab")[^>]*>(.*?)<\/button>/gs)).map((m) => m[1]);
    expect(buttons).toEqual(["Override here"]);
  });

  it("keeps every inherited section read-only, the JSON escape hatch included", () => {
    for (const section of ["sampling", "limits", "advanced"] as const) {
      const controls = controlsOf(draw({ preset: "thorough" }, { section }));
      for (const control of controls) expect(control).toContain('disabled=""');
    }
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
