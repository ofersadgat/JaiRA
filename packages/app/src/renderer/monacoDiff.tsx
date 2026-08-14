/**
 * Monaco's DiffEditor, local and worker-wired (CHANGESETS.md §7.3) — the full-pane half of the
 * reviewer that §8.3 promises: side-by-side is unreadable at conversation width, so the wide view
 * is where it lives.
 *
 * Two decisions §7.3 warned about, and how they landed:
 *
 *  - **No CDN, no loader.** `monaco-editor` is imported as ESM and bundled by Vite;
 *    `MonacoEnvironment.getWorker` hands out the bundled workers (`?worker` imports). The
 *    `@monaco-editor/react` loader — the thing that "hangs on a blank editor with no error" in
 *    Electron — is not involved at all.
 *  - **The alignment question (§10.2) is dissolved, not answered.** Monaco renders only diffs it
 *    computes itself, and that is fine here because nothing of ours is overlaid on it: decisions
 *    are per CHANGE (§4.1), the stored jsdiff/structural hunks remain the record and the
 *    conversation-width rendering, and this pane is a reading-and-editing surface. Its
 *    `diffAlgorithm` is the default 'advanced', free to differ from the stored hunks because the
 *    two never have to line up.
 *
 * The modified side is editable: what the user types is §4.1's `merged.content`, the one part of
 * the outcome that is not derivable — the pane reports edits up and the reviewer folds them into
 * the decision.
 */
import { useEffect, useRef, type JSX } from "react";
import * as monaco from "monaco-editor";
// Monaco ≥0.53 maps subpaths through its exports table (`./*` → `./esm/vs/*.js`), so the worker
// specifiers are spelled WITHOUT the `esm/vs` prefix the older guides show.
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

// Installed once, before the first editor is created. The label→worker map is the canonical Vite
// arrangement; everything unlisted (yaml, markdown, plain text) runs on the base editor worker,
// which is also where diff computation happens.
if (window.MonacoEnvironment === undefined) {
  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case "json":
          return new JsonWorker();
        case "css":
        case "scss":
        case "less":
          return new CssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new HtmlWorker();
        case "typescript":
        case "javascript":
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };
}

/** The Monaco language id for a MIME type — display only, so unknown safely means plain text. */
export function monacoLanguageOf(mime: string): string {
  if (mime.endsWith("+json") || mime === "application/json") return "json";
  if (mime.endsWith("+yaml") || mime === "application/yaml") return "yaml";
  if (mime.endsWith("+markdown") || mime === "text/markdown") return "markdown";
  switch (mime) {
    case "text/x-typescript":
      return "typescript";
    case "text/javascript":
      return "javascript";
    case "text/x-python":
      return "python";
    case "text/html":
      return "html";
    case "text/css":
      return "css";
    case "application/x-sh":
      return "shell";
    case "application/xml":
    case "image/svg+xml":
      return "xml";
    default:
      return "plaintext";
  }
}

/** The Monaco theme for the app's `data-theme` attribute. */
const themeOf = (): string => (document.documentElement.dataset["theme"] === "dark" ? "vs-dark" : "vs");

export interface MonacoDiffProps {
  original: string;
  modified: string;
  /** A MIME type — mapped through {@link monacoLanguageOf}. */
  mime: string;
  /** Called with the modified side's full text on every edit — §4.1's `merged.content` feed. */
  onModified?: (text: string) => void;
  readOnly?: boolean;
}

export function MonacoDiffPane({ original, modified, mime, onModified, readOnly }: MonacoDiffProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  // The latest callback, without tearing the editor down per render: the editor is created once per
  // (original, mime) and the subscription reads through the ref.
  const report = useRef(onModified);
  report.current = onModified;

  useEffect(() => {
    const node = host.current;
    if (node === null) return undefined;
    const language = monacoLanguageOf(mime);
    const originalModel = monaco.editor.createModel(original, language);
    const modifiedModel = monaco.editor.createModel(modified, language);
    const editor = monaco.editor.createDiffEditor(node, {
      automaticLayout: true,
      renderSideBySide: true,
      originalEditable: false,
      readOnly: readOnly === true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      theme: themeOf(),
    });
    editor.setModel({ original: originalModel, modified: modifiedModel });
    const edits = modifiedModel.onDidChangeContent(() => report.current?.(modifiedModel.getValue()));

    // Follow the app's theme while the pane is open — the attribute is the one source of truth.
    const themes = new MutationObserver(() => monaco.editor.setTheme(themeOf()));
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      themes.disconnect();
      edits.dispose();
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
    // `modified` is deliberately absent: the pane OWNS the modified text once open (it is the
    // editing surface), and resetting the model on every keystroke's round-trip would fight the
    // user's cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original, mime, readOnly]);

  return <div className="monaco-host" ref={host} />;
}
