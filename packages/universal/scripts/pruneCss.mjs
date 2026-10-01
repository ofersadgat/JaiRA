/**
 * `styles.css`, held to what still reads it (decision 0015).
 *
 *   npm --workspace @jaira/universal run css             rewrite it, dropping every rule nothing can match
 *   npm --workspace @jaira/universal run css -- --check  fail if it holds such a rule (and say which)
 *   npm --workspace @jaira/universal run css -- --list   say what a rewrite would drop, and change nothing
 *
 * The stylesheet was the desktop's DOM renderer's, nineteen thousand lines of it, and that renderer is
 * gone: the universal tree draws every room from the tokens `tokens.mjs` reads out of this file. What is
 * left to style with it is the ISLANDS — the eight DOM components the universal tree hosts rather than
 * copies (`packages/app/src/renderer/*.tsx`), which on web stand inside `[data-island]` with this sheet
 * scoped to them (`islands/islandStyles.ts`) and on a phone each on a page of its own that imports it
 * whole (`packages/client/island/host.tsx`).
 *
 * So a rule stays when one of two readers needs it:
 *
 *  - `tokens.mjs`: a top-level rule whose selector it classifies (`:root…`, `:root… .scope`, `.scope`)
 *    and that declares custom properties. Kept with those declarations, in place and in order — the
 *    generated `cssTokens.generated.ts` must come out byte for byte the same, and this script runs
 *    `tokens.mjs --check` after writing and puts the file back if it does not. Where nothing in an island
 *    can match such a rule (`.sidebar`'s own palette, a pill's colours), its other declarations go:
 *    native replays the variables, and nobody draws with the rest.
 *  - an island: a rule with a selector that CAN match in the markup the island components and their
 *    libraries produce. "Can" is decided by the names in the selector, not by running anything: every
 *    class a selector requires (outside `:not()`; any one branch of `:is()`/`:where()`) must be one an
 *    island can carry — {@link CLASSES} and {@link PREFIXES}, or for Monaco's own markup
 *    {@link COLLISIONS}. Elements, attributes and pseudo-classes are never grounds to drop: `button`,
 *    `pre`, `*`, `::-webkit-scrollbar` and `:root[data-palette="ink"]` all reach an island. A rule that
 *    cannot match cannot have been overriding one that does, so nothing an island draws moves when it
 *    goes.
 *
 * Of a kept rule's selector list, the selectors that cannot match go too. `@media` and `@container` stay
 * while they hold a kept rule, `@keyframes` while a kept declaration names it, `@font-face` always (an
 * island page has no other source of the two faces). A comment goes with the rule or declaration it
 * stands before.
 *
 * Adding a class to an island component means adding it to {@link CLASSES} — `--check` does not know
 * the components, only this list — and its rule to the stylesheet.
 *
 * `postcss` is not a dependency of this package: it is in the tree through Vite, which every build here
 * runs on, and this script is run by hand.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

const CSS = fileURLToPath(new URL("../../app/src/renderer/styles.css", import.meta.url));
const TOKENS = fileURLToPath(new URL("./tokens.mjs", import.meta.url));

/**
 * The classes an island's own markup carries, by who writes them. Read off the components
 * (`packages/app/src/renderer/*.tsx`), their hosts (`islands/Island.tsx`, `client/island/*.tsx`) and the
 * ancestors a host stands an island under (`IslandProps.under`).
 */
const CLASSES = new Set([
  // The hosts: the band an editor fills, and the value view's boxes a reading or a frame stands in
  // (`Island.tsx`'s `.file-edit`; `ValueView.tsx`'s FENCE_UNDER and READING_UNDER; `client/island/artifact.tsx`).
  "file-edit", "vv", "vv-inline", "vv-body",
  // `markdown.tsx`: the reading, its front matter, a fenced block a renderer drew.
  "markdown", "md-front", "md-front-body", "md-block", "code-line", "tok",
  // `markdownEditor.tsx` (CodeMirror: its own classes are the `cm-` prefix): the editor's box, its
  // palette (`editorThemes.ts`'s `editorPaint`), a fence with no renderer.
  "md-editor", "read-only", "ed-app", "ed-themed", "vv-source",
  // `schemaEditor.tsx`: the two layers, the hints, the caret's slot, and the completion list — a
  // `Popover` (`popover.tsx`: `.float`, in `<body>`).
  "schema-edit", "schema-main", "editor-stack", "wrap", "code-layer", "highlight", "code-input", "line-hint-slot", "line-hint",
  "caret-slot", "caret-anchor", "completion-ghost", "float", "completions", "completions-head", "completions-more", "completion-key",
  "completion-type", "sub", "ellip", "on", "star",
  // `monacoDiff.tsx`: Monaco's host, the code view's plain text and Shiki's (`<pre class="shiki"><span class="line">`).
  "monaco-host", "monaco-fit", "code-text", "code-shiki", "shiki", "line",
  // `htmlFrame.tsx`, `interactiveArtifact.tsx`: the frame.
  "vv-html",
]);

/** Families an island's markup carries: CodeMirror's classes, a token's kind, a fence's language, Monaco's own. */
const PREFIXES = ["cm-", "tok-", "language-", "monaco-", "mtk"];

/**
 * What Monaco's own elements can be reached by, inside its host: its prefixed classes, the boxes its host
 * stands in, and {@link COLLISIONS}.
 */
const MONACO_PREFIXES = ["monaco-", "mtk"];
const MONACO_HOSTS = new Set(["file-edit", "vv", "vv-inline", "vv-body", "markdown", "md-block", "monaco-host", "monaco-fit"]);

/**
 * Names Monaco gives its own elements that this stylesheet ALSO uses as classes of the page that is gone:
 * the peek view and the parameter hints have a `.body`, a hover's status bar its `.actions`, the colour
 * picker a `.strip`. A rule on such a name alone has always reached those widgets, by accident, and is
 * kept so that they are drawn as they were — this script removes what nothing can match, and does not
 * decide what an editor should look like. Emptying this set and running the script is how to take the
 * accidents out, once somebody has looked at those widgets with and without them.
 *
 * From Monaco's stylesheets (every `.css` under `monaco-editor/esm`) and the class names its code sets
 * (`classList.add("idle")`), intersected with the classes this file selects by.
 */
const COLLISIONS = new Set([
  "actions", "active", "arrow", "body", "clickable", "count", "debug", "detail", "done", "drop-target", "editor", "empty", "error",
  "file-path", "highlight", "horizontal", "idle", "inline", "primary", "selected", "strip", "wide",
]);

/** The two kinds of markup in an island: the components' own (CodeMirror's with it), and Monaco's inside its host. */
const OURS = (name) => CLASSES.has(name) || PREFIXES.some((p) => name.startsWith(p));
const MONACOS = (name) => COLLISIONS.has(name) || MONACO_HOSTS.has(name) || MONACO_PREFIXES.some((p) => name.startsWith(p));

/** Split on top-level commas: not those inside `:is(…)`, `[…]` or a string. */
function split(list) {
  const out = [];
  let depth = 0;
  let from = 0;
  let quote = "";
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (quote !== "") {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(list.slice(from, i).trim());
      from = i + 1;
    }
  }
  out.push(list.slice(from).trim());
  return out;
}

const IDENT = /^-?[_a-zA-Z][\w-]*/;

/** Whether `selector` can match in an island: every class it requires is one that kind of markup carries. */
const canMatch = (selector) => matches(selector, OURS) || matches(selector, MONACOS);

function matches(selector, carried) {
  for (let i = 0; i < selector.length; ) {
    const c = selector[i];
    if (c === "\\") i += 2;
    else if (c === '"' || c === "'") {
      for (i++; i < selector.length && selector[i] !== c; i++) if (selector[i] === "\\") i++;
      i++;
    } else if (c === "[") {
      // An attribute is never grounds to drop; its value may hold a dot.
      let quote = "";
      for (i++; i < selector.length && (quote !== "" || selector[i] !== "]"); i++) {
        if (quote !== "") {
          if (selector[i] === "\\") i++;
          else if (selector[i] === quote) quote = "";
        } else if (selector[i] === '"' || selector[i] === "'") quote = selector[i];
      }
      i++;
    } else if (c === "." || c === "#") {
      const name = IDENT.exec(selector.slice(i + 1))?.[0];
      if (name === undefined) throw new Error(`cannot read the selector ${selector}`);
      // No island element has an id of the stylesheet's (it selects by none today).
      if (c === "#" || !carried(name)) return false;
      i += 1 + name.length;
    } else if (c === ":") {
      const colons = selector[i + 1] === ":" ? 2 : 1;
      const name = IDENT.exec(selector.slice(i + colons))?.[0] ?? "";
      i += colons + name.length;
      if (selector[i] !== "(") continue;
      let depth = 0;
      const open = i;
      for (; i < selector.length; i++) {
        if (selector[i] === "(") depth++;
        else if (selector[i] === ")" && --depth === 0) break;
      }
      const inside = selector.slice(open + 1, i);
      i++;
      // One branch that can match is enough; `:not()` requires nothing, and the rest take no selector.
      if (name === "is" || name === "where" || name === "has") {
        if (!split(inside).some((branch) => matches(branch.replace(/^[>+~]\s*/, ""), carried))) return false;
      }
    } else i++;
  }
  return true;
}

// `tokens.mjs`'s own test of a selector it keeps a block for: the two shapes, as it reads them.
const ROOT = /^:root((?:\[data-(?:theme|palette)(?:="[\w-]+")?\]|:is\((?:\s*\[data-palette="[\w-]+"\]\s*,?)+\))*)(?:\s+\.([\w-]+))?$/;
function tokenBlock(selector) {
  if (/^\.([\w-]+)$/.test(selector)) return true;
  const m = ROOT.exec(selector);
  return m !== null && !(/\[data-theme=/.test(m[1] ?? "") && !/\[data-theme="dark"\]/.test(m[1] ?? ""));
}

const isVariable = (node) => node.type === "decl" && node.prop.startsWith("--");

/** Remove `node` and the comments standing before it (a run of them belongs to what follows). */
function drop(node) {
  for (let before = node.prev(); before !== undefined && before.type === "comment"; before = node.prev()) before.remove();
  node.remove();
}

/** What `rule` comes to: "keep", "tokens" (its variables alone), or "drop" — and the selectors that stay. */
function verdict(rule) {
  const selectors = split(rule.selector.replace(/\/\*[\s\S]*?\*\//g, ""));
  const matching = selectors.filter(canMatch);
  const variables = rule.parent.type === "root" && rule.nodes.some(isVariable);
  const blocks = variables ? selectors.filter(tokenBlock) : [];
  if (matching.length > 0) return { what: "keep", selectors: selectors.filter((s) => matching.includes(s) || blocks.includes(s)) };
  if (blocks.length > 0) return { what: "tokens", selectors };
  return { what: "drop", selectors: [] };
}

function prune(css) {
  const root = postcss.parse(css);
  const dropped = [];
  const said = (rule, what) => dropped.push(`${rule.source.start.line}: ${what} ${rule.selector.replace(/\s+/g, " ")}`);
  const visit = (container) => {
    for (const node of [...container.nodes]) {
      if (node.type === "rule") {
        const v = verdict(node);
        if (v.what === "drop") {
          said(node, "rule");
          drop(node);
        } else if (v.what === "tokens") {
          const others = node.nodes.filter((n) => n.type === "decl" && !isVariable(n));
          if (others.length > 0) said(node, `${others.length} declaration(s) of the token block`);
          for (const decl of others) drop(decl);
        } else if (v.selectors.length < split(node.selector).length) {
          said(node, `${split(node.selector).length - v.selectors.length} selector(s) of`);
          node.selectors = v.selectors;
        }
      } else if (node.type === "atrule" && ["media", "container", "supports", "layer"].includes(node.name) && node.nodes !== undefined) {
        visit(node);
        if (!node.nodes.some((n) => n.type !== "comment")) drop(node);
      }
    }
  };
  visit(root);
  // Keyframes nothing kept animates with.
  const animated = new Set();
  root.walkDecls(/^animation(-name)?$/, (decl) => {
    for (const word of decl.value.split(/[\s,]+/)) animated.add(word);
  });
  root.walkAtRules(/keyframes$/, (at) => {
    if (animated.has(at.params.trim())) return;
    dropped.push(`${at.source.start.line}: @keyframes ${at.params}`);
    drop(at);
  });
  return { css: root.toString(), dropped };
}

const before = readFileSync(CSS, "utf8");
const { css: after, dropped } = prune(before);
const lines = (text) => text.split("\n").length - 1;

if (process.argv.includes("--list") || process.argv.includes("--check")) {
  for (const line of dropped) console.log(line);
  console.log(`${dropped.length} to drop; ${lines(before)} lines would be ${lines(after)}`);
  if (process.argv.includes("--check") && dropped.length > 0) {
    console.error("packages/app/src/renderer/styles.css holds rules nothing can match: run `npm --workspace @jaira/universal run css`, or name the island's class in scripts/pruneCss.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(CSS, after);
  try {
    execFileSync(process.execPath, [TOKENS, "--check"], { stdio: "inherit" });
  } catch {
    writeFileSync(CSS, before);
    console.error("the tokens would have changed: styles.css is put back as it was");
    process.exit(1);
  }
  console.log(`${dropped.length} dropped; ${lines(before)} lines → ${lines(after)}`);
}
