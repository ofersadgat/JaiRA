/**
 * The one control on the composer that is not about what to say: the button.
 *
 * It wears three verbs across two props, and the combination that mattered was the one nobody had:
 * a composer that cannot SEND (no conversation in this state) sitting under a workflow that is still
 * running. That is the ordinary shape of watching a composite — its children hold the conversations,
 * it holds none — and it left the panel with no way to stop the run it was showing.
 *
 * Rendered to static markup rather than through a DOM harness: the claim is what is on the page, and
 * a server render answers exactly that.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { declOfToolset, lowerToolset, parseToolset, type ChatPlanView, type ChatSettings, type Toolset, type ToolsetChoice, type ToolsetDecl } from "@jaira/shared/browser";
import { Composer } from "../src/renderer/composer";
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
} from "../src/renderer/composerToolset";

const plan = (): ChatPlanView =>
  ({
    settings: {},
    origin: { model: "unset", reasoning: "unset", tools: "unset", permissions: "unset" },
    unresolved: [],
    live: "idle",
    effective: { reasoning: "medium", permissions: "ask" },
    available: { routes: [], tools: [], models: [] },
  }) as unknown as ChatPlanView;

const draw = (props: Partial<Parameters<typeof Composer>[0]>): string =>
  renderToStaticMarkup(
    createElement(Composer, {
      plan: plan(),
      overrides: {},
      onOverrides: () => undefined,
      onSend: () => undefined,
      ...props,
    }),
  );

/**
 * The two cards over toolsets (decision 0007 §5).
 *
 * Drawn the same way — the real component, to static markup, with the card it is about drawn open
 * from the first render (`startOpen`) — and, for everything a click DOES, asserted on the pure
 * functions the clicks call (`composerToolset.ts`), because there is no DOM harness here.
 */
const choice = (id: string, decl: ToolsetDecl, layer: ToolsetChoice["layer"] = "system"): ToolsetChoice => {
  const cut = id.lastIndexOf("/");
  return { id, bucket: id.slice(0, cut), name: id.slice(cut + 1), layer, decl };
};
const ASK_FIRST: ToolsetDecl = { read_file: "ask", write_file: "ask", bash: "ask", other: "ask" };
const READ_ONLY: ToolsetDecl = { read_file: "allow", write_file: "deny", bash: "deny", other: "deny" };
const TOOLSETS: ToolsetChoice[] = [
  choice("chat/ask-first", ASK_FIRST),
  choice("chat/read-only", READ_ONLY),
  choice("chat_control/ask-first", { start_task: "ask", move_task: "ask", other: "deny" }),
  choice("feature/implementation/writes-asking", { write_file: "ask", other: "deny" }, "project"),
];
const TOOLS = ["read_file", "write_file", "bash", "start_task", "move_task"].map((name) => ({ name }));

/** A plan whose toolset is the person's own choice (`toolset`), or what a state declared (its lowered list and block). */
const toolsetPlan = (settings: ChatSettings, bucket?: string): ChatPlanView =>
  ({
    ...plan(),
    settings,
    origin: { model: "unset", reasoning: "unset", tools: "inherited", permissions: "inherited", implementations: "unset", toolset: settings.toolset !== undefined ? "override" : "unset" },
    from: "chat/session",
    effective: { reasoning: "medium", permissions: "ask by default" },
    available: { routes: [], tools: TOOLS, models: [], toolsets: TOOLSETS, ...(bucket !== undefined ? { bucket } : {}) },
  }) as unknown as ChatPlanView;

/** The chip's word: the text of the Permissions chip button. */
const chipOf = (html: string): string => /title="Permissions: ([^"]*)"/.exec(html)?.[1] ?? "";
const rowsOf = (html: string): string[] => [...html.matchAll(/<span class="cx-opt-name ellip">([^<]*)<\/span><span class="cx-opt-hint ellip">/g)].map((m) => m[1]!);
const of = (decl: ToolsetDecl): Toolset => parseToolset(decl).toolset;

describe("the Permissions card holds the toolsets of one bucket", () => {
  it("names the toolset the map EXACTLY is, ticks its row, and keeps + dim", () => {
    const html = draw({ plan: toolsetPlan({ toolset: READ_ONLY }), onSaveToolset: async () => undefined, startOpen: { card: "Permissions" } });
    expect(chipOf(html)).toBe("read-only");
    expect(rowsOf(html)).toEqual(["ask first", "read-only"]);
    // One tick, on the matching row.
    expect(html.match(/cx-opt-tick/g)).toHaveLength(1);
    expect(html).toMatch(/class="on"[^>]*title="reading goes ahead[^"]*"/);
    expect(html).toMatch(/<button type="button" class="cx-set-add"[^>]*disabled=""/);
    // The head: the bucket, then where the value came from.
    expect(html).toMatch(/cx-origin-pick cx-bucket[^>]*>.*?<\/span>chat<span class="cx-more">/);
    expect(html).toContain("your choice for this message");
  });

  it("matches a state's OWN declaration too — the lowered list and block it arrives as", () => {
    const lowered = lowerToolset(parseToolset({ read_file: "ask", write_file: "ask", bash: "ask", other: "ask" }).toolset);
    const html = draw({ plan: toolsetPlan({ tools: lowered.tools, ...(lowered.permissions !== undefined ? { permissions: lowered.permissions } : {}) }) });
    expect(chipOf(html)).toBe("ask first");
  });

  it("reads CUSTOM the moment one line differs, ticks nothing, and lights +", () => {
    const html = draw({
      plan: toolsetPlan({ toolset: { ...READ_ONLY, bash: "ask" } }),
      onSaveToolset: async () => undefined,
      startOpen: { card: "Permissions" },
    });
    expect(chipOf(html)).toBe("custom");
    expect(html).not.toContain("cx-opt-tick");
    expect(html).toContain('class="cx-set-add ready"');
    expect(html).toContain("match no toolset in chat");
  });

  it("keeps + dim where the host gave it nowhere to write", () => {
    const html = draw({ plan: toolsetPlan({ toolset: { ...READ_ONLY, bash: "ask" } }), startOpen: { card: "Permissions" } });
    expect(html).toMatch(/class="cx-set-add"[^>]*disabled=""/);
  });

  it("asks for a name and where, through the schema form, when + is open", () => {
    const html = draw({
      plan: toolsetPlan({ toolset: { ...READ_ONLY, bash: "ask" } }),
      onSaveToolset: async () => undefined,
      startOpen: { card: "Permissions", keep: true },
    });
    expect(html).toContain("Keep these tools and modes as a toolset in <b>chat</b>");
    expect(html).toContain("in this project");
    expect(html).toContain(">Add</button>");
    // With no project open there is only one place to keep it.
    const baseOnly = draw({
      plan: toolsetPlan({ toolset: { ...READ_ONLY, bash: "ask" } }),
      onSaveToolset: async () => undefined,
      saveLayers: ["base"],
      startOpen: { card: "Permissions", keep: true },
    });
    expect(baseOnly).toContain("for all projects");
    expect(baseOnly).not.toContain("in this project");
  });

  it("opens on the plan's bucket, whose rows are ITS versions of the same names", () => {
    const control = { start_task: "ask", move_task: "ask", other: "deny" } as ToolsetDecl;
    const html = draw({ plan: toolsetPlan({ toolset: control }, "chat_control"), startOpen: { card: "Permissions" } });
    expect(chipOf(html)).toBe("ask first");
    expect(rowsOf(html)).toEqual(["ask first"]);
    expect(html).toContain("ask before starting, moving or answering anything");
    // The same map read in the chat bucket is nobody's: a label belongs to a bucket.
    expect(chipOf(draw({ plan: toolsetPlan({ toolset: control }, "chat") }))).toBe("custom");
  });

  it("draws the hierarchy in the picker: each bucket, what it holds, the layer that defines it, nested ones indented", () => {
    const html = draw({ plan: toolsetPlan({ toolset: ASK_FIRST }), startOpen: { card: "Permissions", buckets: true } });
    const picker = html.slice(html.indexOf('class="cx-submenu"'), html.indexOf('<span class="cx-origin'));
    expect([...picker.matchAll(/padding-left:(\d+)px[^]*?cx-opt-name ellip">([a-z_]+) <span class="cx-src">([^<]*)</g)].map((m) => [m[2], m[1], m[3]])).toEqual([
      ["chat", "7", "built in"],
      ["chat_control", "7", "built in"],
      ["feature", "7", "this project"],
      ["implementation", "23", "this project"],
    ]);
    expect(picker).toContain("ask first · read-only");
    expect(picker).toContain("0 toolsets, and 1 bucket inside");
  });

  it("falls back to what main worded when the call declares no tools — there is no map to match", () => {
    expect(chipOf(draw({ plan: toolsetPlan({}) }))).toBe("ask by default");
  });
});

describe("the Tools card", () => {
  const WITH_COMMANDS: ToolsetDecl = { ...ASK_FIRST, "git status": "allow", "git commit": "ask", git: "deny", "npm test": "ask", script: "ask" };

  it("counts the tools the map holds, as it always did", () => {
    expect(draw({ plan: toolsetPlan({ toolset: WITH_COMMANDS }) })).toContain('title="Tools: 3 tools"');
    expect(draw({ plan: toolsetPlan({ toolset: { bash: "ask", other: "ask" } }) })).toContain('title="Tools: bash"');
    expect(draw({ plan: toolsetPlan({}) })).toContain('title="Tools: no tools"');
  });

  it("lists under Execution the shell, the commands grouped under their program, script, and the line that adds one", () => {
    const html = draw({ plan: toolsetPlan({ toolset: WITH_COMMANDS }), startOpen: { card: "Tools", folds: ["execution", "program:git"] } });
    expect(html).toContain("the shell — and the mode for any command not named below");
    // `git` is a fold that opens onto its subcommands; `npm` is one still shut.
    expect(html).toMatch(/cx-cat cx-sub open[^]*?<span class="mono">git<\/span>[^]*?2 subcommands named; any other git is refused/);
    expect(html).toMatch(/<span class="mono">git status<\/span>[^]*?cx-mode-allow/);
    expect(html).toContain("add a git subcommand");
    expect(html).toMatch(/class="cx-cat cx-sub"[^]*?<span class="mono">npm<\/span>[^]*?>test</);
    expect(html).not.toContain("add a npm subcommand");
    expect(html).toContain("running a file — ./x.sh, npm run, python x.py, make");
    expect(html).toContain("add a command");
    // Order: the shell, the groups, script, then the adding line.
    const at = (text: string): number => html.indexOf(text);
    expect([at("the shell —"), at('<span class="mono">git</span>'), at('<span class="mono">npm</span>'), at("running a file"), at("add a command")]).toEqual(
      [...[at("the shell —"), at('<span class="mono">git</span>'), at('<span class="mono">npm</span>'), at("running a file"), at("add a command")]].sort((a, b) => a - b),
    );
  });

  it("has a Tasks & workflows section, whose tools are drawn like any other now that they are served", () => {
    const tasks = [...TOOLS];
    const html = draw({ plan: toolsetPlan({ toolset: { start_task: "ask", other: "deny" } }), startOpen: { card: "Tools", folds: ["tasks"] } });
    expect(tasks.some((t) => t.name === "start_task")).toBe(true);
    expect(html).toContain("Tasks &amp; workflows");
    // The hint alone — the "· not served yet" suffix went with the `unserved` mark (decision 0005
    // step 6), and a tool a conversation can actually call must not still say nothing serves it.
    expect(html).toContain("start a task in a workflow, from this conversation");
    expect(html).not.toContain("not served yet");
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
    expect(declOfToolset(next)).toEqual({ read_file: "allow", bash: "ask", "git status": "allow", "git commit": "ask", git: "deny", other: "deny" });
  });

  it("reads what was typed as the subject it names — the program implied inside a group, and forgiven when repeated", () => {
    expect(commandSubjectOf("push", "git")).toEqual({ subject: "git push" });
    expect(commandSubjectOf("  git   push --force ", "git")).toEqual({ subject: "git push --force" });
    expect(commandSubjectOf("terraform plan")).toEqual({ subject: "terraform plan" });
    for (const bad of ["", "read_file", "script", "other", "Glob"]) expect(commandSubjectOf(bad), bad).toHaveProperty("problem");
    expect(commandSubjectOf("", "git")).toHaveProperty("problem");
  });

  it("adds a command at the mode that already answers for it, so adding changes nothing until it is set", () => {
    expect(declOfToolset(withCommand(BASE, "git push"))["git push"]).toBe("ask"); // the shell's line
    expect(declOfToolset(withCommand(withSubject(BASE, "git", "deny"), "git push"))["git push"]).toBe("deny"); // the group's own
    expect(withCommand(BASE, "git status")).toBe(BASE); // already a line
  });

  it("unticking a tool REMOVES its line, and ticking it again puts back the mode the row was showing", () => {
    const without = withToolHeld(BASE, {}, "bash", false);
    expect(declOfToolset(without)).not.toHaveProperty("bash");
    // The row still shows a mode — kept beside the map, never in it.
    const parked = { bash: { mode: "deny" as const } };
    expect(toolModeOf(without, parked, "bash")).toBe("deny");
    expect(declOfToolset(withToolHeld(without, parked, "bash", true))["bash"]).toBe("deny");
    expect(declOfToolset(withToolHeld(without, {}, "bash", true))["bash"]).toBe("ask");
  });

  it("a section's mode is derived from its lines — Execution's include the commands and script — and setting it writes them all", () => {
    expect(sectionModeOf(BASE, {}, "execution")).toBeUndefined(); // ask, allow, ask — `custom`
    expect(sectionCountOf(BASE, "execution")).toBe(3);
    const { toolset, parked } = withSectionMode(BASE, {}, "execution", "deny");
    expect(declOfToolset(toolset)).toEqual({ read_file: "allow", bash: "deny", "git status": "deny", "git commit": "deny", other: "deny" });
    expect(sectionModeOf(toolset, parked, "execution")).toBe("deny");
    // A tool the map does not hold takes the mode beside the map, and is still not offered.
    const files = withSectionMode(BASE, {}, "files", "ask");
    expect(declOfToolset(files.toolset)["read_file"]).toBe("ask");
    expect(declOfToolset(files.toolset)).not.toHaveProperty("write_file");
    expect(files.parked["write_file"]).toEqual({ mode: "ask" });
  });
});

describe("the composer's button", () => {
  it("sends when nothing is in flight", () => {
    const html = draw({});
    expect(html).toContain('aria-label="Send"');
    expect(html).not.toContain("cx-stop");
  });

  it("becomes a stop button while something is in flight", () => {
    expect(draw({ busy: true, onStop: () => undefined })).toContain('aria-label="Stop"');
  });

  it("stays a greyed send button when the host has nothing to stop", () => {
    // No `onStop` is an honest shape, not an oversight: a transcript beside a board has no handle on
    // the run it is reading, and a stop button that could not stop anything is worse than none.
    const html = draw({ busy: true });
    expect(html).toContain('aria-label="Send"');
    expect(html).toContain("disabled");
  });

  it("offers stop over a composer that cannot send — the composite case", () => {
    // The regression. A state that holds no conversation disables the box, and disabling the box
    // used to take the only handle on a running workflow with it.
    const html = draw({
      busy: true,
      onStop: () => undefined,
      disabled: "This state holds no conversation of its own — reply in one of the runs below.",
    });
    expect(html).toContain('aria-label="Stop"');
    expect(html).toContain("holds no conversation of its own");
    // And ONLY stop: there is nowhere for a message to go, so offering to send one would be an
    // invitation to an error.
    expect(html).not.toContain('aria-label="Send"');
  });

  it("offers both while a turn is in flight in a conversation", () => {
    // The message joins the turn — that is what the line above the button has been saying, and what
    // `chat:send` has always done. One button meant the box refused what the channel underneath it
    // was willing to do: you could stop the agent, or wait, and nothing else.
    const html = draw({ busy: true, joinable: true, onStop: () => undefined });
    expect(html).toContain('aria-label="Stop"');
    expect(html).toContain('aria-label="Send"');
    expect(html).toContain("joins the turn in flight");
  });

  it("still refuses a second send where the first is what STARTS the conversation", () => {
    // The box on the empty Chat view. Its `busy` is a task being created, and a second send there is
    // a second conversation rather than a second message — so `joinable` is what this turns on, not
    // `busy` alone.
    expect(draw({ busy: true })).toContain("disabled");
  });
});
