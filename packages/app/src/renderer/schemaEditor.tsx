/**
 * A JSON editor that knows what the document is supposed to be — the part of it that is typed INTO.
 *
 * Hand-editing JSON against a format you half-remember is the problem this solves, and it solves it
 * from one schema: the document is checked as you type, missing fields can be filled in, the keys
 * legal at the cursor are offered and completable from the keyboard, and every key carries its own
 * description at the end of its line. Picking a schema turns all of that on; without one this is
 * still a colourised editor, which is the right floor for the many `.json` files that answer to no
 * schema at all.
 *
 * The bar, the picker, the verdict and the field reference round it are the universal tree's
 * (`packages/universal/src/components/files/SchemaEdit.tsx`, decision 0015); this file is the island
 * they host: the coloured layer, the textarea over it, and the completion list at the caret.
 *
 * ## The colour is a layer behind a transparent textarea
 *
 * The usual trick, and the usual trap. A `<pre>` renders the coloured tokens; the textarea sits on
 * top with `color: transparent` and a visible caret, so all the editing behaviour — selection, undo,
 * IME, spellcheck-off, native scrolling — is the browser's and none of it is reimplemented. The
 * price is that the two must lay text out IDENTICALLY: same font, padding, border, line-height and
 * tab-size, scroll offsets synchronised on both axes, and the same width to wrap in — which means
 * the layer has to reserve the scrollbar gutter the textarea takes and it does not.
 *
 * Word wrap is a toggle, and it took one trick to make it safe. The end-of-line hints make the
 * coloured layer's lines longer than the textarea's, and under soft wrap a longer line breaks
 * sooner — which would push every line below it out of alignment. So a hint is rendered inside a
 * ZERO-WIDTH box that overflows to the right (`.line-hint-slot`): it is visible, but it occupies no
 * space in the flow and therefore cannot influence where anything breaks. With that, both layers
 * wrap identically and the toggle just switches `white-space` on both at once.
 *
 * ## The completion UI rides on the aligned layer
 *
 * Because the coloured `<pre>` lays text out identically to the textarea, a zero-width marker placed
 * at the cursor IN THAT LAYER sits exactly where the caret is. Measuring it is how the dropdown knows
 * where to open — no mirrored copy of the textarea, no font metrics, no drift. The same marker
 * carries the inline ghost of what Tab would write.
 *
 * ## YAML is the same editor
 *
 * A Compose file or a GitLab pipeline has a schema as surely as a state does, and the value a schema
 * describes does not care which syntax spelled it. So `format: "yaml"` swaps the scanner that colours
 * the layer (`highlightYaml`, which takes the same per-key hints), and the rest is unchanged.
 * Completion at the cursor stays JSON's for now: `cursorContext` reads braces and quotes, and YAML has
 * neither.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import {
  propertiesOf,
  schemaById,
  withMissingFields,
  type SchemaEntry,
  type SchemaFormat,
  type SchemaProperty,
} from "@jaira/shared/browser";
import { Popover } from "./popover";
import { editorPaint } from "./editorThemes";
import { viewTheme } from "./fileTypes";
import { useRenderChoice } from "./renderChoice";
import { cursorContext, siblingKeys } from "./jsonCursor";
import { highlightJson, splitTokensAt, type HighlightLine, type Token } from "./jsonHighlight";
import { highlightYaml } from "./yamlHighlight";

/** What one Tab inserts. A literal tab, rendered two columns wide by the editor's `tab-size`. */
const INDENT = "\t";

/** Longest hint shown at the end of a line, before it is clipped. */
const HINT_LIMIT = 72;

/** Most completions listed at once. Beyond this the list is a wall rather than a menu. */
const MENU_LIMIT = 10;

/** Replace a span of the document through the editor's own editing path — see `SchemaTextStack`'s `splice`. */
export type SchemaSplice = (from: number, to: number, inserted: string) => void;

/**
 * The editor itself: the coloured layer, the textarea over it, and the completion list at the caret —
 * everything of the schema editor that is typed INTO, apart from the bar, the verdict and the
 * reference around it. Its own component so the universal tree (decision 0015) hosts exactly this
 * as an island, inside native chrome (a fragment: `.schema-main` holds the stack, then the list).
 *
 * `edit` is handed the stack's `splice`, for the one edit the bar makes ("Add missing fields"): through
 * the textarea's own pipeline, so it stays one undoable step.
 */
export function SchemaTextStack({
  text,
  onChange,
  readOnly,
  wrapping,
  entry,
  format,
  edit,
}: {
  text: string;
  onChange: (text: string) => void;
  readOnly: boolean;
  wrapping: boolean;
  entry: SchemaEntry | undefined;
  format: SchemaFormat;
  edit?: { current: SchemaSplice | null } | undefined;
}): JSX.Element {
  const area = useRef<HTMLTextAreaElement | null>(null);
  const layer = useRef<HTMLPreElement | null>(null);
  /** A zero-width span rendered at the cursor inside the coloured layer — the dropdown's ruler. */
  const anchor = useRef<HTMLSpanElement | null>(null);
  const [cursor, setCursor] = useState(0);
  /** Which suggestion the keyboard has selected. Reset whenever the list changes. */
  const [highlighted, setHighlighted] = useState(0);
  /** Escape hides the list until the next edit — a way to see the line under it. */
  const [dismissed, setDismissed] = useState(false);

  /**
   * What each key means, by the path it sits at.
   *
   * Cached per path: the highlighter asks once per key, and a document with fifty keys in the same
   * block would otherwise rebuild that block's property list fifty times.
   */
  const describe = useMemo(() => {
    if (entry === undefined) return undefined;
    const cache = new Map<string, Map<string, string | undefined>>();
    return (path: string[], key: string): string | undefined => {
      const at = path.join(".");
      let block = cache.get(at);
      if (block === undefined) {
        // One line, whatever the schema wrote: a hint is drawn in a zero-width slot at the end of its
        // line, and a published description's line breaks (tsconfig's have several) would spill it
        // onto the lines below, over the text.
        block = new Map(propertiesOf(entry, path).map((p) => [p.key, p.description?.replace(/\s+/g, " ").trim()]));
        cache.set(at, block);
      }
      return block.get(key);
    };
  }, [entry]);

  const lines: HighlightLine[] = useMemo(
    () => (format === "yaml" ? highlightYaml(text, describe) : highlightJson(text, describe)),
    [format, text, describe],
  );

  /** Where the cursor is, and therefore what may be written there. JSON's syntax only — see above. */
  const context = useMemo(
    () => (entry && format === "json" ? cursorContext(text, cursor) : null),
    [entry, format, text, cursor],
  );

  /** The cursor as a (line, column) pair, for placing the marker in the coloured layer. */
  const at = useMemo(() => {
    const before = text.slice(0, cursor);
    const line = before.split("\n").length - 1;
    return { line, column: cursor - (before.lastIndexOf("\n") + 1) };
  }, [text, cursor]);

  const suggestions: SchemaProperty[] = useMemo(() => {
    // `quoted`, not just `inKeyPosition`: see `CursorContext.quoted`. Without it the menu opens on
    // every blank line inside an object, and takes the arrow keys with it.
    if (entry === undefined || context === null || !context.inKeyPosition || !context.quoted || dismissed) {
      return [];
    }
    const present = new Set(siblingKeys(text, cursor));
    const partial = context.partial.toLowerCase();
    return (
      propertiesOf(entry, context.path)
        .filter((property) => !present.has(property.key))
        .filter((property) => property.key.toLowerCase().startsWith(partial))
        // Required-after-merge first. Everything else keeps declaration order, which is the order
        // WORKFLOWS.md lists the fields in — so the list reads like the documentation.
        .sort((a, b) => Number(b.expected) - Number(a.expected))
    );
  }, [entry, context, text, cursor, dismissed]);

  /**
   * What Tab would add, shown ghosted at the cursor.
   *
   * Two conditions, both about not lying. The typed text must be a PREFIX of what would be inserted
   * — an unquoted `mod` becomes `"model": `, which rewrites rather than extends it, so there is no
   * honest way to draw that inline. And nothing may follow the cursor on the line: the ghost takes no
   * width (it cannot, or it would push the coloured layer out of step with the textarea), so anything
   * after it would be painted over.
   */
  const ghost = useMemo((): string | null => {
    if (context === null || suggestions.length === 0) return null;
    const key = suggestions[highlighted]?.key;
    if (key === undefined) return null;
    const typed = text.slice(context.partialStart, cursor);
    const insertion = `"${key}": `;
    if (!insertion.startsWith(typed)) return null;
    const lineEnd = text.indexOf("\n", cursor);
    const rest = lineEnd === -1 ? text.slice(cursor) : text.slice(cursor, lineEnd);
    if (rest.trim().length > 0) return null;
    return insertion.slice(typed.length);
  }, [context, suggestions, highlighted, text, cursor]);

  // A changed list invalidates the selection: index 3 of the old list is not index 3 of the new one.
  useEffect(() => {
    setHighlighted(0);
  }, [suggestions.length, context?.path.join("."), context?.partial]);

  const track = useCallback(() => {
    const element = area.current;
    if (element) setCursor(element.selectionStart);
  }, []);

  /**
   * Reserve the textarea's scrollbar gutter on the coloured layer.
   *
   * The one metric the two layers cannot share by writing it once in the stylesheet. The textarea
   * scrolls and so takes a scrollbar out of its content box; the layer behind it has
   * `overflow: hidden` and never does. That difference is invisible until word wrap is on, at which
   * point the textarea breaks its lines a couple of columns earlier than the layer draws them — the
   * caret is the textarea's and the text is the layer's, so they stop agreeing about which character
   * is under the cursor, and the disagreement compounds with every wrapped row.
   *
   * Measured rather than assumed: a scrollbar is 15px, or 17, or 0 where the platform overlays them.
   * `ResizeObserver` watches the CONTENT box, so it fires on the one event that matters and is
   * otherwise hard to catch — a document growing tall enough that the scrollbar appears mid-keystroke
   * and re-wraps the line being typed into.
   */
  useLayoutEffect(() => {
    const element = area.current;
    const behind = layer.current;
    if (element === null || behind === null) return;
    // `border: 0` on both, so the difference is the scrollbar and nothing else.
    const measure = (): void =>
      behind.style.setProperty("--gutter", `${element.offsetWidth - element.clientWidth}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** Keep the coloured layer under the text, on both axes. The dropdown follows by itself: it is a float anchored to the marker. */
  const syncScroll = useCallback(() => {
    const element = area.current;
    const behind = layer.current;
    if (!element || !behind) return;
    behind.scrollTop = element.scrollTop;
    behind.scrollLeft = element.scrollLeft;
  }, []);

  /**
   * Replace a span of the document — through the browser's own editing pipeline.
   *
   * `execCommand("insertText")` rather than a React state update, and this is the whole reason undo
   * works. Assigning a textarea's `value` — which is what setting state and re-rendering does —
   * replaces the element's content as far as the browser is concerned and DISCARDS its undo history.
   * Every programmatic edit here (accepting a completion, indenting, filling in missing fields)
   * would therefore be a point of no return, and would take the user's own typing down with it.
   * Going through `insertText` records each one as an ordinary edit, so Ctrl+Z steps back through
   * them exactly as it steps back through typing, and Ctrl+Shift+Z steps forward again.
   *
   * The command is deprecated but has no replacement for this, is universally implemented, and this
   * is Chromium. The fallback is the state update it exists to avoid: undo is lost for that one
   * edit, which is better than the edit not happening.
   */
  const splice = useCallback(
    (from: number, to: number, inserted: string): void => {
      const element = area.current;
      if (element === null) return;
      element.focus();
      element.setSelectionRange(from, to);
      if (document.execCommand("insertText", false, inserted)) return;

      const caret = from + inserted.length;
      onChange(`${text.slice(0, from)}${inserted}${text.slice(to)}`);
      requestAnimationFrame(() => {
        const target = area.current;
        if (!target) return;
        target.focus();
        target.setSelectionRange(caret, caret);
        setCursor(caret);
      });
    },
    [text, onChange],
  );

  /**
   * Write a suggested key at the cursor.
   *
   * Replaces whatever partial name was already there — typing `mod` and accepting `model` must not
   * leave `modmodel` — and always writes the quotes and the colon, because those are the characters
   * a completion exists to save you.
   */
  const accept = useCallback(
    (key: string): void => {
      if (context === null) return;
      splice(context.partialStart, cursor, `"${key}": `);
    },
    [context, cursor, splice],
  );

  /**
   * The only keys this editor takes from the textarea.
   *
   * **Tab accepts a completion** when one is on offer — which is only ever inside an object key,
   * since that is the one place a property name belongs. With no list open it indents, because a Tab
   * that moved focus out of a code editor is never what anyone meant.
   *
   * **Enter is left alone, always.** It was briefly the accept key and that was wrong: typing `{`
   * puts the cursor in a key position with every property on offer, so Enter — the obvious way to
   * open a line there — would have written a field name instead of a newline.
   *
   * Everything else falls through untouched, which is what keeps Ctrl+Z, Ctrl+Shift+Z, Home/End and
   * the rest working: they belong to the browser, and it is better at them than this would be.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const element = event.currentTarget;

    if (suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlighted((i) => (i + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlighted((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
      if (event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        accept(suggestions[highlighted]!.key);
        return;
      }
    }

    if (event.key === "Tab") {
      event.preventDefault();
      const { selectionStart, selectionEnd } = element;
      if (selectionStart === selectionEnd && !event.shiftKey) {
        splice(selectionStart, selectionEnd, INDENT);
        return;
      }
      // A selection indents or outdents whole lines, which is what Tab means once more than a caret
      // is involved. The span is widened to the start of the first line so the first one moves too.
      const from = text.lastIndexOf("\n", selectionStart - 1) + 1;
      const block = text.slice(from, selectionEnd);
      const shifted = event.shiftKey ? block.replace(/^(\t| {1,2})/gm, "") : block.replace(/^/gm, INDENT);
      if (shifted === block) return;
      splice(from, selectionEnd, shifted);
      requestAnimationFrame(() => {
        const target = area.current;
        if (!target) return;
        target.setSelectionRange(from, from + shifted.length);
      });
    }
  };

  if (edit !== undefined) edit.current = splice;

  /** The marker is only worth rendering when something is anchored to it. */
  const showMarker = suggestions.length > 0;

  /**
   * What sits at the cursor inside the coloured layer: the dropdown's anchor, and the ghost.
   *
   * Both live in a zero-width slot. That is not decoration — a marker with width would shift every
   * character after it in the coloured layer while leaving the textarea alone, which is precisely the
   * drift the whole two-layer design exists to avoid.
   */
  const marker = showMarker ? (
    <span className="caret-slot" key="caret">
      <span className="caret-anchor" ref={anchor} />
      {ghost !== null ? <span className="completion-ghost">{ghost}</span> : null}
    </span>
  ) : null;

  return (
    <>
      <div className={`editor-stack${wrapping ? " wrap" : ""}`}>
        {/* Behind the text, and never interactive: it is a rendering of the same characters. */}
        <pre className="code-layer highlight" ref={layer} aria-hidden="true">
          {lines.map((line, i) => (
            <span className="code-line" key={i}>
              {renderTokens(line, i === at.line && showMarker ? at.column : -1, marker)}
              {line.hint !== undefined ? (
                // The slot takes no width, so the hint cannot change where this line breaks. That is
                // what lets word wrap be offered at all — see `.line-hint-slot`.
                <span className="line-hint-slot">
                  <span className="line-hint">
                    {line.hint.length > HINT_LIMIT ? `${line.hint.slice(0, HINT_LIMIT)}…` : line.hint}
                  </span>
                </span>
              ) : null}
              {"\n"}
            </span>
          ))}
        </pre>
        <textarea
          ref={area}
          className="code-layer code-input"
          spellCheck={false}
          // A reading. `readOnly` rather than `disabled`: the caret, the selection and the scroll
          // still work, which is the difference between a document you may read and one you may not
          // reach into at all.
          readOnly={readOnly}
          // The attribute AND the stylesheet: `wrap` decides what a submitted value contains and
          // whether the box scrolls sideways, `white-space` decides how the coloured layer behind it
          // breaks. Setting only one of them is how the two layers end up disagreeing.
          wrap={wrapping ? "soft" : "off"}
          value={text}
          onChange={(e) => {
            onChange(e.target.value);
            setCursor(e.target.selectionStart);
            setDismissed(false);
          }}
          {...(readOnly ? {} : { onKeyDown })}
          onKeyUp={track}
          onClick={track}
          onSelect={track}
          onScroll={syncScroll}
        />
      </div>

      {/*
        * Under the caret, by the marker sitting there: the marker is inside the coloured layer, which
        * lays text out identically to the textarea, so its rect IS the caret's position — no font
        * metrics, no mirrored copy. A float, so the editor's own `overflow` cannot cut the list off at
        * its bottom edge, which is exactly where a caret near the end of a document puts it; above the
        * caret when the window has no room below; hidden while the caret is scrolled out of the editor,
        * because a menu pointing at a caret nobody can see is worse than no menu.
        */}
      {showMarker ? (
          <Popover anchor={anchor} side="below" align="start" gap={2} className="completions">
            <div className="completions-head sub">
              <span className="ellip">
                {context !== null && context.path.length > 0 ? `inside ${context.path.join(".")}` : "at the top level"}
              </span>
              <span>tab ⇥</span>
            </div>
            <ul>
              {suggestions.slice(0, MENU_LIMIT).map((property, i) => (
                <li
                  key={property.key}
                  className={i === highlighted ? "on" : undefined}
                  // `onMouseDown` rather than `onClick`: a click blurs the textarea first, and the
                  // selection this reads from is gone by the time the handler runs.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    accept(property.key);
                  }}
                  onMouseEnter={() => setHighlighted(i)}
                >
                  <code className="completion-key">
                    {property.expected ? <span className="star">★</span> : null}
                    {property.key}
                  </code>
                  {property.type ? <span className="sub completion-type">{property.type}</span> : null}
                  {property.description ? <span className="sub ellip">{property.description}</span> : null}
                </li>
              ))}
            </ul>
          {suggestions.length > MENU_LIMIT ? (
            <div className="completions-more sub">+{suggestions.length - MENU_LIMIT} more — keep typing</div>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}

/**
 * {@link SchemaTextStack} on its own, for a host that draws the chrome itself — the universal tree's
 * island (decision 0015), in a WebView on a phone and inline on web. It gives the stack what it needs
 * beside the text: the palette on the element the mapping reads, and "Add missing fields" as a count
 * the host bumps (`fill`), made through the stack's own path so it is one undoable step.
 *
 * The text is held here as well as by the host. The textarea is controlled, and the host's copy comes
 * back over a bridge: typing into a box whose value is a round trip behind would lose characters.
 */
export function SchemaTextField({
  text,
  onChange,
  readOnly,
  wrap,
  schemaId,
  format,
  mime,
  fill,
}: {
  text: string;
  onChange: (text: string) => void;
  readOnly: boolean;
  wrap: boolean;
  schemaId: string | null;
  format: SchemaFormat;
  mime?: string | undefined;
  fill: number;
}): JSX.Element {
  const [local, setLocal] = useState(text);
  useEffect(() => setLocal(text), [text]);
  const chosen = useRenderChoice();
  const edit = useRef<SchemaSplice | null>(null);
  const entry = schemaId === null ? undefined : schemaById(schemaId);
  const filled = useRef(fill);
  useEffect(() => {
    if (fill === filled.current) return;
    filled.current = fill;
    if (entry === undefined) return;
    const next = withMissingFields(entry, local, format);
    if (next !== local) edit.current?.(0, local.length, next);
    // Only a new count asks; the text it reads is the one on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fill]);
  const paint = editorPaint(viewTheme(mime ?? "application/json", "text", readOnly ? "read" : "write", chosen));
  return (
    <div className={`schema-edit${paint === null ? "" : ` ${paint.className}`}`} style={{ ...paint?.style, height: "100%" }}>
      <div className="schema-main" style={{ height: "100%" }}>
        <SchemaTextStack
          text={local}
          onChange={(next) => {
            setLocal(next);
            onChange(next);
          }}
          readOnly={readOnly}
          wrapping={wrap}
          entry={entry}
          format={format}
          edit={edit}
        />
      </div>
    </div>
  );
}

/**
 * One line, as coloured spans, with the caret marker spliced in where it belongs.
 *
 * The arithmetic lives in {@link splitTokensAt} — this only turns the two halves into elements. That
 * split is the part worth getting right and worth testing, and it has nothing to do with React.
 *
 * `column` of -1 means this is not the cursor's line.
 */
function renderTokens(line: HighlightLine, column: number, marker: JSX.Element | null): JSX.Element[] {
  const paint = (tokens: Token[], side: string): JSX.Element[] =>
    tokens.map((token, j) => (
      <span key={`${side}${j}`} className={`tok tok-${token.kind}`}>
        {token.text}
      </span>
    ));

  if (marker === null || column < 0) return paint([...line.tokens], "t");

  const { before, after } = splitTokensAt(line.tokens, column);
  return [...paint(before, "a"), marker, ...paint(after, "b")];
}

