/**
 * The composer's four permission presets — as the permission set FILES they became (decision 0007 §2).
 *
 * A preset used to be a FUNCTION of a tool, spent on the click: it wrote a mode per tool and then had
 * no further say, so what ran was the map. That half survives untouched — what runs is still the map.
 * What changed is where the four maps live: `$SYSTEM/permission-sets/chat/{ask-first, read-only, auto,
 * full}.json`, data a person can read, override in a layer, and add to.
 *
 * So the functions are FROZEN HERE, exactly as they were the day they left the source, and the one
 * claim of this file is that the shipped files say what those functions wrote — for every tool a
 * conversation can be handed, and for the name no preset had ever heard of, which is what `other` is.
 * Which permission set a map IS — the old `presetOf` — is `matchPermissionSet`, in `permissionSetBuckets.test.ts`.
 *
 * ## The workflow tools joined the `chat` bucket (decision 0005 step 6)
 *
 * A session holds the project's tools AND the workflow tools, so the four `chat` files grew eight
 * entries the four functions had never seen. The frozen functions are therefore held to the tools
 * they were written about — the nine a conversation had then — and the eight new ones are held to a
 * rule instead: **a `chat/<name>` gives a workflow tool whatever `chat_control/<name>` gives it**.
 * One bucket, said twice, is one bucket that can drift; this is the assertion that it has not.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPermissionSetMode, READ_ONLY_PRESET_TOOLS, SMART_MODE, type PermissionSetMode } from "../src/operationVocabulary";
import { TOOL_SPEC_BY_NAME, TOOL_SPECS } from "../src/toolVocabulary";
import { heldTools, offeredTools, parsePermissionSet, toolImplementations, toolModes } from "../src/permissionSets";

const PERMISSION_SETS = join(dirname(fileURLToPath(import.meta.url)), "..", "builtin", "permission-sets");

const shipped = (id: string): unknown => JSON.parse(readFileSync(join(PERMISSION_SETS, `${id}.json`), "utf8"));

/** FROZEN — `PERMISSION_PRESETS` as it stood at a1a0581, the last commit that had it. */
const FROZEN_PRESETS: ReadonlyArray<{ id: string; file: string; modeFor: (name: string) => PermissionSetMode }> = [
  { id: "ask", file: "ask-first", modeFor: () => "ask" },
  { id: "read-only", file: "read-only", modeFor: (name) => (READ_ONLY_PRESET_TOOLS.includes(name) ? "allow" : "deny") },
  // The preset wrote the word `smart`; the word became the shipped FUNCTION of that name (decision 0007,
  // amended 2026-09-22), so what `auto` wrote is read as that function — the one change to the frozen map.
  { id: "auto", file: "auto", modeFor: () => SMART_MODE },
  { id: "full", file: "full", modeFor: () => "allow" },
];

/** The workflow tools (decision 0005 §3) — all of what `chat_control` holds, and part of `chat`. */
const WORKFLOW_TOOLS = ["list_workflows", "start_task", "move_task", "list_tasks", "answer_question", "hold_task", "release_task", "stop_task"];

/**
 * The Git tools (decision 0010 §1), with the decision's table of modes — not the frozen functions':
 * the readers are allowed wherever a set lets anything look, and what leaves the machine is asked,
 * judged or refused by how far the set trusts the agent. `wait_git_event` is named and not yet served.
 */
const GIT_TOOLS: Record<string, Record<string, PermissionSetMode>> = {
  list_merge_requests: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
  read_merge_request: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
  git_checks: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
  wait_git_event: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
  open_merge_request: { "ask-first": "ask", auto: SMART_MODE, full: "allow", "read-only": "deny" },
  git_comment: { "ask-first": "ask", auto: SMART_MODE, full: "allow", "read-only": "deny" },
  git_merge: { "ask-first": "ask", auto: "ask", full: "allow", "read-only": "deny" },
  close_merge_request: { "ask-first": "ask", auto: "ask", full: "allow", "read-only": "deny" },
  git_push: { "ask-first": "ask", auto: SMART_MODE, full: "allow", "read-only": "deny" },
};

/** Every tool a conversation can be HANDED today — the nine the presets knew, the eight since, and the Git tools. */
const CONVERSATION_TOOLS = TOOL_SPECS.filter((spec) => spec.nativeOnly !== true && spec.unserved !== true).map((spec) => spec.name);

/** The tools the frozen FUNCTIONS were written about: everything a conversation held before step 6. */
const PRESET_TOOLS = CONVERSATION_TOOLS.filter((name) => !WORKFLOW_TOOLS.includes(name) && GIT_TOOLS[name] === undefined);

describe("the chat bucket is the four presets, written down", () => {
  it.each(FROZEN_PRESETS)("chat/$file writes EXACTLY the map the `$id` preset wrote", ({ file, modeFor }) => {
    const { permissionSet, issues } = parsePermissionSet(shipped(`chat/${file}`));
    const control = parsePermissionSet(shipped(`chat_control/${file}`)).permissionSet;
    expect(issues).toEqual([]);
    // The map the preset wrote for the tools it knew, `chat_control`'s own answer for the workflow
    // tools, and decision 0010's table for the Git tools.
    expect(toolModes(permissionSet)).toEqual({
      ...Object.fromEntries(PRESET_TOOLS.map((name) => [name, modeFor(name)])),
      ...toolModes(control),
      ...Object.fromEntries(Object.entries(GIT_TOOLS).map(([name, modes]) => [name, modes[file]!])),
    });
    // Every line is HELD — a preset never unticked anything, and a permission set's line is its tick —
    // including a tool named and not yet served, whose mode is inert until it is.
    expect(heldTools(permissionSet).sort()).toEqual([...CONVERSATION_TOOLS, ...TOOL_SPECS.filter((s) => s.unserved === true).map((s) => s.name)].sort());
    // …and what is not served yet is held without being handed to anybody.
    expect(offeredTools(permissionSet)).not.toContain("wait_git_event");
    for (const name of Object.keys(GIT_TOOLS).filter((tool) => tool !== "wait_git_event")) expect(offeredTools(permissionSet), name).toContain(name);
    // …with nobody's implementation chosen, because a preset never chose one.
    expect(toolImplementations(permissionSet)).toEqual({});
    // "A name the preset has never heard of gets its strictest" is what `other` says.
    expect(permissionSet.other).toEqual(modeFor("a tool nobody has heard of"));
  });

  it("read-only allows exactly the frozen list, and that list is still in the vocabulary", () => {
    const { permissionSet } = parsePermissionSet(shipped("chat/read-only"));
    const allowed = Object.entries(toolModes(permissionSet))
      .filter(([name, mode]) => mode === "allow" && !WORKFLOW_TOOLS.includes(name) && GIT_TOOLS[name] === undefined)
      .map(([name]) => name);
    expect(allowed.sort()).toEqual([...READ_ONLY_PRESET_TOOLS].sort());
    expect(READ_ONLY_PRESET_TOOLS.every((name) => TOOL_SPEC_BY_NAME.has(name))).toBe(true);
  });

  it("ships no `plan`, because a chat turn has no door out of it", () => {
    // Plan mode is an ESCALATION — read-only until the agent presents a plan and a human approves the
    // exit — and the exit gate is registered by the engine for the states it runs, not by the chat
    // path. Shipped here it would be `read-only` under a name promising a door nobody has hung.
    expect(readdirSync(join(PERMISSION_SETS, "chat")).sort()).toEqual(["ask-first.json", "auto.json", "full.json", "read-only.json"]);
  });
});

describe("chat_control has its OWN versions of the same names", () => {
  it("ships the same four names", () => {
    expect(readdirSync(join(PERMISSION_SETS, "chat_control")).sort()).toEqual(readdirSync(join(PERMISSION_SETS, "chat")).sort());
  });

  it.each(["ask-first", "read-only", "auto", "full"])("chat_control/%s holds ONLY the task and workflow tools, and refuses everything else", (name) => {
    const { permissionSet, issues } = parsePermissionSet(shipped(`chat_control/${name}`));
    // No warning either: the eight names are in the standard list, or each would be dropped as unknown.
    expect(issues).toEqual([]);
    expect(Object.keys(permissionSet.entries).sort()).toEqual([...WORKFLOW_TOOLS].sort());
    expect(permissionSet.other).toBe("deny");
  });

  it("holds them and HANDS THEM OVER: they are named, and served since step 6", () => {
    const { permissionSet } = parsePermissionSet(shipped("chat_control/full"));
    expect(heldTools(permissionSet).sort()).toEqual([...WORKFLOW_TOOLS].sort());
    // What lowering writes into the engine's `tools` list, and what an agent plan calls held. It was
    // empty while the eight carried `unserved`; deleting that mark was the whole of serving them.
    expect(offeredTools(permissionSet).sort()).toEqual([...WORKFLOW_TOOLS].sort());
    for (const name of WORKFLOW_TOOLS) {
      expect(TOOL_SPEC_BY_NAME.get(name)).toMatchObject({ category: "tasks" });
      expect(TOOL_SPEC_BY_NAME.get(name)!.unserved).toBeUndefined();
    }
  });

  it("read-only may look and may not steer", () => {
    expect(toolModes(parsePermissionSet(shipped("chat_control/read-only")).permissionSet)).toEqual({
      list_workflows: "allow",
      list_tasks: "allow",
      start_task: "deny",
      move_task: "deny",
      answer_question: "deny",
      hold_task: "deny",
      release_task: "deny",
      stop_task: "deny",
    });
  });
});

describe("the Git tools (decision 0010 §1)", () => {
  it("are the whole of the git category, in the decision's order", () => {
    expect(TOOL_SPECS.filter((spec) => spec.category === "git").map((spec) => spec.name)).toEqual(Object.keys(GIT_TOOLS));
  });

  it("are not offered by chat_control, whose `other` refuses them", () => {
    for (const name of ["ask-first", "read-only", "auto", "full"]) {
      const { permissionSet } = parsePermissionSet(shipped(`chat_control/${name}`));
      for (const tool of Object.keys(GIT_TOOLS)) expect(permissionSet.entries[tool], `chat_control/${name}: ${tool}`).toBeUndefined();
      expect(permissionSet.other).toBe("deny");
    }
  });

  it("sit after the web tools in every chat file, as the menu draws them", () => {
    for (const name of ["ask-first", "read-only", "auto", "full"]) {
      const keys = Object.keys(shipped(`chat/${name}`) as Record<string, unknown>);
      expect(keys.slice(keys.indexOf("web_search") + 1, keys.indexOf("web_search") + 10), name).toEqual(Object.keys(GIT_TOOLS));
    }
  });
});

describe("every shipped permission set", () => {
  it("only ever writes a mode a permission set takes — one of the three words, or a function", () => {
    for (const bucket of readdirSync(PERMISSION_SETS)) {
      for (const file of readdirSync(join(PERMISSION_SETS, bucket))) {
        const map = shipped(`${bucket}/${file.replace(/\.json$/, "")}`) as Record<string, unknown>;
        for (const [subject, mode] of Object.entries(map)) expect(isPermissionSetMode(mode), `${bucket}/${file}: ${subject}`).toBe(true);
        // `other` is the LAST line, where a person reading the file looks for it.
        expect(Object.keys(map).at(-1), `${bucket}/${file}`).toBe("other");
      }
    }
  });
});
