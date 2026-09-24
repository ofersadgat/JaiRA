/**
 * Settings → Permission sets and the state editor's one Tools field (decision 0007 §6).
 *
 * Three claims, and every one of them is about a pure function — there is no DOM harness here, so
 * logic that lives in a component is logic nothing asserts (`permissionSetsPane.tsx`'s own header):
 *
 *  - what the RAIL lists, and which permission set stays open through a write;
 *  - what a section's add-menu offers and what its minus takes away (`composerPermissionSet.ts`);
 *  - the state field's ROUND TRIP — `$ref` plus siblings in, the same document out, and a value it
 *    cannot draw kept as it was.
 *
 * Plus one render: the pane and the field are drawn to static markup, which is what a still picture
 * of them is, and is enough to catch a component that throws on a shape the model allows.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MODE_WHEN_UNSET,
  parsePermissionSet,
  SCRIPT_SUBJECT,
  permissionSetsAt,
  type ToolChoice,
  type PermissionSetChoice,
  type PermissionSetDecl,
  type PermissionSetRecord,
  type PermissionSetsView as PermissionSetsData,
} from "@jaira/shared/browser";
import {
  addableScript,
  addableTools,
  commandGroupsOf,
  suggestedPrograms,
  suggestedSubcommands,
  withoutProgram,
  withToolHeld,
} from "../src/renderer/composerPermissionSet";
import { applyOperationFields, operationFieldsOf } from "../src/renderer/operationForm";
import { ToolsFieldControl } from "../src/renderer/toolsField";
import {
  applyToolsField,
  linesOfPermissionSet,
  NO_PERMISSION_SET_LABEL,
  pickOfReference,
  referenceOfLabel,
  showsToolsField,
  permissionSetPicks,
  toolsFieldOf,
} from "../src/renderer/toolsFieldForm";
import { openSectionsOf } from "../src/renderer/permissionSetCard";
import { detachingLines, newPermissionSetProblem, permissionSetLayersOf, permissionSetRailItems, PermissionSetsView } from "../src/renderer/permissionSetsPane";

const SHIPPED: PermissionSetDecl = { read_file: "allow", glob: "allow", bash: "deny", "git status": "allow", other: "deny" };

const records: PermissionSetRecord[] = [
  {
    id: "chat/read-only",
    bucket: "chat",
    name: "read-only",
    files: [
      { layer: "project", file: ".jaira/permission-sets/chat/read-only.json", format: "json", follows: "$SYSTEM/permission-sets/chat/read-only", decl: { ...SHIPPED, bash: "ask" } },
      { layer: "system", file: "built in/permission-sets/chat/read-only.json", format: "json", decl: SHIPPED },
    ],
  },
  { id: "chat/full", bucket: "chat", name: "full", files: [{ layer: "system", file: "built in/permission-sets/chat/full.json", format: "json", decl: { bash: "allow", other: "allow" } }] },
  {
    id: "feature/writes",
    bucket: "feature",
    name: "writes",
    files: [{ layer: "project", file: ".jaira/permission-sets/feature/writes.json", format: "json", decl: { edit: "ask", "git commit": "ask", other: "ask" } }],
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
  it("is the bucket hierarchy: a heading per bucket, its permission sets, + permission set, and + bucket last", () => {
    const items = permissionSetRailItems(permissionSetsAt(records, "project"), "project", {});
    expect(items.map((item) => [item.id, item.heading !== undefined, item.indent])).toEqual([
      ["bucket:chat", true, 0],
      ["permissionSet:chat/read-only", false, 0],
      ["permissionSet:chat/full", false, 0],
      ["new:chat", false, 0],
      ["bucket:feature", true, 0],
      ["permissionSet:feature/writes", false, 0],
      ["new:feature", false, 0],
      ["+bucket", false, undefined],
    ]);
  });

  it("indents a nested bucket under its parent", () => {
    const nested: PermissionSetRecord = { id: "feature/impl/reads", bucket: "feature/impl", name: "reads", files: [{ layer: "project", file: "x", format: "json", decl: SHIPPED }] };
    const items = permissionSetRailItems(permissionSetsAt([...records, nested], "project"), "project", {});
    expect(items.filter((item) => item.id.startsWith("bucket:")).map((item) => [item.id, item.indent])).toEqual([
      ["bucket:chat", 0],
      ["bucket:feature", 0],
      ["bucket:feature/impl", 1],
    ]);
  });

  it("offers no + rows where nothing can be written — the personal layer holds no permission sets", () => {
    const items = permissionSetRailItems(permissionSetsAt(records, "project"), undefined, {});
    expect(items.some((item) => item.id.startsWith("new:") || item.id === "+bucket")).toBe(false);
  });

  it("marks what THIS layer states, and marks nothing on a layer that states nothing", () => {
    const here = (writesTo: "project" | undefined): string[] =>
      permissionSetRailItems(permissionSetsAt(records, "project"), writesTo, {})
        .filter((item) => item.heading === undefined && renderToStaticMarkup(createElement("i", {}, item.label)).includes("set-here-dot"))
        .map((item) => item.id);
    expect(here("project")).toEqual(["permissionSet:chat/read-only", "permissionSet:feature/writes"]);
    expect(here(undefined)).toEqual([]);
  });

  it("tags a copy of what ships beside its name, and nothing else", () => {
    const tags = permissionSetRailItems(permissionSetsAt(records, "project"), "project", {})
      .filter((item) => item.heading === undefined)
      .map((item) => [item.id, /class="cx-src">([^<]*)</.exec(renderToStaticMarkup(createElement("i", {}, item.label)))?.[1]]);
    expect(tags.filter(([, tag]) => tag !== undefined)).toEqual([["permissionSet:chat/read-only", "this project · copied from built in"]]);
  });

  it("says a row is unsaved from its draft", () => {
    const draft = parsePermissionSet({ read_file: "allow", other: "deny" }).permissionSet;
    const items = permissionSetRailItems(permissionSetsAt(records, "project"), "project", { "chat/read-only": draft });
    expect(items.find((item) => item.id === "permissionSet:chat/read-only")?.summary).toBe("unsaved · 1 line · other deny");
  });
});

describe("which files a layer of the page reads, and where its changes go", () => {
  it("reads and writes a layer that holds files; reads the nearest one from any other, and writes nowhere", () => {
    expect(permissionSetLayersOf("project", ["project", "base", "system"])).toEqual({ reads: "project", writesTo: "project" });
    expect(permissionSetLayersOf("base", ["project", "base", "system"])).toEqual({ reads: "base", writesTo: "base" });
    // The personal layer — any layer that is not one of the two — is spelled here without naming it,
    // so this holds on a branch whose ConfigLayer does not have it yet.
    expect(permissionSetLayersOf("you", ["project", "base", "system"])).toEqual({ reads: "project", writesTo: undefined });
    expect(permissionSetLayersOf("you", ["base", "system"])).toEqual({ reads: "base", writesTo: undefined });
  });
});

describe("what a save will do", () => {
  it("names the lines that make an override stop following, and nothing while none do", () => {
    const [readOnly] = permissionSetsAt(records, "project");
    expect(detachingLines(readOnly!, parsePermissionSet({ ...SHIPPED, bash: "allow" }).permissionSet)).toEqual([]);
    const { glob: _gone, ...rest } = SHIPPED;
    expect(detachingLines(readOnly!, parsePermissionSet(rest).permissionSet)).toEqual(["glob"]);
    expect(detachingLines(readOnly!, undefined)).toEqual([]);
  });

  it("refuses a new name the layer already holds, and one a reference could not carry", () => {
    const ats = permissionSetsAt(records, "project");
    expect(newPermissionSetProblem(ats, "chat", "read-only")).toMatch(/already a permission set/);
    expect(newPermissionSetProblem(ats, "chat", "full")).toMatch(/inherited/);
    expect(newPermissionSetProblem(ats, "chat", "a b")).toMatch(/letters, digits/);
    expect(newPermissionSetProblem(ats, "", "ok")).toMatch(/bucket/);
    expect(newPermissionSetProblem(ats, "chat", "quiet")).toBeUndefined();
  });
});

describe("a section's add line and its minus", () => {
  const permissionSet = parsePermissionSet({ read_file: "allow", bash: "ask", "git status": "allow", "git commit": "ask", script: "ask", other: "deny" }).permissionSet;

  it("offers only what the section does not hold, and only what this project registers", () => {
    expect(addableTools(permissionSet, "files", tools.map((t) => t.name))).toEqual(["glob", "grep", "edit", "write_file"]);
    expect(addableTools(permissionSet, "execution", tools.map((t) => t.name))).toEqual([]);
    expect(addableScript(permissionSet)).toBe(false);
    expect(addableScript(parsePermissionSet({ other: "deny" }).permissionSet)).toBe(true);
  });

  it("suggests the subcommands of a program it does not already name, and the programs it names none of", () => {
    expect(suggestedSubcommands(permissionSet, "git")).not.toContain("git status");
    expect(suggestedSubcommands(permissionSet, "git")).toContain("git push");
    expect(suggestedPrograms(permissionSet)).not.toContain("git");
    expect(suggestedPrograms(permissionSet)).toContain("npm");
  });

  it("takes a whole program out with every subcommand under it, and nothing else", () => {
    const without = withoutProgram(permissionSet, "git");
    expect(commandGroupsOf(without)).toEqual([]);
    expect(Object.keys(without.entries)).toEqual(["read_file", "bash", SCRIPT_SUBJECT]);
  });

  it("removing a tool takes its line out — absent is how a map says not offered", () => {
    expect(Object.keys(withToolHeld(permissionSet, {}, "read_file", false).entries)).not.toContain("read_file");
  });

  it("opens on the sections that hold a line", () => {
    expect(openSectionsOf(permissionSet)).toEqual(["files", "execution"]);
    expect(openSectionsOf(parsePermissionSet({ other: "deny" }).permissionSet)).toEqual([]);
  });
});

describe("the state editor's one Tools field", () => {
  it("reads all three spellings, and writes each back as the plain one", () => {
    const bare = "$/permission-sets/chat/read-only";
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
    const written = { $ref: "$/permission-sets/chat/read-only", "git commit": "ask", write_file: { mode: "ask", implementation: "native" } };
    expect(applyToolsField(written, toolsFieldOf(written)!)).toBe(written);
  });

  it("changes spelling only when what it says changes", () => {
    const bare = "$/permission-sets/chat/read-only";
    const form = toolsFieldOf(bare)!;
    expect(applyToolsField(bare, { ...form, lines: { edit: "ask" } })).toEqual({ $ref: bare, edit: "ask" });
    // Dropping the last line goes back to a bare reference; dropping the reference leaves the map.
    expect(applyToolsField({ $ref: bare, edit: "ask" }, { reference: bare, lines: {}, unread: {} })).toBe(bare);
    expect(applyToolsField({ $ref: bare, edit: "ask" }, { reference: "", lines: { edit: "ask" }, unread: {} })).toEqual({ edit: "ask" });
    // …and a state that names neither writes no `tools` key at all.
    expect(applyToolsField({ $ref: bare }, { reference: "", lines: {}, unread: {} })).toBeUndefined();
  });

  it("carries a sibling it could not read straight through, rather than deleting the evidence", () => {
    const odd = { $ref: "$/permission-sets/chat/read-only", read_file: "sometimes" };
    const form = toolsFieldOf(odd)!;
    expect(form).toMatchObject({ lines: {}, unread: { read_file: "sometimes" } });
    expect(applyToolsField(odd, form)).toBe(odd);
    // It survives an edit to a different line.
    expect(applyToolsField(odd, { ...form, lines: { edit: "ask" } })).toEqual({ $ref: "$/permission-sets/chat/read-only", read_file: "sometimes", edit: "ask" });
  });

  it("is not the form's field for a binding, or for a list (which the linter refuses)", () => {
    expect(toolsFieldOf(["read_file"])).toBeUndefined();
    expect(toolsFieldOf({ $expr: ".inputs.tools" })).toBeUndefined();
    expect(showsToolsField({ tools: ["read_file"] })).toBe(false);
    // Whatever sits in `permissions` has no say in it.
    expect(showsToolsField({ permissions: { scopes: [] } })).toBe(true);
    expect(showsToolsField({ tools: "$/permission-sets/chat/read-only" })).toBe(true);
    expect(showsToolsField({})).toBe(true);
  });

  it("round-trips through the whole operation form, and keeps a value it cannot draw as it was", () => {
    const migrated = { kind: "prompt", prompt: "go", tools: { $ref: "$/permission-sets/chat/read-only", write_file: "ask" } };
    const form = operationFieldsOf(migrated);
    expect(form.toolsField).toEqual({ reference: "$/permission-sets/chat/read-only", lines: { write_file: "ask" }, unread: {} });
    expect(applyOperationFields(migrated, form)).toEqual(migrated);

    const bound = { kind: "prompt", prompt: "go", tools: { $expr: ".inputs.tools" } };
    const boundForm = operationFieldsOf(bound);
    expect(boundForm.toolsField).toBeUndefined();
    expect(boundForm.structured["tools"]).toBe(true);
    expect(applyOperationFields(bound, boundForm)).toEqual(bound);
  });

  it("writes the permission set the picker chose, and the lines the rows changed", () => {
    const block = { kind: "prompt", tools: "$/permission-sets/chat/read-only" };
    const form = operationFieldsOf(block);
    const next = applyOperationFields(block, { ...form, toolsField: { ...form.toolsField!, reference: "$/permission-sets/chat/full", lines: { bash: "deny" } } });
    expect(next["tools"]).toEqual({ $ref: "$/permission-sets/chat/full", bash: "deny" });
    // "none" is a real answer, and it leaves the lines behind as the whole statement.
    const none = applyOperationFields(block, { ...form, toolsField: { reference: "", lines: { bash: "deny" }, unread: {} } });
    expect(none["tools"]).toEqual({ bash: "deny" });
  });

  it("lines are not a whole permission set: `other` is written only when a line says it", () => {
    // `declOfPermissionSet` always writes `other`; lines over a permission set must not, or every state opened in
    // the form would start overriding the permission set's own catch-all.
    expect(linesOfPermissionSet(parsePermissionSet({ edit: "ask" }).permissionSet)).toEqual({ edit: "ask" });
    expect(linesOfPermissionSet(parsePermissionSet({ edit: "ask", other: "deny" }).permissionSet)).toEqual({ edit: "ask", other: "deny" });
    expect(linesOfPermissionSet(parsePermissionSet({ write_file: { mode: "ask", implementation: "native" } }).permissionSet)).toEqual({ write_file: { mode: "ask", implementation: "native" } });
  });
});

describe("the permission set picker", () => {
  const choices: PermissionSetChoice[] = [
    { id: "chat/read-only", bucket: "chat", name: "read-only", layer: "project", decl: SHIPPED },
    { id: "chat/full", bucket: "chat", name: "full", layer: "system", decl: SHIPPED },
    { id: "feature/impl/reads", bucket: "feature/impl", name: "reads", layer: "base", decl: SHIPPED },
  ];

  it("lists every permission set as `bucket / name — layer`, then none", () => {
    expect(permissionSetPicks(choices, "").map((pick) => pick.label)).toEqual([
      "chat / read-only — this project",
      "chat / full — built in",
      "feature / impl / reads — all projects",
      NO_PERMISSION_SET_LABEL,
    ]);
  });

  it("lists a reference nobody offers FIRST, as written — a form never restates what a state names", () => {
    const picks = permissionSetPicks(choices, "$BASE/permission-sets/team/review");
    expect(picks[0]).toEqual({ label: "$BASE/permission-sets/team/review — as written", reference: "$BASE/permission-sets/team/review" });
    expect(pickOfReference(picks, "$BASE/permission-sets/team/review")).toBe(picks[0]);
  });

  it("falls to none for a reference that is empty, and reads a label back as its reference", () => {
    const picks = permissionSetPicks(choices, "");
    expect(pickOfReference(picks, "").label).toBe(NO_PERMISSION_SET_LABEL);
    expect(referenceOfLabel(picks, "chat / full — built in")).toBe("$/permission-sets/chat/full");
    expect(referenceOfLabel(picks, NO_PERMISSION_SET_LABEL)).toBe("");
    expect(referenceOfLabel(picks, "half a wor")).toBeUndefined();
  });
});

describe("drawn", () => {
  const data: PermissionSetsData = { records, usedBy: { "chat/read-only": ["sync/review", "a", "b"] }, tools, layers: ["project", "base", "system"] };
  const none = (): void => undefined;
  const draw = (extra: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(
      createElement(PermissionSetsView, {
        data,
        layer: "project",
        writesTo: "project",
        choice: { permissionSet: "chat/read-only" },
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
        onCopy: none,
        onCopyTo: none,
        puttingBack: false,
        onPutBack: none,
        told: null,
        onAdd: none,
        ...extra,
      } as never),
    );

  it("draws the path, the standing, who uses it, and the card's own rows", () => {
    const html = draw({ folds: new Set(["files", "execution"]) });
    expect(html).toContain("chat / read-only");
    expect(html).toContain("used by sync/review and 2 more states");
    // A held line starts with the minus, and the shell's line says what it stands for.
    expect(html).toContain("set-minus");
    expect(html).toContain("the shell — and the mode for any command not named below");
  });

  it("draws a built-in on a layer LIVE: every line changeable, where its copy will go, and no Override here", () => {
    const html = draw({ choice: { permissionSet: "chat/full" }, folds: new Set(["execution"]) });
    expect(html).not.toContain("set-readonly");
    expect(html).toContain("set-minus");
    expect(html).not.toContain("Override");
    expect(html).toContain(">built in<");
    expect(html).toContain("your first change copies it to <span class=\"mono\">.jaira/permission-sets/chat/full.json</span>");
    // Nothing of this layer's to save, revert or put back until the first change writes the copy.
    expect(html).not.toContain(">Save<");
    expect(html).not.toContain("Put back");
  });

  it("draws a copy: its tag, how many lines differ from what ships and where it lives, and Put back the built-in", () => {
    const html = draw({ folds: new Set(["execution"]) });
    expect(html).toContain("this project · copied from built in");
    expect(html).toContain("<b>1 line</b> differs from what ships — <span class=\"mono\">.jaira/permission-sets/chat/read-only.json</span>");
    expect(html).toContain(">Save<");
    expect(html).toContain("Put back the built-in");
    expect(html).not.toContain("Reset to built in");
  });

  it("asks before putting back, in the page, naming the file it deletes", () => {
    const html = draw({ puttingBack: true });
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Put back the built-in? This deletes <span class=\"mono\">.jaira/permission-sets/chat/read-only.json</span>.");
    expect(html).toContain(">Put back<");
    expect(html).toContain(">Cancel<");
    // The confirmation takes the actions' place: nothing else can be pressed meanwhile.
    expect(html).not.toContain(">Save<");
  });

  it("on the personal layer: shows what is in effect, and asks where a first change goes", () => {
    const quiet = draw({ writesTo: undefined, choice: { permissionSet: "chat/full" } });
    expect(quiet).toContain("Just you holds no permission sets, so your first change asks where to copy it");
    expect(quiet).not.toContain("set-readonly");
    const asking = draw({ writesTo: undefined, choice: { permissionSet: "chat/full" }, asking: "chat/full" });
    expect(asking).toContain("Copy to Shared");
    expect(asking).toContain("Copy to this project");
    // While it is asked, the card is held still: the change waits for the answer.
    expect(asking).toContain("set-readonly");
    const noProject = draw({ data: { ...data, layers: ["base", "system"] }, layer: "base", writesTo: undefined, choice: { permissionSet: "chat/full" }, asking: "chat/full" });
    expect(noProject).toContain("Copy to Shared");
    expect(noProject).not.toContain("Copy to this project");
    const told = draw({ writesTo: undefined, choice: { permissionSet: "chat/full" }, told: "Copied to Shared, with your change — ~/.jaira/permission-sets/chat/full.json." });
    expect(told).toContain("Copied to Shared, with your change");
  });

  it("says why a file it cannot read is not drawn as a permission set", () => {
    const broken: PermissionSetRecord = { id: "chat/bad", bucket: "chat", name: "bad", files: [{ layer: "project", file: ".jaira/permission-sets/chat/bad.json", format: "json", problem: "it is a list" }] };
    const html = draw({ data: { ...data, records: [...records, broken] }, choice: { permissionSet: "chat/bad" } });
    expect(html).toContain("could not be read as a permission set");
    expect(html).toContain("it is a list");
  });

  it("draws the state field with its picker and its lines, and nothing at all when a reading has none", () => {
    const choices: PermissionSetChoice[] = [{ id: "chat/read-only", bucket: "chat", name: "read-only", layer: "system", decl: SHIPPED }];
    const field = (raw: unknown, readOnly = false): string =>
      renderToStaticMarkup(createElement(ToolsFieldControl, { value: toolsFieldOf(raw)!, permissionSets: choices, tools, readOnly, onChange: none }));
    const html = field({ $ref: "$/permission-sets/chat/read-only", write_file: "ask" });
    expect(html).toContain("chat / read-only — built in");
    expect(html).toContain("over the permission set, for this state");
    expect(html).toContain("set-minus");
    expect(field(undefined, true)).toBe("");
    expect(field({ read_file: "allow" })).toContain("this state&#x27;s own line");
  });
});

describe("a permission set the card cannot break", () => {
  it("draws a line for a subject no tool has, at the mode it was written with", () => {
    // `parsePermissionSet` drops a name no tool has, so the only way one reaches the card is a COMMAND —
    // which is what `terraform` is here, and what the row must not mistake for a missing tool.
    const permissionSet = parsePermissionSet({ terraform: "ask", other: "deny" }).permissionSet;
    expect(commandGroupsOf(permissionSet)).toEqual([{ program: "terraform", own: "ask", subs: [] }]);
    expect(permissionSet.entries["terraform"]?.mode ?? MODE_WHEN_UNSET).toBe("ask");
  });
});
