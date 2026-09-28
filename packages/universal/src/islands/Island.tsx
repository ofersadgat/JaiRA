import { lazy, Suspense, type JSX } from "react";
import { Markdown } from "@jaira/ui/markdown";
import type { IslandProps } from "./types";

/**
 * An island on WEB: the DOM component itself, inline. There is no WebView to host it in and no need
 * for one, and inline is what keeps the universal tree pixel-identical to the DOM tree around it.
 * `Island.native.tsx` is the WebView.
 */
const MonacoDiffPane = lazy(() => import("@jaira/ui/monacoDiff").then((m) => ({ default: m.MonacoDiffPane })));
const MarkdownEditor = lazy(() => import("@jaira/ui/markdownEditor").then((m) => ({ default: m.MarkdownEditor })));

export function Island({ component, props: p, height, onEvent }: IslandProps): JSX.Element {
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
      return (
        <div className="file-edit" style={box}>
          <Suspense fallback={null}>
            <MarkdownEditor text={String(p["text"] ?? "")} readOnly={p["readOnly"] !== false} {...(p["readOnly"] === false ? { onChange: event("change") } : {})} />
          </Suspense>
        </div>
      );
  }
}
