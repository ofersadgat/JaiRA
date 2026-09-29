import { MarkdownDocument } from "@jaira/ui/markdownDocument";
import { MarkdownEditor, type MarkdownDiff } from "@jaira/ui/markdownEditor";
import { mountIsland } from "./host";

/**
 * The markdown editor island: CodeMirror, filling the page (a file's editor) — or, with `document`, the
 * desktop's `MarkdownDocument` as a value view draws it (an artifact under review: as tall as its words,
 * a change drawn over it), sized to its content.
 */
mountIsland({
  drawn: ".cm-content > *",
  draw: (p, event) =>
    p["document"] === true ? (
      <MarkdownDocument
        text={String(p["text"] ?? "")}
        {...(p["readOnly"] === false ? { onChange: event("change") } : { readOnly: true })}
        {...(p["diff"] !== undefined ? { diff: p["diff"] as MarkdownDiff } : {})}
      />
    ) : (
      <div className="file-edit" style={{ height: "100vh" }}>
        <MarkdownEditor text={String(p["text"] ?? "")} readOnly={p["readOnly"] !== false} {...(p["readOnly"] === false ? { onChange: event("change") } : {})} />
      </div>
    ),
});
