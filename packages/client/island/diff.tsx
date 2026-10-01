import { useEffect, type JSX } from "react";
import { MonacoDiffPane } from "@jaira/ui/monacoDiff";
import type { DiffActions, MonacoDiffProps } from "@jaira/ui/monacoDiffTypes";
import { mountIsland } from "./host";

/**
 * The diff island: the review's Monaco diff, filling the region it is given and scrolling inside.
 *
 * With `select`, the reviewer's line selection comes back as a `select` event — the passage a note is
 * about (its rect in this page; the native host moves it into the window) and whether it covers a
 * changed line, which is what the reviewer's Revert says before it is pressed. `revertSelectedLines`
 * (a command) puts the original back over those lines and answers with a `reverted` event. `intel` is
 * the compiler on each side, called back over the bridge (`protocol.ts`'s `call`). `frame` is laid on the
 * pane's own box: what the host's stylesheet gives it under an ancestor this page does not have.
 */
let actions: DiffActions | null = null;

function dress(frame: unknown): void {
  const host = document.querySelector<HTMLElement>("#island .monaco-host");
  if (host !== null && frame !== null && typeof frame === "object") Object.assign(host.style, frame);
}

/** The pane, dressed in its host's `frame` whenever that moves (a palette switch recolours the ring). */
function Pane({ p, event }: { p: Record<string, unknown>; event: (name: string) => (value: unknown) => void }): JSX.Element {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => dress(p["frame"]), [JSON.stringify(p["frame"])]);
  return (
    <div style={{ height: "100vh" }}>
      <MonacoDiffPane
        original={String(p["original"] ?? "")}
        modified={String(p["modified"] ?? "")}
        mime={String(p["mime"] ?? "text/plain")}
        readOnly={p["readOnly"] !== false}
        sideBySide={p["sideBySide"] === true}
        {...(typeof p["file"] === "string" ? { file: p["file"] } : {})}
        {...(p["readOnly"] === false ? { onModified: event("modified") } : {})}
        {...(p["select"] === true ? { onSelect: (selection) => event("select")({ selection, canRevert: actions?.hasChangedSelection() === true }) } : {})}
        onReady={(ready) => {
          actions = ready;
          dress(p["frame"]);
        }}
        {...(p["intel"] !== null && typeof p["intel"] === "object" ? { intel: p["intel"] as NonNullable<MonacoDiffProps["intel"]> } : {})}
      />
    </div>
  );
}

mountIsland({
  drawn: ".monaco-diff-editor .view-lines > *",
  draw: (p, event) => <Pane p={p} event={event} />,
  command: (name, _value, event) => {
    if (name === "revertSelectedLines") event("reverted")(actions?.revertSelectedLines() ?? null);
  },
});
