import type { JSX, ReactNode } from "react";
import { View } from "@tamagui/core";
import type { PinnedValue } from "@jaira/ui/valuePanel";
import { PreviewCard } from "@jaira/universal";

/**
 * A value that owns the panel's column — `PreviewCard` (`components/panel/PreviewCard.tsx`, the value
 * view's `pinned`; the copy of what `panelViews.tsx` drew), in a stage as tall as a panel's body
 * (decision 0015). What the interactive artifact adds is the grant (`serve`) and the bridge
 * (`onPrompt`), which only a real task's record can answer: the `conversation-artifact`,
 * `artifact-prompt`, `artifact-produced` and `artifact-preview` scenes run one.
 *
 *  - `preview-page` — an HTML artifact (inert, no grant): the page full bleed under the head.
 *  - `preview-source` — a long JSON value: the head padded 7 10 0, the body 0 10 10, no 340 ceiling.
 */
export interface ArtifactSpecimen {
  width: number;
  rn: () => JSX.Element;
}

const PAGE = [
  "<!doctype html>",
  '<html><body style="margin:0;font:14px/1.4 sans-serif;color:#222">',
  '<h1 style="margin:0;padding:16px 16px 0;font-size:18px">Lane picker</h1>',
  '<p style="margin:4px 16px 0">A page in the panel, drawn as it is.</p>',
  "</body></html>",
].join("\n");

const LONG = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`step_${String(i + 1).padStart(2, "0")}`, { state: i % 3 === 0 ? "critique" : "plan", ok: i % 4 !== 0 }]));

const PAGE_ITEM: PinnedValue = { title: "lane-picker.html", value: { path: "lane-picker.html", mediaType: "text/html", content: PAGE } };
const SOURCE_ITEM: PinnedValue = { title: "steps", value: LONG, label: "output" };

/** The panel's body, as tall as the studio's: `.sp-body`, a flex column the Preview card fills. */
const HEIGHT = 520;
function RnStage({ children }: { children: ReactNode }): JSX.Element {
  return <View height={HEIGHT}>{children}</View>;
}

const specimen = (item: PinnedValue): ArtifactSpecimen => ({
  width: 540,
  rn: () => (
    <RnStage>
      <PreviewCard item={item} />
    </RnStage>
  ),
});

export const ARTIFACT_SPECIMENS: Record<string, ArtifactSpecimen> = {
  "preview-page": specimen(PAGE_ITEM),
  "preview-source": specimen(SOURCE_ITEM),
};
