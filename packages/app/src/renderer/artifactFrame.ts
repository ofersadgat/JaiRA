/**
 * The grant an interactive artifact is framed from — moved out of `valueView.tsx`'s `ValueView`
 * unchanged, so the universal value view (decision 0015) asks for it the same way and cannot come to
 * a different conclusion about when something may run. The frame itself is `interactiveArtifact.tsx`.
 */
import { useEffect, useState } from "react";
import type { ArtifactValue, ServedArtifact } from "@jaira/shared/browser";

/**
 * The address an interactive artifact is framed from, once it has been granted one.
 *
 * Asked for only when the value CLAIMS to be interactive and a grant is possible; the answer is
 * still checked, because the record is the authority on whether anything may run and this side is
 * only reporting what a tool result said. A refusal leaves this null and the static rendering
 * stands, which is why nothing here throws.
 */
export function useArtifactFrame(artifact: ArtifactValue | undefined, serve: ((path: string) => Promise<ServedArtifact>) | undefined): string | null {
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const wantsFrame = artifact?.interactive === true && artifact.path !== undefined && serve !== undefined;
  const framePath = wantsFrame ? artifact.path : undefined;
  useEffect(() => {
    if (framePath === undefined || serve === undefined) {
      setFrameUrl(null);
      return;
    }
    let live = true;
    void serve(framePath)
      .then((granted) => {
        // The GRANT decides, not the value we were handed: a record that never claimed to be
        // interactive is shown statically however the envelope described itself.
        if (live) setFrameUrl(granted.interactive ? granted.url : null);
      })
      .catch(() => {
        if (live) setFrameUrl(null);
      });
    return () => {
      live = false;
    };
  }, [framePath, serve]);
  return frameUrl;
}
