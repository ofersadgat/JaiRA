/**
 * Reading and writing the files the Files view can now open.
 *
 * `file:read` and `file:write` are the channels that made a prompt editable, and they are addressed
 * by PATH — which means they carry the same containment burden the state-file surface does, over a
 * wider root. The tests that matter here are the refusals: outside the root, not text, and the state
 * file that must not slip past `workflow:write`'s parse check by being written as plain text.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { CONFIG_JSON, WORKFLOW_JSON } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-fileio-"));
  initProject(dir, testHome());
  service = new AppService({ baseDir: testHome(), watchWorkflows: false });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("file:read", () => {
  it("reads a prompt and reports what it is", () => {
    service.createFile({ layer: "project", path: "prompts/goals.md", kind: "file", text: "# Goals\n" });
    const doc = service.readFile({ layer: "project", path: "prompts/goals.md" });
    expect(doc.text).toBe("# Goals\n");
    expect(doc.mime).toBe("text/markdown");
    expect(doc.exists).toBe(true);
    expect(doc.stateId).toBeUndefined();
    expect(doc.file).toContain("goals.md");
  });

  it("names the state a workflow file defines, so the panel can open its board", () => {
    service.writeWorkflow({ stateId: "plan", layer: "project", text: '{"label":"Plan"}' });
    const doc = service.readFile({ layer: "project", path: "workflows/plan.json" });
    expect(doc.stateId).toBe("plan");
    expect(doc.mime).toBe(WORKFLOW_JSON);
  });

  it("gives settings.json its own type, which is what puts the effective view above it", () => {
    expect(service.readFile({ layer: "project", path: "settings.json" }).mime).toBe(CONFIG_JSON);
  });

  it("reports a file that does not exist yet rather than throwing", () => {
    // The tree can point at a path a moment after something else removed it, and "not created yet"
    // is also what a brand-new file looks like before its first save.
    const doc = service.readFile({ layer: "project", path: "prompts/absent.md" });
    expect(doc.exists).toBe(false);
    expect(doc.text).toBe("");
  });

  it("refuses a type that is not text instead of decoding it as UTF-8", () => {
    writeFileSync(join(dir, ".jaira", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    expect(() => service.readFile({ layer: "project", path: "shot.png" })).toThrow(/not text/);
  });

  it("refuses to read a directory", () => {
    service.createFile({ layer: "project", path: "prompts", kind: "directory" });
    expect(() => service.readFile({ layer: "project", path: "prompts" })).toThrow(/directory/);
  });

  it("refuses a path that climbs out of the layer root", () => {
    expect(() => service.readFile({ layer: "project", path: "../../.ssh/id_rsa" })).toThrow(/not inside/);
  });
});

describe("file:write", () => {
  it("writes a prompt and reads back exactly what it was given", () => {
    service.writeFile({ layer: "project", path: "prompts/goals.md", text: "one\ntwo" });
    expect(readFileSync(join(dir, ".jaira", "prompts", "goals.md"), "utf8")).toBe("one\ntwo");
    expect(service.readFile({ layer: "project", path: "prompts/goals.md" }).text).toBe("one\ntwo");
  });

  it("creates the directories on the way, so a new path in the dialog just works", () => {
    service.writeFile({ layer: "project", path: "skills/review/SKILL.md", text: "# Review\n" });
    expect(service.readFile({ layer: "project", path: "skills/review/SKILL.md" }).exists).toBe(true);
  });

  it("refuses a state file, which must go through workflow:write to be parsed", () => {
    // The check is here rather than only in the renderer: a bypass that depends on the untrusted
    // half of the boundary choosing the right channel is not a check at all.
    expect(() =>
      service.writeFile({ layer: "project", path: "workflows/plan.json", text: "not json at all" }),
    ).toThrow(/workflow:write/);
  });

  it("refuses a path outside the layer root", () => {
    expect(() => service.writeFile({ layer: "project", path: "../escaped.md", text: "x" })).toThrow(/not inside/);
  });

  it("still refuses a state file when the text would have parsed", () => {
    expect(() =>
      service.writeFile({ layer: "project", path: "workflows/plan.json", text: "{}" }),
    ).toThrow(/workflow:write/);
  });

  it("writes a YAML state as text, because the authoring form cannot save one", () => {
    // A YAML state keeps its board, but its editor is the plain one — see the surface table.
    service.writeFile({ layer: "project", path: "workflows/legacy.yaml", text: "label: Legacy\n" });
    const doc = service.readFile({ layer: "project", path: "workflows/legacy.yaml" });
    expect(doc.stateId).toBe("legacy");
    expect(doc.text).toBe("label: Legacy\n");
  });
});
