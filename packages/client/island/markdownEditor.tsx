import { MarkdownDocument } from "@jaira/ui/markdownDocument";
import { MarkdownEditor } from "@jaira/ui/markdownEditor";
import type { MarkdownDiff } from "@jaira/ui/markdownEditorTypes";
import { publishRenderChoices } from "@jaira/ui/renderChoice";
import { mountIsland } from "./host";

/**
 * The markdown editor island: CodeMirror, filling the page (a file's editor) — or, with `document`,
 * `MarkdownDocument` as a value view draws it (an artifact under review: as tall as its words, a change
 * drawn over it), sized to its content.
 *
 * `mime` is the type the document IS, for the palette chosen per type and view (`viewTheme`, read by
 * `MarkdownDocument`): a file's editor given one is `MarkdownDocument` too, in the same band. The
 * choices themselves arrive with the look (`IslandLook.appearance`), where the host sends it, and are
 * published as the desktop's store publishes them. Only the choices: the rest of the appearance block
 * (the editors' face, size and own palette, `editorAppearance.ts`) is not applied to this page yet.
 */
/** The choices last published: every render carries the look, and one goes out per keystroke. */
let published = "";

mountIsland({
  drawn: ".cm-content > *",
  look: (look) => {
    if (look.appearance === undefined) return;
    const key = JSON.stringify(look.appearance.renderers);
    if (key === published) return;
    published = key;
    publishRenderChoices(look.appearance.renderers);
  },
  draw: (p, event) =>
    p["document"] === true ? (
      <MarkdownDocument
        text={String(p["text"] ?? "")}
        {...(p["readOnly"] === false ? { onChange: event("change") } : { readOnly: true })}
        {...(p["diff"] !== undefined ? { diff: p["diff"] as MarkdownDiff } : {})}
        {...(typeof p["mime"] === "string" ? { mime: p["mime"] } : {})}
      />
    ) : (
      <div className="file-edit" style={{ height: "100vh" }}>
        {typeof p["mime"] === "string" ? (
          <MarkdownDocument text={String(p["text"] ?? "")} mime={p["mime"]} {...(p["readOnly"] === false ? { onChange: event("change") } : { readOnly: true })} />
        ) : (
          <MarkdownEditor text={String(p["text"] ?? "")} readOnly={p["readOnly"] !== false} {...(p["readOnly"] === false ? { onChange: event("change") } : {})} />
        )}
      </div>
    ),
});
