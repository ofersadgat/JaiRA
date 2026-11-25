import { describe, expect, it } from "vitest";
import type { PermissionStackView } from "@jaira/shared/browser";
import { addOf, answerOf, boardOf, flatOf, lineTreeOf, modeDeclOfFlat, moveOf, RESULT, withLinesEdited, type Board } from "../src/renderer/permissionBoard";

/** A stack as `permissionSets:stack` answers it: a built-in root, a project set, the run's answers and the conversation's lines. */
function viewOf(conversation: Record<string, unknown> = {}): Pick<PermissionStackView, "layers" | "runtime"> {
  return {
    layers: [
      { id: "auto", scope: "built in", role: "bottom", icon: "layers", lines: 3, own: { glob: { "**": "ask", "credentials/**": "deny" }, grep: "ask", other: "ask" } },
      { id: "app/build", scope: "project", role: "named", icon: "layers", lines: 2, own: { glob: { "src/**": "allow" }, stop_process: { "**": "ask", owner: { session: "allow" } } } },
      { id: "runtime", scope: "runtime", role: "runtime", icon: "history", lines: 1 },
      { id: "tools", scope: "this conversation", role: "own", icon: "chat", lines: Object.keys(conversation).length, own: conversation },
    ],
    runtime: { "grep @ **": "allow" },
  };
}

const open = (resources: string[], accesses: string[] = []) => ({ resources: new Set(resources), accesses: new Set(accesses) });
const row = (board: Board, key: string) => board.rows.find((each) => each.key === key)!;

describe("a line, flat", () => {
  it("spells a kind's map as kind=place and writes it back nested", () => {
    const flat = flatOf({ "**": "ask", owner: { session: "allow", "**": "deny" } });
    expect(flat).toEqual({ "**": "ask", "owner=session": "allow", "owner=**": "deny" });
    expect(modeDeclOfFlat(flat!)).toEqual({ "**": "ask", owner: { session: "allow", "**": "deny" } });
    expect(modeDeclOfFlat({ "**": "allow" })).toBe("allow");
  });
  it("reads an implementation wrapper's mode, and keeps the wrapper on an edit", () => {
    expect(flatOf({ mode: "smart", implementation: "x" })).toEqual({ "**": "smart" });
    expect(withLinesEdited({ shell: { mode: "smart", implementation: "x" } }, [{ subject: "shell", place: "src", decision: "allow" }])).toEqual({ shell: { mode: { "**": "smart", src: "allow" }, implementation: "x" } });
  });
  it("puts a function's name in Smart and unavailable in Off", () => {
    expect(answerOf("review")).toBe("smart");
    expect(answerOf("unavailable")).toBe("off");
  });
});

describe("the board", () => {
  it("has a column group per layer, oldest first, with who writes each", () => {
    const board = boardOf({ view: viewOf(), open: open([]) });
    expect(board.layers.map((layer) => [layer.label, layer.writes])).toEqual([
      ["Root · auto", "none"],
      ["app/build", "set"],
      ["This run", "none"],
      ["This conversation", "conversation"],
    ]);
    expect(board.layers[1]!.setLayer).toBe("project");
  });

  it("merges the layers into the Result, newest at the same place, and says who answered", () => {
    const board = boardOf({ view: viewOf(), open: open(["files"], ["files.search"]) });
    const globChips = row(board, "files.search@glob").cells[RESULT]!;
    expect(globChips.find((chip) => chip.place === "src/**")).toMatchObject({ answer: "allow", from: "1:app/build" });
    expect(globChips.find((chip) => chip.place === "credentials/**")).toMatchObject({ answer: "deny", from: "0:auto" });
    // The run allowed grep everywhere: the root's plain answer is overruled.
    expect(row(board, "files.search@grep").cells[RESULT]!.find((chip) => chip.place === "**")).toMatchObject({ answer: "allow", from: "2:runtime" });
    // The root's plain ask is every Search tool's alike, so the Search row keeps it — the run overruled grep's only.
    expect(row(board, "files.search").cells["0:auto"]!.find((chip) => chip.place === "**")).toMatchObject({ answer: "ask" });
    expect(row(board, "files.search").cells["0:auto"]!.find((chip) => chip.place === "**")!.overruled).toBeUndefined();
  });

  it("parks an access's place where its tools disagree, MIXED, at the strictest", () => {
    const board = boardOf({ view: viewOf(), open: open(["files"]) });
    const everywhere = row(board, "files.search").cells[RESULT]!.find((chip) => chip.place === "**")!;
    expect(everywhere).toMatchObject({ mixed: true, answer: "ask" });
  });

  it("keeps a place of another kind on the resource that has that kind", () => {
    const board = boardOf({ view: viewOf(), open: open(["programs"]) });
    const control = row(board, "programs.control").cells["1:app/build"]!;
    expect(control.map((chip) => chip.label).sort()).toEqual(["**", "session"].sort().map((each) => (each === "**" ? "any program" : each)).sort());
    expect(control.find((chip) => chip.place === "owner=session")).toMatchObject({ kind: "owner", answer: "allow" });
  });

  it("tags a closed resource's chips with the accesses they hold for", () => {
    const board = boardOf({ view: viewOf(), open: open([]) });
    const files = row(board, "files").cells["0:auto"]!;
    const credentials = files.find((chip) => chip.place === "credentials/**")!;
    expect(credentials.tags!.map((tag) => tag.label)).toEqual(["Search"]);
  });

  it("leaves under Other only what touches no resource", () => {
    const board = boardOf({ view: viewOf(), open: open(["other"]) });
    // Every tool JaiRA ships is under a resource: Other holds only MCP tools no setting maps, and `other`.
    expect(board.rows.filter((each) => each.key.startsWith("other.")).map((each) => each.key)).toEqual(["other.other"]);
    expect(board.rows.some((each) => each.key === "other.other")).toBe(true);
  });

  it("follows the settings' mapping", () => {
    const board = boardOf({ view: viewOf(), mapping: { web_search: ["sites.fetch"] }, open: open(["sites"]) });
    expect(row(board, "sites.fetch").sub).toContain("web_search");
  });
});

describe("moving a chip", () => {
  const board = boardOf({ view: viewOf(), open: open(["files"], ["files.search"]) });
  const chipIn = (key: string, column: string, place: string) => row(board, key).cells[column]!.find((chip) => chip.place === place)!;

  it("writes a Result move into the conversation's own layer, for every tool under the chip", () => {
    const closed = boardOf({ view: viewOf(), open: open(["files"]) });
    const mixed = row(closed, "files.search").cells[RESULT]!.find((chip) => chip.place === "src/**")!;
    const move = moveOf(closed, mixed, RESULT, { column: RESULT, answer: "deny" });
    expect(move.ok && move.edits.every((edit) => edit.layer === "3:tools" && edit.decision === "deny")).toBe(true);
    expect(move.ok && move.edits.map((edit) => edit.subject).sort()).toEqual(["glob", "grep"]);
  });

  it("moves a place between layers, and asks first when it writes a set", () => {
    const move = moveOf(board, chipIn("files.search@glob", "1:app/build", "src/**"), "1:app/build", { column: "3:tools", answer: "ask" });
    expect(move).toMatchObject({ ok: true });
    if (!move.ok) return;
    expect(move.edits).toEqual([
      { layer: "3:tools", subject: "glob", place: "src/**", decision: "ask" },
      { layer: "1:app/build", subject: "glob", place: "src/**", decision: null },
    ]);
    expect(move.ask).toContain("app/build");
  });

  it("copies out of a read-only layer, and refuses one", () => {
    const copy = moveOf(board, chipIn("files.search@glob", "0:auto", "credentials/**"), "0:auto", { column: "3:tools", answer: "deny" });
    expect(copy.ok && copy.edits.length).toBe(1);
    expect(moveOf(board, chipIn("files.search@glob", "3:tools", "**") ?? chipIn("files.search@glob", RESULT, "**"), RESULT, { column: "0:auto", answer: "allow" })).toMatchObject({ ok: false });
  });

  it("refuses Off for anything but the everywhere answer", () => {
    expect(moveOf(board, chipIn("files.search@glob", RESULT, "src/**"), RESULT, { column: RESULT, answer: "off" })).toMatchObject({ ok: false });
  });

  it("edits a layer's lines: a place added to a plain answer keeps the answer as **, a line left with nothing goes", () => {
    expect(withLinesEdited({ grep: "ask" }, [{ subject: "grep", place: "src/**", decision: "allow" }])).toEqual({ grep: { "**": "ask", "src/**": "allow" } });
    expect(withLinesEdited({ read_file: { "src/**": "allow" } }, [{ subject: "read_file", place: "src/**", decision: null }])).toEqual({});
    expect(withLinesEdited({ stop_process: { "**": "ask" } }, [{ subject: "stop_process", place: "owner=session", decision: "allow" }])).toEqual({ stop_process: { "**": "ask", owner: { session: "allow" } } });
    expect(withLinesEdited({ grep: { "**": "ask", src: "allow" } }, [{ subject: "grep", place: "**", decision: "unavailable" }])).toEqual({ grep: "unavailable" });
  });
});

describe("a conversation with no lines of its own", () => {
  it("still has its own layer on the board, empty, for a Result move to land in", () => {
    const view = viewOf();
    const board = boardOf({ view: { ...view, layers: view.layers.filter((layer) => layer.id !== "tools") }, open: open([]) });
    expect(board.layers.at(-1)).toMatchObject({ label: "This conversation", writes: "conversation", key: "3:tools" });
    const chip = board.rows.find((each) => each.key === "files")!.cells[RESULT]![0]!;
    const move = moveOf(board, chip, RESULT, { column: RESULT, answer: "allow" });
    expect(move.ok && move.edits.every((edit) => edit.layer === "3:tools")).toBe(true);
  });
});

describe("what every row under a row says alike", () => {
  const line = (more: Record<string, string> = {}) => ({ "**": "ask", "~/.jaira/system/machine.key": "deny", ...more });
  const view: Pick<PermissionStackView, "layers" | "runtime"> = {
    layers: [
      {
        id: "auto",
        scope: "built in",
        role: "bottom",
        icon: "layers",
        lines: 5,
        own: { read_file: line({ "src/**": "allow" }), glob: line({ "src/**": "allow" }), grep: line({ "src/**": "allow" }), edit: line(), write_file: line() },
      },
      { id: "tools", scope: "this conversation", role: "own", icon: "chat", lines: 0, own: {} },
    ],
    runtime: {},
  };
  const board = boardOf({ view, open: open(["files"], ["files.search"]) });
  const places = (key: string, column = RESULT) => row(board, key).cells[column]!.map((chip) => `${chip.place}:${chip.answer}`).sort();

  it("keeps a place every access says alike on the resource's row, once", () => {
    expect(places("files")).toEqual(["**:ask", "~/.jaira/system/machine.key:deny"]);
    // In the root's own column the skill and artifact tools say nothing at all, so its plain ask is not
    // every access's; the machine key is every file tool's — the ones that can be placed at a path.
    expect(places("files", "0:auto")).toEqual(["~/.jaira/system/machine.key:deny"]);
    expect(places("files.write")).toEqual([]);
    expect(places("files.skills")).toEqual([]);
  });

  it("keeps what an access's tools say alike on the access's row, and the tools say only where they differ", () => {
    // Search's tools say src/** alike: the Search row has it, its tools do not.
    expect(places("files.search")).toEqual(["src/**:allow"]);
    expect(places("files.search@glob")).toEqual([]);
    expect(places("files.search@grep")).toEqual([]);
    // src/** is every reading tool's, but not the writing ones': on Read and on Search, not on Files.
    expect(places("files.read")).toEqual(["src/**:allow"]);
  });

  it("moves every line a kept chip stands for", () => {
    const chip = row(board, "files").cells[RESULT]!.find((each) => each.place === "~/.jaira/system/machine.key")!;
    expect(chip.lines.map((each) => each.subject).sort()).toEqual(["edit", "glob", "grep", "read_file", "write_file"]);
  });

  it("puts each place on the resource whose kinds have it when the settings put a tool on two", () => {
    const two = boardOf({
      view: { layers: [{ id: "auto", scope: "built in", role: "bottom", icon: "layers", lines: 1, own: { open_app: { "**": "ask", path: { "src/**": "allow" }, owner: { session: "allow" } } } }], runtime: {} },
      mapping: { open_app: ["files.read", "programs.open"] },
      open: open(["files", "programs"], ["files.read", "programs.open"]),
    });
    const at = (key: string) => [...Object.values(row(two, key).cells).flat()].map((chip) => chip.place);
    expect(at("files.read@open_app").concat(at("files")).concat(at("files.read"))).toContain("path=src/**");
    expect(at("programs.open@open_app").concat(at("programs")).concat(at("programs.open"))).toContain("owner=session");
    expect(at("files.read@open_app").concat(at("files")).concat(at("files.read"))).not.toContain("owner=session");
  });
});

describe("place sets on the board", () => {
  const credentials = ["**/.env", "**/.env.*", "**/*.pem", "**/id_rsa*", "~/.ssh", "~/.aws", "~/.claude/.credentials.json", "~/.codex/auth.json"];
  const view: Pick<PermissionStackView, "layers" | "runtime"> = {
    layers: [{ id: "auto", scope: "built in", role: "bottom", icon: "layers", lines: 1, own: { read_file: { "**": "ask", $PROJECT: "allow", ...Object.fromEntries(credentials.map((place) => [place, "deny"])) }, other: "ask" } }],
    runtime: {},
  };

  it("draws a set whose places all say one thing as one chip, its places its members", async () => {
    const { placeSetsOf } = await import("@jaira/shared");
    const board = boardOf({ view, placeSets: placeSetsOf(), open: open(["files"]) });
    const chips = row(board, "files.read").cells["0:auto"]!;
    const set = chips.find((chip) => chip.set?.id === "credentials")!;
    expect(set).toMatchObject({ label: "credentials 8", answer: "deny", kind: "set" });
    expect(set.members!.map((chip) => chip.place)).toEqual(credentials);
    expect(set.lines).toHaveLength(8);
    expect(chips.find((chip) => chip.set?.id === "project")).toMatchObject({ label: "project files", answer: "allow" });
    expect(chips.some((chip) => chip.place === "~/.ssh")).toBe(false);
  });

  it("lists `other` once, as Other's last row", () => {
    const board = boardOf({ view, open: open(["other"]) });
    expect(board.rows.filter((each) => each.label === "everything not listed")).toHaveLength(1);
  });
});

describe("the Tools view", () => {
  it("is a band per tool category, a row per tool, every place of its line on it", () => {
    const board = boardOf({ view: viewOf(), by: "tools", open: open(["cat:files", "cat:system", "cat:other"]) });
    const bands = board.rows.filter((each) => each.level === 1).map((each) => each.label);
    expect(bands.slice(0, 2)).toEqual(["File permissions", "Execution"]);
    expect(bands.at(-1)).toBe("Other");
    expect(row(board, "cat:files.glob").sub).toBe("Files · Search");
    expect(row(board, "cat:files.glob").cells[RESULT]!.map((chip) => chip.place)).toContain("credentials/**");
    expect(row(board, "cat:system.stop_process").cells["1:app/build"]!.map((chip) => chip.place)).toContain("owner=session");
    expect(board.rows.filter((each) => each.label === "everything not listed")).toHaveLength(1);
  });
});

describe("a line's row, opened on the lines under it", () => {
  const withCommands = (): Pick<PermissionStackView, "layers" | "runtime"> => ({
    layers: [
      { id: "auto", scope: "built in", role: "bottom", icon: "layers", lines: 3, own: { shell: "ask", git: "allow", "git push": "deny", set_env: "ask", other: "ask" } },
      { id: "runtime", scope: "runtime", role: "runtime", icon: "history", lines: 0 },
      { id: "tools", scope: "this conversation", role: "own", icon: "chat", lines: 0, own: {} },
    ],
    runtime: {},
  });
  const tree = lineTreeOf(["shell", "git", "git push", "git push --force", "set_env", "read_file", "npm run dev"]);

  it("puts a program under the shell, a subcommand under its program, a flag line under its tool", () => {
    expect(tree.children.get("shell")).toEqual(expect.arrayContaining(["git", "npm", "shell --run_in_background"]));
    expect(tree.children.get("git")).toEqual(expect.arrayContaining(["git push", "git status"]));
    expect(tree.children.get("git push")).toEqual(["git push --force"]);
    // `npm run dev` stands under `npm run`, the longest line its words start with.
    expect(tree.children.get("npm run")).toEqual(["npm run dev"]);
    expect(tree.children.get("set_env")).toContain("set_env PATH");
    expect(tree.roots).toEqual(expect.arrayContaining(["shell", "set_env", "read_file"]));
    expect(tree.roots).not.toContain("git");
  });

  it("lists the lines a layer writes first", () => {
    expect(tree.children.get("git")![0]).toBe("git push");
  });

  it("draws a program in the Tools view only under its open tool, a subcommand empty where it answers as its program", () => {
    const closed = boardOf({ view: withCommands(), by: "tools", open: open(["cat:execution"]) });
    expect(closed.rows.find((each) => each.label === "git")).toBeUndefined();
    const shell = row(closed, "cat:execution.shell");
    expect(shell).toMatchObject({ opens: true, open: false, ref: { level: 4, key: "cat:execution.shell" }, subject: "shell" });

    const lines = new Set(["cat:execution.shell", "cat:execution.shell>git"]);
    const board = boardOf({ view: withCommands(), by: "tools", open: { ...open(["cat:execution"]), lines } });
    const git = row(board, "cat:execution.shell>git");
    expect(git).toMatchObject({ level: 3, depth: 1, opens: true, open: true, subject: "git" });
    expect(git.cells[RESULT]!.map((chip) => chip.answer)).toEqual(["allow"]);
    // Pushing is denied: it says so. Status answers as git does: an empty row, there to be given a line.
    expect(row(board, "cat:execution.shell>git>git push").cells[RESULT]!.map((chip) => chip.answer)).toEqual(["deny"]);
    const status = row(board, "cat:execution.shell>git>git status");
    expect(status).toMatchObject({ depth: 2, subject: "git status", opens: false });
    expect(Object.values(status.cells).flat()).toHaveLength(0);
    // npm is named by no layer: empty, and it opens on its usual subcommands.
    expect(row(board, "cat:execution.shell>npm")).toMatchObject({ opens: true, cells: {} });
  });

  it("opens a tool's row in the Resources view too", () => {
    const view = withCommands();
    const closed = boardOf({ view, open: open(["programs"], ["programs.run"]) });
    const shell = closed.rows.find((each) => each.subject === "shell" && each.level === 3)!;
    expect(shell.opens).toBe(true);
    const board = boardOf({ view, open: { ...open(["programs"], ["programs.run"]), lines: new Set([shell.key]) } });
    expect(board.rows.map((each) => each.key)).toContain(`${shell.key}>git`);
  });

  it("gives a line an answer of its own from an empty cell — the Result's in the conversation's lines", () => {
    const board = boardOf({ view: withCommands(), by: "tools", open: open([]) });
    const move = addOf(board, "git status", { column: RESULT, answer: "ask" });
    expect(move).toMatchObject({ ok: true, edits: [{ layer: "2:tools", subject: "git status", place: "**", decision: "ask" }] });
    expect(addOf(board, "git status", { column: RESULT, answer: "off" }).ok).toBe(false);
    expect(addOf(board, "read_file", { column: RESULT, answer: "off" }).ok).toBe(true);
  });
});
