import { useState, type ComponentType, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import { GALLERY_CHANGESET, GALLERY_SURFACES, type Changeset, type GallerySurface, type PendingInteraction } from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { initialState, interactionOf, parsedDoc } from "@jaira/ui/galleryModel";
import { GalleryStage, GateSurface, ImageDiff, useTokens, type ImageLayout } from "@jaira/universal";

/**
 * The changeset reviewer where the gallery's cards do not reach it, as specimens (decision 0015), each
 * from a fixture.
 *
 *  - `image-diff-overlay`, `image-diff-split`, `image-diff-added` — `ImageDiff`'s comparison of two
 *    versions of a picture: stacked with the fader, side by side, and one side only (a create).
 *  - `changeset-image` — the reviewer open on a change of a picture (the gallery's stage, a changeset
 *    whose first change is an SVG redrawn), and a create of one beside it.
 *  - `changeset-settled`, `changeset-settled-forge` — the reviewer as it was answered, in a state's panel
 *    (the gate drawn `plain`), over the picture set: decided here with a note, a comment and a
 *    change reverted; and settled on the forge, with the request's strip, its thread and the forge's
 *    word (`SettledBy`).
 */
export interface ChangesetSpecimen {
  width: number;
  rn: ComponentType;
}

const NOOP = (): void => undefined;

// --- the pictures -----------------------------------------------------------------------------------

const svg = (body: string, width = 160, height = 96): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
/** The mark as it was, and as the change redraws it: the dot moved four pixels right and a bar added. */
const LOGO_BEFORE = svg(`<rect x="8" y="8" width="144" height="80" rx="10" fill="#e8eefc"/><circle cx="56" cy="48" r="24" fill="#3b5bdb"/>`);
const LOGO_AFTER = svg(`<rect x="8" y="8" width="144" height="80" rx="10" fill="#e8eefc"/><circle cx="60" cy="48" r="24" fill="#3b5bdb"/><rect x="96" y="36" width="40" height="24" rx="4" fill="#f59f00"/>`);
const BADGE = svg(`<circle cx="24" cy="24" r="20" fill="#2f9e44"/><path d="M14 25 l7 7 l13 -15" stroke="#fff" stroke-width="4" fill="none"/>`, 48, 48);
const src = (text: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;

function RnImages({ before, after, layout }: { before?: string; after?: string; layout: ImageLayout }): JSX.Element {
  const [now, setNow] = useState<ImageLayout>(layout);
  return <ImageDiff before={before} after={after} layout={now} onLayout={setNow} />;
}

/** The ground the reviewer's pane stands on (--bg); the comparison states its own text. */
function RnBody({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return <View backgroundColor={t.v("bg") as never}>{children}</View>;
}

const images = (layout: ImageLayout, before: string | undefined, after: string | undefined): ChangesetSpecimen => ({
  width: 520,
  rn: () => (
    <RnBody>
      <RnImages {...(before !== undefined ? { before } : {})} {...(after !== undefined ? { after } : {})} layout={layout} />
    </RnBody>
  ),
});

// --- the reviewer -----------------------------------------------------------------------------------

/** A set whose first change is a picture redrawn, then a picture added, then the gallery's code. */
const IMAGE_CHANGESET: Changeset = {
  source: GALLERY_CHANGESET.source,
  changes: [
    { id: "i1", path: "assets/logo.svg", action: "update", reason: "the mark nudged right, with the new badge beside it", before: LOGO_BEFORE, after: LOGO_AFTER },
    { id: "i2", path: "assets/badge.svg", action: "create", reason: "the badge on its own", after: BADGE },
    GALLERY_CHANGESET.changes[0]!,
  ],
};

const surfaceOf = (id: string): GallerySurface => GALLERY_SURFACES.find((s) => s.id === id)!;
const IMAGE_SURFACE: GallerySurface = { ...surfaceOf("review_artifacts/basic"), id: "review_artifacts/image", variant: "image", inputs: { changeset: IMAGE_CHANGESET as unknown as JsonValue } };

/** The gallery's stage: the dashed box. */
function RnStage({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View padding={12} borderRadius={8} backgroundColor={t.v("bg") as never} borderWidth={1} borderStyle="dashed" borderColor={t.v("line") as never} minWidth={0}>
      {children}
    </View>
  );
}

const staged = (surface: GallerySurface): ChangesetSpecimen => ({
  width: 624,
  rn: () => (
    <RnStage>
      <GalleryStage surface={surface} text={initialState(surface).text} onResult={NOOP} />
    </RnStage>
  ),
});

/**
 * A gallery card's gate over the picture set. A record opens on its first change, and that one is the
 * picture: a diff's Monaco loads after a specimen is photographed (the diff's read-only record is driven,
 * not photographed — `drive9302`).
 */
function gateOf(id: string): PendingInteraction {
  const surface = surfaceOf(id);
  return { ...interactionOf(surface, parsedDoc(initialState(surface).text).doc!).pending, inputs: { changeset: IMAGE_CHANGESET as unknown as JsonValue } };
}

/** A note on the picture's source: its words are in the SVG, so it resolves. */
const QUOTE = `<rect x="96" y="36"`;
const NOTE = { artifact: "i1", quote: QUOTE, range: { start: LOGO_AFTER.indexOf(QUOTE), end: LOGO_AFTER.indexOf(QUOTE) + QUOTE.length }, side: "after", body: "The badge crowds the mark — give it 8 more.", author: "you", at: "2026-09-19T10:40:00Z" };

/** Decided here: a note and a comment on the picture, the code change reverted, sent back to revise. */
const DECIDED: JsonValue = {
  decisions: [
    { id: "i1", decision: "commented", comment: "Check it on the dark ground too.", notes: [NOTE] },
    { id: "i2", decision: "approved" },
    { id: "c1", decision: "reverted" },
  ],
  decision: "revise",
  comments: "One more pass on the cache before it merges.",
} as unknown as JsonValue;

/** Settled on the forge: changes requested there, the worktree reset to the target, and the request's thread. */
const ON_FORGE: JsonValue = {
  decisions: [
    { id: "i1", decision: "commented", notes: [{ ...NOTE, author: "mara", source: "gitlab", thread: "gallery-thread-1", replies: [{ author: "you", body: "Moved it — 8 more.", at: "2026-09-19T10:50:00Z" }] }] },
    { id: "i2", decision: "approved" },
    { id: "c1", decision: "approved" },
  ],
  decision: "revise",
  notes: [{ artifact: "$review", quote: "", body: "Close — the badge needs room to breathe.", author: "mara", at: "2026-09-19T11:02:00Z", source: "gitlab" }],
  settled_by: { via: "remote", who: "mara", act: "changes_requested" },
  remote: { provider: "gitlab", project: "mistlabs/jaira", number: 41, head: "9c1e2f3a4b5c6d7e", target: "main", adopted: { reset: true, dropped: "jaira/t-qfr49rm80m/kept", why: "the target moved while the review was open" } },
} as unknown as JsonValue;

const settled = (id: string, value: JsonValue): ChangesetSpecimen => {
  const pending = gateOf(id);
  return {
    width: 640,
    rn: () => (
      <View flexDirection="column">
        <GateSurface pending={pending} onSubmit={NOOP} settled={{ value }} plain />
      </View>
    ),
  };
};

export const CHANGESET_SPECIMENS: Record<string, ChangesetSpecimen> = {
  "image-diff-overlay": images("overlay", src(LOGO_BEFORE), src(LOGO_AFTER)),
  "image-diff-split": images("split", src(LOGO_BEFORE), src(LOGO_AFTER)),
  "image-diff-added": images("overlay", undefined, src(BADGE)),
  "changeset-image": staged(IMAGE_SURFACE),
  "changeset-settled": settled("review_artifacts/routed", DECIDED),
  "changeset-settled-forge": settled("review_artifacts/remote", ON_FORGE),
};
