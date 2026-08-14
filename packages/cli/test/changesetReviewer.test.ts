/**
 * The terminal reviewer (CHANGESETS.md §8.4): one change at a time, the same five decisions, the
 * same changeset in and out — driven over injected streams, because the property under test is the
 * dialogue, not the terminal.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Changeset } from "@jaira/shared";
import { reviewChangesetOnTerminal } from "../src/changesetReviewer";

const CHANGESET: Changeset = {
  source: "git:abcd1234",
  changes: [
    {
      id: "c1",
      path: "src/a.ts",
      action: "update",
      before: "old\n",
      after: "new\n",
      hunks: [{ id: "h1", start: 0, end: 4, text: "new\n", label: "@@ -1,1 +1 @@" }],
    },
    { id: "c2", path: "img.png", action: "update", unshowable: "binary content cannot be shown" },
  ],
};

/** Feed scripted lines when prompted, capture everything printed. */
function terminal(lines: string[]): { io: { input: PassThrough; output: PassThrough }; printed: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
    // Answer the next prompt as soon as one is written — readline prompts synchronously with reads.
    if (text.endsWith(": ") && lines.length > 0) input.write(`${lines.shift()!}\n`);
  });
  return { io: { input, output }, printed: () => text };
}

describe("reviewChangesetOnTerminal", () => {
  it("walks the changes in order and returns one decision per change", async () => {
    const t = terminal(["m", "d"]);
    const decisions = await reviewChangesetOnTerminal(CHANGESET, t.io);
    expect(decisions).toEqual([
      { id: "c1", decision: "merged" },
      { id: "c2", decision: "denied" },
    ]);
    // The rendering shows the hunk and says why the binary cannot be shown.
    expect(t.printed()).toContain("- old");
    expect(t.printed()).toContain("+ new");
    expect(t.printed()).toContain("binary content cannot be shown");
  });

  it("collects the comment a comment decision carries — flow 1's payload", async () => {
    const t = terminal(["c", "why not the other approach?", "a"]);
    const decisions = await reviewChangesetOnTerminal(CHANGESET, t.io);
    expect(decisions[0]).toEqual({ id: "c1", decision: "comment", comment: "why not the other approach?" });
    expect(decisions[1]).toEqual({ id: "c2", decision: "approved" });
  });

  it("re-asks on an answer outside the five decisions rather than guessing", async () => {
    const t = terminal(["x", "merge it", "merged", "r"]);
    const decisions = await reviewChangesetOnTerminal(CHANGESET, t.io);
    expect(decisions[0]).toEqual({ id: "c1", decision: "merged" });
    expect(decisions[1]).toEqual({ id: "c2", decision: "reverted" });
    expect(t.printed()).toContain("choose one of");
  });
});
