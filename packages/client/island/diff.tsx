import { MonacoDiffPane } from "@jaira/ui/monacoDiff";
import { mountIsland } from "./host";

/** The diff island: the review's Monaco diff, filling the region it is given and scrolling inside. */
mountIsland({
  drawn: ".monaco-diff-editor .view-lines > *",
  draw: (p, event) => (
    <div style={{ height: "100vh" }}>
      <MonacoDiffPane
        original={String(p["original"] ?? "")}
        modified={String(p["modified"] ?? "")}
        mime={String(p["mime"] ?? "text/plain")}
        readOnly={p["readOnly"] !== false}
        sideBySide={p["sideBySide"] === true}
        {...(typeof p["file"] === "string" ? { file: p["file"] } : {})}
        {...(p["readOnly"] === false ? { onModified: event("modified") } : {})}
      />
    </div>
  ),
});
