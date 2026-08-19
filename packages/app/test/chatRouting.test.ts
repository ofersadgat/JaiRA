/**
 * Which database the Chat view reads — the one rule, and the three faults it stops.
 *
 * A chat call NAMES its project. Unnamed, main resolves "the focused project", and `sessionOf`
 * answers that only while exactly one user project is open:
 *
 *  - standing on `~/.jaira`, no user project is open at all — a shared session is not a user one —
 *    so every read threw `no project is open`. That is the reported crash: `chat:thread`,
 *    `artifact:list` and `chat:startPlan`, one per surface the view had on screen.
 *  - with a SECOND checkout open it throws `several projects are open, so this call must name one`,
 *    which is the arrangement this whole shell exists for.
 *  - and a conversation opened from the root list belongs to whichever project holds it, which is
 *    not necessarily either of those.
 */
import { describe, expect, it } from "vitest";
import { SHARED_SESSION } from "@jaira/shared";
import { chatProjectOf } from "../src/renderer/chatPane";

describe("chatProjectOf", () => {
  it("reads an open conversation out of the project that holds it", () => {
    // The root list spans every project, so the row's own project is the only right answer — and it
    // is the one `openConversation` was already being told and nothing was reading.
    expect(chatProjectOf("/w/atlas-web", null)).toBe("/w/atlas-web");
    // Even while the address is standing somewhere else: the thread is a fact about the task.
    expect(chatProjectOf("/w/atlas-web", "/w/notes-api")).toBe("/w/atlas-web");
  });

  it("sends a new conversation to the project the address is standing on", () => {
    expect(chatProjectOf(null, "/w/notes-api")).toBe("/w/notes-api");
  });

  it("names the shared root at the root of the address", () => {
    // Where a base-layer workflow runs (`runTargetOf`), and the one project that means the same
    // thing in every window.
    expect(chatProjectOf(null, null)).toBe(SHARED_SESSION);
  });

  it("never answers null, whatever it is given", () => {
    // The whole point. `null` meant "let main resolve it", which is the resolution that throws.
    for (const open of [null, "/w/a"]) {
      for (const at of [null, "/w/b"]) {
        expect(chatProjectOf(open, at)).toBeTruthy();
      }
    }
  });

  it("names the shared root as a PROJECT while the address stands on it", () => {
    // `~/.jaira` is a row in the sidebar and a place to stand, and standing there is what produced
    // "no project is open": the address was set, so nothing thought it had to say where it was.
    expect(chatProjectOf(null, "/home/me/.jaira")).toBe("/home/me/.jaira");
  });
});
