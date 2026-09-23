/**
 * Which toolset a map IS — the label on the Permissions chip (decision 0007 §5).
 *
 * A LABEL IS A MATCH, NEVER A MEMORY. Nothing records that a map began as `read-only`: the chip reads
 * a toolset's name while the map is exactly that toolset's — tools held, modes, implementations,
 * command subjects, `other` — and `custom` the moment one line differs. `matchToolset` is what the old
 * `presetOf` became, and it keeps the one contract of that function a reader could not have guessed:
 * a stale line for a tool nobody registers any more does not hold the label at `custom`.
 */
import { describe, expect, it } from "vitest";
import {
  bucketOf,
  matchToolset,
  sameToolset,
  toolsetBucketProblem,
  toolsetBuckets,
  toolsetHint,
  toolsetLabel,
  toolsetNameProblem,
  toolsetSummary,
  type ToolsetChoice,
} from "../src/toolsetBuckets";
import { declOfToolset, lowerToolset, parseToolset, toolsetOfEnvironment, type ToolsetDecl } from "../src/toolsets";

const choice = (id: string, decl: ToolsetDecl, layer: ToolsetChoice["layer"] = "system"): ToolsetChoice => {
  const cut = id.lastIndexOf("/");
  return { id, bucket: id.slice(0, cut), name: id.slice(cut + 1), layer, decl };
};

const READ_ONLY: ToolsetDecl = { read_file: "allow", bash: "deny", "git status": "allow", other: "deny" };
const ASK_FIRST: ToolsetDecl = { read_file: "ask", bash: "ask", other: "ask" };

const CHOICES: ToolsetChoice[] = [
  choice("chat/ask-first", ASK_FIRST),
  choice("chat/read-only", READ_ONLY),
  choice("chat_control/ask-first", { start_task: "ask", move_task: "ask", other: "deny" }),
  choice("feature/implementation/writes-asking", { write_file: "ask", other: "deny" }, "project"),
];

const REGISTERED = ["read_file", "write_file", "bash", "start_task", "move_task"];
const of = (decl: ToolsetDecl) => parseToolset(decl).toolset;

describe("which toolset a map is", () => {
  it("names the toolset whose map it EXACTLY is — round trip, through the map the composer writes", () => {
    for (const each of CHOICES) {
      const written = declOfToolset(of(each.decl));
      expect(matchToolset(of(written), CHOICES, each.bucket, REGISTERED)?.id, each.id).toBe(each.id);
    }
  });

  it("is the BUCKET's: the same map is nobody's in a bucket that does not hold it", () => {
    expect(matchToolset(of(READ_ONLY), CHOICES, "chat", REGISTERED)?.id).toBe("chat/read-only");
    expect(matchToolset(of(READ_ONLY), CHOICES, "chat_control", REGISTERED)).toBeUndefined();
    // …and the same NAME in two buckets is two toolsets.
    expect(matchToolset(of(ASK_FIRST), CHOICES, "chat_control", REGISTERED)).toBeUndefined();
  });

  it.each([
    ["a mode", { ...READ_ONLY, bash: "ask" }],
    ["a tool unticked", { read_file: "allow", "git status": "allow", other: "deny" }],
    ["a tool ticked", { ...READ_ONLY, write_file: "deny" }],
    ["an implementation", { ...READ_ONLY, read_file: { mode: "allow", implementation: "native" } }],
    ["a command subject's mode", { ...READ_ONLY, "git status": "ask" }],
    ["a command subject added", { ...READ_ONLY, "git commit": "ask" }],
    ["a command subject removed", { read_file: "allow", bash: "deny", other: "deny" }],
    ["`other`", { ...READ_ONLY, other: "ask" }],
  ] as Array<[string, ToolsetDecl]>)("becomes CUSTOM when %s differs", (_what, decl) => {
    expect(matchToolset(of(decl), CHOICES, "chat", REGISTERED)).toBeUndefined();
  });

  it("does not care about the ORDER of the lines, or an implementation written out as ours", () => {
    const shuffled: ToolsetDecl = { other: "deny", "git status": "allow", bash: "deny", read_file: { mode: "allow", implementation: "app" } };
    expect(matchToolset(of(shuffled), CHOICES, "chat", REGISTERED)?.id).toBe("chat/read-only");
  });

  it("IGNORES a line for a tool no longer registered — stale is not custom", () => {
    // `presetOf`'s contract, kept. A block that still holds a tool this project retired is a map with
    // a dead line in it; letting that hold the label at `custom` for ever would make every toolset
    // look unselectable for no reason the reader could see.
    const stale = toolsetOfEnvironment(["read_file", "bash", "retired_tool"], { tools: { read_file: "ask", bash: "ask", retired_tool: "deny" }, other: "ask" });
    expect(matchToolset(stale, CHOICES, "chat", REGISTERED)?.id).toBe("chat/ask-first");
    // …and a MODE for a tool the list does not offer (a key inherited from a parent) is not a line.
    const unGranted = toolsetOfEnvironment(["read_file", "bash"], { tools: { read_file: "ask", bash: "ask", write_file: "deny" }, other: "ask" });
    expect(matchToolset(unGranted, CHOICES, "chat", REGISTERED)?.id).toBe("chat/ask-first");
    // The same line for a tool that IS registered is a real difference.
    expect(matchToolset(of({ read_file: "ask", bash: "ask", write_file: "ask", other: "ask" }), CHOICES, "chat", REGISTERED)).toBeUndefined();
  });

  it("matches a map whose lines name FUNCTIONS by the function's name, and still after it is lowered", () => {
    const auto = choice("chat/auto", { read_file: { function: "smart" }, bash: { function: "smart" }, other: { function: "smart" } });
    const lowered = lowerToolset(of(auto.decl));
    expect(matchToolset(toolsetOfEnvironment(lowered.tools, lowered.permissions), [auto], "chat", REGISTERED)?.id).toBe("chat/auto");
    // The same lines under ANOTHER function are another toolset — and a word is not a function.
    expect(matchToolset(of({ read_file: { function: "judge" }, bash: { function: "smart" }, other: { function: "smart" } }), [auto], "chat", REGISTERED)).toBeUndefined();
    expect(matchToolset(of({ read_file: "ask", bash: { function: "smart" }, other: { function: "smart" } }), [auto], "chat", REGISTERED)).toBeUndefined();
  });

  it("still matches after a state LOWERED it — the shell's `ask`, a function, the marks, and a tool nothing serves", () => {
    // What a loaded state holds is the list and block its toolset lowered to. Read back, that has to
    // be the same toolset, or a conversation started from `$/toolsets/chat/read-only` would read
    // `custom` before anybody had touched it. `start` and `move` are named and not served yet, so
    // lowering leaves them out of the list — and they were held.
    for (const each of CHOICES) {
      const lowered = lowerToolset(of(each.decl));
      const back = toolsetOfEnvironment(lowered.tools, lowered.permissions);
      expect(matchToolset(back, CHOICES, each.bucket, REGISTERED)?.id, each.id).toBe(each.id);
    }
  });

  it("matches nothing when the map holds nothing — undeclared is not a toolset", () => {
    const empty = [...CHOICES, choice("chat/nothing", {})];
    expect(matchToolset(of({}), empty, "chat", REGISTERED)).toBeUndefined();
    expect(matchToolset(toolsetOfEnvironment(undefined), empty, "chat", REGISTERED)).toBeUndefined();
  });
});

describe("the bucket a conversation opens on", () => {
  it("is the bucket of the toolset its map is, `chat` tried first", () => {
    expect(bucketOf(of(READ_ONLY), CHOICES, REGISTERED)).toBe("chat");
    expect(bucketOf(of({ start_task: "ask", move_task: "ask", other: "deny" }), CHOICES, REGISTERED)).toBe("chat_control");
    expect(bucketOf(of({ write_file: "ask", other: "deny" }), CHOICES, REGISTERED)).toBe("feature/implementation");
  });

  it("is `chat` for a state that names none", () => {
    expect(bucketOf(toolsetOfEnvironment(undefined), CHOICES, REGISTERED)).toBe("chat");
    expect(bucketOf(of({}), [], REGISTERED)).toBe("chat");
  });
});

describe("the hierarchy the picker draws", () => {
  it("lists parents before children, a folder that only holds buckets included, with the layer that defines each", () => {
    expect(toolsetBuckets(CHOICES).map((b) => [b.path, b.depth, b.layer, b.toolsets.length, b.hint])).toEqual([
      ["chat", 0, "system", 2, "ask first · read-only"],
      ["chat_control", 0, "system", 1, "its own four — the task and workflow tools only"],
      ["feature", 0, "project", 0, "0 toolsets, and 1 bucket inside"],
      ["feature/implementation", 1, "project", 1, "writes-asking"],
    ]);
  });

  it("a shipped bucket with one file overridden here is still the shipped bucket", () => {
    const overridden = [choice("chat/ask-first", ASK_FIRST), choice("chat/read-only", { ...READ_ONLY, bash: "ask" }, "project")];
    expect(toolsetBuckets(overridden)[0]).toMatchObject({ path: "chat", layer: "system" });
  });
});

describe("what a toolset is called", () => {
  it("uses the shipped words for a shipped file, and the file's own name and contents otherwise", () => {
    expect(toolsetLabel(CHOICES[0]!)).toBe("ask first");
    expect(toolsetHint(choice("chat/ask-first", ASK_FIRST))).toBe("stop and ask before every call");
    // An override keeps the NAME people know it by and loses the sentence, which may no longer be true.
    expect(toolsetLabel(choice("chat/full", {}, "project"))).toBe("full access");
    expect(toolsetHint(choice("chat/full", { bash: "allow", other: "ask" }, "project"))).toBe("1 line · other ask");
    expect(toolsetLabel(CHOICES[3]!)).toBe("writes-asking");
  });

  it("summarises a map by its lines and its `other`", () => {
    expect(toolsetSummary(of(ASK_FIRST))).toBe("2 lines · all ask");
    expect(toolsetSummary(of(READ_ONLY))).toBe("3 lines · other deny");
    expect(toolsetSummary(of({ bash: { function: "smart" }, other: { function: "smart" } }))).toBe("1 line · all smart");
  });
});

describe("a name a toolset file can have", () => {
  it("is one path segment a reference can carry", () => {
    expect(toolsetNameProblem("ask-but-commit")).toBeUndefined();
    expect(toolsetNameProblem("v2.strict_mode")).toBeUndefined();
    for (const bad of ["", "../escape", "a/b", "with space", ".hidden", "-lead"]) expect(toolsetNameProblem(bad), bad).toBeDefined();
  });

  it("and a bucket is one or more of them", () => {
    expect(toolsetBucketProblem("chat")).toBeUndefined();
    expect(toolsetBucketProblem("feature/implementation")).toBeUndefined();
    for (const bad of ["", "/chat", "chat/", "chat/../x", "a//b"]) expect(toolsetBucketProblem(bad), bad).toBeDefined();
  });
});
