/**
 * An armed rewind in a TRANSCRIPT — what `Transcript` draws when told where a cut would fall.
 *
 * The claim is what the reader can check before agreeing to a deletion: every message from the
 * turn on is faded, and one counted line says how many. Rendered to static markup, like the panels.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Transcript } from "../src/renderer/transcriptView";
import type { TranscriptEntry } from "../src/renderer/transcript";

const said = (role: "user" | "assistant", text: string, turn: number): TranscriptEntry => ({ kind: "message", role, text, turn, at: 1_000 + turn });

const thread: TranscriptEntry[] = [
  said("user", "one", 0),
  said("assistant", "first answer", 1),
  said("user", "two", 2),
  said("assistant", "second answer", 3),
  said("user", "three", 4),
  said("assistant", "third answer", 5),
];

describe("a transcript with a rewind armed", () => {
  it("fades every message from the cut on, under one line that counts them", () => {
    const html = renderToStaticMarkup(createElement(Transcript, { entries: thread, doomedFrom: 2 }));
    expect(html).toContain("4 messages below this line will be deleted");
    expect(html.match(/ts-doomed/g)).toHaveLength(4);
    // The line sits before the first doomed message and after the last kept one.
    const cut = html.indexOf("ts-cut");
    expect(cut).toBeGreaterThan(html.indexOf("first answer"));
    expect(cut).toBeLessThan(html.indexOf(">two<"));
  });

  it("draws nothing of the sort when nothing is armed", () => {
    const html = renderToStaticMarkup(createElement(Transcript, { entries: thread }));
    expect(html).not.toContain("ts-doomed");
    expect(html).not.toContain("ts-cut");
  });

  it("offers rewind and fork where the host names a cut, with the sentence for the role", () => {
    const html = renderToStaticMarkup(
      createElement(Transcript, {
        entries: thread,
        onEdit: {
          can: (turn: number) => turn === 2 || turn === 4,
          edit: () => undefined,
          cut: (turn: number) => (turn === 2 || turn === 4 ? "before" : turn === 1 || turn === 3 ? "after" : undefined),
          rewind: () => undefined,
          fork: () => undefined,
        },
      }),
    );
    expect(html.match(/aria-label="Rewind to before this message"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Rewind to this reply"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Fork after this reply"/g)).toHaveLength(2);
    // The last reply has nothing after it, and offers neither.
    expect(html.match(/aria-label="Fork/g)).toHaveLength(4);
  });
});
