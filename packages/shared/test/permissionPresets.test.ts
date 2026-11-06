/**
 * The composer's four permission presets — as the permission set FILES they became (decision 0007 §2).
 *
 * A preset used to be a FUNCTION of a tool, spent on the click: it wrote a mode per tool and then had
 * no further say, so what ran was the map. That half survives untouched — what runs is still the map.
 * What changed is where the four maps live: `$SYSTEM/permission-sets/{ask-first, read-only, auto,
 * full}.json`, data a person can read, override in a layer, and add to.
 *
 * So the functions are FROZEN HERE, exactly as they were the day they left the source, and the one
 * claim of this file is that the shipped files say what those functions wrote — for every tool a
 * conversation can be handed, and for the name no preset had ever heard of, which is what `other` is.
 * Which permission set a map IS — the old `presetOf` — is `matchPermissionSet`, in `permissionSetBuckets.test.ts`.
 *
 * ## The workflow tools joined the conversation presets (decision 0005 step 6)
 *
 * A session holds the project's tools AND the workflow tools, so the four top-level files grew eight
 * entries the four functions had never seen. The frozen functions are therefore held to the tools
 * they were written about — the nine a conversation had then — and the eight new ones are held to a
 * rule instead: **a top-level `<name>` gives a workflow tool whatever `control/<name>` gives it**.
 * One bucket, said twice, is one bucket that can drift; this is the assertion that it has not.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { READ_ONLY_PRESET_TOOLS, SMART_MODE, type PermissionSetMode } from "../src/operationVocabulary";
import { TOOL_SPEC_BY_NAME, TOOL_SPECS } from "../src/toolVocabulary";
import { heldTools, linePlaces, offeredTools, parsePermissionSet, toolImplementations, toolModes, type PermissionSet } from "../src/permissionSets";
import { resolvePlace } from "../src/places";

/**
 * Each tool's mode IN THE PROJECT — what the frozen presets were about. Since decision 0023 §7.1 a
 * shipped line may be a place map (`read_file`: the set's mode in `$PROJECT` and `$WORKTREE`, `ask`
 * elsewhere, credentials asking), so the preset's word is the line's answer at `$PROJECT` where it
 * names one, and its own mode otherwise. What the places add is held to §7.1 below.
 */
const projectModes = (permissionSet: PermissionSet): Record<string, PermissionSetMode> => {
  const places = linePlaces(permissionSet);
  return Object.fromEntries(Object.entries(toolModes(permissionSet)).map(([name, mode]) => [name, places[name]?.["$PROJECT"] ?? mode]));
};

const PERMISSION_SETS = join(dirname(fileURLToPath(import.meta.url)), "..", "builtin", "permission-sets");

/** The top level's set files — the conversation presets. */
const topLevel = (): string[] => readdirSync(PERMISSION_SETS, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);

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

/** The workflow tools (decision 0005 §3) — all of what `control` holds, and part of every top-level set. */
const WORKFLOW_TOOLS = ["list_workflows", "start_task", "move_task", "list_tasks", "answer_question", "hold_task", "release_task", "stop_task"];

/**
 * The Git tools (decision 0010 §1), with the decision's table of modes — not the frozen functions':
 * the readers are allowed wherever a set lets anything look, and what leaves the machine is asked,
 * judged or refused by how far the set trusts the agent.
 */
const GIT_TOOLS: Record<string, Record<string, PermissionSetMode>> = {
  list_merge_requests: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
  read_merge_request: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
  open_merge_request: { "ask-first": "ask", auto: SMART_MODE, full: "allow", "read-only": "deny" },
  comment_merge_request: { "ask-first": "ask", auto: SMART_MODE, full: "allow", "read-only": "deny" },
  git_merge: { "ask-first": "ask", auto: "ask", full: "allow", "read-only": "deny" },
  close_merge_request: { "ask-first": "ask", auto: "ask", full: "allow", "read-only": "deny" },
  git_push: { "ask-first": "ask", auto: SMART_MODE, full: "allow", "read-only": "deny" },
};

/** The CI tools (decision 0016): reads only, so modes like the Git readers'. */
const CI_TOOLS: Record<string, Record<string, PermissionSetMode>> = {
  list_pipelines: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
  read_pipeline: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
  read_pipeline_job: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
  download_pipeline_artifact: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
};

/** Every tool that reaches the forge, in the order the top-level files write them. */
const FORGE_TOOLS = { ...GIT_TOOLS, ...CI_TOOLS };

/** `wait_for_event` (decision 0016 §5): any event, so a task tool — the readers' modes, before the workflow tools. */
const EVENT_TOOLS: Record<string, Record<string, PermissionSetMode>> = {
  wait_for_event: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
};

/**
 * The System tools (decision 0019 §5, as ruled 2026-10-20): "system should default to ask" — every one
 * asks, except that read-only lets the looks go ahead (the clipboard and the screen too: they only
 * read) and refuses the changes, and full allows all sixteen.
 */
const SYSTEM_LOOKS = ["read_system", "list_processes", "list_services", "list_software", "read_settings", "read_clipboard", "list_windows", "screenshot"];
const SYSTEM_CHANGES = ["power", "stop_process", "control_service", "install_software", "write_settings", "write_clipboard", "open_app", "control_input"];
const SYSTEM_TOOLS: Record<string, Record<string, PermissionSetMode>> = Object.fromEntries([
  ...SYSTEM_LOOKS.map((name) => [name, { "ask-first": "ask", auto: "ask", full: "allow", "read-only": "allow" }] as const),
  ...SYSTEM_CHANGES.map((name) => [name, { "ask-first": "ask", auto: "ask", full: "allow", "read-only": "deny" }] as const),
]);

/** The tools with a table of their own here rather than a frozen preset's mode. */
const TABLED = { ...FORGE_TOOLS, ...EVENT_TOOLS, ...SYSTEM_TOOLS };

/** Every tool a conversation can be HANDED today — the nine the presets knew, the eight since, and the Git tools. */
const CONVERSATION_TOOLS = TOOL_SPECS.filter((spec) => spec.nativeOnly !== true && spec.unserved !== true).map((spec) => spec.name);

/** The tools the frozen FUNCTIONS were written about: everything a conversation held before step 6. */
const PRESET_TOOLS = CONVERSATION_TOOLS.filter((name) => !WORKFLOW_TOOLS.includes(name) && TABLED[name] === undefined);

describe("the top level is the four presets, written down, and read-only-scratch", () => {
  it.each(FROZEN_PRESETS)("$file writes EXACTLY the map the `$id` preset wrote", ({ file, modeFor }) => {
    const { permissionSet, issues } = parsePermissionSet(shipped(file));
    const control = parsePermissionSet(shipped(`control/${file}`)).permissionSet;
    expect(issues).toEqual([]);
    // The map the preset wrote for the tools it knew, `control`'s own answer for the workflow
    // tools, and decision 0010's table for the Git tools.
    expect(projectModes(permissionSet)).toEqual({
      ...Object.fromEntries(PRESET_TOOLS.map((name) => [name, modeFor(name)])),
      ...toolModes(control),
      ...Object.fromEntries(Object.entries(TABLED).map(([name, modes]) => [name, modes[file]!])),
    });
    // Every line is HELD — a preset never unticked anything, and a permission set's line is its tick —
    // including any tool named and not yet served, whose mode is inert until it is.
    expect(heldTools(permissionSet).sort()).toEqual([...CONVERSATION_TOOLS, ...TOOL_SPECS.filter((s) => s.unserved === true).map((s) => s.name)].sort());
    // …and every forge tool is handed on, and wait_for_event, which the event hub serves.
    for (const name of Object.keys(TABLED)) if (TOOL_SPEC_BY_NAME.get(name)?.unserved !== true) expect(offeredTools(permissionSet), name).toContain(name);
    // …with nobody's implementation chosen, because a preset never chose one.
    expect(toolImplementations(permissionSet)).toEqual({});
    // "A name the preset has never heard of gets its strictest" is what `other` says.
    expect(permissionSet.other).toEqual(modeFor("a tool nobody has heard of"));
  });

  it("read-only allows exactly the frozen list, and that list is still in the vocabulary", () => {
    const { permissionSet } = parsePermissionSet(shipped("read-only"));
    const allowed = Object.entries(projectModes(permissionSet))
      .filter(([name, mode]) => mode === "allow" && !WORKFLOW_TOOLS.includes(name) && TABLED[name] === undefined)
      .map(([name]) => name);
    expect(allowed.sort()).toEqual([...READ_ONLY_PRESET_TOOLS].sort());
    expect(READ_ONLY_PRESET_TOOLS.every((name) => TOOL_SPEC_BY_NAME.has(name))).toBe(true);
  });

  it("ships no `plan`, because a chat turn has no door out of it", () => {
    // Plan mode is an ESCALATION — read-only until the agent presents a plan and a human approves the
    // exit — and the exit gate is registered by the engine for the states it runs, not by the chat
    // path. Shipped here it would be `read-only` under a name promising a door nobody has hung.
    expect(topLevel().sort()).toEqual(["ask-first.json", "auto.json", "full.json", "read-only-scratch.json", "read-only.json"]);
  });
});

describe("control has its OWN versions of the same names", () => {
  it("ships the same four names — not read-only-scratch, which differs only in file tools a control conversation never holds", () => {
    const chat = topLevel().filter((file) => file !== "read-only-scratch.json");
    expect(readdirSync(join(PERMISSION_SETS, "control")).sort()).toEqual(chat.sort());
  });

  it.each(["ask-first", "read-only", "auto", "full"])("control/%s holds ONLY the task and workflow tools, and refuses everything else", (name) => {
    const { permissionSet, issues } = parsePermissionSet(shipped(`control/${name}`));
    // No warning either: the eight names are in the standard list, or each would be dropped as unknown.
    expect(issues).toEqual([]);
    expect(Object.keys(permissionSet.entries).sort()).toEqual([...WORKFLOW_TOOLS].sort());
    expect(permissionSet.other).toBe("deny");
  });

  it("holds them and HANDS THEM OVER: they are named, and served since step 6", () => {
    const { permissionSet } = parsePermissionSet(shipped("control/full"));
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
    expect(toolModes(parsePermissionSet(shipped("control/read-only")).permissionSet)).toEqual({
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

  it("leave CI to the ci category (decision 0016)", () => {
    expect(TOOL_SPECS.filter((spec) => spec.category === "ci").map((spec) => spec.name)).toEqual(Object.keys(CI_TOOLS));
  });

  it("are not offered by control, whose `other` refuses them", () => {
    for (const name of ["ask-first", "read-only", "auto", "full"]) {
      const { permissionSet } = parsePermissionSet(shipped(`control/${name}`));
      for (const tool of Object.keys(FORGE_TOOLS)) expect(permissionSet.entries[tool], `control/${name}: ${tool}`).toBeUndefined();
      expect(permissionSet.other).toBe("deny");
    }
  });

  it("sit after the web tools in every top-level file, the CI tools after them, as the menu draws them", () => {
    const forge = Object.keys(FORGE_TOOLS);
    for (const name of ["ask-first", "read-only", "read-only-scratch", "auto", "full"]) {
      const keys = Object.keys(shipped(name) as Record<string, unknown>);
      expect(keys.slice(keys.indexOf("web_search") + 1, keys.indexOf("web_search") + 1 + forge.length), name).toEqual(forge);
    }
  });
});

describe("every shipped permission set", () => {
  it("only ever writes a decision a permission set takes — one of the three words, or a function by its name", () => {
    // The top level, then each bucket.
    const files = [...topLevel().map((file) => ({ bucket: ".", file })), ...readdirSync(PERMISSION_SETS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => readdirSync(join(PERMISSION_SETS, entry.name)).map((file) => ({ bucket: entry.name, file })))];
    for (const { bucket, file } of files) {
      {
        const map = shipped(bucket === "." ? file.replace(/.json$/, "") : `${bucket}/${file.replace(/.json$/, "")}`) as Record<string, unknown>;
        for (const [subject, mode] of Object.entries(map)) {
          // A plain string, or a map of places (decision 0023 §7.1) — and none says `unavailable`, which
          // is a statement about a layer below.
          expect(typeof mode === "string" || (typeof mode === "object" && mode !== null), `${bucket}/${file}: ${subject}`).toBe(true);
          expect(mode, `${bucket}/${file}: ${subject}`).not.toBe("unavailable");
          expect(parsePermissionSet({ [subject]: mode }).issues, `${bucket}/${file}: ${subject}`).toEqual([]);
        }
        // `other` is the LAST line, where a person reading the file looks for it.
        expect(Object.keys(map).at(-1), `${bucket}/${file}`).toBe("other");
      }
    }
  });
});

describe("what ships gains places (decision 0023 §7.1)", () => {
  const ROOT = "C:/work/app";
  const options = { root: ROOT, named: { $PROJECT: ROOT, $WORKTREE: "C:/work/app-wt", $AGENT_WORKSPACE: "C:/Users/me/.claude/projects/C--work-app-wt", $TEMP: "C:/tmp", "~": "C:/Users/me" } };
  const CREDENTIALS = ["**/.env", "**/.env.*", "**/*.pem", "**/id_rsa*", "~/.ssh", "~/.aws", "~/.claude/.credentials.json", "~/.codex/auth.json"];
  /** A line's answer at one path, as a call's place is judged: the most specific place, else the line's own mode. */
  const at = (file: string, tool: string, path: string): PermissionSetMode | undefined => {
    const { permissionSet } = parsePermissionSet(shipped(file));
    const entry = permissionSet.entries[tool]!;
    const place = resolvePlace({ ...(entry.mode !== undefined ? { "**": entry.mode } : {}), ...entry.places }, "path", path, options);
    return place?.decision ?? entry.mode;
  };

  it.each([
    ["read-only", "allow"],
    ["ask-first", "ask"],
    ["auto", SMART_MODE],
  ] as const)("%s reads, globs and greps at its own mode in the project, the worktree and the agent's own folder, and ASKS elsewhere", (file, mode) => {
    for (const tool of ["read_file", "glob", "grep"]) {
      expect(at(file, tool, `${ROOT}/src/index.ts`), `${file} ${tool}`).toEqual(mode);
      expect(at(file, tool, "C:/work/app-wt/src/index.ts"), `${file} ${tool}`).toEqual(mode);
      // The agent's memory and transcripts: neither the project nor the worktree, and its own.
      expect(at(file, tool, "C:/Users/me/.claude/projects/C--work-app-wt/memory/notes.md"), `${file} ${tool}`).toEqual(mode);
      // Not the rest of the agent's folder, where its sign-in is.
      expect(at(file, tool, "C:/Users/me/.claude/.credentials.json"), `${file} ${tool}`).toBe("ask");
      // A read outside the project asks — under ask-first, as everywhere.
      expect(at(file, tool, "C:/Users/me/Documents/notes.txt"), `${file} ${tool}`).toBe("ask");
    }
  });

  it("full keeps allow — and still asks at a credential", () => {
    expect(at("full", "read_file", "C:/Users/me/Documents/notes.txt")).toBe("allow");
    expect(at("full", "read_file", `${ROOT}/src/index.ts`)).toBe("allow");
    // `.env` asks under full: a place that pins the file beats any folder that holds it (ruling 3).
    expect(at("full", "read_file", `${ROOT}/.env`)).toBe("ask");
    expect(at("full", "write_file", `${ROOT}/.env.local`)).toBe("ask");
    expect(at("full", "edit", "C:/Users/me/.ssh/config")).toBe("ask");
  });

  it.each(["read-only", "read-only-scratch", "ask-first", "auto", "full"])("%s asks at every credential place, inside the project too", (file) => {
    const { permissionSet } = parsePermissionSet(shipped(file));
    for (const tool of ["read_file", "glob", "grep"]) for (const place of CREDENTIALS) expect(linePlaces(permissionSet)[tool]?.[place], `${file} ${tool} ${place}`).toBe("ask");
    expect(at(file, "read_file", `${ROOT}/config/server.pem`)).toBe("ask");
    expect(at(file, "read_file", "C:/Users/me/.aws/credentials")).toBe("ask");
    expect(at(file, "grep", `${ROOT}/packages/app/.env.production`)).toBe("ask");
  });

  it.each(["read-only", "read-only-scratch"])("never loosens a refusal into a question: %s's writers still refuse a credential", (file) => {
    expect(at(file, "write_file", `${ROOT}/.env`)).toBe("deny");
    expect(at(file, "edit", "C:/Users/me/.ssh/config")).toBe("deny");
    expect(at(file, "write_file", "C:/Users/me/.claude/.credentials.json")).toBe("deny");
  });

  it("read-only-scratch is read-only, except that it writes and edits in the agent's own folder", () => {
    const scratch = shipped("read-only-scratch") as Record<string, unknown>;
    const readOnly = shipped("read-only") as Record<string, unknown>;
    expect(parsePermissionSet(scratch).issues).toEqual([]);
    // Every other line, in the same order, is read-only's.
    expect(Object.keys(scratch)).toEqual(Object.keys(readOnly));
    for (const key of Object.keys(readOnly)) if (key !== "edit" && key !== "write_file") expect(scratch[key], key).toEqual(readOnly[key]);
    const memory = "C:/Users/me/.claude/projects/C--work-app-wt/memory/notes.md";
    for (const tool of ["write_file", "edit"]) {
      expect(at("read-only-scratch", tool, memory), tool).toBe("allow");
      expect(at("read-only-scratch", tool, `${ROOT}/src/index.ts`), tool).toBe("deny");
      expect(at("read-only-scratch", tool, "C:/work/app-wt/src/index.ts"), tool).toBe("deny");
      expect(at("read-only-scratch", tool, "C:/tmp/x.txt"), tool).toBe("deny");
      // A credential pinned by name is refused even inside the agent's folder (ruling 3).
      expect(at("read-only-scratch", tool, "C:/Users/me/.claude/projects/C--work-app-wt/.env"), tool).toBe("deny");
      expect(at("read-only", tool, memory), tool).toBe("deny");
    }
  });

  it("auto judges a push with smart, and asks before pushing main, master or a release branch", () => {
    const { permissionSet } = parsePermissionSet(shipped("auto"));
    const push = permissionSet.entries["git_push"]!;
    expect(push.mode).toEqual(SMART_MODE);
    const map = { "**": push.mode!, ...push.places };
    for (const branch of ["main", "origin:main", "master", "release/1.2"]) expect(resolvePlace(map, "branch", branch, {})?.decision, branch).toBe("ask");
    expect(resolvePlace(map, "branch", "claude/fix-1", {})?.decision).toEqual(SMART_MODE);
  });
});
