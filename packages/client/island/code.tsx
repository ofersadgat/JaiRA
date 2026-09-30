import { CodeText, MonacoCodePane } from "@jaira/ui/monacoDiff";
import type { RenderView } from "@jaira/shared/browser";
import { applyEditorAppearance } from "./editorAppearance";
import { mountIsland } from "./host";

/**
 * The code island: `documents.tsx`'s `CodeDocument` for a file surface, in the `.file-edit` band it
 * fills on the desktop — the Monaco editor (`MonacoCodePane`: the text surface of most types, editable
 * or a reading with typing off), or with `reading` the tokenizer's coloured text and no editor under
 * it (`CodeText`: the code view). The region is fixed by the host and the editor scrolls inside it.
 *
 * Props: `text`, `mime`, `readOnly` (the editor, refusing typing), `reading` (the code view instead),
 * `view` (which view's palette), `file` (the name Monaco parses by), `reveal` (the caret on the way
 * in), `theme` (the code view's palette, for a preview showing one), `autoHeight` (a fenced block's
 * editor: as tall as its text, which the page reports as its height, rather than filling the region). Events: `change`, the text.
 * Code intelligence (`file:check` and the rest) stays on the desktop: it asks main, which an island
 * page cannot reach.
 */
mountIsland({
  drawn: ".monaco-editor .view-lines > *, .code-shiki .line, .code-text",
  look: applyEditorAppearance,
  draw: (p, event) => {
    const text = String(p["text"] ?? "");
    const mime = String(p["mime"] ?? "text/plain");
    const file = typeof p["file"] === "string" ? p["file"] : undefined;
    if (p["reading"] === true) {
      return (
        <div className="file-edit" style={{ height: "100vh" }}>
          <CodeText text={text} mime={mime} {...(typeof p["theme"] === "string" ? { theme: p["theme"] } : {})} />
        </div>
      );
    }
    const reveal = p["reveal"] as { line: number; column: number } | undefined;
    const fit = p["autoHeight"] === true;
    return (
      <div className="file-edit" style={fit ? {} : { height: "100vh" }}>
        <MonacoCodePane
          // A different file is a different editor — `documents.tsx`'s `key`, for the same reasons.
          key={file}
          text={text}
          mime={mime}
          onChange={event("change")}
          {...(p["readOnly"] === true ? { readOnly: true } : {})}
          view={(p["view"] as RenderView | undefined) ?? "write"}
          {...(fit ? { autoHeight: true } : {})}
          {...(file === undefined ? {} : { file })}
          {...(reveal === undefined ? {} : { reveal })}
        />
      </div>
    );
  },
});
