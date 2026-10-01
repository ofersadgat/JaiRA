import type { Look } from "../tokens";

/**
 * The desktop's stylesheet, for islands alone (decision 0015) — web only, imported by `Island.tsx`.
 *
 * An island on web is the desktop's DOM component drawn inline, and that component is half its
 * stylesheet: the markdown editor is CodeMirror with `.md-editor` inheriting the page's type and sixty
 * `.cm-*` rules giving a heading its size and a fence its box. On a phone the island's page brings
 * `styles.css` with it (`client/island/host.tsx`). The universal page has none — it tests the native path,
 * where no copy may be helped by a rule — so an inline island stood unstyled there: the editor in the
 * browser's serif at 16px, 57px taller than the desktop's, and everything under it on the page that much
 * lower.
 *
 * So the island gets the stylesheet, and nothing else does: every rule is inside
 * `@scope ([data-island])`, where it reaches the island's own elements and no copy. Three things are
 * changed on the way in:
 *
 *   :root          `:scope` — the island's own box stands in for the root: it carries the look as the
 *                  root does (`data-theme`, `data-palette`, …, {@link dress}), so a palette's variables
 *                  and its rules resolve inside it, and the page's root is left without a variable.
 *   body           its `color` and `font` alone, on the island's box: what the component inherits. Its
 *                  ground is not the island's to paint.
 *   @font-face     dropped (the page's `fonts.css` has the faces); `@keyframes` stand outside the scope.
 *
 * A page that carries the stylesheet already — the desktop's, with a copy standing in for an original —
 * needs none of this, and gets none.
 */
let installed: Promise<void> | undefined;
let done = false;

/** Whether the stylesheet is in already: an island mounted after the first draws at once. */
export const islandStylesIn = (): boolean => done;

export function islandStyles(): Promise<void> {
  installed ??= (async () => {
    if (typeof document !== "undefined" && getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() === "") {
      const css = (await import("@jaira/ui/styles.css?inline")).default;
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(scoped(css));
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }
    done = true;
  })();
  return installed;
}

/** `styles.css` as an island reads it: see {@link islandStyles}. */
export function scoped(css: string): string {
  const outside: string[] = [];
  const inside: string[] = [];
  for (const { prelude, body } of topLevel(css.replace(/\/\*[\s\S]*?\*\//g, ""))) {
    if (/^@(font-face|import|charset)\b/.test(prelude)) continue;
    if (/^@(-webkit-)?keyframes\b/.test(prelude)) outside.push(`${prelude}{${body}}`);
    else if (prelude === "body") inside.push(`:scope{${body.split(";").filter((d) => /^\s*(color|font[a-z-]*)\s*:/.test(d)).join(";")}}`);
    else inside.push(`${prelude.replaceAll(":root", ":scope")}{${prelude.startsWith("@") ? body.replaceAll(":root", ":scope") : body}}`);
  }
  return `${outside.join("\n")}\n@scope ([data-island]) {\n${inside.join("\n")}\n}`;
}

/** The sheet's top-level rules: what stands before each outermost `{`, and what is between it and its `}`. */
function* topLevel(css: string): Generator<{ prelude: string; body: string }> {
  let depth = 0;
  let start = 0;
  let open = 0;
  let quote = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (quote !== "") {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "{") {
      if (depth++ === 0) open = i;
    } else if (c === "}") {
      if (--depth === 0) {
        yield { prelude: css.slice(start, open).trim(), body: css.slice(open + 1, i) };
        start = i + 1;
      }
    } else if (c === ";" && depth === 0) start = i + 1;
  }
}

/**
 * The look, on an island's own box, as `applyAppearance` writes it on the desktop's root: what the
 * scoped rules select by. First whatever the page's root carries (the editors' palette, and the sizes
 * and faces the person chose, which are inline there), then the look this island stands in — the
 * replayed one, which on a specimen's page is the only place it is said.
 */
export function dress(box: HTMLElement | null, look: Look): void {
  if (box === null) return;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(root.dataset)) if (name !== "island" && value !== undefined) box.dataset[name] = value;
  for (const name of Array.from(root.style)) if (name.startsWith("--") && LENT.get(name) !== root.style.getPropertyValue(name)) box.style.setProperty(name, root.style.getPropertyValue(name));
  const mark = (name: string, value: string | null): void => {
    if (value === null) delete box.dataset[name];
    else box.dataset[name] = value;
  };
  mark("theme", look.scheme);
  mark("palette", look.palette === "classic" ? null : look.palette);
  mark("buckets", look.buckets === "line" ? "line" : null);
  mark("lanes", look.lanes ? "on" : null);
  mark("wash", look.wash ? "on" : null);
  // What an editor reads off the ROOT: Monaco draws into a canvas and cannot inherit, so it takes its face
  // and size from the root's computed style (`editorFont()`), which on this page has neither — and drew in
  // its own default face. Lent to the root from this box, where the scoped stylesheet resolves them, for as
  // long as the root has none of its own. Two names, and no copy reads either: a copy's values are replayed.
  const mine = getComputedStyle(box);
  for (const name of ["--font-data", "--size-editor"]) {
    const value = mine.getPropertyValue(name).trim();
    const there = root.style.getPropertyValue(name);
    if (value !== "" && value !== there && (there === LENT.get(name) || getComputedStyle(root).getPropertyValue(name).trim() === "")) {
      root.style.setProperty(name, value);
      LENT.set(name, value);
    }
  }
}

/** See {@link dress}: what was lent to the root, so it is not taken for the person's own choice and copied back. */
const LENT = new Map<string, string>();
