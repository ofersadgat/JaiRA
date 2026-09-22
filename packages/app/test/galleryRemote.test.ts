/**
 * The Components view's remote card never reaches main (decision 0004's second door, as a showcase).
 *
 * The gallery's gates claim a placeholder project, so a `remote:*` call from one is refused by main
 * — every ten seconds, per card, into the log. The gallery supplies its own `remote` instead, and
 * these tests wire a card exactly as `ChangesetGate` does, with an invoke that records every channel.
 */
import { describe, expect, it } from "vitest";
import { GALLERY_SURFACES, parseComponentConfig, type ReviewArtifactsConfig } from "@jaira/shared/browser";
import { gateServices } from "../src/renderer/changesetReview";
import { GALLERY_PROJECT, galleryServices } from "../src/renderer/componentGallery";
import { stripWords } from "../src/renderer/remoteStrip";

const surface = GALLERY_SURFACES.find((s) => s.id === "review_artifacts/remote")!;
const config = parseComponentConfig("review_artifacts", surface.sample) as ReviewArtifactsConfig;

/** An invoke that answers nothing and remembers everything it was asked. */
function recording(): { calls: string[]; invoke: Parameters<typeof gateServices>[0] } {
  const calls: string[] = [];
  const invoke = ((channel: string) => {
    calls.push(channel);
    return Promise.resolve([]);
  }) as unknown as Parameters<typeof gateServices>[0];
  return { calls, invoke };
}

/** The card's services, composed the way `ChangesetGate` composes them for `InteractionDialog`. */
const wire = (invoke: Parameters<typeof gateServices>[0], host: Parameters<typeof gateServices>[2]) =>
  gateServices(
    invoke,
    { config, project: GALLERY_PROJECT, author: "you", gate: { taskId: "gallery", project: GALLERY_PROJECT } },
    host,
  );

describe("the gallery's remote card", () => {
  it("would ask main about its placeholder project if the gallery supplied no door of its own", async () => {
    // The control: without this the test below could pass by the door simply not being wired.
    const { calls, invoke } = recording();
    await wire(invoke, {}).remote?.status();
    expect(calls).toEqual(["remote:status"]);
  });

  it("answers status, Check now and a reply without a single remote:* call", async () => {
    const { calls, invoke } = recording();
    const remote = wire(invoke, galleryServices(surface, config)).remote!;
    await remote.status();
    await remote.check();
    await remote.reply("gallery-thread-1", "One promise, yes.");
    expect(calls.filter((channel) => channel.startsWith("remote:"))).toEqual([]);
  });

  it("still draws its strip: the request, who wrote there, the deadline and the thread", async () => {
    const { invoke } = recording();
    const now = Date.now();
    const [row] = await wire(invoke, galleryServices(surface, config)).remote!.status();
    const words = stripWords(config.remote!, row, now);
    expect(words.label).toBe("mistlabs/jaira !41");
    expect(words.href).toBe("https://gitlab.com/mistlabs/jaira/-/merge_requests/41");
    expect(words.who).toBe("mara commented");
    expect(words.window?.text).toMatch(/^goes back at /);
    expect(words.error).toBeUndefined();
    expect(row!.notes?.["c1"]).toEqual([expect.objectContaining({ source: "gitlab", thread: "gallery-thread-1" })]);
  });

  it("keeps a reply on the card, and leaves the fixture as it was", async () => {
    const remote = galleryServices(surface, config).remote!;
    const [row] = await remote.reply("gallery-thread-1", "One promise, yes.");
    const thread = (row!.notes?.["c1"] ?? []) as Array<{ replies?: Array<{ body: string }> }>;
    expect(thread[0]!.replies?.map((reply) => reply.body)).toEqual(["One promise, yes."]);
    expect(surface.forge?.notes?.["c1"]?.[0]?.replies).toBeUndefined();
  });

  it("gives every other gallery gate no door at all", () => {
    for (const other of GALLERY_SURFACES) {
      if (other.id === surface.id || other.component !== "review_artifacts") continue;
      const cfg = parseComponentConfig("review_artifacts", other.sample);
      expect(galleryServices(other, cfg).remote, other.id).toBeUndefined();
    }
  });
});
