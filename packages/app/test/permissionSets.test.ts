/**
 * Settings → Permission sets and the state editor's one Tools field (decision 0007 §6).
 *
 * Every claim is about a pure function — there is no DOM harness here, so logic that lives in a
 * component is logic nothing asserts:
 *
 *  - what the RAIL lists (`permissionSetsHost.ts`'s rows, which the pane draws), which files a layer
 *    of the page reads, where its changes go, and which permission set stays open through a write;
 *  - what a section's add-menu offers and what its minus takes away (`composerPermissionSet.ts`);
 *  - the state field's ROUND TRIP — `$ref` plus siblings in, the same document out, and a value it
 *    cannot draw kept as it was;
 *  - what the pane SAYS of the permission set that is open — its standing, who uses it, how far a
 *    copy has moved from what it was copied from, where a first change goes — and the label the
 *    state field shows for the one a state names. The sentences around them are the component's.
 */
import { describe, expect, it } from "vitest";
import {
  copiedFrom,
  copyDifferences,
  MODE_WHEN_UNSET,
  parsePermissionSet,
  permissionSetFileLabel,
  permissionSetStanding,
  SCRIPT_SUBJECT,
  permissionSetsAt,
  usedByLine,
  type ToolChoice,
  type PermissionSetChoice,
  type PermissionSetDecl,
  type PermissionSetRecord,
} from "@jaira/shared/browser";
import {
  addableScript,
  addableTools,
  commandGroupsOf,
  sectionCountOf,
  suggestedPrograms,
  suggestedSubcommands,
  withoutProgram,
  withToolHeld,
} from "../src/renderer/composerPermissionSet";
import { applyOperationFields, operationFieldsOf } from "../src/renderer/operationForm";
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
import {
  detachingLines,
  INTO_NAME,
  LOWER_NAME,
  newPermissionSetProblem,
  permissionSetLayersOf,
  permissionSetRailRows,
  PERSONAL,
  type PermissionSetRailRow,
} from "../src/renderer/permissionSetsHost";

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
  /** The rows of one kind — a permission set's are the ones that carry a dot, a copy's tag and a summary. */
  const setsOf = (rows: readonly PermissionSetRailRow[]): Array<Extract<PermissionSetRailRow, { kind: "set" }>> =>
    rows.filter((row): row is Extract<PermissionSetRailRow, { kind: "set" }> => row.kind === "set");
  const bucketsOf = (rows: readonly PermissionSetRailRow[]): Array<Extract<PermissionSetRailRow, { kind: "bucket" }>> =>
    rows.filter((row): row is Extract<PermissionSetRailRow, { kind: "bucket" }> => row.kind === "bucket");

  it("is the bucket hierarchy: a heading per bucket, its permission sets, + permission set, and + bucket last", () => {
    const rows = permissionSetRailRows(permissionSetsAt(records, "project"), "project", {});
    expect(rows.map((row) => [row.id, row.kind, row.depth])).toEqual([
      ["bucket:chat", "bucket", 0],
      ["permissionSet:chat/read-only", "set", 0],
      ["permissionSet:chat/full", "set", 0],
      ["new:chat", "add", 0],
      ["bucket:feature", "bucket", 0],
      ["permissionSet:feature/writes", "set", 0],
      ["new:feature", "add", 0],
      ["+bucket", "add", undefined],
    ]);
  });

  it("indents a nested bucket under its parent", () => {
    const nested: PermissionSetRecord = { id: "feature/impl/reads", bucket: "feature/impl", name: "reads", files: [{ layer: "project", file: "x", format: "json", decl: SHIPPED }] };
    const rows = permissionSetRailRows(permissionSetsAt([...records, nested], "project"), "project", {});
    expect(bucketsOf(rows).map((row) => [row.id, row.depth])).toEqual([
      ["bucket:chat", 0],
      ["bucket:feature", 0],
      ["bucket:feature/impl", 1],
    ]);
  });

  it("folds a closed bucket to its heading, a bucket inside it included, and flips one on its heading", () => {
    const nested: PermissionSetRecord = { id: "feature/impl/reads", bucket: "feature/impl", name: "reads", files: [{ layer: "project", file: "x", format: "json", decl: SHIPPED }] };
    const flipped: string[] = [];
    const rows = permissionSetRailRows(permissionSetsAt([...records, nested], "project"), "project", {}, { open: new Set(["chat"]), onFold: (bucket) => flipped.push(bucket) });
    expect(rows.map((row) => row.id)).toEqual([
      "bucket:chat",
      "permissionSet:chat/read-only",
      "permissionSet:chat/full",
      "new:chat",
      "bucket:feature",
      "+bucket",
    ]);
    expect(bucketsOf(rows).map((row) => [row.id, row.fold?.open])).toEqual([
      ["bucket:chat", true],
      ["bucket:feature", false],
    ]);
    bucketsOf(rows)
      .find((row) => row.id === "bucket:feature")
      ?.fold?.onFold();
    expect(flipped).toEqual(["feature"]);
  });

  it("offers no + rows where nothing can be written — the personal layer holds no permission sets", () => {
    const rows = permissionSetRailRows(permissionSetsAt(records, "project"), undefined, {});
    expect(rows.some((row) => row.kind === "add")).toBe(false);
    expect(rows.map((row) => row.id)).toEqual(["bucket:chat", "permissionSet:chat/read-only", "permissionSet:chat/full", "bucket:feature", "permissionSet:feature/writes"]);
  });

  it("marks what THIS layer states, and marks nothing on a layer that states nothing", () => {
    const here = (writesTo: "project" | undefined): string[] =>
      setsOf(permissionSetRailRows(permissionSetsAt(records, "project"), writesTo, {}))
        .filter((row) => row.dot)
        .map((row) => row.id);
    expect(here("project")).toEqual(["permissionSet:chat/read-only", "permissionSet:feature/writes"]);
    expect(here(undefined)).toEqual([]);
  });

  it("tags a copy of what ships beside its name, and nothing else", () => {
    const tags = setsOf(permissionSetRailRows(permissionSetsAt(records, "project"), "project", {})).map((row) => [row.id, row.copy]);
    expect(tags).toEqual([
      ["permissionSet:chat/read-only", "this project · copied from built in"],
      ["permissionSet:chat/full", undefined],
      ["permissionSet:feature/writes", undefined],
    ]);
  });

  it("says a row is unsaved from its draft", () => {
    const draft = parsePermissionSet({ read_file: "allow", other: "deny" }).permissionSet;
    const rows = permissionSetRailRows(permissionSetsAt(records, "project"), "project", { "chat/read-only": draft });
    expect(setsOf(rows).find((row) => row.id === "permissionSet:chat/read-only")?.summary).toBe("unsaved · 1 line · other deny");
    // With no draft the row says what the file holds.
    expect(setsOf(permissionSetRailRows(permissionSetsAt(records, "project"), "project", {})).find((row) => row.id === "permissionSet:chat/read-only")?.summary).toBe("4 lines · other deny");
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

  it("counts the lines each section holds — the card opens on the sections that hold one", () => {
    // Execution's four: the shell, `script`, and the two `git` subcommands its program names.
    const counts = (set: typeof permissionSet): number[] => (["files", "execution", "web", "git", "tasks", "mcp"] as const).map((section) => sectionCountOf(set, section));
    expect(counts(permissionSet)).toEqual([1, 4, 0, 0, 0, 0]);
    expect(counts(parsePermissionSet({ other: "deny" }).permissionSet)).toEqual([0, 0, 0, 0, 0, 0]);
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

describe("what the pane says of the open permission set, and the field of the one a state names", () => {
  const usedBy: Record<string, string[]> = { "chat/read-only": ["sync/review", "a", "b"] };
  const at = (id: string, all: readonly PermissionSetRecord[] = records) => permissionSetsAt(all, "project").find((one) => one.id === id)!;

  it("says who uses it", () => {
    expect(usedByLine(usedBy["chat/read-only"])).toBe("used by sync/review and 2 more states");
    expect(usedByLine(usedBy["chat/full"])).toBe("no state names it");
  });

  it("a built-in on a layer is not the layer's own: its standing, and where its first change will copy it", () => {
    const full = at("chat/full");
    expect(permissionSetStanding(full)).toEqual({ here: false, label: "built in" });
    expect(permissionSetFileLabel("project", full.id)).toBe(".jaira/permission-sets/chat/full.json");
    // Nothing of this layer's to save, revert or put back until the first change writes the copy.
    expect(full.here).toBe(false);
    expect(copiedFrom(full)).toBeUndefined();
    expect(copyDifferences(full)).toBeUndefined();
  });

  it("a copy: its tag, how many lines differ from what ships and where it lives", () => {
    const readOnly = at("chat/read-only");
    expect(permissionSetStanding(readOnly)).toEqual({ here: true, label: "this project · copied from built in" });
    expect(copyDifferences(readOnly)).toBe(1);
    expect(readOnly.source.file).toBe(".jaira/permission-sets/chat/read-only.json");
    // A copy of what SHIPS is put back; a copy of the shared one is reset to it. The layer it was
    // copied from decides which, and is named as the page names it.
    expect(copiedFrom(readOnly)).toBe("system");
    expect(LOWER_NAME[copiedFrom(readOnly)!]).toBe("what ships");
  });

  it("names the personal layer, and the two a change made there can be copied to", () => {
    expect(PERSONAL).toBe("Just you");
    expect(INTO_NAME).toEqual({ base: "Shared", project: "this project" });
  });

  it("keeps why a file it cannot read is not a permission set", () => {
    const broken: PermissionSetRecord = { id: "chat/bad", bucket: "chat", name: "bad", files: [{ layer: "project", file: ".jaira/permission-sets/chat/bad.json", format: "json", problem: "it is a list" }] };
    const bad = at("chat/bad", [...records, broken]);
    // No map to draw a card from, and the reason the page gives instead.
    expect(bad.source.decl).toBeUndefined();
    expect(bad.source.problem).toBe("it is a list");
    expect(bad.source.file).toBe(".jaira/permission-sets/chat/bad.json");
  });

  it("the state field shows the permission set a state names by its row's label", () => {
    const choices: PermissionSetChoice[] = [{ id: "chat/read-only", bucket: "chat", name: "read-only", layer: "system", decl: SHIPPED }];
    const reference = toolsFieldOf({ $ref: "$/permission-sets/chat/read-only", write_file: "ask" })!.reference;
    expect(pickOfReference(permissionSetPicks(choices, reference), reference).label).toBe("chat / read-only — built in");
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
