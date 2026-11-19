/**
 * `chat/session` is `session` (2026-11-18): a root's own copy of it, the settings that name it, and the
 * conversations that ran it are renamed once, when the root is opened (`sessionRename.ts`).
 *
 * The old id is spelled in pieces (`OLD`) so a sweep that renames it across the tests leaves this file's
 * fixtures as the old name they have to be.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import { initProject, openProject, type Project } from "../src/project";
import { renamedSessionReferences } from "../src/sessionRename";

/** The old id, by name. */
const OLD = ["chat", "session"].join("/");

let dir: string;
let project: Project | undefined;

const write = (file: string, body: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
};
const read = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-session-rename-"));
  initProject(dir, testHome());
});

afterEach(() => {
  project?.close();
  project = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const workflows = (): string => join(dir, ".jaira", "workflows");

describe("chat/session becomes session", () => {
  it("moves a project's own copy to its new name, the reference in it renamed, and the settings with it", () => {
    write(join(workflows(), `${OLD}.json`), { $ref: `$SYSTEM/workflows/${OLD}`, disabled: true });
    write(join(workflows(), OLD, "helper.ts"), "export const x = 1;\n");
    write(join(dir, ".jaira", "settings.json"), { conversations: { workflow: OLD } });
    project = openProject(dir, { baseDir: testHome() });
    expect(existsSync(join(workflows(), `${OLD}.json`))).toBe(false);
    expect(read(join(workflows(), "session.json"))).toEqual({ $ref: "$SYSTEM/workflows/session", disabled: true });
    // What sat beside it, under its name, moves with it.
    expect(existsSync(join(workflows(), "session", "helper.ts"))).toBe(true);
    expect(read(join(dir, ".jaira", "settings.json"))).toMatchObject({ conversations: { workflow: "session" } });
  });

  it("leaves the old copy where it is when the new name already holds a state", () => {
    write(join(workflows(), `${OLD}.json`), { label: "old" });
    write(join(workflows(), "session.ts"), "export default async function session() {}\n");
    project = openProject(dir, { baseDir: testHome() });
    expect(existsSync(join(workflows(), `${OLD}.json`))).toBe(true);
    expect(existsSync(join(workflows(), "session.json"))).toBe(false);
  });

  it("names the new id in a conversation's task file, and is idempotent", () => {
    project = openProject(dir, { baseDir: testHome() });
    const meta = project.tasks.list();
    expect(meta).toEqual([]);
    const file = join(project.paths.tasksDir, "t-old.json");
    write(file, { id: "t-old", title: "a conversation", workflow: OLD, createdAt: 1 });
    project.close();
    project = openProject(dir, { baseDir: testHome() });
    expect(read(file)).toMatchObject({ workflow: "session" });
    project.close();
    project = openProject(dir, { baseDir: testHome() });
    expect(read(file)).toMatchObject({ workflow: "session" });
  });

  it("renames only references to the shipped state", () => {
    expect(renamedSessionReferences(`{"$ref": "$SYSTEM/workflows/${OLD}"}`)).toBe(`{"$ref": "$SYSTEM/workflows/session"}`);
    expect(renamedSessionReferences(`{"$ref": "$BASE/workflows/${OLD}-mine"}`)).toBe(`{"$ref": "$BASE/workflows/${OLD}-mine"}`);
  });
});
