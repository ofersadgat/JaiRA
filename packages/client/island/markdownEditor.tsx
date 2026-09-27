import { MarkdownEditor } from "@jaira/ui/markdownEditor";
import { mountIsland } from "./host";

/** The markdown editor island: CodeMirror, read-only in v1 and editable in v2. */
mountIsland({
  drawn: ".cm-content > *",
  draw: (p, event) => (
    <div className="file-edit" style={{ height: "100vh" }}>
      <MarkdownEditor text={String(p["text"] ?? "")} readOnly={p["readOnly"] !== false} {...(p["readOnly"] === false ? { onChange: event("change") } : {})} />
    </div>
  ),
});
