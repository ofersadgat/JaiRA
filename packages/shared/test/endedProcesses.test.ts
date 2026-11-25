/**
 * What ended among a task's background processes goes with the person's next message (decision 0032,
 * ruling 8) — and a window still recognises that message as the one it sent, so it is drawn once.
 */
import { describe, expect, it } from "vitest";
import { holdsSentMessage, withEndedProcesses } from "../src/terminals";

const note = "`npm run dev` (pid 84456) was stopped after 1m; its last lines:\nready";

describe("a message with ended background processes", () => {
  it("is the message alone when nothing ended", () => {
    expect(withEndedProcesses("hello", [])).toBe("hello");
  });

  it("says one ended, or several", () => {
    expect(withEndedProcesses("hello", [note])).toBe(`hello\n\nA background process ended:\n\n${note}`);
    expect(withEndedProcesses("hello", [note, note])).toBe(`hello\n\nBackground processes ended:\n\n${note}\n\n${note}`);
  });

  it("is still the message that was sent", () => {
    expect(holdsSentMessage("hello", "hello")).toBe(true);
    expect(holdsSentMessage(withEndedProcesses("hello", [note]), "hello")).toBe(true);
    expect(holdsSentMessage(withEndedProcesses("hello", [note, note]), "hello")).toBe(true);
  });

  it("is not some other message that starts the same way", () => {
    expect(holdsSentMessage("hello there", "hello")).toBe(false);
    expect(holdsSentMessage("hello\n\nand more", "hello")).toBe(false);
    expect(holdsSentMessage("hello", "hello\n\nA background process ended:\n\nx")).toBe(false);
  });
});
