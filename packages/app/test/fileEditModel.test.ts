/**
 * The Files room's code editor and the project's compiler: which documents are files on a disk, which
 * of those the compiler can be asked about, how it is addressed, and what the editor is handed to ask
 * with (`fileEditModel.ts`). The editor that draws the answers is Monaco, in an island.
 */
import { describe, expect, it, vi } from "vitest";
import type { FileLocation, FileSource } from "@jaira/shared";
import { codeIntelOf, fileAddressOf, isCheckableFile, isLocatedFile, type IntelInvoke } from "../src/renderer/fileEditModel";

const doc = (over: Partial<FileSource>): FileSource => ({ layer: "project", path: "src/a.ts", file: "/work/project/src/a.ts", mime: "text/x-typescript", text: "", exists: true, ...over });

describe("whether a document is a file on a disk", () => {
  it("is one for an absolute path, with either slash", () => {
    expect(isLocatedFile(doc({ file: "/work/project/src/a.ts" }))).toBe(true);
    expect(isLocatedFile(doc({ file: "C:/work/project/src/a.ts" }))).toBe(true);
    // What resolving a path against a layer root produces on Windows — the spelling every file the
    // tree opens there has.
    expect(isLocatedFile(doc({ file: "C:\\work\\project\\src\\a.ts" }))).toBe(true);
    expect(isLocatedFile(doc({ file: "\\\\server\\share\\a.ts" }))).toBe(true);
  });

  it("is not one for the settings preview's sample", () => {
    expect(isLocatedFile(doc({ file: "sample" }))).toBe(false);
    expect(isLocatedFile(doc({ file: "sample.ts" }))).toBe(false);
  });
});

describe("whether the compiler can be asked about a document", () => {
  it("can for TypeScript and JavaScript on a disk", () => {
    expect(isCheckableFile(doc({ file: "C:\\work\\a.ts", mime: "text/x-typescript" }))).toBe(true);
    expect(isCheckableFile(doc({ file: "/work/a.js", mime: "text/javascript" }))).toBe(true);
  });

  it("cannot for another type, or for a sample", () => {
    expect(isCheckableFile(doc({ file: "/work/a.json", mime: "application/json" }))).toBe(false);
    expect(isCheckableFile(doc({ file: "/work/a.md", mime: "text/markdown" }))).toBe(false);
    expect(isCheckableFile(doc({ file: "sample", mime: "text/x-typescript" }))).toBe(false);
  });
});

describe("how the compiler's channels address a document", () => {
  it("is as the read that opened it was: its layer and path, and its project only when it has one", () => {
    expect(fileAddressOf({ layer: "project", project: "/work/project", path: "src/a.ts" })).toEqual({ layer: "project", project: "/work/project", path: "src/a.ts" });
    expect(fileAddressOf({ layer: "base", path: "notes.ts" })).toEqual({ layer: "base", path: "notes.ts" });
    expect("project" in fileAddressOf({ layer: "base", path: "notes.ts" })).toBe(false);
  });
});

describe("what a code pane is handed to ask with", () => {
  const address = () => fileAddressOf({ layer: "project", project: "/work/project", path: "src/a.ts" });
  const answers: Record<string, unknown> = {
    "file:check": { checked: true, diagnostics: [] },
    "file:definition": { checked: true, definitions: [] },
    "file:references": { checked: true, references: [] },
    "file:hover": { checked: true },
    "file:source": { text: "export const answer = 42;\n" },
  };
  const wired = (onDefinition?: Parameters<typeof codeIntelOf>[2]) => {
    const invoke = vi.fn(async (channel: string) => answers[channel]);
    return { invoke, intel: codeIntelOf(invoke as unknown as IntelInvoke, address, onDefinition) };
  };
  const place = (over: Partial<FileLocation>): FileLocation => ({ file: "/work/project/src/service.ts", startLine: 3, startColumn: 14, endLine: 3, endColumn: 20, ...over });

  it("asks each channel at the document's address, with the text on screen and the caret", async () => {
    const { invoke, intel } = wired();
    await intel.check?.("let a = 1;");
    await intel.definitions?.("let a = 1;", { line: 1, column: 5 });
    await intel.references?.("let a = 1;", { line: 1, column: 5 });
    await intel.hover?.("let a = 1;", { line: 1, column: 5 });
    expect(invoke.mock.calls).toEqual([
      ["file:check", { layer: "project", project: "/work/project", path: "src/a.ts", text: "let a = 1;" }],
      ["file:definition", { layer: "project", project: "/work/project", path: "src/a.ts", text: "let a = 1;", line: 1, column: 5 }],
      ["file:references", { layer: "project", project: "/work/project", path: "src/a.ts", text: "let a = 1;", line: 1, column: 5 }],
      ["file:hover", { layer: "project", project: "/work/project", path: "src/a.ts", text: "let a = 1;", line: 1, column: 5 }],
    ]);
  });

  it("reads another file's text for a peek through the program, and answers nothing when it cannot", async () => {
    const { invoke, intel } = wired();
    expect(await intel.read?.(place({}))).toBe("export const answer = 42;\n");
    expect(invoke).toHaveBeenLastCalledWith("file:source", { layer: "project", project: "/work/project", path: "src/a.ts", file: "/work/project/src/service.ts" });
    const refused = codeIntelOf((async () => Promise.reject(new Error("outside the program"))) as unknown as IntelInvoke, address, undefined);
    expect(await refused.read?.(place({}))).toBeUndefined();
  });

  it("follows a definition the window can address, to where it starts", () => {
    const onDefinition = vi.fn();
    const { intel } = wired(onDefinition);
    const at = { layer: "project" as const, project: "/work/project", path: "src/service.ts" };
    expect(intel.open?.(place({ at }))).toBe(true);
    expect(onDefinition).toHaveBeenCalledWith(at, { line: 3, column: 14 });
  });

  it("refuses a definition outside the tree, which has no address", () => {
    const onDefinition = vi.fn();
    const { intel } = wired(onDefinition);
    expect(intel.open?.(place({ file: "/elsewhere/far.ts" }))).toBe(false);
    expect(onDefinition).not.toHaveBeenCalled();
  });

  it("offers no way out where there is no shell to navigate", () => {
    expect(wired().intel.open).toBeUndefined();
  });
});
