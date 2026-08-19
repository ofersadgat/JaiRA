/**
 * Which root in the Files drawer introduces itself, and which one does not.
 *
 * The tree's top level is every open project with `~/.jaira` beside them (SHELL.md §2.2), and each
 * root used to be headed by a row carrying its own name. Nested under a project row that is already
 * that name, that row printed the same word twice and spent the first line of a 250px column doing
 * it — so the root you are standing in stopped drawing one.
 *
 * The case worth a test is the shared root. It carries no `project` (it belongs to none) and it is
 * also a row in the sidebar and a perfectly ordinary place to stand — so a stamp-only test can never
 * be true there, and `~/.jaira` went on introducing itself inside itself.
 */
import { describe, expect, it } from "vitest";
import { rootNeedsName } from "../src/renderer/files";

const project = (dir: string): { dir: string; project?: string } => ({ dir: `${dir}/.jaira`, project: dir });
const shared = { dir: "/home/me/.jaira" };

describe("rootNeedsName", () => {
  it("does not name the checkout the drawer is standing in", () => {
    expect(rootNeedsName(project("/w/atlas"), "/w/atlas")).toBe(false);
  });

  it("does not name the SHARED root while you are standing in it", () => {
    // The reported fault: `~/.jaira` is a project row too, and standing there the tree showed one
    // root, headed by the name of the place you had just clicked to get there.
    expect(rootNeedsName(shared, "/home/me/.jaira")).toBe(false);
  });

  it("names the shared root from inside a checkout, because it is somewhere else", () => {
    expect(rootNeedsName(shared, "/w/atlas")).toBe(true);
  });

  it("names another open checkout, for the same reason", () => {
    expect(rootNeedsName(project("/w/notes"), "/w/atlas")).toBe(true);
  });

  it("names everything at the root of the address, where you are standing in nothing", () => {
    expect(rootNeedsName(project("/w/atlas"), null)).toBe(true);
    expect(rootNeedsName(shared, null)).toBe(true);
  });
});
