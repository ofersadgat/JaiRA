import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import type { RenderView, SchemaFormat } from "@jaira/shared/browser";
import { Markdown } from "@jaira/ui/markdown";
import type { DiffActions, MonacoDiffProps } from "@jaira/ui/monacoDiffTypes";
import { useLook } from "../tokens";
import { dress, islandStyles, islandStylesIn } from "./islandStyles";
import type { IslandHandle, IslandProps } from "./types";

/**
 * An island on WEB: the DOM component itself (one of `@jaira/ui`'s), inline in the page. There is no
 * WebView to host it in and no need for one. `Island.native.tsx` is the WebView.
 */
const MonacoDiffPane = lazy(() => import("@jaira/ui/monacoDiff").then((m) => ({ default: m.MonacoDiffPane })));
const MarkdownEditor = lazy(() => import("@jaira/ui/markdownEditor").then((m) => ({ default: m.MarkdownEditor })));
const MonacoCodePane = lazy(() => import("@jaira/ui/monacoDiff").then((m) => ({ default: m.MonacoCodePane })));
const CodeText = lazy(() => import("@jaira/ui/monacoDiff").then((m) => ({ default: m.CodeText })));
const SchemaTextField = lazy(() => import("@jaira/ui/schemaEditor").then((m) => ({ default: m.SchemaTextField })));
const MarkdownDocument = lazy(() => import("@jaira/ui/markdownDocument").then((m) => ({ default: m.MarkdownDocument })));
const Html = lazy(() => import("@jaira/ui/htmlFrame").then((m) => ({ default: m.Html })));
const InteractiveArtifact = lazy(() => import("@jaira/ui/interactiveArtifact").then((m) => ({ default: m.InteractiveArtifact })));

export function Island(props: IslandProps): JSX.Element {
  const look = useLook();
  const box = useRef<HTMLDivElement>(null);
  // The component is half its stylesheet, which the universal page does not carry: it is drawn once the
  // island's own copy of it is in (`islandStyles`), so it never lays out unstyled and then again.
  const [styled, setStyled] = useState(islandStylesIn);
  useEffect(() => {
    let here = true;
    if (!styled) void islandStyles().then(() => here && setStyled(true));
    return () => {
      here = false;
    };
  }, [styled]);
  // The look on the island's box, where the scoped stylesheet reads it (`:root` there is this box).
  useLayoutEffect(() => dress(box.current, look), [styled, look.palette, look.scheme, look.wash, look.buckets, look.lanes]);
  // Marked: the stylesheet is scoped to this box (`@scope ([data-island])`), and `pair.mts` paints it
  // out of a comparison — what stands inside is a DOM component, not this tree's drawing.
  return (
    <div ref={box} data-island={props.component}>
      {styled ? (props.under ?? []).reduceRight((inner, classes) => <div className={classes} style={{ display: "contents" }}>{inner}</div>, inline(props)) : null}
    </div>
  );
}

function inline({ component, props: p, height, onEvent, handle }: IslandProps): JSX.Element {
  const event = (name: string) => (value: unknown) => onEvent?.(name, value);
  const box = height !== undefined ? { height } : undefined;
  switch (component) {
    case "markdown":
      return <Markdown text={String(p["text"] ?? "")} />;
    case "diff":
      return <DiffInline p={p} box={box} event={event} {...(handle !== undefined ? { handle } : {})} />;
    case "markdownEditor":
      // A value view's document (an artifact under review): `MarkdownDocument`, which draws the
      // editor as tall as its words, with a change over it.
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
      // `autoHeight`: a fenced block's editor, as tall as its text (`MonacoCodePane`'s), in no band.
      const fit = p["autoHeight"] === true;
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
                {...(fit ? { autoHeight: true } : {})}
                {...(file === undefined ? {} : { file })}
                {...(reveal === undefined ? {} : { reveal })}
              />
            )}
          </Suspense>
        </div>
      );
    }
    // An HTML or SVG artifact, drawn as the page it is (`htmlFrame.tsx`'s `Html`) — or, with a `url` the
    // record granted it (`artifactFrame.ts`), the frame it RUNS in (`interactiveArtifact.tsx`), whose
    // messages come back as `prompt` events. Each brings its own sandbox; `style` is the frame's box,
    // stated by the host (`ValueView.tsx`'s `PageFrame`), and `strut` the font of the block the frame
    // stands in: an iframe is inline, on its line's baseline, so the block is the frame and the line's
    // depth below that baseline (a value's body, 13/12.5 on 1.5, adds 5.5 to 360).
    case "artifact": {
      const style = p["style"] as CSSProperties | undefined;
      const strut = p["strut"] as CSSProperties | undefined;
      const frame = (
        <Suspense fallback={null}>
          {typeof p["url"] === "string" ? (
            <InteractiveArtifact url={p["url"]} onPrompt={event("prompt")} style={style} />
          ) : (
            <Html text={String(p["text"] ?? "")} style={style} />
          )}
        </Suspense>
      );
      return strut === undefined ? frame : <div style={strut}>{frame}</div>;
    }
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

/**
 * The diff, inline: `MonacoDiffPane` with what the changeset reviewer wires into it. `select` reports the
 * line selection (`select`: the passage and whether it covers a changed line — what Revert says before
 * it is pressed); the pane's actions are the handle's `revertSelectedLines`, answered as `reverted`;
 * `intel` is the compiler on each side, handed straight through. `loading` is the fallback a host draws
 * while Monaco loads (its words and its box's style); `frame` is the look a host gives the pane's own
 * box (`.monaco-host` — the changeset reviewer's ring, radius and floor), laid on the element itself: the
 * host stands outside the island and cannot style what is inside it any other way.
 */
function DiffInline({ p, box, event, handle }: { p: Record<string, unknown>; box: CSSProperties | undefined; event: (name: string) => (value: unknown) => void; handle?: (handle: IslandHandle | null) => void }): JSX.Element {
  const actions = useRef<DiffActions | null>(null);
  // The latest host's, for the handle: it is handed over once, when the pane is made.
  const live = useRef(event);
  live.current = event;
  const loading = p["loading"] as { text: string; style: CSSProperties } | undefined;
  const wrap = useRef<HTMLDivElement>(null);
  const frame = p["frame"] as Record<string, string> | undefined;
  const dress = (): void => {
    const host = wrap.current?.querySelector<HTMLElement>(".monaco-host");
    if (host !== null && host !== undefined && frame !== undefined) Object.assign(host.style, frame);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(dress, [JSON.stringify(frame)]);
  return (
    <div style={box} ref={wrap}>
      <Suspense fallback={loading === undefined ? null : <div style={loading.style}>{loading.text}</div>}>
        <MonacoDiffPane
          original={String(p["original"] ?? "")}
          modified={String(p["modified"] ?? "")}
          mime={String(p["mime"] ?? "text/plain")}
          readOnly={p["readOnly"] !== false}
          sideBySide={p["sideBySide"] === true}
          {...(typeof p["file"] === "string" ? { file: p["file"] } : {})}
          {...(p["readOnly"] === false ? { onModified: event("modified") } : {})}
          {...(p["select"] === true ? { onSelect: (selection) => event("select")({ selection, canRevert: actions.current?.hasChangedSelection() === true }) } : {})}
          onReady={(ready) => {
            actions.current = ready;
            dress();
            handle?.(ready === null ? null : { command: (name) => name === "revertSelectedLines" && live.current("reverted")(ready.revertSelectedLines()) });
          }}
          {...(p["intel"] !== null && typeof p["intel"] === "object" ? { intel: p["intel"] as NonNullable<MonacoDiffProps["intel"]> } : {})}
        />
      </Suspense>
    </div>
  );
}
