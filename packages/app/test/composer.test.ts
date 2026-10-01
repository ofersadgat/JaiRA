/**
 * What the composer says and does, asserted on the pure modules its chips and cards are drawn from.
 * The components that draw them are the universal tree's, and nothing here renders one:
 *
 *  - the two cards over permission sets (decision 0007 §5) — the chips' words, the Permissions card's
 *    rows, its bucket and its sentence, and what the Tools card lists (`composerModel.ts`,
 *    `composerCards.ts`, `permissionSetWords.ts`, and a permission set's own words in `@jaira/shared`);
 *  - what a click on the Tools card does to the permission map (`composerPermissionSet.ts`): how
 *    commands group under their program, what a group's and a section's mode is, and what ticking,
 *    unticking and adding write;
 *  - the one control that is not about what to say, the button: whether a message can be sent right
 *    now, and what the button says Enter will do (`composerModel.ts`).
 */
import { describe, expect, it } from "vitest";
import {
  declOfPermissionSet,
  lowerPermissionSet,
  parsePermissionSet,
  PERMISSION_SET_LAYER_LABELS,
  permissionSetHint,
  permissionSetLabel,
  TOOL_CATEGORIES,
  TOOL_SPEC_BY_NAME,
  type ChatPlanView,
  type ChatSettings,
  type PermissionSet,
  type PermissionSetChoice,
  type PermissionSetDecl,
} from "@jaira/shared/browser";
import { KEEP_WHERE, originWordsOf, permissionsHintOf } from "../src/renderer/composerCards";
import { canSendOf, chipValuesOf, composerFactsOf, sendTitleOf, type ComposerFacts } from "../src/renderer/composerModel";
import {
  commandGroupsOf,
  commandSubjectOf,
  groupModeOf,
  groupSentence,
  groupSummary,
  sectionCountOf,
  sectionModeOf,
  toolModeOf,
  withCommand,
  withSectionMode,
  withSubject,
  withToolHeld,
} from "../src/renderer/composerPermissionSet";
import { toolLineOption } from "../src/renderer/permissionSetLinesModel";
import { SCRIPT_HINT, SHELL_HINT } from "../src/renderer/permissionSetWords";

const plan = (): ChatPlanView =>
  ({
    settings: {},
    origin: { model: "unset", reasoning: "unset", tools: "unset", permissions: "unset" },
    unresolved: [],
    live: "idle",
    effective: { reasoning: "medium", permissions: "ask" },
    available: { routes: [], tools: [], models: [] },
  }) as unknown as ChatPlanView;

/**
 * The two cards over permission sets (decision 0007 §5).
 *
 * What the cards SAY is read where the composer reads it: `composerFactsOf` for the map, the rows and
 * the bucket, `chipValuesOf` for the chips' words. Everything a click DOES is asserted on the pure
 * functions the clicks call (`composerPermissionSet.ts`), in the describe after these.
 */
const choice = (id: string, decl: PermissionSetDecl, layer: PermissionSetChoice["layer"] = "system"): PermissionSetChoice => {
  const cut = id.lastIndexOf("/");
  return { id, bucket: id.slice(0, cut), name: id.slice(cut + 1), layer, decl };
};
const ASK_FIRST: PermissionSetDecl = { read_file: "ask", write_file: "ask", bash: "ask", other: "ask" };
const READ_ONLY: PermissionSetDecl = { read_file: "allow", write_file: "deny", bash: "deny", other: "deny" };
const PERMISSION_SETS: PermissionSetChoice[] = [
  choice("chat/ask-first", ASK_FIRST),
  choice("chat/read-only", READ_ONLY),
  choice("chat_control/ask-first", { start_task: "ask", move_task: "ask", other: "deny" }),
  choice("feature/implementation/writes-asking", { write_file: "ask", other: "deny" }, "project"),
];
const TOOLS = ["read_file", "write_file", "bash", "start_task", "move_task"].map((name) => ({ name }));

/** A plan whose permission set is the person's own choice (`permission set`), or what a state declared (its lowered list and block). */
const permissionSetPlan = (settings: ChatSettings, bucket?: string): ChatPlanView =>
  ({
    ...plan(),
    settings,
    origin: { model: "unset", reasoning: "unset", tools: "inherited", permissions: "inherited", implementations: "unset", permissionSet: settings.permissionSet !== undefined ? "override" : "unset" },
    from: "chat/session",
    effective: { reasoning: "medium", permissions: "ask by default" },
    available: { routes: [], tools: TOOLS, models: [], permissionSets: PERMISSION_SETS, ...(bucket !== undefined ? { bucket } : {}) },
  }) as unknown as ChatPlanView;

/** What the composer reads off a plan, with no bucket picked on the card. */
const factsOf = (view: ChatPlanView): ComposerFacts => composerFactsOf(view, undefined);
/** The chips' words for a plan — the Permissions chip's and the Tools chip's are the two read here. */
const chipsOf = (view: ChatPlanView): ReturnType<typeof chipValuesOf> => chipValuesOf(view, factsOf(view), undefined);
/** The Permissions card's rows, as each is called. */
const rowsOf = (facts: ComposerFacts): string[] => facts.rows.map(permissionSetLabel);
const of = (decl: PermissionSetDecl): PermissionSet => parsePermissionSet(decl).permissionSet;

describe("the Permissions card holds the permission sets of one bucket", () => {
  it("names the permission set the map EXACTLY is, and matches its row and no other", () => {
    const view = permissionSetPlan({ permissionSet: READ_ONLY });
    const facts = factsOf(view);
    expect(chipsOf(view).permissions).toBe("read-only");
    expect(rowsOf(facts)).toEqual(["ask first", "read-only"]);
    // One match, which is the row that is ticked — and, the map being somebody's already, why `+`
    // has nothing to keep.
    expect(facts.matched?.id).toBe("chat/read-only");
    expect(permissionSetHint(facts.matched!)).toBe("reading goes ahead, anything that writes is refused");
    // The head: the bucket, then where the value came from.
    expect(facts.bucket).toBe("chat");
    expect(originWordsOf(facts.permissionsOrigin, view.from)).toEqual({ text: "your choice for this message", tone: "own" });
  });

  it("matches a state's OWN declaration too — the lowered list and block it arrives as", () => {
    const lowered = lowerPermissionSet(parsePermissionSet({ read_file: "ask", write_file: "ask", bash: "ask", other: "ask" }).permissionSet);
    const view = permissionSetPlan({ tools: lowered.tools, ...(lowered.permissions !== undefined ? { permissions: lowered.permissions } : {}) });
    expect(chipsOf(view).permissions).toBe("ask first");
    // Nobody chose it here, so the card says where the state's declaration came from.
    expect(originWordsOf(factsOf(view).permissionsOrigin, view.from).text).toBe("inherited from chat/session");
  });

  it("reads CUSTOM the moment one line differs, matches no row, and says what + would keep", () => {
    const view = permissionSetPlan({ permissionSet: { ...READ_ONLY, bash: "ask" } });
    const facts = factsOf(view);
    expect(chipsOf(view).permissions).toBe("custom");
    expect(facts.matched).toBeUndefined();
    expect(permissionsHintOf(facts.rows.length, facts.matched !== undefined, facts.tools.length, facts.bucket)).toBe(
      "These tools and modes match no permission set in chat — + keeps them as a new one.",
    );
  });

  it("words where a kept permission set goes, one word per layer", () => {
    // The form offers these as its `where`, and reads the layer back from the word that was picked —
    // so with no project open there is one place to keep it, and two words must never be the same.
    expect(KEEP_WHERE).toEqual({ project: "in this project", base: "for all projects" });
  });

  it("opens on the plan's bucket, whose rows are ITS versions of the same names", () => {
    const control = { start_task: "ask", move_task: "ask", other: "deny" } as PermissionSetDecl;
    const view = permissionSetPlan({ permissionSet: control }, "chat_control");
    const facts = factsOf(view);
    expect(facts.bucket).toBe("chat_control");
    expect(chipsOf(view).permissions).toBe("ask first");
    expect(rowsOf(facts)).toEqual(["ask first"]);
    expect(facts.rows.map(permissionSetHint)).toEqual(["ask before starting, moving or answering anything"]);
    // The same map read in the chat bucket is nobody's: a label belongs to a bucket.
    expect(chipsOf(permissionSetPlan({ permissionSet: control }, "chat")).permissions).toBe("custom");
  });

  it("lists the hierarchy for the picker: each bucket, what it holds, the layer that defines it, nested ones a level in", () => {
    const { buckets } = factsOf(permissionSetPlan({ permissionSet: ASK_FIRST }));
    expect(buckets.map((row) => [row.name, row.depth, PERMISSION_SET_LAYER_LABELS[row.layer]])).toEqual([
      ["chat", 0, "built in"],
      ["chat_control", 0, "built in"],
      ["feature", 0, "this project"],
      ["implementation", 1, "this project"],
    ]);
    expect(buckets.find((row) => row.path === "chat")?.hint).toBe("ask first · read-only");
    expect(buckets.find((row) => row.path === "feature")?.hint).toBe("0 permission sets, and 1 bucket inside");
  });

  it("falls back to what main worded when the call declares no tools — there is no map to match", () => {
    expect(chipsOf(permissionSetPlan({})).permissions).toBe("ask by default");
  });
});

describe("the Tools card", () => {
  const WITH_COMMANDS: PermissionSetDecl = { ...ASK_FIRST, "git status": "allow", "git commit": "ask", git: "deny", "npm test": "ask", script: "ask" };

  it("counts the tools the map holds, as it always did", () => {
    expect(chipsOf(permissionSetPlan({ permissionSet: WITH_COMMANDS })).tools).toBe("3 tools");
    expect(chipsOf(permissionSetPlan({ permissionSet: { bash: "ask", other: "ask" } })).tools).toBe("bash");
    expect(chipsOf(permissionSetPlan({})).tools).toBe("no tools");
  });

  it("lists under Execution the shell, the commands grouped under their program, and script", () => {
    const { map } = factsOf(permissionSetPlan({ permissionSet: WITH_COMMANDS }));
    // The programs in the order they were written, each with its subcommands under it.
    const groups = commandGroupsOf(map);
    expect(groups).toEqual([
      { program: "git", own: "deny", subs: [{ subject: "git status", mode: "allow" }, { subject: "git commit", mode: "ask" }] },
      { program: "npm", subs: [{ subject: "npm test", mode: "ask" }] },
    ]);
    // An open group says its sentence; one still shut names what is under it.
    expect(groupSentence(map, groups[0]!)).toBe("2 subcommands named; any other git is refused");
    expect(groupSummary(map, groups[1]!)).toBe("test");
    expect(map.entries["script"]).toEqual({ kind: "script", mode: "ask" });
    // What the shell's line and script's say they stand for.
    expect(SHELL_HINT).toBe("the shell — and the mode for any command not named below");
    expect(SCRIPT_HINT).toBe("running a file — ./x.sh, bash x.sh, python x.py — and what a runner runs that could not be read");
  });

  it("has a Tasks & workflows section, whose tools are worded like any other now that they are served", () => {
    const facts = factsOf(permissionSetPlan({ permissionSet: { start_task: "ask", other: "deny" } }));
    expect(facts.offered.some((tool) => tool.name === "start_task")).toBe(true);
    const spec = TOOL_SPEC_BY_NAME.get("start_task")!;
    expect(TOOL_CATEGORIES.find((category) => category.id === spec.category)?.label).toBe("Tasks & workflows");
    expect(sectionCountOf(facts.map, "tasks")).toBe(1);
    // The hint alone — the "· not served yet" suffix went with the `unserved` mark (decision 0005
    // step 6), and a tool a conversation can actually call must not still say nothing serves it.
    expect(spec.unserved).toBeUndefined();
    expect(toolLineOption("start_task").hint).toBe("start a task in a workflow, from this conversation");
  });
});

describe("what a click on the Tools card does to the map", () => {
  const BASE = of({ read_file: "allow", bash: "ask", "git status": "allow", "git commit": "ask", other: "deny" });

  it("groups commands under their program, the bare program's entry being the group's OWN mode", () => {
    const groups = commandGroupsOf(of({ bash: "ask", "git status": "allow", "npm test": "ask", git: "deny", "git push --force": "deny", terraform: "ask", other: "ask" }));
    expect(groups).toEqual([
      { program: "git", own: "deny", subs: [{ subject: "git status", mode: "allow" }, { subject: "git push --force", mode: "deny" }] },
      { program: "npm", subs: [{ subject: "npm test", mode: "ask" }] },
      { program: "terraform", own: "ask", subs: [] },
    ]);
  });

  it("a group with no entry of its own shows what any other command of it answers to: the shell's line, then `other`", () => {
    const [git] = commandGroupsOf(BASE);
    expect(groupModeOf(BASE, git!)).toBe("ask");
    expect(groupSentence(BASE, git!)).toBe("2 subcommands named; any other git asks");
    expect(groupSummary(BASE, git!)).toBe("status · commit");
    const noShell = of({ "git status": "allow", other: "deny" });
    expect(groupModeOf(noShell, commandGroupsOf(noShell)[0]!)).toBe("deny");
  });

  it("setting a group's mode writes the BARE program and leaves its subcommands saying what they said", () => {
    const next = withSubject(BASE, "git", "deny");
    expect(declOfPermissionSet(next)).toEqual({ read_file: "allow", bash: "ask", "git status": "allow", "git commit": "ask", git: "deny", other: "deny" });
  });

  it("reads what was typed as the subject it names — the program implied inside a group, and forgiven when repeated", () => {
    expect(commandSubjectOf("push", "git")).toEqual({ subject: "git push" });
    expect(commandSubjectOf("  git   push --force ", "git")).toEqual({ subject: "git push --force" });
    expect(commandSubjectOf("terraform plan")).toEqual({ subject: "terraform plan" });
    for (const bad of ["", "read_file", "script", "other", "Glob"]) expect(commandSubjectOf(bad), bad).toHaveProperty("problem");
    expect(commandSubjectOf("", "git")).toHaveProperty("problem");
  });

  it("adds a command at the mode that already answers for it, so adding changes nothing until it is set", () => {
    expect(declOfPermissionSet(withCommand(BASE, "git push"))["git push"]).toBe("ask"); // the shell's line
    expect(declOfPermissionSet(withCommand(withSubject(BASE, "git", "deny"), "git push"))["git push"]).toBe("deny"); // the group's own
    expect(withCommand(BASE, "git status")).toBe(BASE); // already a line
  });

  it("unticking a tool REMOVES its line, and ticking it again puts back the mode the row was showing", () => {
    const without = withToolHeld(BASE, {}, "bash", false);
    expect(declOfPermissionSet(without)).not.toHaveProperty("bash");
    // The row still shows a mode — kept beside the map, never in it.
    const parked = { bash: { mode: "deny" as const } };
    expect(toolModeOf(without, parked, "bash")).toBe("deny");
    expect(declOfPermissionSet(withToolHeld(without, parked, "bash", true))["bash"]).toBe("deny");
    expect(declOfPermissionSet(withToolHeld(without, {}, "bash", true))["bash"]).toBe("ask");
  });

  it("a section's mode is derived from its lines — Execution's include the commands and script — and setting it writes them all", () => {
    expect(sectionModeOf(BASE, {}, "execution")).toBeUndefined(); // ask, allow, ask — `custom`
    expect(sectionCountOf(BASE, "execution")).toBe(3);
    const { permissionSet, parked } = withSectionMode(BASE, {}, "execution", "deny");
    expect(declOfPermissionSet(permissionSet)).toEqual({ read_file: "allow", bash: "deny", "git status": "deny", "git commit": "deny", other: "deny" });
    expect(sectionModeOf(permissionSet, parked, "execution")).toBe("deny");
    // A tool the map does not hold takes the mode beside the map, and is still not offered.
    const files = withSectionMode(BASE, {}, "files", "ask");
    expect(declOfPermissionSet(files.permissionSet)["read_file"]).toBe("ask");
    expect(declOfPermissionSet(files.permissionSet)).not.toHaveProperty("write_file");
    expect(files.parked["write_file"]).toEqual({ mode: "ask" });
  });
});

describe("the composer's button", () => {
  // The button wears three verbs across two props, and what decides between them is one question:
  // can a message be sent right now. The stop button itself is the host's `onStop` and is drawn by
  // the component; whether SEND stands beside it, and whether it is greyed, is `canSendOf`.
  it("sends when nothing is in flight", () => {
    expect(canSendOf(undefined, undefined, undefined)).toBe(true);
    expect(sendTitleOf(false, undefined)).toBe("Enter to send, Shift+Enter for a new line");
  });

  it("cannot send over a composer that is disabled — the composite case", () => {
    // The regression. A state that holds no conversation disables the box, and where a workflow is
    // still running under it the stop button has to stand alone: there is nowhere for a message to
    // go, so offering to send one would be an invitation to an error.
    const disabled = "This state holds no conversation of its own — reply in one of the runs below.";
    expect(canSendOf(disabled, true, undefined)).toBe(false);
    // Not even where the host would let a message join a turn, and not at rest either.
    expect(canSendOf(disabled, true, true)).toBe(false);
    expect(canSendOf(disabled, undefined, undefined)).toBe(false);
  });

  it("sends while a turn is in flight in a conversation, and says the message joins it", () => {
    // The message joins the turn — that is what the line above the button has been saying, and what
    // `chat:send` has always done. One button meant the box refused what the channel underneath it
    // was willing to do: you could stop the agent, or wait, and nothing else.
    expect(canSendOf(undefined, true, true)).toBe(true);
    expect(sendTitleOf(false, true)).toBe("Enter to send — this joins the turn in flight");
  });

  it("still refuses a second send where the first is what STARTS the conversation", () => {
    // The box on the empty Chat view. Its `busy` is a task being created, and a second send there is
    // a second conversation rather than a second message — so `joinable` is what this turns on, not
    // `busy` alone.
    expect(canSendOf(undefined, true, undefined)).toBe(false);
    expect(canSendOf(undefined, true, false)).toBe(false);
  });
});
