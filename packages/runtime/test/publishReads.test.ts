/**
 * A publish answers to `read_file`'s line for every file it reads (decision 0020, amended 2026-11-05).
 *
 * `show_artifact` shows a person the bytes of the files it is handed, so it may publish exactly the files
 * the conversation may read — judged by the gate at `read_file`'s places, file by file — and no fixed list
 * of folders decides it. Its text sent in the call reads nothing, and is judged by its own line alone.
 * Found in a real conversation (t-elvj5dhzoy, read-only-scratch): the agent wrote a design into its own
 * folder, where the set lets it write and read, and every publish of it was refused as "outside the
 * workspace, the task's artifact folder and the temporary folder".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FunctionInputs } from "@declarative-ai/exec";
import { claudeProjectsDir } from "@declarative-ai/agents-api";
import { createToolGate, PermissionLedger } from "@declarative-ai/permissions";
import { lowerPermissionSet, parsePermissionSet, permissionsOfPermissionSet, type PermissionSet } from "@jaira/shared";
import { commandDecisionOf, compilePolicy } from "../src/policy";
import { placeNarrowingFor } from "../src/tools";
import { namedPlacesOf } from "../src/linePlaces";
import { CLAUDE_TOOLS } from "../src/agentTools";
import { noteCallAgent } from "../src/callAgent";

const shipped = (name: string): PermissionSet =>
  parsePermissionSet(JSON.parse(readFileSync(fileURLToPath(new URL(`../../shared/builtin/permission-sets/${name}.json`, import.meta.url)), "utf8"))).permissionSet;

const ROOT = "C:/work/app";
const claudeFolder = `${claudeProjectsDir().replace(/\\/g, "/")}/C--work-app`;
const url = "artifact://t-1/@a-1";

function publisher(set: PermissionSet, source: string) {
  const block = lowerPermissionSet(set, source).permissions!;
  const narrow = placeNarrowingFor({ root: ROOT, named: namedPlacesOf(ROOT) });
  return (args: Record<string, unknown>): { mode: ReturnType<typeof narrow>; input: FunctionInputs } => {
    const input = args as FunctionInputs;
    noteCallAgent(input, CLAUDE_TOOLS);
    return { mode: narrow({ name: "show_artifact" }, input, block as never), input };
  };
}

describe("a publish, judged at read_file's line", () => {
  const publish = publisher(shipped("read-only-scratch"), "$/permission-sets/read-only-scratch");

  it("publishes what the conversation may read — its own scratch folder, the project — unasked", () => {
    const root = `${claudeFolder}/scratch/chat-six`;
    expect(publish({ url, root, file_path: `${root}/project/canvas.json`, files: { "project/Main.dc.html": "project/Main.dc.html" } }).mode).toBeUndefined();
    expect(publish({ file_path: `${ROOT}/out/page.html` }).mode).toBeUndefined();
  });

  it("asks where a read would ask — elsewhere on the machine, a credential among the files — as a read of that file", () => {
    const elsewhere = publish({ file_path: "C:/Users/someone/Documents/x.html" });
    expect(elsewhere.mode).toBe("ask");
    const part = commandDecisionOf(elsewhere.input)?.parts?.parts[0];
    expect(part).toMatchObject({ subject: "read_file", paths: ["C:/Users/someone/Documents/x.html"] });
    const root = `${ROOT}/c`;
    expect(publish({ url, root, file_path: `${root}/project/canvas.json`, files: { "project/A.dc.html": `${ROOT}/.env` } }).mode).toBe("ask");
  });

  it("judges nothing it does not read: text sent in the call, a read of the artifact, a new canvas", () => {
    expect(publish({ url, files: { "project/canvas.json": { content: "{}" }, "project/Main.dc.html": { content: "<x-dc></x-dc>" } } }).mode).toBeUndefined();
    // `file_path` beside `content` only names the page.
    expect(publish({ content: "<p>x</p>", file_path: "C:/Users/someone/x.html" }).mode).toBeUndefined();
    expect(publish({ action: "read", url, path: "project/canvas.json" }).mode).toBeUndefined();
  });

  it("refuses where read_file refuses", () => {
    const strict = publisher(parsePermissionSet({ read_file: { "**": "deny", $PROJECT: "allow" }, show_artifact: "allow", other: "deny" }).permissionSet, "$/permission-sets/strict");
    expect(strict({ file_path: `${ROOT}/out/page.html` }).mode).toBeUndefined();
    expect(strict({ file_path: "C:/Users/someone/x.html" }).mode).toBe("deny");
    expect(strict({ content: "<p>x</p>" }).mode).toBeUndefined();
  });

  it("is never pre-approved past that judgement: the gate's word with no input is not `allow`", () => {
    const set = shipped("read-only-scratch");
    const policy = compilePolicy({}, { permissionSet: set, workspaceRoot: ROOT });
    const gate = createToolGate({
      ledger: new PermissionLedger({ baseline: policy.baseline ?? {} }),
      sessionId: "s",
      approve: () => ({ decision: "deny", scope: "once" }),
      tools: { show_artifact: { readOnly: true } },
      authored: permissionsOfPermissionSet(set) as never,
      ...(policy.scopeOf !== undefined ? { scopeOf: policy.scopeOf } : {}),
    });
    expect(gate.modeOf({ name: "show_artifact", readOnly: true })).not.toBe("allow");
  });
});
