/**
 * A JSON editor that knows what the document is supposed to be.
 *
 * Hand-editing JSON against a format you half-remember is the problem this solves, and it solves it
 * from one schema: the document is checked as you type, missing fields can be filled in, the keys
 * legal at the cursor are offered and completable from the keyboard, and every key carries its own
 * description at the end of its line. Picking a schema turns all of that on; without one this is
 * still a colourised editor, which is the right floor for the many `.json` files that answer to no
 * schema at all.
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
 * ## The checking happens in main
 *
 * ajv is a main-process dependency by design (see `service.validateSchema`), so the draft goes over
 * IPC to be checked. Debounced, because the answer to "is this valid?" is only interesting once you
 * have stopped typing — and because a round-trip per keystroke would put the panel a keystroke
 * behind the text, which reads as the validator being wrong rather than late.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from "react";
import {
  listSchemas,
  mergeSkeleton,
  propertiesOf,
  schemaById,
  type SchemaEntry,
  type SchemaProperty,
  type ValidateSchemaResult,
} from "@jaira/shared/browser";
import { EditorActions } from "./editorChrome";
import { cursorContext, siblingKeys } from "./jsonCursor";
import { highlightJson, splitTokensAt, type HighlightLine, type Token } from "./jsonHighlight";
import type { UiSurface } from "./fileTypes";
import { Splitter } from "./splitter";
import { FOLD, PANE, paneDefault } from "./uiState";

/** How long to wait after the last keystroke before asking main to check the draft. */
const VALIDATE_DEBOUNCE_MS = 300;

/** What one Tab inserts. A literal tab, rendered two columns wide by the editor's `tab-size`. */
const INDENT = "\t";

/** Longest hint shown at the end of a line, before it is clipped. */
const HINT_LIMIT = 72;

/** Most completions listed at once. Beyond this the list is a wall rather than a menu. */
const MENU_LIMIT = 10;

/** The menu's own box, as the placement maths assumes it. Kept in step with `.completions` in CSS. */
const MENU_WIDTH = 260;
const MENU_HEIGHT = 190;

export interface SchemaJsonEditorProps {
  text: string;
  busy: boolean;
  onChange: (text: string) => void;
  /** Absent on a surface that saves some other way — the workflow editor's JSON tab owns its own. */
  onSave?: (() => void) | undefined;
  /** Dirty state, when the host tracks it. Controls the Save button only. */
  dirty?: boolean;
  onRevert?: (() => void) | undefined;
  /** Check a draft against a schema. Supplied by the store, which owns the IPC. */
  validate: (schemaId: string, text: string) => Promise<ValidateSchemaResult | null>;
  /** The schema chosen for this document, and how to remember a change. */
  schemaId: string | null;
  onSchema: (schemaId: string | null) => void;
  /**
   * Word wrap, and where the preference is kept.
   *
   * Controlled when both are supplied — the app stores it in `user-settings.json`, so it survives a
   * restart — and falls back to local state otherwise, which keeps the component usable anywhere.
   */
  wrap?: boolean;
  onWrap?: ((wrap: boolean) => void) | undefined;
  /**
   * The field reference beside the editor: whether it is showing, how wide it is, and where those
   * two are kept.
   *
   * Controlled or local on the same terms as {@link SchemaJsonEditorProps.wrap}. Worth remembering
   * for the reason any pane is: the reference is either something you work with or something you
   * never open, and re-deciding that on every file is the version of the question nobody wants.
   */
  reference?: boolean;
  onReference?: ((show: boolean) => void) | undefined;
  referenceWidth?: number;
  onReferenceWidth?: ((width: number) => void) | undefined;
  /** Extra controls for the host to place beside the picker. */
  children?: React.ReactNode;
}

/**
 * The four field-reference props, wired to the window's remembered layout.
 *
 * One helper rather than the same four lines at each call site: this editor is reached two ways —
 * directly for a `.json` file, and through the workflow editor's JSON tab — and the panel should not
 * be remembered on one and forgotten on the other. Returns nothing when there is no host to remember
 * through, which leaves the editor on its own state.
 */
export function schemaReferenceProps(
  ui: UiSurface | undefined,
): Pick<SchemaJsonEditorProps, "reference" | "onReference" | "referenceWidth" | "onReferenceWidth"> {
  if (ui === undefined) return {};
  return {
    reference: ui.open(FOLD.schemaReference, false),
    onReference: (show) => ui.setOpen(FOLD.schemaReference, show),
    referenceWidth: ui.pane(PANE.schemaReference, REFERENCE_WIDTH),
    onReferenceWidth: (width) => ui.setPane(PANE.schemaReference, width),
  };
}

export function SchemaJsonEditor({
  text,
  busy,
  onChange,
  onSave,
  dirty,
  onRevert,
  validate,
  schemaId,
  onSchema,
  wrap,
  onWrap,
  reference,
  onReference,
  referenceWidth,
  onReferenceWidth,
  children,
}: SchemaJsonEditorProps): JSX.Element {
  const area = useRef<HTMLTextAreaElement | null>(null);
  const layer = useRef<HTMLPreElement | null>(null);
  /** A zero-width span rendered at the cursor inside the coloured layer — the dropdown's ruler. */
  const anchor = useRef<HTMLSpanElement | null>(null);
  /** The whole editor. The menu is positioned against THIS rather than against the scrolling stack,
   *  which is what keeps `overflow: hidden` on the stack from clipping it. */
  const root = useRef<HTMLDivElement | null>(null);
  /** Where the dropdown sits, relative to the editor. Null until the anchor has been measured. */
  const [menuAt, setMenuAt] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const [result, setResult] = useState<ValidateSchemaResult | null>(null);
  const [cursor, setCursor] = useState(0);
  /** Used only when the host controls neither — see {@link SchemaJsonEditorProps.reference}. */
  const [localReference, setLocalReference] = useState(false);
  const [localReferenceWidth, setLocalReferenceWidth] = useState(REFERENCE_WIDTH);
  /** Which suggestion the keyboard has selected. Reset whenever the list changes. */
  const [highlighted, setHighlighted] = useState(0);
  /** Escape hides the list until the next edit — a way to see the line under it. */
  const [dismissed, setDismissed] = useState(false);
  /** Used only when the host does not control wrapping — see {@link SchemaJsonEditorProps.wrap}. */
  const [localWrap, setLocalWrap] = useState(false);

  const wrapping = wrap ?? localWrap;
  const setWrapping = (next: boolean): void => (onWrap ? onWrap(next) : setLocalWrap(next));

  const showReference = reference ?? localReference;
  const setShowReference = (next: boolean): void =>
    onReference ? onReference(next) : setLocalReference(next);
  const width = referenceWidth ?? localReferenceWidth;
  const setWidth = (next: number): void =>
    onReferenceWidth ? onReferenceWidth(next) : setLocalReferenceWidth(next);

  const entry = schemaId === null ? undefined : schemaById(schemaId);

  // Check the draft, once it has stopped moving. The cleanup cancels the pending check on every
  // keystroke, so only the last one in a burst is ever sent.
  useEffect(() => {
    if (entry === undefined) {
      setResult(null);
      return;
    }
    const timer = setTimeout(() => {
      void validate(entry.id, text).then(setResult);
    }, VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [entry, text, validate]);

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
        block = new Map(propertiesOf(entry, path).map((p) => [p.key, p.description]));
        cache.set(at, block);
      }
      return block.get(key);
    };
  }, [entry]);

  const lines: HighlightLine[] = useMemo(() => highlightJson(text, describe), [text, describe]);

  /** Where the cursor is, and therefore what may be written there. */
  const context = useMemo(() => (entry ? cursorContext(text, cursor) : null), [entry, text, cursor]);

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

  /**
   * Put the dropdown under the caret, by measuring the marker sitting there.
   *
   * The marker is inside the coloured layer, which lays text out identically to the textarea — so its
   * rect IS the caret's position, with no font metrics or mirrored copy involved.
   *
   * Two containers are read, and they do different jobs. The STACK decides visibility: a marker
   * scrolled out of the editor means the caret is off screen, and a menu pointing at a caret nobody
   * can see is worse than no menu. The ROOT decides coordinates, because the stack clips its overflow
   * — anchoring to it would cut the list off at the editor's bottom edge, which is exactly where a
   * caret near the end of a document puts it.
   */
  const placeMenu = useCallback(() => {
    const mark = anchor.current;
    const stack = mark?.closest(".editor-stack");
    const box = root.current;
    if (!mark || !stack || !box) {
      setMenuAt(null);
      return;
    }
    const markRect = mark.getBoundingClientRect();
    const stackRect = stack.getBoundingClientRect();
    if (
      markRect.bottom < stackRect.top ||
      markRect.top > stackRect.bottom ||
      markRect.left < stackRect.left - 1 ||
      markRect.left > stackRect.right
    ) {
      setMenuAt(null);
      return;
    }
    const boxRect = box.getBoundingClientRect();
    // Flip above the caret when the list would run off the bottom of the window.
    const above = markRect.bottom + MENU_HEIGHT > window.innerHeight;
    setMenuAt({
      left: Math.max(0, Math.min(markRect.left - boxRect.left, boxRect.width - MENU_WIDTH)),
      top: (above ? markRect.top : markRect.bottom) - boxRect.top,
      above,
    });
  }, []);

  // `useLayoutEffect` so the position is set before the browser paints — measuring in an ordinary
  // effect would show the menu at its previous spot for one frame, which reads as the menu lagging
  // the cursor rather than following it.
  useLayoutEffect(() => {
    if (suggestions.length === 0) {
      setMenuAt(null);
      return;
    }
    placeMenu();
  }, [suggestions, at.line, at.column, text, wrapping, lines, placeMenu]);

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

  /** Keep the coloured layer under the text, on both axes — and the dropdown under the caret. */
  const syncScroll = useCallback(() => {
    const element = area.current;
    const behind = layer.current;
    if (!element || !behind) return;
    behind.scrollTop = element.scrollTop;
    behind.scrollLeft = element.scrollLeft;
    // The marker moved with the layer, so anything anchored to it has to be re-measured.
    placeMenu();
  }, [placeMenu]);

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

  /** Add what the document is missing, leaving what it has exactly as it is. */
  const addMissing = (): void => {
    if (entry === undefined) return;
    let current: unknown = {};
    if (text.trim().length > 0) {
      try {
        current = JSON.parse(text);
      } catch {
        // Unreachable while the button is disabled on a parse error, but a merge into a document
        // that cannot be read would be a guess at what it holds — and guessing is what "merge"
        // exists to avoid.
        return;
      }
    }
    // Through `splice` over the whole document, so filling in the missing fields is one undoable
    // step rather than a silent replacement of everything the editor held.
    splice(0, text.length, `${JSON.stringify(mergeSkeleton(entry, current), null, 2)}\n`);
  };

  const parses = result?.parseError === undefined;

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
    <div className="file-edit schema-edit" ref={root}>
      {/* `edit-bar` is the row every editing surface opens with — see `editorChrome`. What is IN it
          differs (a schema picker here, a path and a tab switch on the state form); that it is one
          quiet line of chrome above the text, and never part of the document, does not. */}
      <div className="edit-bar schema-bar">
        <label className="schema-pick">
          <span className="sub">Schema</span>
          <select value={schemaId ?? ""} onChange={(e) => onSchema(e.target.value === "" ? null : e.target.value)}>
            <option value="">none — plain JSON</option>
            {listSchemas().map((option) => (
              <option key={option.id} value={option.id} title={option.hint}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {entry ? (
          <>
            {/* Merges rather than replaces, so it is safe on a document with content in it — which
                is when "what else belongs here?" is actually being asked. */}
            <button
              className="ghost"
              onClick={addMissing}
              disabled={busy || !parses}
              title={parses ? entry.hint : "fix the JSON first — a document that cannot be read cannot be merged into"}
            >
              Add missing fields
            </button>
            <button className="ghost" onClick={() => setShowReference(!showReference)}>
              {showReference ? "Hide fields" : "Fields"}
            </button>
            <SchemaStatus result={result} />
          </>
        ) : null}
        {/* Outside the schema branch: wrapping is about reading the text, and a plain `.json` file
            with no schema chosen has just as many long lines in it. */}
        <label className="toggle wrap-toggle" title="wrap long lines instead of scrolling sideways">
          <input type="checkbox" checked={wrapping} onChange={(e) => setWrapping(e.target.checked)} />
          <span className="sub">Wrap</span>
        </label>
        {children}
      </div>
      {entry ? <div className="sub schema-hint">{entry.hint}</div> : null}

      {/* Two COLUMNS when the reference is open, not two rows. The reference is a thing you read
          WHILE typing — "what else belongs in this block?" — and putting it under the editor meant
          scrolling away from the line that raised the question. */}
      <div
        className={`schema-body${showReference && entry ? " with-reference" : ""}`}
        style={{ "--reference-width": `${width}px` } as CSSProperties}
      >
        <div className="schema-main">
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
          onKeyDown={onKeyDown}
          onKeyUp={track}
          onClick={track}
          onSelect={track}
          onScroll={syncScroll}
        />
      </div>

      {showMarker && menuAt !== null ? (
          <div
            className={`completions${menuAt.above ? " above" : ""}`}
            style={{ left: menuAt.left, top: menuAt.top }}
          >
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
        </div>
      ) : null}


      {result?.parseError !== undefined ? (
        <div className="reason">not valid JSON: {result.parseError}</div>
      ) : (
        (result?.violations ?? []).map((violation, i) => (
          <div key={`${violation.path}-${i}`} className="notice bad violation">
            <b>{violation.path.length > 0 ? violation.path : "(root)"}</b> — {violation.message}
          </div>
        ))
      )}
        </div>

        {showReference && entry ? (
          <>
            <Splitter
              label="Resize the field reference"
              value={width}
              reset={REFERENCE_WIDTH}
              invert
              min={200}
              max={620}
              onChange={setWidth}
            />
            <SchemaReference entry={entry} />
          </>
        ) : null}
      </div>

      {onSave ? (
        <EditorActions dirty={dirty} busy={busy} onSave={onSave} onRevert={onRevert} />
      ) : null}
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

/** A one-glance verdict, so "is it valid?" does not require reading the list below. */
function SchemaStatus({ result }: { result: ValidateSchemaResult | null }): JSX.Element {
  if (result === null) return <span className="chip">checking…</span>;
  if (result.parseError !== undefined) return <span className="chip chip-bad">not JSON</span>;
  const count = result.violations.length;
  if (count === 0) return <span className="chip chip-ok">conforms</span>;
  return (
    <span className="chip chip-bad">
      {count} {count === 1 ? "problem" : "problems"}
    </span>
  );
}

/**
 * Every field the schema declares, expandable into the blocks they nest.
 *
 * The hints are `operationVocabulary`'s own — "route-prefixed", "an empty list drops the inherited
 * ones" — which is the whole argument for building these schemas from that table rather than beside
 * it. The same strings are what appear at the end of each line in the editor.
 *
 * It used to render the top level only, with a note suggesting you move the cursor into a block to
 * see inside it. That is a poor answer to "what can go in here?" — it makes reading the format
 * conditional on already editing it, and a slot's `schema` is three levels down from anywhere the
 * cursor usefully sits.
 */
function SchemaReference({ entry }: { entry: SchemaEntry }): JSX.Element {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (at: string): void =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(at)) next.delete(at);
      else next.add(at);
      return next;
    });

  return (
    <section className="schema-reference">
      <h4>{String(entry.document["title"] ?? entry.label)}</h4>
      <div className="sub">
        ★ marks what a complete document needs — required after the environment merge, never in the
        file itself.
      </div>
      <FieldList entry={entry} path={[]} open={open} onToggle={toggle} />
    </section>
  );
}

/**
 * How deep the panel will expand.
 *
 * A slot's `schema` refers to itself — `items` of `items` of `items` — so there is no natural
 * bottom. The cap is not about performance (expansion is lazy) but about the tree staying a
 * reference rather than becoming a fractal.
 */
const REFERENCE_DEPTH = 6;

/**
 * How wide the reference column opens, and what a double-click on its divider restores.
 *
 * Read from the layout table so that the default and the remembered value cannot drift apart — the
 * shell stores this pane under {@link PANE.schemaReference}, and a second copy of the number here
 * would be the one a "reset" put back.
 */
const REFERENCE_WIDTH = paneDefault(PANE.schemaReference);

/** The placeholder a map's author-chosen key is shown as. Any name resolves the same way. */
const ANY_KEY = "*";

function FieldList({
  entry,
  path,
  open,
  onToggle,
}: {
  entry: SchemaEntry;
  path: string[];
  open: ReadonlySet<string>;
  onToggle: (at: string) => void;
}): JSX.Element {
  return (
    <dl className="kv schema-fields">
      {propertiesOf(entry, path).map((property) => (
        <FieldRow key={property.key} entry={entry} path={path} property={property} open={open} onToggle={onToggle} />
      ))}
    </dl>
  );
}

function FieldRow({
  entry,
  path,
  property,
  open,
  onToggle,
}: {
  entry: SchemaEntry;
  path: string[];
  property: SchemaProperty;
  open: ReadonlySet<string>;
  onToggle: (at: string) => void;
}): JSX.Element {
  const here = [...path, property.key];
  const at = here.join(".");
  const expanded = open.has(at);

  // Two ways a field has something inside it. Declared properties are the ordinary case; a MAP —
  // `inputs`, `children`, `properties` — declares none, because its keys are the author's, and its
  // shape lives one synthetic step further down. Probing for both is how the panel describes a slot
  // without needing to know the name of one.
  const deeper = path.length < REFERENCE_DEPTH;
  const direct = deeper ? propertiesOf(entry, here) : [];
  const perEntry = deeper && direct.length === 0 ? propertiesOf(entry, [...here, ANY_KEY]) : [];
  const hasChildren = direct.length > 0 || perEntry.length > 0;

  return (
    <>
      <dt>
        {property.expected ? "★ " : ""}
        {hasChildren ? (
          <button className="link disclose" onClick={() => onToggle(at)} aria-expanded={expanded}>
            {expanded ? "▾" : "▸"} <code>{property.key}</code>
          </button>
        ) : (
          <code>{property.key}</code>
        )}
      </dt>
      <dd>
        {property.type ? <span className="chip">{property.type}</span> : null}
        {property.values ? <code className="sub">{property.values.join(" · ")}</code> : null}
        {property.description ? <span className="sub"> {property.description}</span> : null}
      </dd>
      {expanded ? (
        <dd className="nested">
          {perEntry.length > 0 ? (
            <>
              <div className="sub">
                each entry — the key is yours to name
              </div>
              <FieldList entry={entry} path={[...here, ANY_KEY]} open={open} onToggle={onToggle} />
            </>
          ) : (
            <FieldList entry={entry} path={here} open={open} onToggle={onToggle} />
          )}
        </dd>
      ) : null}
    </>
  );
}
