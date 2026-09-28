import type { SchemaFormat } from "@jaira/shared/browser";
import { SchemaTextField } from "@jaira/ui/schemaEditor";
import { applyEditorAppearance } from "./editorAppearance";
import { mountIsland } from "./host";

/**
 * The schema-aware editor's text (`schemaEditor.tsx`'s `SchemaTextStack`): the coloured layer, the
 * textarea over it, the per-key hints and the completion list at the caret. The bar, the verdict, the
 * violations and the field reference around it are the host's, drawn natively; so is the check, which
 * asks main. Filling the region it is given, and scrolling inside.
 *
 * Props: `text`, `readOnly`, `wrap`, `schemaId` (null: plain), `format` (json|yaml), `mime` (the
 * palette's type), `fill` (a count: bumped, it adds the missing fields). Events: `change`, the text.
 */
mountIsland({
  drawn: ".editor-stack .code-line",
  look: applyEditorAppearance,
  draw: (p, event) => (
    <div style={{ height: "100vh" }}>
      <SchemaTextField
        text={String(p["text"] ?? "")}
        onChange={event("change")}
        readOnly={p["readOnly"] === true}
        wrap={p["wrap"] === true}
        schemaId={typeof p["schemaId"] === "string" ? p["schemaId"] : null}
        format={(p["format"] as SchemaFormat | undefined) ?? "json"}
        {...(typeof p["mime"] === "string" ? { mime: p["mime"] } : {})}
        fill={Number(p["fill"] ?? 0)}
      />
    </div>
  ),
});
