/**
 * The reorganised Settings pages (the person's rulings, 2026-09-23), as the models the universal tree
 * draws them from say them (`functionsModel.ts`, `connectionsModel.ts`):
 *
 *  1. Tools → Functions is the permission sets keyed by the FUNCTION — one row per tool, one column per
 *     set, the mode in each cell, a dash where a set does not offer it — with a set's commands as rows
 *     under `bash`, and whether a run may reach a function a workflow calls.
 *  2. Connections → Forges says who a connection acts as — signed in through the forge or by a token —
 *     which forge its + box signs in with, and which row's sign-in is waiting on the browser.
 *  3. Connections → Local models says what each server on the usual ports answered, and a weights
 *     file's size.
 */
import { describe, expect, it } from "vitest";
import { functionAllowed, parseConfig, toolsInCategory, type ConfigView, type ForgeCheck, type LocalServerProbe, type PermissionSetsView } from "@jaira/shared";
import { forgeRowOf, forgesOf, gitToolsSentence, localServerSaid, weightsSize, type ForgeRowOAuth } from "../src/renderer/connectionsModel";
import { cellOf, columnsOf, commandSubjectsOf, isSubRow, modeClass } from "../src/renderer/functionsModel";
import { permissionSetLayersOf } from "../src/renderer/permissionSetsHost";

const config = (doc: Record<string, unknown>): ConfigView => ({
  base: doc as never,
  project: null,
  system: null,
  you: null,
  effective: parseConfig(doc) as never,
  baseFile: "~/.jaira/settings.json",
  projectFile: "",
  youFile: "~/.jaira/personal-settings.json",
  baseDir: "~/.jaira",
});

const view = (sets: Record<string, Record<string, unknown>>): PermissionSetsView => ({
  records: Object.entries(sets).map(([id, decl]) => ({
    id,
    bucket: id.split("/")[0]!,
    name: id.split("/")[1]!,
    files: [{ layer: "system", file: `builtin/${id}.json`, format: "json", decl: decl as never }],
  })),
  usedBy: {},
  tools: [],
  layers: ["base", "system"],
});

describe("Tools → Functions", () => {
  const data = view({
    "chat/ask-first": { read_file: "ask", bash: "ask", other: "ask" },
    "chat/auto": { read_file: { function: "smart" }, bash: { function: "smart" }, other: { function: "smart" } },
    "chat/read-only": { read_file: "allow", bash: "deny", "git status": "allow", other: "deny" },
  });
  // The columns the Shared page's table has: the sets the layer its switch is on can see.
  const columns = columnsOf(data, permissionSetLayersOf("base", data.layers).reads);
  const rowOf = (name: string) => columns.map((column) => cellOf(column, name));

  it("has one column per set, and in a function's row each set's mode", () => {
    expect(columns.map((column) => column.id)).toEqual(["chat/ask-first", "chat/auto", "chat/read-only"]);
    expect(rowOf("read_file").map((cell) => cell.text)).toEqual(["ask", "☆ smart", "allow"]);
    // a set that does not offer a tool has a dash, not a mode
    expect(rowOf("web_fetch").map((cell) => [cell.text, modeClass(cell.mode)])).toEqual([
      ["—", "none"],
      ["—", "none"],
      ["—", "none"],
    ]);
  });

  it("lists a set's commands as rows under bash", () => {
    expect(commandSubjectsOf(columns)).toEqual(["git status"]);
    // A command's row is drawn indented under its tool; the tool's own is not.
    expect(isSubRow("git status")).toBe(true);
    expect(isSubRow("bash")).toBe(false);
    expect(rowOf("git status").map((cell) => cell.text)).toEqual(["—", "—", "allow"]);
  });

  it("says which functions a run may reach from the default executor's rules", () => {
    const rules = ["everything", "-claude-cli"];
    expect(functionAllowed(rules, "claude-cli")).toBe(false);
    expect(functionAllowed(rules, "choose_option")).toBe(true);
  });
});

describe("Connections → Forges", () => {
  const forges = forgesOf(config({}));
  const checks: ForgeCheck[] = [
    { name: "gitlab", provider: "gitlab", host: "gitlab.com", status: "ok", detail: "signed in as @ofer", identity: { login: "ofer" }, credential: { source: "keychain" }, via: "oauth" },
    { name: "github", provider: "github", host: "github.com", status: "unconfigured", detail: "no token stored under GITHUB_TOKEN" },
  ];
  const oauth = (waiting = false): ForgeRowOAuth => ({
    signingIn: new Set(waiting ? ["github"] : []),
    pending: new Map(waiting ? [["github", "WDJB-MJHT"]] : []),
    errors: new Map(),
    viaOAuth: new Set(["gitlab"]),
    onSignIn: () => undefined,
    onCancel: () => undefined,
    onDisconnect: () => undefined,
  });
  const row = (name: string, signIn: ForgeRowOAuth | undefined) => forgeRowOf(name, forges[name]!, checks.find((check) => check.name === name), signIn);

  it("says the account a connection acts as, how it signed in, and the forge its + box signs in with", () => {
    expect(row("gitlab", oauth())).toMatchObject({ state: "available", identity: { login: "ofer" }, viaOAuth: true });
    // Nobody is signed in to GitHub: no account's box, and the + box offers "Sign in with GitHub".
    expect(row("github", oauth())).toMatchObject({ state: "unconfigured", identity: undefined, label: "GitHub", signingIn: false });
  });

  it("knows which row's sign-in waits on the browser", () => {
    expect(row("github", oauth(true)).signingIn).toBe(true);
    expect(row("gitlab", oauth(true)).signingIn).toBe(false);
  });

  it("opens with what uses the connection — counted from the vocabulary", () => {
    const git = toolsInCategory("git");
    expect(git.length).toBe(7);
    // The CI tools (decision 0016) reach the forge through the same connection, so they are counted too.
    expect(gitToolsSentence().lead).toBe(`Used by ${git.length} Git tools — ${git[0]!.name}, ${git.at(-1)!.name} and five more, and ${toolsInCategory("ci").length} CI tools`);
    expect(gitToolsSentence().lead).toBe("Used by 7 Git tools — list_merge_requests, git_push and five more, and 4 CI tools");
  });

  it("counts whatever the git category holds", () => {
    expect(gitToolsSentence()).toEqual({ count: toolsInCategory("git").length, lead: `Used by ${toolsInCategory("git").length} Git tools — list_merge_requests, git_push and five more, and ${toolsInCategory("ci").length} CI tools` });
  });
});

describe("Connections → Local models", () => {
  it("says what each server answered: its models, or that it is not running", () => {
    const found: LocalServerProbe[] = [
      { name: "Ollama", baseURL: "http://localhost:11434/v1", up: true, models: ["qwen2.5-coder"], inUse: true },
      { name: "LM Studio", baseURL: "http://localhost:1234/v1", up: true, models: ["phi-4"], inUse: false },
      { name: "vLLM", baseURL: "http://localhost:8000/v1", up: false, models: [], inUse: false },
    ];
    expect(found.map(localServerSaid)).toEqual(["localhost:11434/v1 · qwen2.5-coder", "localhost:1234/v1 · phi-4", "localhost:8000/v1 · not running"]);
  });

  it("says a found weights file's size", () => {
    expect(weightsSize(4_700_000_000)).toBe("4.7 GB");
  });
});
