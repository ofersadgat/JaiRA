import { useEffect, type JSX } from "react";
import { View } from "@tamagui/core";
import { PublishedView } from "../components/panel/PublishedView";
import { useTokens } from "../tokens";
import { useSheetInset } from "./columnsFit";
import { artifactInMain } from "./viewState";

/**
 * A published artifact in the main view (`viewState.ts`' `artifactInMain`): drawn OVER the room's middle
 * column, which stays mounted under it, so going back finds the conversation where it was, its draft and
 * its scroll, and the side panel stays beside it. The room's column holds it, positioned, as its last
 * child. Going to another task or room takes it away.
 *
 *   the sheet     fills the column, on --bg; the artifact fills it (`PublishedView`'s `fill`), a ‹ on its
 *                 title bar
 */
export function ArtifactInMain({ at = null }: { /** What the column is showing: when that changes, this has nothing to stand over. */ at?: string | null | undefined }): JSX.Element | null {
  const t = useTokens();
  const held = artifactInMain.use();
  // On a phone the panel's sheet stands over the room's foot: the artifact stops above its head.
  const inset = useSheetInset();
  useEffect(() => () => artifactInMain.set(null), [at]);
  if (held === null) return null;
  return (
    <View position="absolute" top={0} right={0} bottom={inset} left={0} zIndex={10} backgroundColor={t.v("bg") as never} flexDirection="column" minHeight={0}>
      <PublishedView key={`${held.published.id}@${String(held.published.version)}`} published={held.published} artifacts={held.artifacts} fill follows={held.follows} onBack={() => artifactInMain.set(null)} />
    </View>
  );
}
