/**
 * The editing surfaces' logic, apart from their drawing: the Files room's surfaces
 * (`packages/universal/src/components/files/`, their editors islands) decide from here — which schema a
 * document answers to, which syntax it is in, whether it is a file on a disk, and what the
 * configuration editor shows and saves.
 */
import { useEffect } from "react";
import {
  isWritableLayer,
  monacoGrammarOf,
  structuredFormatOf,
  type CheckTarget,
  type ConfigView,
  type FileSource,
  type IpcRequest,
  type IpcResponse,
  type PatchFile,
  type SchemaFormat,
  type WritableLayer,
} from "@jaira/shared/browser";
import { docKey } from "./drafts";
import type { FileSurfaceContext } from "./fileTypes";
import type { CodeIntel } from "./monacoDiffTypes";

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
 * A patch's first file as the two revisions it is BETWEEN (`PatchSideBySide`): a context line belongs to
 * both, a removed line to the left only, an added line to the right only — a fold over the hunks, which
 * loses only what the patch itself left out (the unchanged stretches between hunks). Null for no file.
 */
export function patchSidesOf(files: readonly PatchFile[]): { file: PatchFile; before: string; after: string } | null {
  const file = files[0];
  if (file === undefined) return null;
  const before: string[] = [];
  const after: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== "add") before.push(line.text);
      if (line.kind !== "del") after.push(line.text);
    }
  }
  return { file, before: before.join("\n"), after: after.join("\n") };
}

/** What the side-by-side panes say after the file's path under themselves: how many others the patch holds. */
export function patchSidesMore(files: readonly PatchFile[]): string {
  return files.length > 1 ? ` — and ${files.length - 1} other ${files.length === 2 ? "file" : "files"} in this patch` : "";
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
  // Either slash: on Windows a resolved path is `C:\…`, and one that read as "not a file" was given no
  // name — its model was `inmemory://model/1`, parsed as plain TypeScript, and never checked.
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(doc.file);
}

/**
 * Whether the compiler can be asked about this document.
 *
 * TypeScript and JavaScript only, because that is what main can answer about — every other type
 * would cost a round trip to be told no project covers it — and only a file on a disk (see
 * {@link isLocatedFile}): the settings preview's sample is neither in a project nor anywhere.
 */
export function isCheckableFile(doc: FileSource): boolean {
  const grammar = monacoGrammarOf(doc.mime);
  return isLocatedFile(doc) && (grammar === "typescript" || grammar === "javascript");
}

/**
 * How the compiler's channels address a document: exactly as the `file:read` that opened it was, which
 * is what keeps the containment check the same one. One spelling for the check and for the release
 * that withdraws its buffer (`CheckTarget` says why).
 */
export function fileAddressOf(doc: Pick<FileSource, "layer" | "project" | "path">): CheckTarget {
  return {
    layer: doc.layer,
    ...(doc.project === undefined ? {} : { project: doc.project }),
    path: doc.path,
  };
}

/** The compiler's channels, as a host that can reach main hands them over (the store's `invoke`). */
export type IntelInvoke = <C extends "file:check" | "file:definition" | "file:references" | "file:hover" | "file:source">(
  channel: C,
  request: IpcRequest<C>,
) => Promise<IpcResponse<C>>;

/**
 * Everything a code pane can ask about its own text, and what it can do with an answer.
 *
 * `open` is the half Monaco has no way to perform: a standalone editor holds one model, so
 * following a definition OUT of this file is navigation only the window can do. A definition main
 * could not address — one outside the tree it searched — arrives without an `at` and is refused
 * here, which draws nothing rather than going somewhere plausible and wrong. With no `onDefinition`
 * (a surface with no shell behind it) the pane offers no cross-file jump at all.
 */
export function codeIntelOf(invoke: IntelInvoke, address: () => CheckTarget, onDefinition: FileSurfaceContext["onOpenDefinition"]): CodeIntel {
  return {
    check: (text) => invoke("file:check", { ...address(), text }),
    definitions: (text, at) => invoke("file:definition", { ...address(), text, ...at }),
    references: (text, at) => invoke("file:references", { ...address(), text, ...at }),
    hover: (text, at) => invoke("file:hover", { ...address(), text, ...at }),
    /**
     * Another file's text, for a peek to preview.
     *
     * `file:source` rather than `file:read`, because a definition is not addressed the way an
     * opened file is: it can resolve outside the tree entirely, and in this repository most of
     * them do — `@declarative-ai/*` goes through a workspace junction into a sibling checkout. A
     * read contained to the project root could preview none of those, which would have made peek
     * work only for the imports that were already the easy case.
     *
     * What bounds it instead is the program: main serves the text only for a file the compiler
     * itself resolved. Failure is answered with nothing, and that result simply loses its preview.
     */
    read: async (to) => {
      const source = await invoke("file:source", { ...address(), file: to.file }).catch(() => undefined);
      return source?.text;
    },
    ...(onDefinition === undefined
      ? {}
      : {
          open: (to) => {
            if (to.at === undefined) return false;
            onDefinition(to.at, { line: to.startLine, column: to.startColumn });
            return true;
          },
        }),
  };
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
