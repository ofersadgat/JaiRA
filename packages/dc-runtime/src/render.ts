/**
 * A parsed Design Component → React: the logic class, the template walk, child components.
 *
 * The logic is format.md's "plain classic JS … must be `class Component extends DCLogic`", given React's
 * class component semantics (`this.props`, `state`/`setState`/`forceUpdate`, the lifecycle) "minus
 * `render()`". So `DCLogic` IS a React class component, and its `render()` is the one thing it supplies:
 * call `renderVals()` and walk the template with what it returned. Each compiled file gets its own
 * `DCLogic`, closed over that file's template, so a subclass needs nothing but `renderVals()`.
 */

import * as React from "react";
import { Component, Fragment, createContext, createElement, isValidElement, useContext, useEffect, useState, type ComponentType, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { attr, type ElementNode, type Node, type TextNode } from "./html.js";
import { evaluate, interpolate, scope, segments, wholeHole, type Scope } from "./holes.js";
import { importProps, propsOf } from "./attrs.js";
import { parse, type DCDocument } from "./parse.js";
import { resolveCanvasPath } from "./paths.js";

export type Mode = "play" | "edit" | "static";

export interface RenderEnv {
  readonly mode: Mode;
  /**
   * Where `<helmet>`'s children go: into `helmetTarget` (the document's `<head>`) through a portal — so
   * an imported child's helmet is added too, and leaves with it — in place, or nowhere.
   */
  readonly helmet: "portal" | "inline" | "omit";
  readonly helmetTarget: Element | null;
  readonly loader: Loader;
  readonly onError: (message: string) => void;
}

/** A file made ready to draw: its document, its logic class, or why it cannot be drawn. */
export interface Compiled {
  readonly path: string;
  /** The document is held, not fixed: an edit that leaves the script alone swaps it in place (see `recompile`). */
  readonly holder: { doc: DCDocument };
  readonly Logic: ComponentType<Record<string, unknown>> | null;
  readonly error: string | null;
}

export interface Loader {
  /** The compiled file at a canvas path when it can be had now (loaded already, or given as text). */
  peek(path: string): Compiled | undefined;
  /** The compiled file at a canvas path; never rejects — a file that cannot be had compiles to an error. */
  load(path: string): Promise<Compiled>;
}

/** The base class a file's script extends, as its script sees it. */
export interface DCLogicClass {
  new (props: Record<string, unknown>): Component<Record<string, unknown>, Record<string, unknown>> & {
    renderVals?(): Record<string, unknown>;
  };
}

export function compile(doc: DCDocument, path: string, env: RenderEnv): Compiled {
  const holder = { doc };
  if (doc.error) return { path, holder, Logic: null, error: doc.error };
  const Base = logicBase(holder, path, env);
  if (doc.script === null || doc.script.trim() === "") return { path, holder, Logic: Base, error: null };
  try {
    // The script is classic JS defining `Component`; `DCLogic` and `React` are what it may name. We run
    // inside the artboard's sandboxed frame, whose CSP must allow this (`'unsafe-eval'`).
    const factory = new Function("DCLogic", "React", `${doc.script}\n;return typeof Component === "undefined" ? undefined : Component;`) as (
      base: DCLogicClass,
      react: typeof React,
    ) => unknown;
    const Logic = factory(Base, React);
    if (typeof Logic !== "function" || !(Logic.prototype instanceof Base)) {
      return { path, holder, Logic: null, error: "The script must define `class Component extends DCLogic`." };
    }
    return { path, holder, Logic: Logic as ComponentType<Record<string, unknown>>, error: null };
  } catch (cause) {
    return { path, holder, Logic: null, error: `The script failed: ${message(cause)}` };
  }
}

/**
 * The same file after an edit. When the script did not change, the class is kept and only the document
 * swapped, so the mounted component keeps its `state` — a style edit in the editor does not reset the
 * prototype a person was clicking through. A changed script is a new class, which React remounts.
 */
export function recompile(previous: Compiled, doc: DCDocument, env: RenderEnv): Compiled {
  if (!previous.error && !doc.error && previous.holder.doc.script === doc.script) {
    previous.holder.doc = doc;
    return previous;
  }
  return compile(doc, previous.path, env);
}

function logicBase(holder: { doc: DCDocument }, path: string, env: RenderEnv): DCLogicClass {
  class DCLogic extends Component<Record<string, unknown>, Record<string, unknown>> {
    declare renderVals?: () => Record<string, unknown>;

    constructor(props: Record<string, unknown>) {
      super(props);
      // So `this.state.x` reads undefined rather than throwing before the first `setState`; a class
      // field `state = {…}` in the subclass replaces it.
      this.state = {};
    }

    override render(): ReactNode {
      // No script yet (the file is still streaming in): the `hint-*` attributes stand in for values.
      const hasLogic = typeof this.renderVals === "function";
      const vals = hasLogic ? (this.renderVals!() ?? {}) : {};
      return renderTemplate(holder.doc, vals, { env, path, placeholders: !hasLogic });
    }
  }
  return DCLogic;
}

interface Walk {
  readonly env: RenderEnv;
  /** The canvas path of the file whose template this is. */
  readonly path: string;
  readonly placeholders: boolean;
}

export function renderTemplate(doc: DCDocument, vals: Record<string, unknown>, walk: Walk): ReactNode {
  return createElement(Fragment, null, ...renderNodes(doc.nodes, scope(vals), walk, null, true));
}

/** Parents in which a whitespace-only text node is not content, and React refuses one. */
const NO_WHITESPACE = new Set(["table", "thead", "tbody", "tfoot", "tr", "colgroup", "select", "optgroup", "helmet"]);
/** HTML drops the newline that directly follows these start tags. */
const LEADING_NEWLINE = new Set(["pre", "textarea", "listing"]);
/** Elements whose content is one string to React. */
const STRING_CONTENT = new Set(["style", "title", "script"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function renderNodes(nodes: readonly Node[], at: Scope, walk: Walk, parentTag: string | null, top: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  nodes.forEach((node, index) => {
    if (node.type === "text") out.push(...renderText(node, at, parentTag, index === 0));
    else out.push(renderElement(node, at, walk, parentTag, top));
  });
  return out;
}

function renderText(node: TextNode, at: Scope, parentTag: string | null, first: boolean): ReactNode[] {
  let raw = node.raw;
  if (parentTag !== null && NO_WHITESPACE.has(parentTag) && raw.trim() === "") return [];
  if (first && parentTag !== null && LEADING_NEWLINE.has(parentTag)) raw = raw.replace(/^\r?\n/, "");
  return segments(raw, node.decode).map((part) => (typeof part === "string" ? part : child(evaluate(part.hole, at))));
}

/** A hole's value as content: text for strings and numbers, an element as itself, nothing for the rest. */
function child(value: unknown): ReactNode {
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return String(value);
  if (isValidElement(value)) return value;
  if (Array.isArray(value)) return value.map(child);
  return null;
}

function attrValue(el: ElementNode, key: string, at: Scope): unknown {
  const a = attr(el, key);
  if (!a || a.raw === null) return undefined;
  const hole = wholeHole(a.raw);
  return hole !== null ? evaluate(hole, at) : interpolate(segments(a.raw, true), at);
}

function renderElement(el: ElementNode, at: Scope, walk: Walk, parentTag: string | null, top: boolean): ReactNode {
  switch (el.tag) {
    case "sc-for": {
      const list = attrValue(el, "list", at);
      const as = attr(el, "as")?.value?.trim() || "item";
      const count = Number(attrValue(el, "hint-placeholder-count", at)) || 0;
      const items: readonly unknown[] = Array.isArray(list) ? list : walk.placeholders ? Array.from({ length: count }, () => ({})) : [];
      return items.map((item, index) =>
        createElement(Fragment, { key: index }, ...renderNodes(el.children, scope({ [as]: item, $index: index }, at), walk, parentTag, top)),
      );
    }
    case "sc-if": {
      let value = attrValue(el, "value", at);
      if (walk.placeholders && value === undefined) value = attrValue(el, "hint-placeholder-val", at);
      return value ? createElement(Fragment, null, ...renderNodes(el.children, at, walk, parentTag, top)) : null;
    }
    case "dc-import": {
      const name = attr(el, "name")?.value?.trim() ?? "";
      const [width, height] = (attr(el, "hint-size")?.value ?? "").split(",").map((part) => part.trim() || undefined);
      return createElement(DCImport, {
        n: el.n,
        path: resolveCanvasPath(walk.path, `${name}.dc.html`),
        props: importProps(el, at),
        width,
        height,
        env: walk.env,
      });
    }
    case "helmet": {
      const children = renderNodes(el.children, at, walk, "helmet", false);
      if (walk.env.helmet === "omit") return null;
      const target = walk.env.helmetTarget ?? (typeof document === "undefined" ? null : document.head);
      if (walk.env.helmet === "inline" || target === null) return createElement(Fragment, null, ...children);
      return createPortal(createElement(Fragment, null, ...children), target);
    }
    case "script":
      // A script in the template never runs: the logic class is the only code an artboard has.
      return null;
    case "x-dc":
      return createElement(Fragment, null, ...renderNodes(el.children, at, walk, parentTag, top));
  }

  const props = propsOf(el, at);
  props["data-dc-id"] = el.n;
  // The file an element came from is its nearest `data-dc-src`: each template's top elements carry it.
  if (top) props["data-dc-src"] = walk.path;
  if (VOID.has(el.tag) && !el.svg) return createElement(el.tag, props);
  if (el.tag === "textarea") {
    props["defaultValue"] ??= textOf(el, at, true);
    return createElement(el.tag, props);
  }
  if (STRING_CONTENT.has(el.tag)) return createElement(el.tag, props, textOf(el, at, false));
  return createElement(el.tag, props, ...renderNodes(el.children, at, walk, el.tag, false));
}

function textOf(el: ElementNode, at: Scope, dropLeadingNewline: boolean): string {
  const text = el.children.map((node) => (node.type === "text" ? interpolate(segments(node.raw, node.decode), at) : "")).join("");
  return dropLeadingNewline ? text.replace(/^\r?\n/, "") : text;
}

/** The chain of files being drawn, outermost first, so a file importing itself is refused, not looped. */
const ImportChain = createContext<readonly string[]>([]);

interface DCImportProps {
  readonly n: number;
  readonly path: string;
  readonly props: Record<string, unknown>;
  readonly width: string | undefined;
  readonly height: string | undefined;
  readonly env: RenderEnv;
}

/** `<dc-import>`: the `hint-size` box until the child file is loaded, then the child. */
function DCImport({ n, path, props, width, height, env }: DCImportProps): ReactNode {
  const chain = useContext(ImportChain);
  const [compiled, setCompiled] = useState<Compiled | undefined>(() => env.loader.peek(path));
  useEffect(() => {
    if (compiled?.path === path) return;
    let live = true;
    void env.loader.load(path).then((loaded) => {
      if (live) setCompiled(loaded);
    });
    return () => {
      live = false;
    };
  }, [path, compiled, env]);
  if (chain.includes(path)) return errorBox(`${path} imports itself.`);
  if (compiled?.path !== path) {
    return createElement("div", { "data-dc-id": n, "aria-hidden": true, style: { width, height, boxSizing: "border-box" } });
  }
  return createElement(DocView, { compiled, props, env });
}

interface DocViewProps {
  readonly compiled: Compiled;
  readonly props: Readonly<Record<string, unknown>>;
  readonly env: RenderEnv;
}

/**
 * One file drawn: its logic class given `this.props` — the declared `default`s, overridden by the props
 * it was given (a parent's `<dc-import>` attributes, or the host's tweak values) — inside a boundary
 * that turns a throw into a visible error box rather than an empty frame.
 */
export function DocView({ compiled, props, env }: DocViewProps): ReactNode {
  const chain = useContext(ImportChain);
  const { error, Logic } = compiled;
  useEffect(() => {
    if (error) env.onError(`${compiled.path}: ${error}`);
  }, [error, compiled.path, env]);
  if (error || !Logic) return errorBox(`${compiled.path}: ${error ?? "it could not be drawn."}`);
  const merged = { ...defaultsOf(compiled.holder.doc), ...props };
  return createElement(
    ImportChain.Provider,
    { value: [...chain, compiled.path] },
    createElement(Boundary, { env, path: compiled.path, doc: compiled.holder.doc }, createElement(Logic, merged)),
  );
}

/** The `default`s `data-props` declares, by prop name. */
export function defaultsOf(doc: DCDocument): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(doc.props)) if ("default" in spec) defaults[name] = spec.default;
  return defaults;
}

interface BoundaryProps {
  readonly env: RenderEnv;
  readonly path: string;
  /** A new document clears the error: the edit that caused it may have been undone. */
  readonly doc: DCDocument;
  readonly children?: ReactNode;
}

class Boundary extends Component<BoundaryProps, { error: string | null; doc: DCDocument }> {
  override state = { error: null as string | null, doc: this.props.doc };

  static getDerivedStateFromError(cause: unknown): { error: string } {
    return { error: message(cause) };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: { error: string | null; doc: DCDocument }): { error: string | null; doc: DCDocument } | null {
    return props.doc !== state.doc ? { error: null, doc: props.doc } : null;
  }

  override componentDidCatch(cause: unknown): void {
    this.props.env.onError(`${this.props.path}: ${message(cause)}`);
  }

  override render(): ReactNode {
    return this.state.error !== null ? errorBox(`${this.props.path}: ${this.state.error}`) : this.props.children;
  }
}

/** The small box drawn where a file cannot be: never a blank page. */
export function errorBox(text: string): ReactNode {
  return createElement(
    "div",
    {
      role: "alert",
      "data-dc-error": "",
      style: {
        margin: 8,
        padding: "8px 10px",
        border: "1px solid #f3b4ae",
        borderRadius: 6,
        background: "#fff4f2",
        color: "#9f1d12",
        font: "12px/1.45 system-ui, sans-serif",
        whiteSpace: "pre-wrap",
        maxWidth: 560,
      },
    },
    createElement("strong", null, "This artboard could not be drawn."),
    createElement("br"),
    text,
  );
}

export function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Files by canvas path: given as text (`files`), fetched (`resolve`), compiled once each. */
export function createLoader(env: () => RenderEnv, source: { files?: Readonly<Record<string, string>>; resolve?: (path: string) => Promise<string> }): Loader {
  const done = new Map<string, Compiled>();
  const pending = new Map<string, Promise<Compiled>>();
  const failed = (path: string, reason: string): Compiled => ({ path, holder: { doc: parse("") }, Logic: null, error: reason });
  const loader: Loader = {
    peek(path) {
      const known = done.get(path);
      if (known) return known;
      const text = source.files?.[path];
      if (text === undefined) return undefined;
      const compiled = compile(parse(text), path, env());
      done.set(path, compiled);
      return compiled;
    },
    load(path) {
      const now = loader.peek(path);
      if (now) return Promise.resolve(now);
      let promise = pending.get(path);
      if (!promise) {
        const resolve = source.resolve;
        promise = (resolve ? resolve(path) : Promise.reject(new Error("nothing was given to load files with")))
          .then(
            (text) => compile(parse(text), path, env()),
            (cause: unknown) => failed(path, `It could not be loaded: ${message(cause)}`),
          )
          .then((compiled) => {
            done.set(path, compiled);
            pending.delete(path);
            return compiled;
          });
        pending.set(path, promise);
      }
      return promise;
    },
  };
  return loader;
}

export interface RenderOptions {
  /** Props over the declared defaults, as the host's Tweaks would give them. */
  readonly props?: Readonly<Record<string, unknown>>;
  /** The artboard's canvas path, which its imports and links resolve against. Default `Main.dc.html`. */
  readonly path?: string;
  /** The other files `<dc-import>` may name, by canvas path. */
  readonly files?: Readonly<Record<string, string>>;
  /** Where `<helmet>` goes; a server render cannot portal, so in place by default. */
  readonly helmet?: "inline" | "omit";
}

/**
 * An artboard as one React element, for rendering without a DOM: `react-dom/server`, tests, a host
 * that draws the static markup. Imports come only from `files`, synchronously; an import not given
 * there is drawn as its `hint-size` box.
 */
export function renderArtboard(source: string, options: RenderOptions = {}): ReactElement {
  const path = options.path ?? "Main.dc.html";
  const env: RenderEnv = {
    mode: "static",
    helmet: options.helmet ?? "inline",
    helmetTarget: null,
    loader: createLoader(() => env, { files: options.files ?? {} }),
    onError: () => {},
  };
  return createElement(DocView, { compiled: compile(parse(source), path, env), props: options.props ?? {}, env });
}
