/**
 * The editing surfaces' logic, apart from their drawing (decision 0015): `fileSurfaces.tsx` draws them
 * in the DOM and the universal copy natively (its editors islands), and both decide from here — which
 * schema a document answers to, which syntax it is in, whether it is a file on a disk, and what the
 * configuration editor shows and saves.
 */
import { useEffect } from "react";
import { isWritableLayer, structuredFormatOf, type ConfigView, type FileSource, type SchemaFormat, type WritableLayer } from "@jaira/shared/browser";
import { docKey } from "./drafts";
import type { FileSurfaceContext } from "./fileTypes";

/**
 * Which schema a document answers to, asking the app once if nobody has decided.
 *
 * Shared by the two surfaces that need the answer — the JSON editor and the form — and that sharing
 * is the point rather than a tidy. The choice used to be filled in by the editor's own effect, which
 * was fine while the editor was the only thing that read it; a form drawn ABOVE an editor the person
 * had swapped for Monaco would then have found nothing chosen and said so, on a file whose schema
 * this app can identify perfectly well. Either surface alone now answers the question.
 *
 * Only when nothing has been decided — `chosen` absent, not `""`. The result is RECORDED as the
 * choice, including a miss (`""`), so this asks once per file rather than on every keystroke, and so
 * editing the document afterwards cannot pull the picker out from under the author.
 *
 * Detection reads `doc.text`, the file as it is on disk, rather than any draft: what schema a file IS
 * should not change while it is half-typed. And it is handed the path, because some files are what
 * they are CALLED — a `package.json`, a `.gitlab-ci.yml` — and the name is asked before the content.
 */
export function useSchemaChoice(doc: FileSource, context: FileSurfaceContext): string | undefined {
  const key = docKey(doc.layer, doc.path);
  const chosen = context.schemaChoice[key];
  const { detectSchema, onSchemaChoice } = context;
  useEffect(() => {
    if (chosen !== undefined) return;
    let live = true;
    void detectSchema(doc.text, doc.path, schemaFormatOf(doc)).then((found) => {
      if (live && found !== null) onSchemaChoice(key, found.schemaId);
    });
    return () => {
      live = false;
    };
  }, [key, chosen, doc.text, doc.path, detectSchema, onSchemaChoice]);
  return chosen;
}

/**
 * Which syntax a document held to a schema is written in — YAML for a YAML type (a Compose file, a
 * pipeline), JSON for everything else this is registered on.
 */
export function schemaFormatOf(doc: FileSource): SchemaFormat {
  return structuredFormatOf(doc.mime) === "yaml" ? "yaml" : "json";
}

/**
 * Whether this document is a FILE — somewhere on a disk — rather than a sample that looks like one.
 *
 * `FileSource.file` is absolute for everything the tree opens, because that is what resolving a
 * path against a layer root produces. The settings preview builds a document by hand to show what
 * a renderer does to a type, and its `file` is the word "sample": asking the compiler about that
 * would be a refused round trip per keystroke, in a pane whose subject is a colour scheme.
 */
export function isLocatedFile(doc: FileSource): boolean {
  return /^([a-zA-Z]:[\/]|[\/])/.test(doc.file);
}

/**
 * The configuration layer as the editor shows it. Preferred over the file's own contents because
 * `config:read` has already parsed it BOM-tolerantly and reprinted it; the raw bytes may differ in
 * ways that would show up as a spurious diff the moment anyone saved.
 */
export function configAuthoredText(config: ConfigView | null, doc: FileSource): string {
  const authored = config === null ? null : doc.layer === "base" ? config.base : config.project;
  return authored == null ? doc.text || "{}" : JSON.stringify(authored, null, 2);
}

/**
 * What saving a configuration draft does: the parsed document for `config:write`, or why not.
 * `config:write` takes a parsed document and validates it, so an unparsable draft is refused here
 * rather than written and reported afterwards.
 */
export function configSaveOf(text: string, layer: FileSource["layer"]): { layer: WritableLayer; doc: unknown } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: (e as Error).message };
  }
  // The built-in layer has no settings and takes no writes (decision 0006). Nothing opens this
  // surface on it today — the tree does not draw that root — so this is the type saying what the
  // service would say anyway.
  if (!isWritableLayer(layer)) return { error: "what ships with JaiRA is read-only" };
  return { layer, doc: parsed };
}
