/**
 * Settings → Toolsets and the state editor's one Tools field (decision 0007 §6).
 *
 * Three claims, and every one of them is about a pure function — there is no DOM harness here, so
 * logic that lives in a component is logic nothing asserts (`toolsetsPane.tsx`'s own header):
 *
 *  - what the RAIL lists, and which toolset stays open through a write;
 *  - what a section's add-menu offers and what its minus takes away (`composerToolset.ts`);
 *  - the state field's ROUND TRIP — `$ref` plus siblings in, the same document out, and an
 *    unmigrated state left with the two fields it has always had.
 *
 * Plus one render: the pane and the field are drawn to static markup, which is what a still picture
 * of them is, and is enough to catch a component that throws on a shape the model allows.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MODE_WHEN_UNSET,
  parseToolset,
  SCRIPT_SUBJECT,
  toolsetsAt,
  type ToolChoice,
  type ToolsetChoice,
  type ToolsetDecl,
  type ToolsetRecord,
  type ToolsetsView as ToolsetsData,
} from "@jaira/shared/browser";
import {
  addableScript,
  addableTools,
  commandGroupsOf,
  suggestedPrograms,
  suggestedSubcommands,
  withoutProgram,
  withToolHeld,
} from "../src/renderer/composerToolset";
import { applyOperationFields, operationFieldsOf } from "../src/renderer/operationForm";
import { ToolsFieldControl } from "../src/renderer/toolsField";
import {
  applyToolsField,
  linesOfToolset,
  NO_TOOLSET_LABEL,
  pickOfReference,
  referenceOfLabel,
  showsToolsField,
  toolsetPicks,
  toolsFieldOf,
} from "../src/renderer/toolsFieldForm";
import { openSectionsOf } from "../src/renderer/toolsetCard";
import { detachingLines, newToolsetProblem, toolsetRailItems, ToolsetsView } from "../src/renderer/toolsetsPane";

const SHIPPED: ToolsetDecl = { read_file: "allow", glob: "allow", bash: "deny", "git status": "allow", other: "deny" };

const records: ToolsetRecord[] = [
  {
    id: "chat/read-only",
    bucket: "chat",
    name: "read-only",
    files: [
      { layer: "project", file: ".jaira/toolsets/chat/read-only.json", format: "json", follows: "$SYSTEM/toolsets/chat/read-only", decl: { ...SHIPPED, bash: "ask" } },
      { layer: "system", file: "built in/toolsets/chat/read-only.json", format: "json", decl: SHIPPED },
    ],
  },
  { id: "chat/full", bucket: "chat", name: "full", files: [{ layer: "system", file: "built in/toolsets/chat/full.json", format: "json", decl: { bash: "allow", other: "allow" } }] },
  {
    id: "feature/writes",
    bucket: "feature",
    name: "writes",
    files: [{ layer: "project", file: ".jaira/toolsets/feature/writes.json", format: "json", decl: { edit: "ask", "git commit": "ask", other: "ask" } }],
  },
];

const tools: ToolChoice[] = [
  { name: "read_file", natives: { "claude-cli": "Read" } },
  { name: "glob" },
  { name: "grep" },
  { name: "edit" },
  { name: "write_file" },
  { name: "bash", natives: { "claude-cli": "Bash" } },
  { name: "web_fetch" },
];

describe("the rail", () => {
  it("is the bucket hierarchy: a heading per bucket, its toolsets, + toolset, and + bucket last", () => {
    const items = toolsetRailItems(toolsetsAt(records, "project"), "project", {});
    expect(items.map((item) => [item.id, item.heading !== undefined, item.indent])).toEqual([
      ["bucket:chat", true, 0],
      ["toolset:chat/read-only", false, 0],
      ["toolset:chat/full", false, 0],
      ["new:chat", false, 0],
      ["bucket:feature", true, 0],
      ["toolset:feature/writes", false, 0],
      ["new:feature", false, 0],
      ["+bucket", false, undefined],
    ]);
  });

  it("indents a nested bucket under its parent", () => {
    const nested: ToolsetRecord = { id: "feature/impl/reads", bucket: "feature/impl", name: "reads", files: [{ layer: "project", file: "x", format: "json", decl: SHIPPED }] };
    const items = toolsetRailItems(toolsetsAt([...records, nested], "project"), "project", {});
    expect(items.filter((item) => item.id.startsWith("bucket:")).map((item) => [item.id, item.indent])).toEqual([
      ["bucket:chat", 0],
      ["bucket:feature", 0],
      ["bucket:feature/impl", 1],
    ]);
  });

  it("offers no + rows on the built-in layer: nothing can be added to what ships", () => {
    const items = toolsetRailItems(toolsetsAt(records, "system"), "system", {});
    expect(items.some((item) => item.id.startsWith("new:") || item.id === "+bucket")).toBe(false);
  });

  it("marks what THIS layer states, and marks nothing on the layer that states everything", () => {
    const here = (layer: "project" | "system"): string[] =>
      toolsetRailItems(toolsetsAt(records, layer), layer, {})
        .filter((item) => item.heading === undefined && renderToStaticMarkup(createElement("i", {}, item.label)).includes("set-here-dot"))
        .map((item) => item.id);
    expect(here("project")).toEqual(["toolset:chat/read-only", "toolset:feature/writes"]);
    // Every shipped toolset is stated by the built-in layer, so a dot on each would say nothing.
    expect(here("system")).toEqual([]);
  });

  it("says a row is unsaved from its draft", () => {
    const draft = parseToolset({ read_file: "allow", other: "deny" }).toolset;
    const items = toolsetRailItems(toolsetsAt(records, "project"), "project", { "chat/read-only": draft });
    expect(items.find((item) => item.id === "toolset:chat/read-only")?.summary).toBe("unsaved · 1 line · other deny");
  });
});

describe("what a save will do", () => {
  it("names the lines that make an override stop following, and nothing while none do", () => {
    const [readOnly] = toolsetsAt(records, "project");
    expect(detachingLines(readOnly!, parseToolset({ ...SHIPPED, bash: "allow" }).toolset)).toEqual([]);
    const { glob: _gone, ...rest } = SHIPPED;
    expect(detachingLines(readOnly!, parseToolset(rest).toolset)).toEqual(["glob"]);
    expect(detachingLines(readOnly!, undefined)).toEqual([]);
  });

  it("refuses a new name the layer already holds, and one a reference could not carry", () => {
    const ats = toolsetsAt(records, "project");
    expect(newToolsetProblem(ats, "chat", "read-only")).toMatch(/already a toolset/);
    expect(newToolsetProblem(ats, "chat", "full")).toMatch(/inherited/);
    expect(newToolsetProblem(ats, "chat", "a b")).toMatch(/letters, digits/);
    expect(newToolsetProblem(ats, "", "ok")).toMatch(/bucket/);
    expect(newToolsetProblem(ats, "chat", "quiet")).toBeUndefined();
  });
});

describe("a section's add line and its minus", () => {
  const toolset = parseToolset({ read_file: "allow", bash: "ask", "git status": "allow", "git commit": "ask", script: "ask", other: "deny" }).toolset;

  it("offers only what the section does not hold, and only what this project registers", () => {
    expect(addableTools(toolset, "files", tools.map((t) => t.name))).toEqual(["glob", "grep", "edit", "write_file"]);
    expect(addableTools(toolset, "execution", tools.map((t) => t.name))).toEqual([]);
    expect(addableScript(toolset)).toBe(false);
    expect(addableScript(parseToolset({ other: "deny" }).toolset)).toBe(true);
  });

  it("suggests the subcommands of a program it does not already name, and the programs it names none of", () => {
    expect(suggestedSubcommands(toolset, "git")).not.toContain("git status");
    expect(suggestedSubcommands(toolset, "git")).toContain("git push");
    expect(suggestedPrograms(toolset)).not.toContain("git");
    expect(suggestedPrograms(toolset)).toContain("npm");
  });

  it("takes a whole program out with every subcommand under it, and nothing else", () => {
    const without = withoutProgram(toolset, "git");
    expect(commandGroupsOf(without)).toEqual([]);
    expect(Object.keys(without.entries)).toEqual(["read_file", "bash", SCRIPT_SUBJECT]);
  });

  it("removing a tool takes its line out — absent is how a map says not offered", () => {
    expect(Object.keys(withToolHeld(toolset, {}, "read_file", false).entries)).not.toContain("read_file");
  });

  it("opens on the sections that hold a line", () => {
    expect(openSectionsOf(toolset)).toEqual(["files", "execution"]);
    expect(openSectionsOf(parseToolset({ other: "deny" }).toolset)).toEqual([]);
  });
});

describe("the state editor's one Tools field", () => {
  it("reads all three spellings, and writes each back as the plain one", () => {
    const bare = "$/toolsets/chat/read-only";
    expect(toolsFieldOf(bare)).toEqual({ reference: bare, lines: {}, unread: {} });
    expect(applyToolsField(bare, toolsFieldOf(bare)!)).toBe(bare);

    const over = { $ref: bare, write_file: "ask" };
    expect(toolsFieldOf(over)).toEqual({ reference: bare, lines: { write_file: "ask" }, unread: {} });
    expect(applyToolsField(over, toolsFieldOf(over)!)).toBe(over);

    const map = { read_file: "allow", other: "deny" };
    expect(toolsFieldOf(map)).toEqual({ reference: "", lines: map, unread: {} });
    expect(applyToolsField(map, toolsFieldOf(map)!)).toBe(map);

    expect(toolsFieldOf(undefined)).toEqual({ reference: "", lines: {}, unread: {} });
    expect(applyToolsField(undefined, toolsFieldOf(undefined)!)).toBeUndefined();
  });

  it("hands the document back UNCHANGED when nothing was edited — spelling and order and all", () => {
    // A `$ref` object with one sibling could be written as either spelling; the one on disk wins.
    const written = { $ref: "$/toolsets/chat/read-only", "git commit": "ask", write_file: { mode: "ask", implementation: "native" } };
    expect(applyToolsField(written, toolsFieldOf(written)!)).toBe(written);
  });

  it("changes spelling only when what it says changes", () => {
    const bare = "$/toolsets/chat/read-only";
    const form = toolsFieldOf(bare)!;
    expect(applyToolsField(bare, { ...form, lines: { edit: "ask" } })).toEqual({ $ref: bare, edit: "ask" });
    // Dropping the last line goes back to a bare reference; dropping the reference leaves the map.
    expect(applyToolsField({ $ref: bare, edit: "ask" }, { reference: bare, lines: {}, unread: {} })).toBe(bare);
    expect(applyToolsField({ $ref: bare, edit: "ask" }, { reference: "", lines: { edit: "ask" }, unread: {} })).toEqual({ edit: "ask" });
    // …and a state that names neither writes no `tools` key at all.
    expect(applyToolsField({ $ref: bare }, { reference: "", lines: {}, unread: {} })).toBeUndefined();
  });

  it("carries a sibling it could not read straight through, rather than deleting the evidence", () => {
    const odd = { $ref: "$/toolsets/chat/read-only", read_file: "sometimes" };
    const form = toolsFieldOf(odd)!;
    expect(form).toMatchObject({ lines: {}, unread: { read_file: "sometimes" } });
    expect(applyToolsField(odd, form)).toBe(odd);
    // It survives an edit to a different line.
    expect(applyToolsField(odd, { ...form, lines: { edit: "ask" } })).toEqual({ $ref: "$/toolsets/chat/read-only", read_file: "sometimes", edit: "ask" });
  });

  it("is not the form's field for a LIST, a binding, or a block with the old permissions in it", () => {
    expect(toolsFieldOf(["read_file"])).toBeUndefined();
    expect(toolsFieldOf({ $expr: ".inputs.tools" })).toBeUndefined();
    expect(showsToolsField({ tools: ["read_file"] })).toBe(false);
    expect(showsToolsField({ permissions: { profile: "read-only" } })).toBe(false);
    expect(showsToolsField({ permissions: { tools: { read_file: "allow" } } })).toBe(false);
    // A `permissions` block holding something else entirely (scopes) is not the legacy statement.
    expect(showsToolsField({ permissions: { scopes: [] } })).toBe(true);
    expect(showsToolsField({ tools: "$/toolsets/chat/read-only", permissions: { profile: "read-only" } })).toBe(true);
    expect(showsToolsField({})).toBe(true);
  });

  it("round-trips through the whole operation form, leaving an unmigrated block's two fields alone", () => {
    const migrated = { kind: "prompt", prompt: "go", tools: { $ref: "$/toolsets/chat/read-only", write_file: "ask" } };
    const form = operationFieldsOf(migrated);
    expect(form.toolsField).toEqual({ reference: "$/toolsets/chat/read-only", lines: { write_file: "ask" }, unread: {} });
    expect(applyOperationFields(migrated, form)).toEqual(migrated);

    const legacy = { kind: "prompt", prompt: "go", tools: ["read_file"], permissions: { profile: "read-only", tools: { read_file: "allow" } } };
    const legacyForm = operationFieldsOf(legacy);
    expect(legacyForm.toolsField).toBeUndefined();
    expect(legacyForm.fields["tools"]).toBe("read_file");
    expect(legacyForm.permissions).toEqual({ profile: "read-only", default: "", tools: [{ tool: "read_file", mode: "allow" }] });
    expect(applyOperationFields(legacy, legacyForm)).toEqual(legacy);
  });

  it("writes the toolset the picker chose, and the lines the rows changed", () => {
    const block = { kind: "prompt", tools: "$/toolsets/chat/read-only" };
    const form = operationFieldsOf(block);
    const next = applyOperationFields(block, { ...form, toolsField: { ...form.toolsField!, reference: "$/toolsets/chat/full", lines: { bash: "deny" } } });
    expect(next["tools"]).toEqual({ $ref: "$/toolsets/chat/full", bash: "deny" });
    // "none" is a real answer, and it leaves the lines behind as the whole statement.
    const none = applyOperationFields(block, { ...form, toolsField: { reference: "", lines: { bash: "deny" }, unread: {} } });
    expect(none["tools"]).toEqual({ bash: "deny" });
  });

  it("lines are not a whole toolset: `other` is written only when a line says it", () => {
    // `declOfToolset` always writes `other`; lines over a toolset must not, or every state opened in
    // the form would start overriding the toolset's own catch-all.
    expect(linesOfToolset(parseToolset({ edit: "ask" }).toolset)).toEqual({ edit: "ask" });
    expect(linesOfToolset(parseToolset({ edit: "ask", other: "deny" }).toolset)).toEqual({ edit: "ask", other: "deny" });
    expect(linesOfToolset(parseToolset({ write_file: { mode: "ask", implementation: "native" } }).toolset)).toEqual({ write_file: { mode: "ask", implementation: "native" } });
  });
});

describe("the toolset picker", () => {
  const choices: ToolsetChoice[] = [
    { id: "chat/read-only", bucket: "chat", name: "read-only", layer: "project", decl: SHIPPED },
    { id: "chat/full", bucket: "chat", name: "full", layer: "system", decl: SHIPPED },
    { id: "feature/impl/reads", bucket: "feature/impl", name: "reads", layer: "base", decl: SHIPPED },
  ];

  it("lists every toolset as `bucket / name — layer`, then none", () => {
    expect(toolsetPicks(choices, "").map((pick) => pick.label)).toEqual([
      "chat / read-only — this project",
      "chat / full — built in",
      "feature / impl / reads — all projects",
      NO_TOOLSET_LABEL,
    ]);
  });

  it("lists a reference nobody offers FIRST, as written — a form never restates what a state names", () => {
    const picks = toolsetPicks(choices, "$BASE/toolsets/team/review");
    expect(picks[0]).toEqual({ label: "$BASE/toolsets/team/review — as written", reference: "$BASE/toolsets/team/review" });
    expect(pickOfReference(picks, "$BASE/toolsets/team/review")).toBe(picks[0]);
  });

  it("falls to none for a reference that is empty, and reads a label back as its reference", () => {
    const picks = toolsetPicks(choices, "");
    expect(pickOfReference(picks, "").label).toBe(NO_TOOLSET_LABEL);
    expect(referenceOfLabel(picks, "chat / full — built in")).toBe("$/toolsets/chat/full");
    expect(referenceOfLabel(picks, NO_TOOLSET_LABEL)).toBe("");
    expect(referenceOfLabel(picks, "half a wor")).toBeUndefined();
  });
});

describe("drawn", () => {
  const data: ToolsetsData = { records, usedBy: { "chat/read-only": ["sync/review", "a", "b"] }, tools, layers: ["project", "base", "system"] };
  const none = (): void => undefined;
  const draw = (extra: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(
      createElement(ToolsetsView, {
        data,
        layer: "project",
        choice: { toolset: "chat/read-only" },
        onChoice: none,
        drafts: {},
        onDraft: none,
        comparing: false,
        onCompare: none,
        naming: {},
        onNaming: none,
        locked: false,
        problem: null,
        onSave: none,
        onReset: none,
        onOverride: none,
        onAdd: none,
        ...extra,
      } as never),
    );

  it("draws the path, the standing, who uses it, and the card's own rows", () => {
    const html = draw({ folds: new Set(["files", "execution"]) });
    expect(html).toContain("chat / read-only");
    expect(html).toContain("overrides built in");
    expect(html).toContain("used by sync/review and 2 more states");
    // A held line starts with the minus, and the shell's line says what it stands for.
    expect(html).toContain("set-minus");
    expect(html).toContain("the shell — and the mode for any command not named below");
    expect(html).toContain("Reset to built in");
  });

  it("draws what ships as a reading: no minus, no add line, and the two overrides instead of Save", () => {
    const html = draw({ layer: "system", choice: { toolset: "chat/full" } });
    expect(html).toContain("set-readonly");
    expect(html).not.toContain("set-minus");
    expect(html).not.toContain("set-add-line");
    expect(html).toContain("Override for all projects");
    expect(html).toContain("Override here");
    expect(html).not.toContain(">Save<");
  });

  it("says why a file it cannot read is not drawn as a toolset", () => {
    const broken: ToolsetRecord = { id: "chat/bad", bucket: "chat", name: "bad", files: [{ layer: "project", file: ".jaira/toolsets/chat/bad.json", format: "json", problem: "it is a list" }] };
    const html = draw({ data: { ...data, records: [...records, broken] }, choice: { toolset: "chat/bad" } });
    expect(html).toContain("could not be read as a toolset");
    expect(html).toContain("it is a list");
  });

  it("draws the state field with its picker and its lines, and nothing at all when a reading has none", () => {
    const choices: ToolsetChoice[] = [{ id: "chat/read-only", bucket: "chat", name: "read-only", layer: "system", decl: SHIPPED }];
    const field = (raw: unknown, readOnly = false): string =>
      renderToStaticMarkup(createElement(ToolsFieldControl, { value: toolsFieldOf(raw)!, toolsets: choices, tools, readOnly, onChange: none }));
    const html = field({ $ref: "$/toolsets/chat/read-only", write_file: "ask" });
    expect(html).toContain("chat / read-only — built in");
    expect(html).toContain("over the toolset, for this state");
    expect(html).toContain("set-minus");
    expect(field(undefined, true)).toBe("");
    expect(field({ read_file: "allow" })).toContain("this state&#x27;s own line");
  });
});

describe("a toolset the card cannot break", () => {
  it("draws a line for a subject no tool has, at the mode it was written with", () => {
    // `parseToolset` drops a name no tool has, so the only way one reaches the card is a COMMAND —
    // which is what `terraform` is here, and what the row must not mistake for a missing tool.
    const toolset = parseToolset({ terraform: "ask", other: "deny" }).toolset;
    expect(commandGroupsOf(toolset)).toEqual([{ program: "terraform", own: "ask", subs: [] }]);
    expect(toolset.entries["terraform"]?.mode ?? MODE_WHEN_UNSET).toBe("ask");
  });
});
