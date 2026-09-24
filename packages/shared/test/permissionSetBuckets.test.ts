/**
 * Which permission set a map IS — the label on the Permissions chip (decision 0007 §5).
 *
 * A LABEL IS A MATCH, NEVER A MEMORY. Nothing records that a map began as `read-only`: the chip reads
 * a permission set's name while the map is exactly that permission set's — tools held, modes, implementations,
 * command subjects, `other` — and `custom` the moment one line differs. `matchPermissionSet` is what the old
 * `presetOf` became, and it keeps the one contract of that function a reader could not have guessed:
 * a stale line for a tool nobody registers any more does not hold the label at `custom`.
 */
import { describe, expect, it } from "vitest";
import {
  bucketOf,
  matchPermissionSet,
  samePermissionSet,
  permissionSetBucketProblem,
  permissionSetBuckets,
  permissionSetHint,
  permissionSetLabel,
  permissionSetNameProblem,
  permissionSetSummary,
  type PermissionSetChoice,
} from "../src/permissionSetBuckets";
import { declOfPermissionSet, lowerPermissionSet, parsePermissionSet, permissionSetOfEnvironment, type PermissionSetDecl } from "../src/permissionSets";

const choice = (id: string, decl: PermissionSetDecl, layer: PermissionSetChoice["layer"] = "system"): PermissionSetChoice => {
  const cut = id.lastIndexOf("/");
  return { id, bucket: id.slice(0, cut), name: id.slice(cut + 1), layer, decl };
};

const READ_ONLY: PermissionSetDecl = { read_file: "allow", bash: "deny", "git status": "allow", other: "deny" };
const ASK_FIRST: PermissionSetDecl = { read_file: "ask", bash: "ask", other: "ask" };

const CHOICES: PermissionSetChoice[] = [
  choice("chat/ask-first", ASK_FIRST),
  choice("chat/read-only", READ_ONLY),
  choice("chat_control/ask-first", { start_task: "ask", move_task: "ask", other: "deny" }),
  choice("feature/implementation/writes-asking", { write_file: "ask", other: "deny" }, "project"),
];

const REGISTERED = ["read_file", "write_file", "bash", "start_task", "move_task"];
const of = (decl: PermissionSetDecl) => parsePermissionSet(decl).permissionSet;

describe("which permission set a map is", () => {
  it("names the permission set whose map it EXACTLY is — round trip, through the map the composer writes", () => {
    for (const each of CHOICES) {
      const written = declOfPermissionSet(of(each.decl));
      expect(matchPermissionSet(of(written), CHOICES, each.bucket, REGISTERED)?.id, each.id).toBe(each.id);
    }
  });

  it("is the BUCKET's: the same map is nobody's in a bucket that does not hold it", () => {
    expect(matchPermissionSet(of(READ_ONLY), CHOICES, "chat", REGISTERED)?.id).toBe("chat/read-only");
    expect(matchPermissionSet(of(READ_ONLY), CHOICES, "chat_control", REGISTERED)).toBeUndefined();
    // …and the same NAME in two buckets is two permission sets.
    expect(matchPermissionSet(of(ASK_FIRST), CHOICES, "chat_control", REGISTERED)).toBeUndefined();
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
  ] as Array<[string, PermissionSetDecl]>)("becomes CUSTOM when %s differs", (_what, decl) => {
    expect(matchPermissionSet(of(decl), CHOICES, "chat", REGISTERED)).toBeUndefined();
  });

  it("does not care about the ORDER of the lines, or an implementation written out as ours", () => {
    const shuffled: PermissionSetDecl = { other: "deny", "git status": "allow", bash: "deny", read_file: { mode: "allow", implementation: "app" } };
    expect(matchPermissionSet(of(shuffled), CHOICES, "chat", REGISTERED)?.id).toBe("chat/read-only");
  });

  it("IGNORES a line for a tool no longer registered — stale is not custom", () => {
    // `presetOf`'s contract, kept. A block that still holds a tool this project retired is a map with
    // a dead line in it; letting that hold the label at `custom` for ever would make every permission set
    // look unselectable for no reason the reader could see.
    const stale = permissionSetOfEnvironment(["read_file", "bash", "retired_tool"], { tools: { read_file: "ask", bash: "ask", retired_tool: "deny" }, other: "ask" });
    expect(matchPermissionSet(stale, CHOICES, "chat", REGISTERED)?.id).toBe("chat/ask-first");
    // …and a MODE for a tool the list does not offer (a key inherited from a parent) is not a line.
    const unGranted = permissionSetOfEnvironment(["read_file", "bash"], { tools: { read_file: "ask", bash: "ask", write_file: "deny" }, other: "ask" });
    expect(matchPermissionSet(unGranted, CHOICES, "chat", REGISTERED)?.id).toBe("chat/ask-first");
    // The same line for a tool that IS registered is a real difference.
    expect(matchPermissionSet(of({ read_file: "ask", bash: "ask", write_file: "ask", other: "ask" }), CHOICES, "chat", REGISTERED)).toBeUndefined();
  });

  it("matches a map whose lines name FUNCTIONS by the function's name, and still after it is lowered", () => {
    const auto = choice("chat/auto", { read_file: { function: "smart" }, bash: { function: "smart" }, other: { function: "smart" } });
    const lowered = lowerPermissionSet(of(auto.decl));
    expect(matchPermissionSet(permissionSetOfEnvironment(lowered.tools, lowered.permissions), [auto], "chat", REGISTERED)?.id).toBe("chat/auto");
    // The same lines under ANOTHER function are another permission set — and a word is not a function.
    expect(matchPermissionSet(of({ read_file: { function: "judge" }, bash: { function: "smart" }, other: { function: "smart" } }), [auto], "chat", REGISTERED)).toBeUndefined();
    expect(matchPermissionSet(of({ read_file: "ask", bash: { function: "smart" }, other: { function: "smart" } }), [auto], "chat", REGISTERED)).toBeUndefined();
  });

  it("still matches after a state LOWERED it — the shell's `ask`, a function, the marks, and a tool nothing serves", () => {
    // What a loaded state holds is the list and block its permission set lowered to. Read back, that has to
    // be the same permission set, or a conversation started from `$/permission-sets/chat/read-only` would read
    // `custom` before anybody had touched it. `start` and `move` are named and not served yet, so
    // lowering leaves them out of the list — and they were held.
    for (const each of CHOICES) {
      const lowered = lowerPermissionSet(of(each.decl));
      const back = permissionSetOfEnvironment(lowered.tools, lowered.permissions);
      expect(matchPermissionSet(back, CHOICES, each.bucket, REGISTERED)?.id, each.id).toBe(each.id);
    }
  });

  it("matches nothing when the map holds nothing — undeclared is not a permission set", () => {
    const empty = [...CHOICES, choice("chat/nothing", {})];
    expect(matchPermissionSet(of({}), empty, "chat", REGISTERED)).toBeUndefined();
    expect(matchPermissionSet(permissionSetOfEnvironment(undefined), empty, "chat", REGISTERED)).toBeUndefined();
  });
});

describe("the bucket a conversation opens on", () => {
  it("is the bucket of the permission set its map is, `chat` tried first", () => {
    expect(bucketOf(of(READ_ONLY), CHOICES, REGISTERED)).toBe("chat");
    expect(bucketOf(of({ start_task: "ask", move_task: "ask", other: "deny" }), CHOICES, REGISTERED)).toBe("chat_control");
    expect(bucketOf(of({ write_file: "ask", other: "deny" }), CHOICES, REGISTERED)).toBe("feature/implementation");
  });

  it("is `chat` for a state that names none", () => {
    expect(bucketOf(permissionSetOfEnvironment(undefined), CHOICES, REGISTERED)).toBe("chat");
    expect(bucketOf(of({}), [], REGISTERED)).toBe("chat");
  });
});

describe("the hierarchy the picker draws", () => {
  it("lists parents before children, a folder that only holds buckets included, with the layer that defines each", () => {
    expect(permissionSetBuckets(CHOICES).map((b) => [b.path, b.depth, b.layer, b.permissionSets.length, b.hint])).toEqual([
      ["chat", 0, "system", 2, "ask first · read-only"],
      ["chat_control", 0, "system", 1, "its own four — the task and workflow tools only"],
      ["feature", 0, "project", 0, "0 permission sets, and 1 bucket inside"],
      ["feature/implementation", 1, "project", 1, "writes-asking"],
    ]);
  });

  it("a shipped bucket with one file overridden here is still the shipped bucket", () => {
    const overridden = [choice("chat/ask-first", ASK_FIRST), choice("chat/read-only", { ...READ_ONLY, bash: "ask" }, "project")];
    expect(permissionSetBuckets(overridden)[0]).toMatchObject({ path: "chat", layer: "system" });
  });
});

describe("what a permission set is called", () => {
  it("uses the shipped words for a shipped file, and the file's own name and contents otherwise", () => {
    expect(permissionSetLabel(CHOICES[0]!)).toBe("ask first");
    expect(permissionSetHint(choice("chat/ask-first", ASK_FIRST))).toBe("stop and ask before every call");
    // An override keeps the NAME people know it by and loses the sentence, which may no longer be true.
    expect(permissionSetLabel(choice("chat/full", {}, "project"))).toBe("full access");
    expect(permissionSetHint(choice("chat/full", { bash: "allow", other: "ask" }, "project"))).toBe("1 line · other ask");
    expect(permissionSetLabel(CHOICES[3]!)).toBe("writes-asking");
  });

  it("summarises a map by its lines and its `other`", () => {
    expect(permissionSetSummary(of(ASK_FIRST))).toBe("2 lines · all ask");
    expect(permissionSetSummary(of(READ_ONLY))).toBe("3 lines · other deny");
    expect(permissionSetSummary(of({ bash: { function: "smart" }, other: { function: "smart" } }))).toBe("1 line · all smart");
  });
});

describe("a name a permission set file can have", () => {
  it("is one path segment a reference can carry", () => {
    expect(permissionSetNameProblem("ask-but-commit")).toBeUndefined();
    expect(permissionSetNameProblem("v2.strict_mode")).toBeUndefined();
    for (const bad of ["", "../escape", "a/b", "with space", ".hidden", "-lead"]) expect(permissionSetNameProblem(bad), bad).toBeDefined();
  });

  it("and a bucket is one or more of them", () => {
    expect(permissionSetBucketProblem("chat")).toBeUndefined();
    expect(permissionSetBucketProblem("feature/implementation")).toBeUndefined();
    for (const bad of ["", "/chat", "chat/", "chat/../x", "a//b"]) expect(permissionSetBucketProblem(bad), bad).toBeDefined();
  });
});
