import { lazy, Suspense, type JSX } from "react";
import type { RenderView, SchemaFormat } from "@jaira/shared/browser";
import { Markdown } from "@jaira/ui/markdown";
import type { IslandProps } from "./types";

/**
 * An island on WEB: the DOM component itself, inline. There is no WebView to host it in and no need
 * for one, and inline is what keeps the universal tree pixel-identical to the DOM tree around it.
 * `Island.native.tsx` is the WebView.
 */
const MonacoDiffPane = lazy(() => import("@jaira/ui/monacoDiff").then((m) => ({ default: m.MonacoDiffPane })));
const MarkdownEditor = lazy(() => import("@jaira/ui/markdownEditor").then((m) => ({ default: m.MarkdownEditor })));
const MonacoCodePane = lazy(() => import("@jaira/ui/monacoDiff").then((m) => ({ default: m.MonacoCodePane })));
const CodeText = lazy(() => import("@jaira/ui/monacoDiff").then((m) => ({ default: m.CodeText })));
const SchemaTextField = lazy(() => import("@jaira/ui/schemaEditor").then((m) => ({ default: m.SchemaTextField })));
const MarkdownDocument = lazy(() => import("@jaira/ui/markdownDocument").then((m) => ({ default: m.MarkdownDocument })));
const Html = lazy(() => import("@jaira/ui/htmlFrame").then((m) => ({ default: m.Html })));

export function Island(props: IslandProps): JSX.Element {
  // Marked, so the fidelity gate can leave it out: an island is the desktop's own component by
  // construction, and on `/rn` it stands without the stylesheet a phone's island page carries.
  return <div data-island={props.component}>{inline(props)}</div>;
}

function inline({ component, props: p, height, onEvent }: IslandProps): JSX.Element {
  const event = (name: string) => (value: unknown) => onEvent?.(name, value);
  const box = height !== undefined ? { height } : undefined;
  switch (component) {
    case "markdown":
      return <Markdown text={String(p["text"] ?? "")} />;
    case "diff":
      return (
        <div style={box}>
          <Suspense fallback={null}>
            <MonacoDiffPane
              original={String(p["original"] ?? "")}
              modified={String(p["modified"] ?? "")}
              mime={String(p["mime"] ?? "text/plain")}
              readOnly={p["readOnly"] !== false}
              sideBySide={p["sideBySide"] === true}
              {...(typeof p["file"] === "string" ? { file: p["file"] } : {})}
              {...(p["readOnly"] === false ? { onModified: event("modified") } : {})}
            />
          </Suspense>
        </div>
      );
    case "markdownEditor":
      // A value view's document (an artifact under review): the desktop's `MarkdownDocument`, which
      // draws the editor as tall as its words, with a change over it.
      if (p["document"] === true) {
        return (
          <Suspense fallback={null}>
            <MarkdownDocument
              text={String(p["text"] ?? "")}
              {...(p["readOnly"] === false ? { onChange: event("change") } : { readOnly: true })}
              {...(p["diff"] !== undefined ? { diff: p["diff"] as never } : {})}
            />
          </Suspense>
        );
      }
      return (
        <div className="file-edit" style={box}>
          <Suspense fallback={null}>
            <MarkdownEditor text={String(p["text"] ?? "")} readOnly={p["readOnly"] !== false} {...(p["readOnly"] === false ? { onChange: event("change") } : {})} />
          </Suspense>
        </div>
      );
    // The island pages' own markup (`client/island/code.tsx`, `schemaText.tsx`), in the region given.
    case "code": {
      const text = String(p["text"] ?? "");
      const mime = String(p["mime"] ?? "text/plain");
      const file = typeof p["file"] === "string" ? p["file"] : undefined;
      const reveal = p["reveal"] as { line: number; column: number } | undefined;
      return (
        <div className="file-edit" style={{ ...box, display: "flex", flexDirection: "column" }}>
          <Suspense fallback={null}>
            {p["reading"] === true ? (
              <CodeText text={text} mime={mime} {...(typeof p["theme"] === "string" ? { theme: p["theme"] } : {})} />
            ) : (
              <MonacoCodePane
                key={file}
                text={text}
                mime={mime}
                onChange={event("change")}
                {...(p["readOnly"] === true ? { readOnly: true } : {})}
                view={(p["view"] as RenderView | undefined) ?? "write"}
                {...(file === undefined ? {} : { file })}
                {...(reveal === undefined ? {} : { reveal })}
              />
            )}
          </Suspense>
        </div>
      );
    }
    // An HTML or SVG artifact, drawn as the page it is (`valueView.tsx`'s `Html`).
    case "artifact":
      return (
        <Suspense fallback={null}>
          <Html text={String(p["text"] ?? "")} />
        </Suspense>
      );
    case "schemaText":
      return (
        <div style={box}>
          <Suspense fallback={null}>
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
          </Suspense>
        </div>
      );
  }
}
