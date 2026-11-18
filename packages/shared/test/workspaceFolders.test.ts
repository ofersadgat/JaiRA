/** Where a machine's new workspaces go, and what each one's folder is called. */
import { describe, expect, it } from "vitest";
import { guessProjectsFolder, workspaceFolderName } from "../src/index";

describe("a machine's projects folder", () => {
  it("is where most of its workspaces already are, else Code in the home folder", () => {
    expect(guessProjectsFolder("/home/sam", ["/srv/work/atlas", "/srv/work/billing", "/home/sam/x/routing"])).toBe("/srv/work");
    expect(guessProjectsFolder("/home/sam/", [])).toBe("/home/sam/Code");
    expect(guessProjectsFolder("C:\\Users\\sam", ["C:\\src\\atlas\\"], "\\")).toBe("C:\\src");
    expect(guessProjectsFolder("C:\\Users\\sam", [], "\\")).toBe("C:\\Users\\sam\\Code");
  });
});

describe("a new workspace's folder name", () => {
  it("is the project's name, or name-1, name-2 when that is taken", () => {
    expect(workspaceFolderName("atlas", () => false)).toBe("atlas");
    const taken = new Set(["atlas", "atlas-1"]);
    expect(workspaceFolderName("atlas", (n) => taken.has(n))).toBe("atlas-2");
    expect(workspaceFolderName("bad/name:x", () => false)).toBe("bad-name-x");
    expect(workspaceFolderName("..", () => false)).toBe("project");
  });
});
