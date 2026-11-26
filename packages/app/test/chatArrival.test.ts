/**
 * A window arriving at a project lands on a new conversation there, and a conversation nothing can be
 * said to hands its box to a new one (the person, 2026-11-26: "I just started a project typed in a
 * prompt and it just disappeared" — the window had opened a new project with a conversation from the
 * last one still selected, one that had never run, and its box swallowed the prompt).
 */
import { describe, expect, it } from "vitest";
import { chatOnArriving } from "../src/renderer/chatArrival";
import { replyPlaceholder, strandedFor } from "../src/renderer/chatThreadModel";
import type { ChatState } from "../src/renderer/store";

describe("arriving at a project", () => {
  const open: ChatState = {
    taskId: "t-47fkj3414d",
    project: "c:\\ubuntucode\\jaira",
    busy: false,
    opening: "fix the picker",
    error: "an old failure",
    runOn: { project: "c:\\ubuntucode\\jaira" },
    settings: { model: "opus" },
    walkedInto: "i-1",
  };

  it("leaves the conversation of the place it left, and what was picked for it", () => {
    expect(chatOnArriving(open)).toEqual({ taskId: null, project: null, busy: false, opening: null, error: null });
  });

  it("keeps a conversation still being started, which lands where it was asked to", () => {
    expect(chatOnArriving({ ...open, busy: true }).busy).toBe(true);
  });
});

describe("a conversation nothing can be said to", () => {
  const base = { hasThread: false, notStarted: false, unreadable: false };

  it("is one that ended without a thread, or could not be read", () => {
    for (const status of ["interrupted", "failed", "canceled", "completed", "archived"] as const) expect(strandedFor({ ...base, status })).toBe(true);
    expect(strandedFor({ ...base, unreadable: true, status: undefined })).toBe(true);
  });

  it("is not one still on its way to a thread, or not read yet", () => {
    expect(strandedFor({ ...base, status: "queued" })).toBe(false);
    expect(strandedFor({ ...base, status: "running" })).toBe(false);
    expect(strandedFor({ ...base, status: undefined })).toBe(false);
    expect(strandedFor({ ...base, notStarted: true, status: "interrupted" })).toBe(false);
  });

  it("is not one with a thread, which takes the message itself", () => {
    expect(strandedFor({ ...base, hasThread: true, unreadable: true, status: "interrupted" })).toBe(false);
  });

  it("says in its box that a message starts a new conversation", () => {
    expect(replyPlaceholder(null, true)).toMatch(/starts a new one in this project/);
    expect(replyPlaceholder(null)).toBe("Reply…");
    expect(replyPlaceholder({ kind: "edit", at: "x", was: "y" }, true)).toBe("Say this instead…");
  });
});
