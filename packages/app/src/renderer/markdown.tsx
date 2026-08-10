/**
 * Rendered markdown, in its own module because two surfaces need it.
 *
 * It was part of the built-in surface table until the workflow description grew a viewer of its own
 * (`syncPanel.tsx`) that shows the same preview behind a toggle. Importing it from there would have
 * made the table import the panel and the panel import the table — a cycle that happens to work in
 * ES modules and is a poor thing to depend on. One parser, one component, one file.
 */
import { useMemo, type JSX } from "react";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import type { FileSurfaceProps } from "./fileTypes";

/**
 * One parser for the whole app.
 *
 * `html: false` is the first half of the safety story and the sanitizer below is the second. Both,
 * not either: markdown files here come from the shared root and from skills someone else authored,
 * so the content is no more trusted than the path it arrived on, and this renderer is inside a
 * privileged renderer process.
 */
const MARKDOWN = new MarkdownIt({ html: false, linkify: true, breaks: false });

/**
 * The markdown preview.
 *
 * Rendered rather than syntax-highlighted, because the thing a prompt author checks is what the
 * model will be shown — heading structure, list nesting, whether a fenced block actually closed.
 * That is a question about the output, and only the output answers it.
 */
export function MarkdownView({ doc }: FileSurfaceProps): JSX.Element {
  if (doc.text.trim().length === 0) return <p className="empty">This file is empty.</p>;
  return <Markdown text={doc.text} />;
}

/**
 * The same rendering, for text that is not a file.
 *
 * A model's answer is markdown and was being shown as preformatted text, so a plan came back as one
 * long line with literal `#` and `-` in it. Split out rather than duplicated because the sanitizer
 * and the parser configuration above are the safety story, and a second copy of a renderer is a
 * second copy to get wrong.
 */
export function Markdown({ text }: { text: string }): JSX.Element {
  const html = useMemo(() => DOMPurify.sanitize(MARKDOWN.render(text), { USE_PROFILES: { html: true } }), [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
