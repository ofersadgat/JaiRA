/**
 * The design canvas editor (decision 0020 §5): Claude Design's files — `project/canvas.json` and one
 * `.dc.html` per artboard — edited the way its own canvas edits them, by JaiRA's own code.
 *
 * Every artboard RUNS in its frame (the grant `base`, an origin of its own) under JaiRA's `.dc.html`
 * runtime, in edit mode: the runtime captures the pointer, so the design's own handlers and links do
 * not fire, and reports what is under it by the template element's id (`data-dc-id`). What the editor
 * changes is SOURCE TEXT, by pure edits at that element's offsets (`@jaira/dc-runtime`'s `editStyle`,
 * `editText`, `removeElement`, `insertElement`), so everything else in the file stays byte for byte as
 * the model wrote it; the frame is handed the new text and re-renders in place.
 *
 * The tools are the canvas's: pointer (select; drag an artboard by its name strip, a note or shape by
 * itself, an element within its artboard; resize an artboard from its corner), hand, text, artboard,
 * note, pen, rectangle, oval, arrow and line. Notes and shapes are `canvas.json`'s `notes`, as the
 * instructions say ("`kind` rect|oval|pen|line|arrow|image is the user's"). A save is a version marked
 * the person's (`onSave`), a second after the last change; refused, because the model published the same
 * file meanwhile, it says so and offers to reload.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { flushSync } from "react-dom";
import { applyMove, editStyle, editText, elementMarkup, formatStyle, insertAfter, insertElement, parse, readStyle, removeElement, setPropDefault, wrapElement, type Moved } from "@jaira/dc-runtime/source";
import { CanvasHistory, changedPaths, type CanvasState } from "./canvasHistory";
import type { CanvasBoardEntry, CanvasIndex, CanvasNote } from "./canvasIndex";
import { Popover } from "./popover";

export type CanvasTool = "pointer" | "hand" | "text" | "artboard" | "note" | "pen" | "rect" | "oval" | "arrow" | "line" | "comment";

/** A comment as the editor draws it (decision 0024): `@jaira/shared`'s `ArtifactComment`, the fields it reads. */
export interface CanvasComment {
  id: string;
  file: string;
  x: number;
  y: number;
  element?: { id: number; tag: string; text?: string };
  text: string;
  toClaude: boolean;
  sentAt?: number;
  resolvedAt?: number;
  createdAt: number;
}

/** A comment being written: where its pin is, and what the person wrote. */
export interface CommentDraft {
  file: string;
  x: number;
  y: number;
  element?: { id: number; tag: string; text?: string };
  text: string;
  toClaude: boolean;
}

export interface CanvasEditorProps {
  /** Every file of the canvas at `base`, by path (`project/canvas.json`, `project/Main.dc.html`, …). */
  files: Record<string, string>;
  /** The version `files` are of: what a save is measured against. */
  base: number;
  /** The grant the artboards are framed from: `jaira-artifact://<token>/`. */
  frames: string;
  /** Keep the changed files as a version marked the person's. */
  onSave: (changes: Record<string, string | null>, base: number) => Promise<{ version: number } | { refused: string; files: string[] }>;
  /** Read the canvas again — after a refusal, the model's newer files. */
  onReload: () => void;
  /** An artboard as a picture or a document, saved where the person chooses. */
  onExport?: ((file: string, format: "png" | "pdf", size: { width: number; height: number }) => void) | undefined;
  /** The comments on this artifact; with `onComment`, the comment tool is offered. */
  comments?: CanvasComment[] | undefined;
  /**
   * Keep a new comment, and send it to Claude when it says so; `failure` when it could not be sent.
   * `version`: the one the editor holds — the element's id is of that source, past the person's saves.
   */
  onComment?: ((draft: CommentDraft, version: number) => Promise<{ failure?: string }>) | undefined;
  /**
   * The grant root of a version (`jaira-artifact://<token>/`): where a file the opened version does not
   * hold — an artboard drawn here — is framed from, once a save has made it a version's.
   */
  serveVersion?: ((version: number) => Promise<string>) | undefined;
  /** Resolve a comment, open it again, or take it away. */
  onSettleComment?: ((id: string, change: { resolved?: boolean; removed?: boolean }) => void) | undefined;
  style?: CSSProperties;
}

type Selection =
  | { kind: "board"; file: string }
  | { kind: "note"; id: string }
  | { kind: "element"; file: string; id: number; rect: Rect; tag: string; style: string; text: string | null };

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface View {
  x: number;
  y: number;
  z: number;
}

/** What a gesture on the board is doing until the pointer lets go. */
type Gesture =
  | { kind: "pan"; from: { x: number; y: number }; view: View }
  | { kind: "moveBoard"; file: string; from: { x: number; y: number }; at: { x: number; y: number } }
  | { kind: "resizeBoard"; file: string; from: { x: number; y: number }; size: { w: number; h: number } }
  | { kind: "moveNote"; id: string; from: { x: number; y: number }; at: { x: number; y: number }; end?: { x: number; y: number } }
  | { kind: "draw"; tool: CanvasTool; start: { x: number; y: number }; now: { x: number; y: number }; points: Array<[number, number]> };

const TOOLS: Array<{ tool: CanvasTool; label: string; key: string; path: string }> = [
  { tool: "pointer", label: "Pointer", key: "V", path: "M5 3l13 8-6 1.5L9 19z" },
  { tool: "hand", label: "Hand", key: "H", path: "M8 12V5a1.5 1.5 0 0 1 3 0v6M11 10V4a1.5 1.5 0 0 1 3 0v7M14 10.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2-4a1.5 1.5 0 0 1 2.6-1.5L8 14" },
  { tool: "text", label: "Text", key: "T", path: "M5 6V4h14v2M12 4v16M9 20h6" },
  { tool: "artboard", label: "Artboard", key: "A", path: "M7 3v18M17 3v18M3 7h18M3 17h18" },
  { tool: "note", label: "Note", key: "N", path: "M5 4h14v11l-5 5H5zM14 20v-5h5" },
  { tool: "pen", label: "Pen", key: "P", path: "M4 20c4-1 6-4 8-8s4-6 8-8M15 4l5 5" },
  { tool: "rect", label: "Rectangle", key: "R", path: "M4 6h16v12H4z" },
  { tool: "oval", label: "Oval", key: "O", path: "M4 12a8 6 0 1 0 16 0a8 6 0 1 0-16 0" },
  { tool: "arrow", label: "Arrow", key: "Shift+L", path: "M5 19L19 5M10 5h9v9" },
  { tool: "line", label: "Line", key: "L", path: "M5 19L19 5" },
  { tool: "comment", label: "Comment", key: "C", path: "M4 5h16v11H9l-5 4z" },
];

/** Tools that share one button in the top-left bar, behind its ⌄ — as Claude Code's canvas groups them. */
type ToolGroup = "pen" | "shape";
const GROUPS: Record<ToolGroup, CanvasTool[]> = { pen: ["pen", "line", "arrow"], shape: ["rect", "oval"] };
const groupOf = (tool: CanvasTool): ToolGroup | undefined => (Object.keys(GROUPS) as ToolGroup[]).find((g) => GROUPS[g].includes(tool));

const CARET = "M6 9l6 6 6-6";
const PLAY = "M8 5.5v13l10-6.5z";
const STOP = "M7 7h10v10H7z";
const SLIDERS = "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4";
const EXPAND = "M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7";
const DOWNLOAD = "M12 4v11M7 10l5 5 5-5M5 20h14";

/** How a shortcut's modifier is written: Cmd on a Mac, Ctrl elsewhere. */
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd" : "Ctrl";

const SHORTCUT: Record<string, CanvasTool> = { v: "pointer", h: "hand", t: "text", a: "artboard", n: "note", p: "pen", r: "rect", o: "oval", l: "line", c: "comment" };

/** The colour of a running artboard's ring and its controls. */
const RUN = "#0f7a45";

/**
 * Which editor the keyboard is for. Several can be open at once — inline in the conversation, the side
 * panel, the main view — and a key read off `window` reached every one: Ctrl+Z would undo in all of them,
 * and Delete would delete in each that had a selection. The keys are the editor's the person last pressed
 * in (its board, its bars, its menus and comment boxes, which carry `data-canvas-keys`, or one of its
 * artboards); a press anywhere else in the window gives them back to the page.
 */
let keysOwner: string | null = null;
let keysWatched = false;
function watchKeysOwner(): void {
  if (keysWatched || typeof window === "undefined") return;
  keysWatched = true;
  window.addEventListener(
    "pointerdown",
    (e) => {
      keysOwner = (e.target instanceof Element ? e.target.closest("[data-canvas-keys]")?.getAttribute("data-canvas-keys") : null) ?? null;
    },
    true,
  );
  // A press in an artboard reaches the frame's window, not this one: this one loses the focus to it.
  window.addEventListener("blur", () =>
    setTimeout(() => {
      const focused = document.activeElement;
      if (focused instanceof HTMLIFrameElement) keysOwner = focused.closest("[data-canvas-keys]")?.getAttribute("data-canvas-keys") ?? keysOwner;
    }, 0),
  );
}

/** A note's box on the board, near enough to frame it (Shift+2). */
function noteBox(n: CanvasNote | undefined): { x: number; y: number; w: number; h: number } | undefined {
  if (n === undefined) return undefined;
  if (n.x2 !== undefined && n.y2 !== undefined) return { x: Math.min(n.x, n.x2), y: Math.min(n.y, n.y2), w: Math.abs(n.x2 - n.x), h: Math.abs(n.y2 - n.y) };
  if (n.points !== undefined && n.points.length > 0) {
    const xs = n.points.map(([px]) => n.x + px);
    const ys = n.points.map(([, py]) => n.y + py);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  return { x: n.x, y: n.y, w: n.w ?? 220, h: n.h ?? 120 };
}

/** What Ctrl+C or Ctrl+X took, for Ctrl+V — in this window, any canvas: an artboard pastes into another canvas too. */
type Clip = { kind: "note"; note: CanvasNote } | { kind: "board"; file: string; entry: CanvasBoardEntry; source: string } | { kind: "element"; html: string };
let clipboard: { clip: Clip; pasted: number } | null = null;

/** `canvas.json` as the editor holds it; its other keys ride along untouched. */
function readIndex(text: string | undefined): CanvasIndex & Record<string, unknown> {
  try {
    const parsed = JSON.parse(text ?? "{}") as CanvasIndex & Record<string, unknown>;
    return { ...parsed, boards: parsed.boards ?? {}, order: parsed.order ?? Object.keys(parsed.boards ?? {}), notes: parsed.notes ?? {} };
  } catch {
    return { v: 3, boards: {}, order: [], notes: {} };
  }
}

/** A new note's id: the instructions allow `[A-Za-z0-9_-]{1,40}`. */
const noteId = (): string => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A new artboard's file: a name the instructions allow, unique among the canvas's stems. */
function artboardFile(index: CanvasIndex): string {
  for (let n = Object.keys(index.boards).length + 1; ; n++) {
    const file = `Artboard${n}.dc.html`;
    if (index.boards[file] === undefined) return file;
  }
}

/** A blank artboard in the format's own skeleton (SKILL.md, "One artboard: the skeleton"). */
function blankArtboard(w: number, h: number, title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<style>
body{margin:0}
</style>
</helmet>
<div style="width: ${w}px; height: ${h}px; box-sizing: border-box; padding: 32px; display: flex; flex-direction: column; gap: 16px; background: #ffffff; font-family: system-ui, sans-serif"></div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":${w},"height":${h}}}'>
class Component extends DCLogic {
renderVals() {
return {};
}
}
</script>
</body>
</html>
`;
}

export function CanvasEditor({ files: initial, base: initialBase, frames, onSave, onReload, onExport, comments = [], onComment, serveVersion, onSettleComment, style }: CanvasEditorProps): JSX.Element {
  /** This editor's name in `data-canvas-keys`: the keys are its while the person last pressed in it. */
  const keysId = useId();
  const [index, setIndex] = useState(() => readIndex(initial["project/canvas.json"]));
  const [sources, setSources] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(initial).filter(([p]) => p.endsWith(".dc.html"))));
  const [base, setBase] = useState(initialBase);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<CanvasTool>("pointer");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [view, setView] = useState<View>({ x: 40, y: 60, z: 0.5 });
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [editingText, setEditingText] = useState<{ file: string; id: number; rect: Rect; text: string } | { note: string; text: string } | null>(null);
  const [status, setStatus] = useState<{ tone: "saved" | "saving" | "refused" | "error"; words: string } | null>(null);
  const [tab, setTab] = useState<"properties" | "tweaks" | "layers" | "comments">("properties");
  /**
   * The artboards RUNNING where they sit (`play`): the design's own handlers, inputs and links are live,
   * as in the app it shows; every other artboard is edited around them. Only an interactive one runs.
   */
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  /** The artboard running on its own, filling the editor's box (⤢). */
  const [full, setFull] = useState<string | null>(null);
  const fullBox = useRef<HTMLDivElement | null>(null);
  /** The comment being written, at its pin. */
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  /** The comment whose pin was opened. */
  const [openPin, setOpenPin] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  /** The pin a comment's box opens against: the one being written, or the one opened. */
  const pinRef = useRef<HTMLButtonElement | null>(null);
  const modeOf = (file: string): "play" | "edit" => (running.has(file) || full === file ? "play" : "edit");
  /**
   * A run is a trial: an artboard that stops is drawn again from its source, its frame loaded afresh.
   * Left as the run left it, it kept the run's state and scroll — an input focused near the edge scrolls
   * the page — and the editor picked nothing where the person pressed. Counted per artboard, as its key.
   */
  const [fresh, setFresh] = useState<Record<string, number>>({});
  const wasRunning = useRef<ReadonlySet<string>>(running);
  useEffect(() => {
    const stopped = [...wasRunning.current].filter((file) => !running.has(file));
    wasRunning.current = running;
    if (stopped.length > 0) setFresh((was) => ({ ...was, ...Object.fromEntries(stopped.map((file) => [file, (was[file] ?? 0) + 1])) }));
  }, [running]);
  const frameEls = useRef(new Map<string, HTMLIFrameElement>());
  /**
   * Where each artboard's frame loads from: the opened version's grant (`frames`), or — for one drawn
   * here, which that grant does not hold — the grant of the version that first saved it.
   */
  const [roots, setRoots] = useState<Record<string, string>>({});
  /**
   * The text each frame's grant serves, by path. A frame that loads again (back from the full view, a
   * remount) gets the grant's text, which is behind the person's saves; it is handed the editor's.
   */
  const granted = useRef<Record<string, string>>(Object.fromEntries(Object.entries(initial).filter(([path]) => path.endsWith(".dc.html"))));
  const servable = (file: string): boolean => roots[file] !== undefined || initial[`project/${file}`] !== undefined;
  const board = useRef<HTMLDivElement | null>(null);
  /**
   * The properties panel (properties, tweaks, layers, comments): a card over the board's right edge,
   * opened by the top-right bar's toggle or Ctrl+\ (Claude Design's own), closed until asked — the board
   * is the whole box, as Claude Code's canvas draws it (the person, 2026-11-07, with its picture).
   */
  const [panelOpen, setPanelOpen] = useState(false);
  /**
   * The board's width. Narrow (a conversation's column: about 210 px in the side panel), the two bars
   * cannot share the top edge — the tools ran under the canvas bar: the tools wrap at the top, the canvas
   * bar goes to the bottom right, and the panel opens between them.
   */
  const [boardWidth, setBoardWidth] = useState(0);
  const stacked = boardWidth > 0 && boardWidth < 600;
  /** Space held: the pointer pans, over the frames too (the capture layer is laid over them). */
  const [spaceHeld, setSpaceHeld] = useState(false);
  /** Which tool each group's button stands for: the last one picked from it. */
  const [groupPick, setGroupPick] = useState<Record<ToolGroup, CanvasTool>>({ pen: "pen", shape: "rect" });
  /** The one menu open: a tool group's, the zoom's, the pages', or an artboard's downloads. */
  const [menu, setMenu] = useState<{ kind: "group"; group: ToolGroup } | { kind: "zoom" } | { kind: "pages" } | { kind: "download"; file: string } | null>(null);
  const menuAnchor = useRef<Element | null>(null);
  const menuBox = useRef<HTMLDivElement | null>(null);
  const openMenu = (next: NonNullable<typeof menu>, anchor: Element): void => {
    menuAnchor.current = anchor;
    setMenu((was) => (was !== null && JSON.stringify(was) === JSON.stringify(next) ? null : next));
  };
  // A press anywhere else, or Esc, puts the menu away (a float's dismissal is its host's).
  useEffect(() => {
    if (menu === null) return;
    const away = (e: Event): void => {
      const target = e.target as Node | null;
      if (target !== null && (menuBox.current?.contains(target) === true || menuAnchor.current?.contains(target) === true)) return;
      setMenu(null);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [menu]);
  /** The page on the board, when the canvas has pages; every artboard and note otherwise. */
  const firstPage = index.pages?.[0]?.id;
  const [page, setPage] = useState<string | undefined>(index.launch?.page ?? firstPage);
  const onPage = (entry: { page?: string | undefined }): boolean => firstPage === undefined || (entry.page ?? firstPage) === page;
  useEffect(() => {
    const el = board.current;
    if (el === null) return;
    if (!moved.current) fitNow.current();
    setBoardWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => {
      setBoardWidth(el.clientWidth);
      if (!moved.current) fitNow.current();
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [full, page]);

  /**
   * The person has panned or zoomed since the last fit: the view is theirs, and stays where they put it
   * when the board's box changes size. Until then the canvas is fitted again as the box changes — it
   * opens in a column that is still being laid out (narrow, the panel closes after the first measure),
   * and a fit made once, from the first width, left the artboards wider than the board.
   */
  const moved = useRef(false);
  /** The board, an artboard or a note was dragged since the press: a press that moved nothing saves nothing. */
  const gestureMoved = useRef(false);
  /** A middle-button pan begun inside a frame: where the pointer last was, in the window. */
  const framePan = useRef<{ x: number; y: number } | null>(null);
  /** Every artboard in what the board shows, 24 px clear, between 5% and 100%; never from a box not yet measured. */
  const fit = (): void => {
    const el = board.current;
    const boxes = Object.values(index.boards).filter(onPage);
    if (el === null || boxes.length === 0 || el.clientWidth <= 0 || el.clientHeight <= 0) return;
    moved.current = false;
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y)) - 24;
    const w = Math.max(...boxes.map((b) => b.x + b.w)) - x;
    const h = Math.max(...boxes.map((b) => b.y + b.h)) - y;
    const room = (side: number): number => Math.max(side - 48, side / 2);
    const z = Math.max(0.05, Math.min(1, room(el.clientWidth) / Math.max(w, 1), room(el.clientHeight) / Math.max(h, 1)));
    setView({ z, x: (el.clientWidth - w * z) / 2 - x * z, y: (el.clientHeight - h * z) / 2 - y * z });
  };
  const fitNow = useRef(fit);
  fitNow.current = fit;

  // --- edits ------------------------------------------------------------------------------------

  /** The canvas as last drawn, and what it was before each edit (canvasHistory.ts). */
  const live = useRef<CanvasState<CanvasIndex & Record<string, unknown>>>({ index, sources });
  live.current = { index, sources };
  const history = useRef(new CanvasHistory<CanvasState<CanvasIndex & Record<string, unknown>>>());
  /** Before an edit: the canvas as it stands is kept for Ctrl+Z. */
  const checkpoint = (): void => history.current.record(live.current);
  /** Back (or forward) to a kept state: what differs is marked changed and saved, and each frame redrawn. */
  const restore = (to: CanvasState<CanvasIndex & Record<string, unknown>> | undefined): void => {
    if (to === undefined) return;
    const paths = changedPaths(live.current, to);
    setIndex(to.index);
    setSources(to.sources);
    setDirty((was) => new Set([...was, ...paths]));
    for (const path of paths) {
      if (path === "project/canvas.json") continue;
      const file = path.replace(/^project\//, "");
      frameEls.current.get(file)?.contentWindow?.postMessage({ type: "dc:source", text: to.sources[path] ?? "" }, "*");
    }
    setEditingText(null);
    // An element's number may name another element now; an artboard or a note may be gone.
    setSelection((was) => (was === null || was.kind === "element" ? null : was.kind === "board" ? (to.index.boards[was.file] !== undefined ? was : null) : to.index.notes?.[was.id] !== undefined ? was : null));
  };
  const undo = (): void => restore(history.current.undo(live.current));
  const redo = (): void => restore(history.current.redo(live.current));

  const touch = (path: string): void => setDirty((was) => new Set(was).add(path));
  const changeIndex = (next: (index: CanvasIndex & Record<string, unknown>) => CanvasIndex & Record<string, unknown>): void => {
    checkpoint();
    setIndex((was) => next(was));
    touch("project/canvas.json");
  };
  const changeSource = (file: string, next: string): void => {
    checkpoint();
    setSources((was) => ({ ...was, [`project/${file}`]: next }));
    touch(`project/${file}`);
    frameEls.current.get(file)?.contentWindow?.postMessage({ type: "dc:source", text: next }, "*");
  };
  const sourceOf = (file: string): string => sources[`project/${file}`] ?? "";

  // A save a second after the last change: the changed files as a version marked the person's.
  useEffect(() => {
    if (dirty.size === 0) return;
    const timer = setTimeout(() => {
      const changes: Record<string, string | null> = {};
      for (const path of dirty) changes[path] = path === "project/canvas.json" ? `${JSON.stringify(index, null, 2)}\n` : (sources[path] ?? null);
      setStatus({ tone: "saving", words: "Saving…" });
      void onSave(changes, base)
        .then((answer) => {
          if ("version" in answer) {
            setBase(answer.version);
            setDirty(new Set());
            // An artboard drawn here is a file of this version now: framed from its grant.
            for (const [path, text] of Object.entries(changes)) {
              const file = path.replace(/^project\//, "");
              if (text === null || !path.endsWith(".dc.html") || servable(file) || serveVersion === undefined) continue;
              void serveVersion(answer.version)
                .then((root) => {
                  granted.current[path] = text;
                  setRoots((was) => ({ ...was, [file]: root }));
                })
                .catch(() => undefined);
            }
            setStatus({ tone: "saved", words: `Saved · your edit is v${answer.version}` });
          } else {
            setStatus({ tone: "refused", words: `Claude changed ${answer.files.map((f) => f.replace(/^project\//, "")).join(", ")} meanwhile — reload to edit the newer version` });
          }
        })
        .catch((e: unknown) => setStatus({ tone: "error", words: `Not saved: ${e instanceof Error ? e.message : String(e)}` }));
    }, 1000);
    return () => clearTimeout(timer);
  }, [dirty, index, sources, base, onSave]);

  // --- the frames' reports ------------------------------------------------------------------------

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const file = [...frameEls.current.entries()].find(([, el]) => el.contentWindow === event.source)?.[0];
      if (file === undefined) return;
      const data = event.data as { type?: string; id?: number; rect?: Rect; at?: { x: number; y: number }; tag?: string; style?: string; text?: string | null; href?: string; phase?: string; x?: number; y?: number };
      // A press or a key in one of this editor's artboards: the keyboard is this editor's.
      if (data.type === "dc:pick" || data.type === "dc:dblclick" || data.type === "dc:moved" || data.type === "dc:key" || (data.type === "dc:pan" && data.phase === "start")) keysOwner = keysId;
      if (data.type === "dc:key") {
        // A key pressed while an artboard had the focus: read as if pressed on this window.
        const k = event.data as { phase?: string; key?: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; repeat?: boolean };
        window.dispatchEvent(new KeyboardEvent(k.phase === "up" ? "keyup" : "keydown", { key: k.key ?? "", code: k.code ?? "", ctrlKey: k.ctrlKey === true, metaKey: k.metaKey === true, shiftKey: k.shiftKey === true, altKey: k.altKey === true, repeat: k.repeat === true }));
        return;
      }
      if (data.type === "dc:pan" && typeof data.x === "number" && typeof data.y === "number") {
        // The middle button dragged inside a frame: where the pointer is, placed in the window by where
        // the frame stands now; the board pans by how far that moved. Committed at once (`flushSync`), so
        // the frame's next report is measured against the board as it now stands.
        const el = frameEls.current.get(file);
        if (el === undefined) return;
        const box = el.getBoundingClientRect();
        const scale = el.offsetWidth > 0 ? box.width / el.offsetWidth : 1;
        const p = { x: box.left + data.x * scale, y: box.top + data.y * scale };
        const was = framePan.current;
        framePan.current = data.phase === "end" ? null : p;
        if (data.phase === "start" || was === null) return;
        moved.current = true;
        flushSync(() => setView((v) => ({ ...v, x: v.x + p.x - was.x, y: v.y + p.y - was.y })));
        return;
      }
      if (data.type === "dc:ready") {
        // The frame's runtime is listening only once it has drawn — a mode sent at `load` can arrive
        // before that — so every `dc:ready` is answered with what the frame should be.
        const w = frameEls.current.get(file)?.contentWindow;
        w?.postMessage({ type: "dc:mode", mode: modeOf(file) }, "*");
        if (selection?.kind === "element" && selection.file === file) w?.postMessage({ type: "dc:select", id: selection.id }, "*");
        return;
      }
      if (data.type === "dc:pick" && typeof data.id === "number" && data.rect !== undefined) {
        if (tool === "comment" && onComment !== undefined) {
          // A pin where the press landed, over the element there.
          const at = data.at ?? { x: data.rect.x, y: data.rect.y };
          const own = typeof data.text === "string" && data.text.trim() !== "" ? { text: data.text.trim().slice(0, 120) } : {};
          setOpenPin(null);
          setDraft({ file, x: Math.round(at.x), y: Math.round(at.y), element: { id: data.id, tag: data.tag ?? "div", ...own }, text: "", toClaude: true });
          return;
        }
        if (tool === "text" && typeof data.text === "string") {
          setEditingText({ file, id: data.id, rect: data.rect, text: data.text });
          return;
        }
        setSelection({ kind: "element", file, id: data.id, rect: data.rect, tag: data.tag ?? "div", style: data.style ?? "", text: data.text ?? null });
      } else if (data.type === "dc:dblclick" && typeof data.id === "number" && data.rect !== undefined) {
        // Only an element holding one literal text can be retyped (`editText`).
        if (typeof data.text === "string") setEditingText({ file, id: data.id, rect: data.rect, text: data.text });
      } else if (data.type === "dc:moved" && tool !== "comment") {
        // A drag the page drew as it happened, written into the source (`applyMove`): the parent's size
        // kept, the siblings pinned, the element placed where it was dropped.
        const moved = event.data as Moved;
        changeSource(file, applyMove(sourceOf(file), moved));
        setSelection((was) => (was?.kind === "element" && was.file === file && was.id === moved.id ? { ...was, rect: { ...moved.rect, x: moved.rect.x + moved.dx, y: moved.rect.y + moved.dy } } : was));
      } else if (data.type === "dc:rects") {
        // The selected element moved under a re-render or a resize: its box follows.
        const rects = (event.data as { rects?: Record<string, Rect> }).rects ?? {};
        setSelection((was) => (was?.kind === "element" && was.file === file && rects[String(was.id)] !== undefined ? { ...was, rect: rects[String(was.id)]! } : was));
      } else if (data.type === "dc:navigate" && typeof data.href === "string") {
        // A link to another artboard moves the run there (format.md, "Links between artboards"): in the
        // full view the view follows it; on the canvas the target runs in place, brought into view.
        const target = data.href.replace(/^\/?project\//, "");
        if (index.boards[target] === undefined) return;
        if (full === file) {
          setFull(target);
        } else if (running.has(file)) {
          setRunning((was) => {
            const next = new Set(was);
            next.delete(file);
            next.add(target);
            return next;
          });
          bringIntoView(target);
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, running, full, index, sources, selection, onComment]);

  // Tell each frame which of its elements is selected, so it reports where that element went.
  const selectedId = selection?.kind === "element" ? `${selection.file}#${String(selection.id)}` : "";
  useEffect(() => {
    for (const [file, el] of frameEls.current) el.contentWindow?.postMessage({ type: "dc:select", id: selection?.kind === "element" && selection.file === file ? selection.id : null }, "*");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Tell every frame what mode it is in: a running one plays; the rest edit (only the pointer, text and
  // comment tools reach a frame).
  useEffect(() => {
    for (const [file, el] of frameEls.current) el.contentWindow?.postMessage({ type: "dc:mode", mode: modeOf(file) }, "*");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, running, full, index]);

  // --- keys ----------------------------------------------------------------------------------------

  const remove = useCallback((): void => {
    if (selection === null) return;
    if (selection.kind === "note") {
      changeIndex((was) => {
        const notes = { ...(was.notes ?? {}) };
        delete notes[selection.id];
        return { ...was, notes };
      });
    } else if (selection.kind === "board") {
      changeIndex((was) => {
        const boards = { ...was.boards };
        delete boards[selection.file];
        return { ...was, boards, order: (was.order ?? []).filter((f) => f !== selection.file) };
      });
      setSources((was) => ({ ...was, [`project/${selection.file}`]: "" }));
      setDirty((was) => new Set(was).add(`project/${selection.file}`));
    } else {
      changeSource(selection.file, removeElement(sourceOf(selection.file), selection.id));
    }
    setSelection(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, sources]);

  /** Ctrl+C / Ctrl+X: what is selected, as a clip. */
  const clipOf = (s: Selection | null): Clip | null => {
    if (s === null) return null;
    if (s.kind === "note") {
      const note = index.notes?.[s.id];
      return note === undefined ? null : { kind: "note", note };
    }
    if (s.kind === "board") {
      const entry = index.boards[s.file];
      return entry === undefined ? null : { kind: "board", file: s.file, entry, source: sourceOf(s.file) };
    }
    try {
      return { kind: "element", html: elementMarkup(sourceOf(s.file), s.id) };
    } catch {
      return null;
    }
  };

  /**
   * Ctrl+V and Ctrl+D: a note a step down and to the right of its original, an artboard beside it (a new
   * file, its source copied), an element right after the selected one — or, with an artboard selected,
   * last in its outermost box. The `n`th paste of one clip steps `n` times, so pastes do not pile up.
   */
  const paste = (clip: Clip, n: number): void => {
    const onThisPage = firstPage !== undefined && page !== undefined ? { page } : {};
    if (clip.kind === "note") {
      const id = noteId();
      const d = 24 * n;
      const note = clip.note;
      changeIndex((was) => ({ ...was, notes: { ...(was.notes ?? {}), [id]: { ...note, ...onThisPage, x: note.x + d, y: note.y + d, ...(note.x2 !== undefined && note.y2 !== undefined ? { x2: note.x2 + d, y2: note.y2 + d } : {}) } } }));
      setSelection({ kind: "note", id });
      return;
    }
    if (clip.kind === "board") {
      const stem = clip.file.replace(/\.dc\.html$/, "").replace(/[^A-Za-z0-9_-]/g, "");
      let file = `${stem}Copy.dc.html`;
      for (let k = 2; index.boards[file] !== undefined || sources[`project/${file}`] !== undefined; k++) file = `${stem}Copy${String(k)}.dc.html`;
      const entry: CanvasBoardEntry = { ...clip.entry, ...onThisPage, x: clip.entry.x + (clip.entry.w + 80) * n, title: `${clip.entry.title ?? stem} copy` };
      changeIndex((was) => ({ ...was, boards: { ...was.boards, [file]: entry }, order: [...(was.order ?? []), file] }));
      setSources((was) => ({ ...was, [`project/${file}`]: clip.source }));
      touch(`project/${file}`);
      setSelection({ kind: "board", file });
      return;
    }
    if (selection?.kind === "element") {
      changeSource(selection.file, insertAfter(sourceOf(selection.file), selection.id, clip.html));
      setSelection(null);
    } else if (selection?.kind === "board") {
      const source = sourceOf(selection.file);
      const box = parse(source).elements.filter((el) => el.parent === null && !["helmet", "style", "script", "link", "meta"].includes(el.tag)).at(-1);
      if (box !== undefined) changeSource(selection.file, insertElement(source, box.n, clip.html));
    }
  };

  /** Arrow keys: a selected artboard or note moves a pixel, ten with Shift. (An element sits in its page's flow; it is dragged.) */
  const nudge = (dx: number, dy: number): boolean => {
    if (selection?.kind === "board" && index.boards[selection.file] !== undefined) {
      const file = selection.file;
      changeIndex((was) => ({ ...was, boards: { ...was.boards, [file]: { ...was.boards[file]!, x: was.boards[file]!.x + dx, y: was.boards[file]!.y + dy } } }));
      return true;
    }
    if (selection?.kind === "note" && index.notes?.[selection.id] !== undefined) {
      const id = selection.id;
      changeIndex((was) => {
        const note = was.notes?.[id];
        if (note === undefined) return was;
        return { ...was, notes: { ...was.notes, [id]: { ...note, x: note.x + dx, y: note.y + dy, ...(note.x2 !== undefined && note.y2 !== undefined ? { x2: note.x2 + dx, y2: note.y2 + dy } : {}) } } };
      });
      return true;
    }
    return false;
  };

  /** Shift+2: the selected artboard (an element's own), or note, filling the board, 24 px clear, at no more than 100%. */
  const zoomToSelection = (): void => {
    const el = board.current;
    const box = selection === null ? undefined : selection.kind === "note" ? noteBox(index.notes?.[selection.id]) : index.boards[selection.file];
    if (el === null || box === undefined || el.clientWidth <= 0) return;
    moved.current = true;
    const z = Math.max(0.05, Math.min(1, (el.clientWidth - 48) / Math.max(box.w, 1), (el.clientHeight - 48) / Math.max(box.h, 1)));
    setView({ z, x: (el.clientWidth - box.w * z) / 2 - box.x * z, y: (el.clientHeight - box.h * z) / 2 - box.y * z });
  };

  /** Typing somewhere that takes text: the key is the field's, not the canvas's. */
  const typing = (e: KeyboardEvent): boolean =>
    editingText !== null || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement || (e.target instanceof HTMLElement && e.target.isContentEditable);

  /**
   * The keyboard, while this editor has it (`keysOwner`): the common canvas keys —
   *
   *   Ctrl+Z  undo · Ctrl+Shift+Z, Ctrl+Y  redo · Ctrl+C / X / V  copy, cut, paste · Ctrl+D  duplicate
   *   Delete, Backspace  delete · arrows  nudge (Shift: 10 px) · Enter  edit the text · Esc  stop, let go
   *   Ctrl+= / Ctrl+-  zoom in, out · Ctrl+0  100% · Shift+1  fit · Shift+2  zoom to the selection
   *   Ctrl+\  the properties panel · Space held  pan · a tool's letter  that tool
   *
   * Cmd for Ctrl on a Mac. Read through a ref, so the one listener always sees this render's state.
   */
  const onKey = (e: KeyboardEvent): void => {
    if (keysOwner !== keysId || typing(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if ((e.code === "Space" || e.key === " ") && !mod) {
      if (!e.repeat) setSpaceHeld(true);
      e.preventDefault();
      return;
    }
    if (mod && !e.altKey) {
      const act = (run: () => void): void => {
        e.preventDefault();
        run();
      };
      if (k === "z") act(e.shiftKey ? redo : undo);
      else if (k === "y") act(redo);
      else if (k === "c" || k === "x") {
        // Words selected on the page are the page's to copy.
        const words = window.getSelection();
        if (words !== null && !words.isCollapsed) return;
        const clip = clipOf(selection);
        if (clip === null) return;
        act(() => {
          clipboard = { clip, pasted: 0 };
          if (k === "x") remove();
        });
      } else if (k === "v") {
        const held = clipboard;
        if (held === null) return;
        act(() => {
          held.pasted += 1;
          paste(held.clip, held.pasted);
        });
      } else if (k === "d") {
        const clip = clipOf(selection);
        if (clip !== null) act(() => paste(clip, 1));
      } else if (k === "=" || k === "+") act(() => zoomTo(Math.min(4, view.z * 1.25)));
      else if (k === "-" || k === "_") act(() => zoomTo(Math.max(0.05, view.z / 1.25)));
      else if (k === "0") act(() => zoomTo(1));
      else if (e.key === "\\") act(() => setPanelOpen((was) => !was));
      return;
    }
    if (e.altKey) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove();
      return;
    }
    if (e.key === "Escape") {
      // What runs stops first; then the comment, the selection and the tool are let go.
      if (running.size > 0 || full !== null) {
        setRunning(new Set());
        setFull(null);
        return;
      }
      setDraft(null);
      setOpenPin(null);
      setSelection(null);
      setTool("pointer");
      return;
    }
    if (e.shiftKey && (e.code === "Digit1" || e.key === "!")) {
      e.preventDefault();
      fit();
      return;
    }
    if (e.shiftKey && (e.code === "Digit2" || e.key === "@")) {
      e.preventDefault();
      zoomToSelection();
      return;
    }
    const arrow = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
    if (arrow !== undefined) {
      const step = e.shiftKey ? 10 : 1;
      if (nudge(arrow[0] * step, arrow[1] * step)) e.preventDefault();
      return;
    }
    if (e.key === "Enter") {
      if (selection?.kind === "note" && index.notes?.[selection.id] !== undefined) {
        e.preventDefault();
        setEditingText({ note: selection.id, text: index.notes[selection.id]!.text ?? "" });
      } else if (selection?.kind === "element" && typeof selection.text === "string") {
        e.preventDefault();
        setEditingText({ file: selection.file, id: selection.id, rect: selection.rect, text: selection.text });
      }
      return;
    }
    const picked = e.shiftKey && k === "l" ? "arrow" : SHORTCUT[k];
    if (picked !== undefined) pickTool(picked);
  };
  const keyHandler = useRef(onKey);
  keyHandler.current = onKey;
  useEffect(() => {
    watchKeysOwner();
    const down = (e: KeyboardEvent): void => keyHandler.current(e);
    // Space let go, or the window left: the tool is what it was.
    const up = (e: KeyboardEvent): void => {
      if (e.code === "Space" || e.key === " ") setSpaceHeld(false);
    };
    const blur = (): void => setSpaceHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // --- the board's gestures --------------------------------------------------------------------------

  /** Zoom to `z`, the board's middle kept where it is. */
  const zoomTo = (z: number): void => {
    const el = board.current;
    if (el === null) return;
    moved.current = true;
    const mx = el.clientWidth / 2;
    const my = el.clientHeight / 2;
    setView((v) => ({ z, x: mx - ((mx - v.x) * z) / v.z, y: my - ((my - v.y) * z) / v.z }));
  };

  /** Pan so an artboard stands in the middle of the board, at the zoom it is at. */
  const bringIntoView = (file: string): void => {
    const el = board.current;
    const b = index.boards[file];
    if (el === null || b === undefined) return;
    moved.current = true;
    setView((v) => ({ ...v, x: (el.clientWidth - b.w * v.z) / 2 - b.x * v.z, y: (el.clientHeight - b.h * v.z) / 2 - b.y * v.z }));
  };

  const run = (file: string): void => {
    setRunning((was) => new Set(was).add(file));
    if (selection !== null && selection.kind !== "note" && selection.file === file) setSelection(null);
  };
  const stop = (file: string): void =>
    setRunning((was) => {
      const next = new Set(was);
      next.delete(file);
      return next;
    });

  /** Pick a tool; one of a group is what that group's button stands for from then on. */
  const pickTool = (next: CanvasTool): void => {
    setTool(next);
    const group = groupOf(next);
    if (group !== undefined) setGroupPick((was) => ({ ...was, [group]: next }));
  };

  /** A pan from a press anywhere — the middle button on a label, a note, a handle — as the board's own. */
  const startPan = (e: ReactPointerEvent<Element>): void => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setGesture({ kind: "pan", from: { x: e.clientX, y: e.clientY }, view });
  };

  /** A pointer's place in board space. */
  const at = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = board.current!.getBoundingClientRect();
    return { x: (e.clientX - rect.left - view.x) / view.z, y: (e.clientY - rect.top - view.y) / view.z };
  };

  useEffect(() => {
    const el = board.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      moved.current = true;
      e.preventDefault();
      setView((v) => {
        if (!e.ctrlKey) return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY };
        const rect = el.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const z = Math.min(4, Math.max(0.05, v.z * Math.exp(-e.deltaY * 0.0015)));
        return { z, x: px - ((px - v.x) * z) / v.z, y: py - ((py - v.y) * z) / v.z };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /** The capture layer over the board: every tool but pointer and text draws or pans here, never in a frame. */
  const onLayerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 && e.button !== 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = at(e);
    if (tool === "hand" || e.button === 1 || spaceHeld) {
      setGesture({ kind: "pan", from: { x: e.clientX, y: e.clientY }, view });
      return;
    }
    if (tool === "note") {
      // The note's text box takes the focus as it mounts; the press's own mousedown would take it back
      // to the board, and the note would be committed empty before a word was typed.
      e.preventDefault();
      const id = noteId();
      changeIndex((was) => ({ ...was, notes: { ...(was.notes ?? {}), [id]: { x: p.x, y: p.y, text: "", w: 220 } } }));
      setSelection({ kind: "note", id });
      setEditingText({ note: id, text: "" });
      setTool("pointer");
      return;
    }
    if (tool === "pointer" || tool === "comment") {
      // On the board itself, not on a frame or note: nothing selected, no comment open, and a drag pans.
      setSelection(null);
      setDraft(null);
      setOpenPin(null);
      setGesture({ kind: "pan", from: { x: e.clientX, y: e.clientY }, view });
      return;
    }
    setGesture({ kind: "draw", tool, start: p, now: p, points: [[0, 0]] });
  };

  const onLayerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (gesture === null) return;
    const p = at(e);
    if (gesture.kind === "pan") {
      moved.current = true;
      setView({ ...gesture.view, x: gesture.view.x + e.clientX - gesture.from.x, y: gesture.view.y + e.clientY - gesture.from.y });
    } else if (gesture.kind === "moveBoard") {
      if (!gestureMoved.current) checkpoint();
      gestureMoved.current = true;
      const dx = p.x - gesture.from.x;
      const dy = p.y - gesture.from.y;
      setIndex((was) => ({ ...was, boards: { ...was.boards, [gesture.file]: { ...was.boards[gesture.file]!, x: Math.round(gesture.at.x + dx), y: Math.round(gesture.at.y + dy) } } }));
    } else if (gesture.kind === "resizeBoard") {
      if (!gestureMoved.current) checkpoint();
      gestureMoved.current = true;
      setIndex((was) => ({
        ...was,
        boards: { ...was.boards, [gesture.file]: { ...was.boards[gesture.file]!, w: Math.max(40, Math.min(8000, Math.round(gesture.size.w + p.x - gesture.from.x))), h: Math.max(40, Math.min(8000, Math.round(gesture.size.h + p.y - gesture.from.y))) } },
      }));
    } else if (gesture.kind === "moveNote") {
      if (!gestureMoved.current) checkpoint();
      gestureMoved.current = true;
      const dx = p.x - gesture.from.x;
      const dy = p.y - gesture.from.y;
      setIndex((was) => {
        const note = was.notes?.[gesture.id];
        if (note === undefined) return was;
        return {
          ...was,
          notes: {
            ...was.notes,
            [gesture.id]: { ...note, x: Math.round(gesture.at.x + dx), y: Math.round(gesture.at.y + dy), ...(gesture.end !== undefined ? { x2: Math.round(gesture.end.x + dx), y2: Math.round(gesture.end.y + dy) } : {}) },
          },
        };
      });
    } else {
      setGesture({ ...gesture, now: p, points: gesture.tool === "pen" ? [...gesture.points, [Math.round(p.x - gesture.start.x), Math.round(p.y - gesture.start.y)]] : gesture.points });
    }
  };

  const onLayerUp = (): void => {
    const g = gesture;
    setGesture(null);
    if (g === null) return;
    const dragged = gestureMoved.current;
    gestureMoved.current = false;
    if (g.kind === "moveBoard" || g.kind === "resizeBoard" || g.kind === "moveNote") {
      // Only a drag is an edit: a press on an artboard's name that moved nothing was a version of
      // nothing (2026-11-07: v16 was canvas.json, reformatted), and hid the canvas from the thread.
      if (dragged) touch("project/canvas.json");
      return;
    }
    if (g.kind !== "draw") return;
    const x = Math.round(Math.min(g.start.x, g.now.x));
    const y = Math.round(Math.min(g.start.y, g.now.y));
    const w = Math.round(Math.abs(g.now.x - g.start.x));
    const h = Math.round(Math.abs(g.now.y - g.start.y));
    if (g.tool === "artboard") {
      const file = artboardFile(index);
      const size = { w: Math.max(w, 120), h: Math.max(h, 120) };
      const entry: CanvasBoardEntry = { x, y, w: size.w, h: size.h, title: file.replace(/\.dc\.html$/, "") };
      changeIndex((was) => ({ ...was, boards: { ...was.boards, [file]: entry }, order: [...(was.order ?? []), file] }));
      setSources((was) => ({ ...was, [`project/${file}`]: blankArtboard(size.w, size.h, entry.title!) }));
      touch(`project/${file}`);
      setSelection({ kind: "board", file });
    } else if (g.tool === "text") {
      const id = noteId();
      changeIndex((was) => ({ ...was, notes: { ...(was.notes ?? {}), [id]: { x: g.start.x, y: g.start.y, text: "", w: Math.max(w, 160), size: "l" } } }));
      setEditingText({ note: id, text: "" });
      setSelection({ kind: "note", id });
    } else {
      const id = noteId();
      const note: CanvasNote =
        g.tool === "pen"
          ? { kind: "pen", x: Math.round(g.start.x), y: Math.round(g.start.y), points: g.points }
          : g.tool === "line" || g.tool === "arrow"
            ? { kind: g.tool, x: Math.round(g.start.x), y: Math.round(g.start.y), x2: Math.round(g.now.x), y2: Math.round(g.now.y) }
            : { kind: g.tool, x, y, w: Math.max(w, 8), h: Math.max(h, 8) };
      if (g.tool !== "pen" && w < 4 && h < 4) return;
      changeIndex((was) => ({ ...was, notes: { ...(was.notes ?? {}), [id]: note } }));
      setSelection({ kind: "note", id });
    }
    pickTool("pointer");
  };

  // --- the selected element's properties -------------------------------------------------------------

  const element = selection?.kind === "element" ? selection : null;
  const styleRecord = useMemo(() => (element !== null ? readStyle(element.style) : {}), [element]);
  const setStyle = (name: string, value: string): void => {
    if (element === null) return;
    const next = { ...styleRecord };
    if (value.trim() === "") delete next[name];
    else next[name] = value;
    const text = formatStyle(next);
    changeSource(element.file, editStyle(sourceOf(element.file), element.id, text));
    setSelection({ ...element, style: text });
  };

  const selectedBoard = selection?.kind === "board" ? index.boards[selection.file] : undefined;
  const selectedNote = selection?.kind === "note" ? index.notes?.[selection.id] : undefined;

  // --- drawing ---------------------------------------------------------------------------------------

  const frameSrc = (file: string): string => `${(roots[file] ?? frames).replace(/\/+$/, "")}/project/${file.split("/").map(encodeURIComponent).join("/")}`;
  /** Hand a frame that has just loaded the editor's text, when its grant serves an older one. */
  const handSource = (file: string, w: Window | null | undefined): void => {
    if (w !== null && w !== undefined && sourceOf(file) !== granted.current[`project/${file}`]) w.postMessage({ type: "dc:source", text: sourceOf(file) }, "*");
  };
  const order = (index.order ?? []).filter((f) => index.boards[f] !== undefined && onPage(index.boards[f]!));
  const layerOn = spaceHeld || (tool !== "pointer" && tool !== "text" && tool !== "comment");
  const interactive = order.filter((f) => index.boards[f]!.is_interactive === true);
  /** Numbered as they were written: a pin keeps its number when others are resolved. */
  const numbered = comments.map((c, i) => ({ ...c, n: i + 1 })).filter((c) => index.boards[c.file] !== undefined);
  const shownPins = numbered.filter((c) => showResolved || c.resolvedAt === undefined);
  const openComment = openPin !== null ? numbered.find((c) => c.id === openPin) : undefined;

  const submitDraft = (): void => {
    if (draft === null || onComment === undefined || draft.text.trim() === "") return;
    const sent = draft;
    setDraft(null);
    void onComment(sent, base)
      .then((answer) => {
        if (answer.failure !== undefined) setStatus({ tone: "error", words: `Comment kept, not sent to Claude: ${answer.failure}` });
      })
      .catch((e: unknown) => setStatus({ tone: "error", words: `Comment not kept: ${e instanceof Error ? e.message : String(e)}` }));
  };

  if (full !== null && index.boards[full] !== undefined) {
    const b = index.boards[full]!;
    return (
      <div ref={fullBox} data-canvas-keys={keysId} style={{ ...shell, ...style }}>
        <div style={bar}>
          <button type="button" style={button} onClick={() => setFull(null)}>
            ← Back to the canvas
          </button>
          <span style={{ ...barText, fontWeight: 600, color: RUN }}>Running · {b.title ?? full}</span>
          <span style={{ flex: 1 }} />
          <button type="button" style={button} title="The whole screen" onClick={() => void fullBox.current?.requestFullscreen().catch(() => undefined)}>
            Full screen
          </button>
        </div>
        <div style={{ flex: 1, overflow: "auto", background: "#eceef3", display: "flex", justifyContent: "center", padding: b.expand === "fill" ? 0 : 24 }}>
          <iframe
            key={full}
            ref={(el) => {
              if (el !== null) frameEls.current.set(full, el);
            }}
            title={b.title ?? full}
            src={frameSrc(full)}
            sandbox="allow-scripts allow-same-origin allow-popups"
            allow="clipboard-write"
            onLoad={(e) => {
              const w = e.currentTarget.contentWindow;
              w?.postMessage({ type: "dc:mode", mode: "play" }, "*");
              handSource(full, w);
            }}
            style={{ width: b.expand === "fill" ? "100%" : b.w, height: b.expand === "fill" ? "100%" : b.h, border: 0, background: "#fff", flexShrink: 0 }}
          />
        </div>
      </div>
    );
  }

  /** A tool's button in the top-left bar. */
  const toolButtonFor = (t: (typeof TOOLS)[number], group?: ToolGroup): JSX.Element => (
    <span key={group ?? t.tool} style={{ display: "inline-flex", alignItems: "center" }}>
      <button
        type="button"
        title={`${t.label} (${t.key})`}
        aria-label={t.label}
        aria-pressed={tool === t.tool}
        onClick={() => pickTool(t.tool)}
        style={{ ...iconButton, background: tool === t.tool ? "var(--fill-ghost-selected, #e5e8f1)" : "transparent", color: tool === t.tool ? "var(--accent, #2563c7)" : "var(--text, #121526)" }}
      >
        <Glyph d={t.path} />
      </button>
      {group !== undefined ? (
        <button type="button" aria-label={`More ${group === "pen" ? "pen and line" : "shape"} tools`} aria-haspopup="menu" aria-expanded={menu?.kind === "group" && menu.group === group} onClick={(e) => openMenu({ kind: "group", group }, e.currentTarget)} style={{ ...iconButton, width: 14, color: "var(--dim, #5a5f7a)" }}>
          <Glyph d={CARET} size={10} />
        </button>
      ) : null}
    </span>
  );
  const toolOf = (which: CanvasTool): (typeof TOOLS)[number] => TOOLS.find((t) => t.tool === which)!;
  const pages = index.pages ?? [];

  return (
    <div data-canvas-keys={keysId} style={{ ...shell, ...style }}>
      <div style={{ position: "relative", display: "flex", flex: 1, minHeight: 0 }}>
        <div ref={board} onMouseDown={(e) => e.button === 1 && e.preventDefault()} style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden", background: "#eceef3", backgroundImage: "radial-gradient(#cfd3de 1px, transparent 1px)", backgroundSize: `${16 * view.z}px ${16 * view.z}px`, backgroundPosition: `${view.x}px ${view.y}px` }}>
          {/* Under the frames and notes: a press here pans, and empties the selection. */}
          <div onPointerDown={onLayerDown} onPointerMove={onLayerMove} onPointerUp={onLayerUp} style={{ position: "absolute", inset: 0, cursor: tool === "hand" ? "grab" : "default" }} />
          <div style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
            {Object.entries(index.notes ?? {})
              .filter(([, n]) => onPage(n))
              .map(([id, n]) => (
              <EditableNote
                key={id}
                note={n}
                selected={selection?.kind === "note" && selection.id === id}
                editing={editingText !== null && "note" in editingText && editingText.note === id}
                onPress={(e) => {
                  if (e.button === 1) {
                    startPan(e);
                    return;
                  }
                  e.stopPropagation();
                  if (tool !== "pointer") return;
                  setSelection({ kind: "note", id });
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setGesture({ kind: "moveNote", id, from: at(e), at: { x: n.x, y: n.y }, ...(n.x2 !== undefined && n.y2 !== undefined ? { end: { x: n.x2, y: n.y2 } } : {}) });
                }}
                onMove={onLayerMove}
                onUp={onLayerUp}
                onEdit={() => (n.kind === undefined || n.kind === "title1") && setEditingText({ note: id, text: n.text ?? "" })}
                onText={(text) => {
                  // A note left with nothing in it is not kept: a press with the note tool and no words.
                  changeIndex((was) => {
                    const notes = was.notes ?? {};
                    if (text.trim() === "" && notes[id]?.kind === undefined) {
                      const { [id]: _dropped, ...rest } = notes;
                      return { ...was, notes: rest };
                    }
                    return { ...was, notes: { ...notes, [id]: { ...notes[id]!, text } } };
                  });
                  setEditingText(null);
                }}
              />
            ))}
            {order.map((file) => {
              const b = index.boards[file]!;
              const chosen = selection !== null && selection.kind !== "note" && selection.file === file;
              return (
                <div key={file} style={{ position: "absolute", left: b.x, top: b.y, width: b.w, height: b.h }}>
                  <div
                    onPointerDown={(e) => {
                      if (e.button === 1) {
                        startPan(e);
                        return;
                      }
                      e.stopPropagation();
                      setSelection({ kind: "board", file });
                      e.currentTarget.setPointerCapture(e.pointerId);
                      setGesture({ kind: "moveBoard", file, from: at(e), at: { x: b.x, y: b.y } });
                    }}
                    onPointerMove={onLayerMove}
                    onPointerUp={onLayerUp}
                    style={{ position: "absolute", left: 0, bottom: "100%", width: b.w, boxSizing: "border-box", paddingBottom: 6 / Math.max(view.z, 0.25), fontSize: 13 / Math.max(view.z, 0.25), lineHeight: 1.2, color: chosen ? "#4a4fd1" : "#5a5f7a", whiteSpace: "nowrap", cursor: "move", userSelect: "none", display: "flex", gap: "0.4em", alignItems: "center" }}
                  >
                    {b.is_interactive === true ? <span title="Its controls respond" style={{ width: "0.6em", height: "0.6em", borderRadius: "50%", background: "#4a4fd1", display: "inline-block", flexShrink: 0 }} /> : null}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, ...(running.has(file) ? { color: RUN, fontWeight: 600 } : {}) }}>
                      {b.title ?? file.replace(/\.dc\.html$/, "")}
                      {running.has(file) ? " · running" : ""}
                    </span>
                    <span style={{ flex: 1 }} />
                    <LabelControls
                      interactive={b.is_interactive === true}
                      running={running.has(file)}
                      onRun={() => run(file)}
                      onStop={() => stop(file)}
                      onFull={() => {
                        stop(file);
                        setFull(file);
                      }}
                      {...(onExport !== undefined ? { onDownload: (anchor: Element) => openMenu({ kind: "download", file }, anchor) } : {})}
                    />
                  </div>
                  {!servable(file) ? (
                    <div style={{ width: b.w, height: b.h, background: "#fff", display: "grid", placeItems: "center", color: "#5a5f7a", fontSize: 13 / Math.max(view.z, 0.25), outline: chosen ? "2px solid #4a4fd1" : "none" }}>{dirty.size > 0 ? "Saving the new artboard…" : "Opening…"}</div>
                  ) : (
                  <iframe
                    key={`${file}#${String(fresh[file] ?? 0)}`}
                    ref={(el) => {
                      if (el !== null) frameEls.current.set(file, el);
                      else frameEls.current.delete(file);
                    }}
                    title={b.title ?? file}
                    src={frameSrc(file)}
                    sandbox="allow-scripts allow-same-origin allow-popups"
                    allow="clipboard-write"
                    onLoad={(e) => {
                      const w = e.currentTarget.contentWindow;
                      w?.postMessage({ type: "dc:mode", mode: modeOf(file) }, "*");
                      // Changed here since its grant's version: hand it the text it should show.
                      handSource(file, w);
                    }}
                    style={{
                      width: b.w,
                      height: b.h,
                      border: 0,
                      display: "block",
                      background: "#fff",
                      pointerEvents: layerOn && !running.has(file) ? "none" : "auto",
                      outline: running.has(file) ? `${2 / view.z}px solid ${RUN}` : chosen ? "2px solid #4a4fd1" : "none",
                      boxShadow: running.has(file) ? `0 0 0 ${6 / view.z}px rgba(15,122,69,.14)` : "none",
                      borderRadius: b.radius ?? 0,
                    }}
                  />
                  )}
                  {selection?.kind === "element" && selection.file === file ? (
                    <div style={{ position: "absolute", left: selection.rect.x, top: selection.rect.y, width: selection.rect.width, height: selection.rect.height, outline: `${1.5 / view.z}px solid #4a4fd1`, pointerEvents: "none" }} />
                  ) : null}
                  {editingText !== null && "file" in editingText && editingText.file === file ? (
                    <textarea
                      autoFocus
                      defaultValue={editingText.text}
                      onBlur={(e) => {
                        changeSource(file, editText(sourceOf(file), editingText.id, e.currentTarget.value));
                        setEditingText(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setEditingText(null);
                        if (e.key === "Enter" && !e.shiftKey) e.currentTarget.blur();
                      }}
                      style={{ position: "absolute", left: editingText.rect.x, top: editingText.rect.y, width: Math.max(editingText.rect.width, 80), height: Math.max(editingText.rect.height, 24), font: "inherit", border: "1.5px solid #4a4fd1", background: "#fff", padding: 0, resize: "none" }}
                    />
                  ) : null}
                  {chosen && selection?.kind === "board" ? (
                    <div
                      title="Resize"
                      onPointerDown={(e) => {
                        if (e.button === 1) {
                          startPan(e);
                          return;
                        }
                        e.stopPropagation();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        setGesture({ kind: "resizeBoard", file, from: at(e), size: { w: b.w, h: b.h } });
                      }}
                      onPointerMove={onLayerMove}
                      onPointerUp={onLayerUp}
                      style={{ position: "absolute", right: -6 / view.z, bottom: -6 / view.z, width: 12 / view.z, height: 12 / view.z, background: "#fff", border: `${1.5 / view.z}px solid #4a4fd1`, cursor: "nwse-resize" }}
                    />
                  ) : null}
                </div>
              );
            })}
            {gesture?.kind === "draw" ? <DrawingPreview gesture={gesture} /> : null}
            {shownPins.map((c) => {
              const b = index.boards[c.file]!;
              return (
                <Pin
                  key={c.id}
                  {...(openPin === c.id && draft === null ? { ref: pinRef } : {})}
                  n={c.n}
                  at={{ x: b.x + c.x, y: b.y + c.y }}
                  zoom={view.z}
                  open={openPin === c.id}
                  resolved={c.resolvedAt !== undefined}
                  onOpen={() => {
                    setDraft(null);
                    setOpenPin(openPin === c.id ? null : c.id);
                  }}
                />
              );
            })}
            {draft !== null && index.boards[draft.file] !== undefined ? (
              <>
                <Pin ref={pinRef} n={numbered.length + 1} at={{ x: index.boards[draft.file]!.x + draft.x, y: index.boards[draft.file]!.y + draft.y }} zoom={view.z} open resolved={false} onOpen={() => undefined} />
              </>
            ) : null}
          </div>
          {/* A comment's box: a float against its pin, so a narrow board never clips it. */}
          {draft !== null && index.boards[draft.file] !== undefined ? (
            <Popover data-canvas-keys={keysId} anchor={pinRef} side="right" align="start" gap={8} style={{ width: 260 }} onPointerDown={(e) => e.stopPropagation()}>
              <CommentBox draft={draft} onChange={setDraft} onSubmit={submitDraft} onCancel={() => setDraft(null)} />
            </Popover>
          ) : null}
          {openComment !== undefined && draft === null ? (
            <Popover data-canvas-keys={keysId} anchor={pinRef} side="right" align="start" gap={8} style={{ width: 260 }} onPointerDown={(e) => e.stopPropagation()}>
              <CommentCard
                comment={openComment}
                boardTitle={index.boards[openComment.file]!.title ?? openComment.file}
                onClose={() => setOpenPin(null)}
                onSettle={(change) => {
                  onSettleComment?.(openComment.id, change);
                  if (change.removed === true || change.resolved === true) setOpenPin(null);
                }}
              />
            </Popover>
          ) : null}
          {/* Over the frames while a drawing tool is held, so a frame never takes the gesture. */}
          {layerOn ? <div onPointerDown={onLayerDown} onPointerMove={onLayerMove} onPointerUp={onLayerUp} style={{ position: "absolute", inset: 0, cursor: tool === "hand" || spaceHeld ? (gesture?.kind === "pan" ? "grabbing" : "grab") : "crosshair" }} /> : null}
        </div>
        {/*
          The canvas's own chrome, floating over the board as Claude Code's does (the person, 2026-11-07):
          the tools at the top left, running, the panel and the zoom at the top right.
        */}
        <div role="toolbar" aria-label="Tools" style={{ ...floatBar, left: 8, flexWrap: "wrap", maxWidth: "calc(100% - 16px)", overflowX: "visible" }}>
          {pages.length > 1 ? (
            <>
              <button type="button" aria-label="Page" aria-haspopup="menu" onClick={(e) => openMenu({ kind: "pages" }, e.currentTarget)} style={{ ...textButton, maxWidth: 180 }}>
                <span style={{ ...countChip }}>{pages.length}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{pages.find((p) => p.id === page)?.name ?? "Page"}</span>
                <Glyph d={CARET} size={10} />
              </button>
              <span style={divider} />
            </>
          ) : null}
          {(["pointer", "hand", "text", "artboard", "note"] as const).map((which) => toolButtonFor(toolOf(which)))}
          {toolButtonFor(toolOf(groupPick.pen), "pen")}
          {toolButtonFor(toolOf(groupPick.shape), "shape")}
          {onComment !== undefined ? toolButtonFor(toolOf("comment")) : null}
        </div>
        <div role="toolbar" aria-label="Canvas" style={{ ...floatBar, right: 8, maxWidth: "calc(100% - 16px)", ...(stacked ? { top: "auto", bottom: 8 } : {}) }}>
          <span style={{ ...barText, ...shrinks, maxWidth: 220, padding: "0 4px", color: status?.tone === "refused" || status?.tone === "error" ? "#d6453d" : "var(--dim, #5a5f7a)" }} title={status?.words ?? `v${String(base)}`}>
            {status?.words ?? (dirty.size > 0 ? "Unsaved" : `v${String(base)}`)}
          </span>
          {status?.tone === "refused" ? (
            <button type="button" style={textButton} onClick={onReload}>
              Reload
            </button>
          ) : null}
          {interactive.length > 0 ? (
            running.size > 0 ? (
              <button type="button" aria-label="Stop every running artboard" title="Stop every running artboard (Esc)" onClick={() => setRunning(new Set())} style={{ ...iconButton, color: RUN }}>
                <Glyph d={STOP} filled />
              </button>
            ) : (
              <button type="button" aria-label="Run canvas" title="Run every interactive artboard where it sits" onClick={() => setRunning(new Set(interactive))} style={iconButton}>
                <Glyph d={PLAY} />
              </button>
            )
          ) : null}
          <button type="button" aria-label="Properties panel" aria-pressed={panelOpen} title="Properties, tweaks, layers and comments (Ctrl+\)" onClick={() => setPanelOpen((was) => !was)} style={{ ...iconButton, background: panelOpen ? "var(--fill-ghost-selected, #e5e8f1)" : "transparent" }}>
            <Glyph d={SLIDERS} />
          </button>
          <button type="button" aria-label="Zoom" aria-haspopup="menu" title="Zoom" onClick={(e) => openMenu({ kind: "zoom" }, e.currentTarget)} style={{ ...textButton, fontVariantNumeric: "tabular-nums" }}>
            {Math.round(view.z * 100)}%
            <Glyph d={CARET} size={10} />
          </button>
        </div>
        <aside aria-label="Properties" style={{ ...panel, display: panelOpen ? "flex" : "none", ...(stacked ? { top: 84, bottom: 50 } : {}) }}>
          <div role="tablist" style={{ display: "flex", borderBottom: "1px solid var(--line, #e0e3ec)", padding: "0 10px" }}>
            {(onComment !== undefined ? (["properties", "tweaks", "layers", "comments"] as const) : (["properties", "tweaks", "layers"] as const)).map((id) => (
              <button key={id} role="tab" type="button" aria-selected={tab === id} onClick={() => setTab(id)} style={{ ...tabButton, color: tab === id ? "var(--text, #121526)" : "var(--dim, #5a5f7a)", fontWeight: tab === id ? 600 : 400, boxShadow: tab === id ? "inset 0 -2px 0 var(--accent, #4a4fd1)" : "none" }}>
                {id === "properties" ? "Properties" : id === "tweaks" ? "Tweaks" : id === "layers" ? "Layers" : `Comments${numbered.some((c) => c.resolvedAt === undefined) ? ` ${String(numbered.filter((c) => c.resolvedAt === undefined).length)}` : ""}`}
              </button>
            ))}
          </div>
          <div style={{ overflow: "auto", flex: 1 }}>
            {tab === "properties" ? (
              element !== null ? (
                <ElementProperties
                  tag={element.tag}
                  style={styleRecord}
                  onStyle={setStyle}
                  onDelete={remove}
                  onWrap={(as) => {
                    changeSource(element.file, wrapElement(sourceOf(element.file), element.id, as));
                    // A new element before it renumbers what follows: the selection is let go.
                    setSelection(null);
                  }}
                />
              ) : selectedBoard !== undefined && selection?.kind === "board" ? (
                <BoardProperties
                  file={selection.file}
                  board={selectedBoard}
                  onChange={(next) => changeIndex((was) => ({ ...was, boards: { ...was.boards, [selection.file]: { ...was.boards[selection.file]!, ...next } } }))}
                  onDelete={remove}
                />
              ) : selectedNote !== undefined && selection?.kind === "note" ? (
                <NoteProperties note={selectedNote} onChange={(next) => changeIndex((was) => ({ ...was, notes: { ...was.notes, [selection.id]: { ...was.notes![selection.id]!, ...next } } }))} onDelete={remove} />
              ) : (
                <p style={hint}>Select an artboard, a note or anything in an artboard. Delete removes it; Esc lets go.</p>
              )
            ) : tab === "tweaks" ? (
              <TweaksTab
                file={selection !== null && selection.kind !== "note" ? selection.file : order[0]}
                source={(file) => sourceOf(file)}
                // A tweak is kept as the prop's default in the artboard's `data-props`: saved with the
                // canvas, and drawn again from the source like every other change.
                onChange={(file, name, value) => changeSource(file, setPropDefault(sourceOf(file), name, value))}
              />
            ) : (
              tab === "layers" ? (
                <Layers order={order} index={index} selection={selection} onPick={(s) => setSelection(s)} />
              ) : (
                <CommentList
                  comments={numbered}
                  index={index}
                  showResolved={showResolved}
                  onShowResolved={setShowResolved}
                  onPick={(c) => {
                    setDraft(null);
                    setOpenPin(c.id);
                    if (c.resolvedAt !== undefined) setShowResolved(true);
                    bringIntoView(c.file);
                  }}
                />
              )
            )}
          </div>
        </aside>
      </div>
      {menu !== null ? (
        <Popover ref={menuBox} data-canvas-keys={keysId} anchor={menuAnchor} side="below" align={menu.kind === "zoom" || menu.kind === "download" ? "end" : "start"} gap={4} role="menu" style={menuCard} onPointerDown={(e) => e.stopPropagation()}>
          {menu.kind === "group"
            ? GROUPS[menu.group].map((which) => {
                const t = toolOf(which);
                return (
                  <button
                    key={which}
                    type="button"
                    role="menuitem"
                    aria-label={t.label}
                    onClick={() => {
                      pickTool(which);
                      setMenu(null);
                    }}
                    style={{ ...menuItem, color: tool === which ? "var(--accent, #2563c7)" : "inherit" }}
                  >
                    <Glyph d={t.path} />
                    <span style={{ flex: 1 }}>{t.label}</span>
                    <span style={{ color: "var(--dim, #5a5f7a)", fontSize: 11 }}>{t.key}</span>
                  </button>
                );
              })
            : menu.kind === "zoom"
              ? (
                  [
                    ["Zoom in", () => zoomTo(Math.min(4, view.z * 1.25)), `${MOD}+=`],
                    ["Zoom out", () => zoomTo(Math.max(0.05, view.z / 1.25)), `${MOD}+-`],
                    ["Zoom to fit", () => fit(), "Shift+1"],
                    ["Zoom to selection", () => zoomToSelection(), "Shift+2"],
                    ["50%", () => zoomTo(0.5), ""],
                    ["100%", () => zoomTo(1), `${MOD}+0`],
                    ["200%", () => zoomTo(2), ""],
                  ] as const
                ).map(([label, act, keys]) => (
                  <button
                    key={label}
                    type="button"
                    role="menuitem"
                    disabled={label === "Zoom to selection" && selection === null}
                    onClick={() => {
                      act();
                      setMenu(null);
                    }}
                    style={{ ...menuItem, opacity: label === "Zoom to selection" && selection === null ? 0.45 : 1 }}
                  >
                    <span style={{ flex: 1 }}>{label}</span>
                    {keys !== "" ? <span style={{ color: "var(--dim, #5a5f7a)", fontSize: 11 }}>{keys}</span> : null}
                  </button>
                ))
              : menu.kind === "pages"
                ? pages.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setPage(p.id);
                        setSelection(null);
                        setMenu(null);
                      }}
                      style={{ ...menuItem, fontWeight: p.id === page ? 600 : 400 }}
                    >
                      {p.name}
                    </button>
                  ))
                : onExport !== undefined
                  ? (["png", "pdf"] as const).map((format) => (
                      <button
                        key={format}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          const b = index.boards[menu.file];
                          if (b !== undefined) onExport(menu.file, format, { width: b.w, height: b.h });
                          setMenu(null);
                        }}
                        style={menuItem}
                      >
                        {format === "png" ? "PNG image" : "PDF document"}
                      </button>
                    ))
                  : null}
        </Popover>
      ) : null}
    </div>
  );
}

/**
 * An artboard's controls at the right of its label (Claude Code's canvas): ▶ runs an interactive one where
 * it sits, ■ stops it; ⤢ shows it on its own, filling the editor; ⬇ saves it as a picture or a document.
 */
function LabelControls({ interactive, running, onRun, onStop, onFull, onDownload }: { interactive: boolean; running: boolean; onRun: () => void; onStop: () => void; onFull: () => void; onDownload?: (anchor: Element) => void }): JSX.Element {
  // The label drags its artboard: a press on a control is the control's.
  const own = { onPointerDown: (e: ReactPointerEvent) => e.button === 0 && e.stopPropagation() };
  const chip: CSSProperties = { font: "inherit", fontSize: "1em", lineHeight: 1, width: "1.5em", height: "1.5em", padding: 0, display: "inline-grid", placeItems: "center", border: 0, borderRadius: "0.3em", background: "transparent", color: "#5a5f7a", cursor: "pointer", flexShrink: 0 };
  return (
    <>
      {interactive ? (
        running ? (
          <button type="button" {...own} onClick={onStop} title="Stop running it" aria-label="Stop" style={{ ...chip, background: RUN, color: "#fff" }}>
            <Glyph d={STOP} filled size="0.9em" />
          </button>
        ) : (
          <button type="button" {...own} onClick={onRun} title="Run it where it sits" aria-label="Run" style={{ ...chip, color: RUN }}>
            <Glyph d={PLAY} size="0.9em" />
          </button>
        )
      ) : null}
      <button type="button" {...own} onClick={onFull} title={interactive ? "Run it on its own, filling the editor" : "See it on its own, filling the editor"} aria-label="Open it on its own" style={chip}>
        <Glyph d={EXPAND} size="0.9em" />
      </button>
      {onDownload !== undefined ? (
        <button type="button" {...own} onClick={(e) => onDownload(e.currentTarget)} title="Save it as a picture or a document" aria-label="Download" aria-haspopup="menu" style={chip}>
          <Glyph d={DOWNLOAD} size="0.9em" />
        </button>
      ) : null}
    </>
  );
}

/** A line icon on the editor's 24-unit grid, in the colour of its text. */
function Glyph({ d, size = 16, filled = false }: { d: string; size?: number | string; filled?: boolean }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      <path d={d} />
    </svg>
  );
}


/** A comment's pin: its point at the place it was put, its number in it. */
function Pin({ n, at, zoom, open, resolved, onOpen, ref }: { n: number; at: { x: number; y: number }; zoom: number; open: boolean; resolved: boolean; onOpen: () => void; ref?: Ref<HTMLButtonElement> }): JSX.Element {
  // Drawn after the frames, so over them: no z-index (floats are popover.tsx's).
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Comment ${String(n)}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onOpen}
      style={{
        position: "absolute",
        left: at.x,
        top: at.y,
        width: 24,
        height: 24,
        // The pin's point is its bottom-left corner, at the place.
        transform: `scale(${1 / zoom}) translateY(-100%)`,
        transformOrigin: "0 0",
        borderRadius: "12px 12px 12px 2px",
        border: "2px solid #fff",
        background: resolved ? "#949cad" : "#2563c7",
        color: "#fff",
        font: "600 11px/20px system-ui, sans-serif",
        textAlign: "center",
        padding: 0,
        cursor: "pointer",
        boxShadow: open ? "0 0 0 3px rgba(37,99,199,.35), 0 2px 6px rgba(18,21,38,.3)" : "0 2px 6px rgba(18,21,38,.3)",
      }}
    >
      {n}
    </button>
  );
}

const card: CSSProperties = { width: "100%", boxSizing: "border-box", gridTemplateColumns: "minmax(0, 1fr)", background: "var(--panel, #fff)", color: "var(--text, #121526)", border: "1px solid var(--line, #e0e3ec)", borderRadius: 8, boxShadow: "0 10px 28px rgba(18,21,38,.2)", padding: 10, display: "grid", gap: 8, fontSize: 12.5 };

/** What the element under a comment is called: its tag and its own words. */
const elementLabel = (element: CanvasComment["element"]): string => (element === undefined ? "" : `<${element.tag}>${element.text !== undefined ? ` “${element.text.slice(0, 40)}”` : ""}`);

/** A comment being written: its words, whether Claude takes it as a request, and Comment. */
function CommentBox({ draft, onChange, onSubmit, onCancel }: { draft: CommentDraft; onChange: (next: CommentDraft) => void; onSubmit: () => void; onCancel: () => void }): JSX.Element {
  return (
    <div style={card} role="dialog" aria-label="New comment">
      {draft.element !== undefined ? <div style={{ fontSize: 11, color: "var(--dim, #5a5f7a)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>On {elementLabel(draft.element)}</div> : null}
      <textarea
        autoFocus
        aria-label="Comment"
        placeholder="Write a comment"
        value={draft.text}
        onChange={(e) => onChange({ ...draft, text: e.currentTarget.value })}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onSubmit();
        }}
        rows={3}
        style={{ font: "inherit", fontSize: 12.5, resize: "vertical", border: "1px solid var(--line, #e0e3ec)", borderRadius: 6, padding: "6px 7px", background: "var(--panel, #fff)", color: "inherit" }}
      />
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--dim, #5a5f7a)", cursor: "pointer" }} title="Claude takes it as a request, in this conversation; unticked, it is a note for people">
          <input type="checkbox" checked={draft.toClaude} onChange={(e) => onChange({ ...draft, toClaude: e.currentTarget.checked })} />
          Send to Claude
        </label>
        <span style={{ flex: 1 }} />
        <button type="button" style={button} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" style={{ ...button, background: "#2563c7", borderColor: "#2563c7", color: "#fff", opacity: draft.text.trim() === "" ? 0.5 : 1 }} disabled={draft.text.trim() === ""} onClick={onSubmit}>
          Comment
        </button>
      </div>
    </div>
  );
}

/** An opened pin: what was written, where it went, and Resolve / Delete. */
function CommentCard({ comment: c, boardTitle, onClose, onSettle }: { comment: CanvasComment & { n: number }; boardTitle: string; onClose: () => void; onSettle: (change: { resolved?: boolean; removed?: boolean }) => void }): JSX.Element {
  return (
    <div style={card} role="dialog" aria-label={`Comment ${String(c.n)}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--dim, #5a5f7a)" }}>
        <span style={{ fontWeight: 600, color: "var(--text, #121526)" }}>#{c.n}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {boardTitle}
          {c.element !== undefined ? ` · ${elementLabel(c.element)}` : ""}
        </span>
        <button type="button" aria-label="Close" onClick={onClose} style={{ ...button, border: 0, padding: "0 4px" }}>
          ×
        </button>
      </div>
      <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{c.text}</div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 11, color: "var(--dim, #5a5f7a)" }}>
        <span>{c.toClaude ? (c.sentAt !== undefined ? `Sent to Claude · ${new Date(c.sentAt).toLocaleString()}` : "For Claude · not sent") : `Note · ${new Date(c.createdAt).toLocaleString()}`}</span>
        <span style={{ flex: 1 }} />
        <button type="button" style={button} onClick={() => onSettle({ resolved: c.resolvedAt === undefined })}>
          {c.resolvedAt === undefined ? "Resolve" : "Reopen"}
        </button>
        <button type="button" style={button} onClick={() => onSettle({ removed: true })}>
          Delete
        </button>
      </div>
    </div>
  );
}

/** Every comment, in the order written: a press opens its pin and brings its artboard into view. */
function CommentList({
  comments,
  index,
  showResolved,
  onShowResolved,
  onPick,
}: {
  comments: Array<CanvasComment & { n: number }>;
  index: CanvasIndex;
  showResolved: boolean;
  onShowResolved: (show: boolean) => void;
  onPick: (comment: CanvasComment) => void;
}): JSX.Element {
  const shown = comments.filter((c) => showResolved || c.resolvedAt === undefined);
  const resolved = comments.filter((c) => c.resolvedAt !== undefined).length;
  return (
    <div style={{ padding: "8px 10px", display: "grid", gap: 6 }}>
      {comments.length === 0 ? <p style={{ ...hint, margin: 0 }}>No comments yet. Pick the comment tool (C) and press on an artboard.</p> : null}
      {shown.map((c) => (
        <button key={c.id} type="button" onClick={() => onPick(c)} style={{ ...layer, display: "grid", gap: 2, padding: "6px 4px", whiteSpace: "normal", borderBottom: "1px solid var(--line, #e0e3ec)", opacity: c.resolvedAt !== undefined ? 0.6 : 1 }}>
          <span style={{ fontSize: 11, color: "var(--dim, #5a5f7a)" }}>
            #{c.n} · {index.boards[c.file]?.title ?? c.file}
            {c.toClaude ? " · to Claude" : ""}
            {c.resolvedAt !== undefined ? " · resolved" : ""}
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{c.text}</span>
        </button>
      ))}
      {resolved > 0 ? (
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, color: "var(--dim, #5a5f7a)", marginTop: 4 }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => onShowResolved(e.currentTarget.checked)} />
          Show {resolved} resolved
        </label>
      ) : null}
    </div>
  );
}

/** A note on the board, as the person edits it: dragged by itself, and its text typed in place. */
function EditableNote({
  note: n,
  selected,
  editing,
  onPress,
  onMove,
  onUp,
  onEdit,
  onText,
}: {
  note: CanvasNote;
  selected: boolean;
  editing: boolean;
  onPress: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onUp: () => void;
  onEdit: () => void;
  onText: (text: string) => void;
}): JSX.Element {
  const ring: CSSProperties = selected ? { outline: "2px solid #4a4fd1", outlineOffset: 2 } : {};
  const ink = n.color ?? "#d6453d";
  if (n.kind === "line" || n.kind === "arrow" || n.kind === "pen") {
    const points: Array<[number, number]> = n.kind === "pen" ? (n.points ?? []) : [[0, 0], [(n.x2 ?? n.x + 100) - n.x, (n.y2 ?? n.y) - n.y]];
    if (points.length < 2) return <></>;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const left = Math.min(...xs) - 8;
    const top = Math.min(...ys) - 8;
    const d = points.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px - left} ${py - top}`).join(" ");
    const [ex, ey] = points.at(-1)!;
    const [sx, sy] = points.at(-2)!;
    const angle = Math.atan2(ey - sy, ex - sx);
    const head = (a: number): string => `M${ex - left} ${ey - top} L${ex - left - 12 * Math.cos(angle + a)} ${ey - top - 12 * Math.sin(angle + a)}`;
    return (
      <div onPointerDown={onPress} onPointerMove={onMove} onPointerUp={onUp} style={{ position: "absolute", left: n.x + left, top: n.y + top, width: Math.max(...xs) - Math.min(...xs) + 16, height: Math.max(...ys) - Math.min(...ys) + 16, cursor: "move", ...ring }}>
        <svg width="100%" height="100%" style={{ overflow: "visible" }} aria-hidden="true">
          <path d={d} fill="none" stroke={ink} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
          {n.kind === "arrow" ? <path d={`${head(0.45)} ${head(-0.45)}`} fill="none" stroke={ink} strokeWidth={2.5} strokeLinecap="round" /> : null}
        </svg>
      </div>
    );
  }
  if (n.kind === "rect" || n.kind === "oval") {
    return <div onPointerDown={onPress} onPointerMove={onMove} onPointerUp={onUp} style={{ position: "absolute", left: n.x, top: n.y, width: n.w ?? 120, height: n.h ?? 80, border: `2px solid ${ink}`, borderRadius: n.kind === "oval" ? "50%" : 2, cursor: "move", ...ring }} />;
  }
  const title = n.kind === "title1";
  const box: CSSProperties = title
    ? { position: "absolute", left: n.x, top: n.y, width: "max-content", maxWidth: n.maxW, fontSize: 72, fontWeight: 700, lineHeight: 1.05, color: "#121526" }
    : { position: "absolute", left: n.x, top: n.y, width: n.w ?? 220, minHeight: 60, padding: "12px 14px", background: "#fdf3c4", boxShadow: "0 1px 2px rgba(0,0,0,.12)", borderRadius: 2, fontSize: 16, color: "#2b2a24", whiteSpace: "pre-wrap" };
  if (editing) {
    return (
      <textarea
        autoFocus
        defaultValue={n.text ?? ""}
        onBlur={(e) => onText(e.currentTarget.value)}
        onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
        style={{ ...box, font: "inherit", fontSize: box.fontSize, border: "1.5px solid #4a4fd1", resize: "none" }}
      />
    );
  }
  return (
    <div onPointerDown={onPress} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={onEdit} style={{ ...box, cursor: "move", ...ring }}>
      {n.text}
    </div>
  );
}

/** What a drawing tool will make, while it is being drawn. */
function DrawingPreview({ gesture: g }: { gesture: Extract<Gesture, { kind: "draw" }> }): JSX.Element {
  const x = Math.min(g.start.x, g.now.x);
  const y = Math.min(g.start.y, g.now.y);
  const w = Math.abs(g.now.x - g.start.x);
  const h = Math.abs(g.now.y - g.start.y);
  if (g.tool === "pen") {
    return (
      <svg style={{ position: "absolute", left: g.start.x, top: g.start.y, overflow: "visible" }} width={1} height={1} aria-hidden="true">
        <path d={g.points.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px} ${py}`).join(" ")} fill="none" stroke="#d6453d" strokeWidth={2.5} strokeLinecap="round" />
      </svg>
    );
  }
  if (g.tool === "line" || g.tool === "arrow") {
    return (
      <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }} width={1} height={1} aria-hidden="true">
        <path d={`M${g.start.x} ${g.start.y} L${g.now.x} ${g.now.y}`} stroke="#d6453d" strokeWidth={2.5} />
      </svg>
    );
  }
  return <div style={{ position: "absolute", left: x, top: y, width: w, height: h, border: `2px ${g.tool === "artboard" ? "solid #4a4fd1" : "solid #d6453d"}`, borderRadius: g.tool === "oval" ? "50%" : 2, background: g.tool === "artboard" ? "rgba(74,79,209,.06)" : "transparent" }} />;
}

/** The selected element's inline style, as fields: what Claude Design's properties panel edits. */
function ElementProperties({ tag, style: s, onStyle, onDelete, onWrap }: { tag: string; style: Record<string, string>; onStyle: (name: string, value: string) => void; onDelete: () => void; onWrap: (as: "stack" | "grid") => void }): JSX.Element {
  const layout = s["display"] === "flex" ? "stack" : s["display"] === "grid" ? "grid" : "block";
  return (
    <>
      <Section title={`Selected · ${tag}`}>
        <Row label="Layout">
          <Segmented
            value={layout}
            options={[
              ["block", "Block"],
              ["stack", "Stack"],
              ["grid", "Grid"],
            ]}
            onChange={(v) => {
              if (v === "block") onStyle("display", "");
              if (v === "stack") onStyle("display", "flex");
              if (v === "grid") onStyle("display", "grid");
            }}
          />
        </Row>
        {layout === "stack" ? (
          <Row label="Direction">
            <Segmented
              value={s["flex-direction"] === "row" ? "row" : "column"}
              options={[
                ["column", "↓"],
                ["row", "→"],
              ]}
              onChange={(v) => onStyle("flex-direction", v)}
            />
          </Row>
        ) : null}
        {layout === "grid" ? <Field label="Columns" value={(/repeat\((\d+)/.exec(s["grid-template-columns"] ?? "") ?? [])[1] ?? ""} onCommit={(v) => onStyle("grid-template-columns", /^\d+$/.test(v) ? `repeat(${v}, minmax(0, 1fr))` : v)} /> : null}
        {layout !== "block" ? <Field label="Gap" value={s["gap"] ?? ""} onCommit={(v) => onStyle("gap", px(v))} /> : null}
        <Field label="Padding" value={s["padding"] ?? ""} onCommit={(v) => onStyle("padding", px(v))} />
      </Section>
      <Section title="Size">
        <Field label="Width" value={s["width"] ?? ""} onCommit={(v) => onStyle("width", px(v))} />
        <Field label="Height" value={s["height"] ?? ""} onCommit={(v) => onStyle("height", px(v))} />
      </Section>
      <Section title="Fill & border">
        <ColorField label="Fill" value={s["background"] ?? s["background-color"] ?? ""} onCommit={(v) => onStyle(s["background-color"] !== undefined ? "background-color" : "background", v)} />
        <Field label="Border" value={s["border"] ?? ""} onCommit={(v) => onStyle("border", v)} />
        <Field label="Radius" value={s["border-radius"] ?? ""} onCommit={(v) => onStyle("border-radius", px(v))} />
      </Section>
      <Section title="Text">
        <ColorField label="Color" value={s["color"] ?? ""} onCommit={(v) => onStyle("color", v)} />
        <Field label="Size" value={s["font-size"] ?? ""} onCommit={(v) => onStyle("font-size", px(v))} />
        <Field label="Weight" value={s["font-weight"] ?? ""} onCommit={(v) => onStyle("font-weight", v)} />
      </Section>
      <Section title="Arrange">
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" style={button} onClick={() => onWrap("stack")}>
            Wrap in stack
          </button>
          <button type="button" style={button} onClick={() => onWrap("grid")}>
            Wrap in grid
          </button>
          <button type="button" style={button} onClick={onDelete}>
            Delete element
          </button>
        </span>
      </Section>
    </>
  );
}

function BoardProperties({ file, board: b, onChange, onDelete }: { file: string; board: CanvasBoardEntry; onChange: (next: Partial<CanvasBoardEntry>) => void; onDelete: () => void }): JSX.Element {
  return (
    <>
      <Section title={`Artboard · ${file}`}>
        <Field label="Title" value={b.title ?? ""} onCommit={(v) => onChange({ title: v })} />
        <Field label="X" value={String(b.x)} onCommit={(v) => onChange({ x: Number(v) || 0 })} />
        <Field label="Y" value={String(b.y)} onCommit={(v) => onChange({ y: Number(v) || 0 })} />
        <Field label="Width" value={String(b.w)} onCommit={(v) => onChange({ w: clamp(Number(v)) })} />
        <Field label="Height" value={String(b.h)} onCommit={(v) => onChange({ h: clamp(Number(v)) })} />
        <Field label="Radius" value={b.radius !== undefined ? String(b.radius) : ""} onCommit={(v) => onChange(v === "" ? { radius: undefined as never } : { radius: Number(v) || 0 })} />
        <Row label="Works">
          <input type="checkbox" checked={b.is_interactive === true} onChange={(e) => onChange({ is_interactive: e.currentTarget.checked })} aria-label="Its controls respond: it runs (▶)" />
        </Row>
      </Section>
      <Section title="Remove">
        <button type="button" style={button} onClick={onDelete}>
          Delete artboard
        </button>
      </Section>
    </>
  );
}

function NoteProperties({ note: n, onChange, onDelete }: { note: CanvasNote; onChange: (next: Partial<CanvasNote>) => void; onDelete: () => void }): JSX.Element {
  const colors = ["gray", "red", "orange", "green", "teal", "blue", "purple", "pink"];
  const shape = n.kind !== undefined && n.kind !== "title1";
  return (
    <>
      <Section title={n.kind === undefined ? "Note" : n.kind === "title1" ? "Title" : n.kind}>
        <Row label={shape ? "Color" : "Fill"}>
          <select value={(shape ? n.color : n.fill) ?? ""} onChange={(e) => onChange(shape ? { color: e.currentTarget.value } : { fill: e.currentTarget.value })} style={input}>
            <option value="">default</option>
            {colors.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Row>
        {!shape ? (
          <Row label="Size">
            <select value={String(n.size ?? "m")} onChange={(e) => onChange({ size: e.currentTarget.value })} style={input}>
              {["s", "m", "l", "xl", "xxl"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Row>
        ) : null}
      </Section>
      <Section title="Remove">
        <button type="button" style={button} onClick={onDelete}>
          Delete
        </button>
      </Section>
    </>
  );
}

/** The artboard's `data-props` levers, live in its frame (`dc:props`). */
function TweaksTab({ file, source, onChange }: { file: string | undefined; source: (file: string) => string; onChange: (file: string, name: string, value: unknown) => void }): JSX.Element {
  if (file === undefined) return <p style={hint}>No artboard yet.</p>;
  const declared = (parse(source(file)).props ?? {}) as Record<string, { editor?: string | null; default?: unknown; options?: unknown[]; min?: number; max?: number; step?: number }>;
  const levers = Object.entries(declared).filter(([name, p]) => name !== "$preview" && typeof p.editor === "string");
  if (levers.length === 0) return <p style={hint}>{file} declares no tweaks.</p>;
  const set = (name: string, value: unknown): void => onChange(file, name, value);
  return (
    <Section title={`Tweaks · ${file}`}>
      {levers.map(([name, p]) => {
        const value = p.default;
        if (p.editor === "boolean") {
          return (
            <Row key={name} label={name}>
              <input type="checkbox" checked={value === true} onChange={(e) => set(name, e.currentTarget.checked)} />
            </Row>
          );
        }
        if (p.editor === "enum" && Array.isArray(p.options)) {
          return (
            <Row key={name} label={name}>
              <select value={String(value ?? "")} onChange={(e) => set(name, e.currentTarget.value)} style={input}>
                {p.options.map((o) => (
                  <option key={String(o)} value={String(o)}>
                    {String(o)}
                  </option>
                ))}
              </select>
            </Row>
          );
        }
        if (p.editor === "color") return <ColorField key={name} label={name} value={String(value ?? "")} onCommit={(v) => set(name, v)} />;
        if (p.editor === "range" || p.editor === "int" || p.editor === "float") {
          return (
            <Row key={name} label={name}>
              <input type={p.editor === "range" ? "range" : "number"} min={p.min} max={p.max} step={p.step ?? (p.editor === "int" ? 1 : 0.1)} value={Number(value ?? 0)} onChange={(e) => set(name, Number(e.currentTarget.value))} style={input} />
            </Row>
          );
        }
        return <Field key={name} label={name} value={String(value ?? "")} onCommit={(v) => set(name, v)} />;
      })}
    </Section>
  );
}

function Layers({ order, index, selection, onPick }: { order: string[]; index: CanvasIndex; selection: Selection | null; onPick: (s: Selection) => void }): JSX.Element {
  return (
    <Section title="Layers">
      {[...order].reverse().map((file) => (
        <button key={file} type="button" onClick={() => onPick({ kind: "board", file })} style={{ ...layer, fontWeight: selection?.kind === "board" && selection.file === file ? 600 : 400 }}>
          ▭ {index.boards[file]!.title ?? file}
        </button>
      ))}
      {Object.entries(index.notes ?? {}).map(([id, n]) => (
        <button key={id} type="button" onClick={() => onPick({ kind: "note", id })} style={{ ...layer, fontWeight: selection?.kind === "note" && selection.id === id ? 600 : 400 }}>
          {n.kind === undefined ? "▤ " : n.kind === "title1" ? "T " : "◇ "}
          {n.text !== undefined && n.text.length > 0 ? n.text.slice(0, 40) : (n.kind ?? "note")}
        </button>
      ))}
    </Section>
  );
}

// --- small parts ----------------------------------------------------------------------------------

/** A bare number is pixels, as the panel's fields read. */
const px = (v: string): string => (/^-?\d+(\.\d+)?$/.test(v.trim()) ? `${v.trim()}px` : v);
const clamp = (v: number): number => Math.max(40, Math.min(8000, Math.round(Number.isFinite(v) ? v : 40)));

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section style={{ padding: "10px 12px", borderBottom: "1px solid var(--line, #e0e3ec)" }}>
      <h5 style={{ margin: "0 0 7px", fontSize: 10, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--tok-hint, #8a8fa8)", fontWeight: 600 }}>{title}</h5>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: 6, alignItems: "center", marginBottom: 6, fontSize: 12 }}>
      <span style={{ color: "var(--dim, #5a5f7a)" }}>{label}</span>
      {children}
    </label>
  );
}

/** A text field committed on Enter or on leaving it, so a half-typed value never reaches the source. */
function Field({ label, value, onCommit }: { label: string; value: string; onCommit: (value: string) => void }): JSX.Element {
  return (
    <Row label={label}>
      <input key={value} defaultValue={value} onBlur={(e) => e.currentTarget.value !== value && onCommit(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} style={input} />
    </Row>
  );
}

function ColorField({ label, value, onCommit }: { label: string; value: string; onCommit: (value: string) => void }): JSX.Element {
  const hex = /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : "#ffffff";
  return (
    <Row label={label}>
      <span style={{ display: "flex", gap: 6 }}>
        <input type="color" value={hex} onChange={(e) => onCommit(e.currentTarget.value)} style={{ width: 28, height: 22, padding: 0, border: "1px solid var(--line, #e0e3ec)", borderRadius: 4 }} />
        <input key={value} defaultValue={value} onBlur={(e) => e.currentTarget.value !== value && onCommit(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} style={{ ...input, flex: 1 }} />
      </span>
    </Row>
  );
}

function Segmented({ value, options, onChange }: { value: string; options: Array<[string, string]>; onChange: (value: string) => void }): JSX.Element {
  return (
    <span role="group" style={{ display: "flex", border: "1px solid var(--line, #e0e3ec)", borderRadius: 6, overflow: "hidden" }}>
      {options.map(([id, words], i) => (
        <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)} style={{ flex: 1, font: "inherit", fontSize: 11, padding: "2px 0", border: 0, borderLeft: i === 0 ? 0 : "1px solid var(--line, #e0e3ec)", background: value === id ? "var(--panel-3, #e5e8f1)" : "transparent", color: value === id ? "var(--text, #121526)" : "var(--dim, #5a5f7a)", fontWeight: value === id ? 600 : 400, cursor: "pointer" }}>
          {words}
        </button>
      ))}
    </span>
  );
}

// `width: 100%`: hosted in a box that sizes to its content, the shell would be only as wide as its tool
// strip and panel, and the board between them — `flex: 1` and nothing of its own — none at all.
const shell: CSSProperties = { display: "flex", flexDirection: "column", width: "100%", boxSizing: "border-box", border: "1px solid var(--line, #e0e3ec)", borderRadius: 6, overflow: "hidden", background: "var(--panel, #fff)", height: 640 };
const bar: CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderBottom: "1px solid var(--line, #e0e3ec)", minHeight: 30, boxSizing: "border-box" };
const barText: CSSProperties = { fontSize: 12, color: "var(--text, #121526)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
/** A bar's words that give way to its controls: shortened to an ellipsis rather than wrapped. */
const shrinks: CSSProperties = { minWidth: 24, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1 };
const button: CSSProperties = { font: "inherit", fontSize: 11.5, color: "var(--text, #121526)", background: "var(--panel, #fff)", border: "1px solid var(--line, #e0e3ec)", borderRadius: 6, padding: "1px 8px", cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" };
/** A bar floating over the board's top edge: a white pill, as Claude Code's canvas draws its two. */
const floatBar: CSSProperties = { position: "absolute", top: 8, display: "flex", alignItems: "center", gap: 2, padding: 3, background: "var(--panel, #fff)", border: "1px solid var(--line, #e0e3ec)", borderRadius: 10, boxShadow: "0 2px 8px rgba(18,21,38,.10)", minWidth: 0, overflowX: "auto", scrollbarWidth: "none" };
const iconButton: CSSProperties = { width: 28, height: 28, borderRadius: 7, display: "grid", placeItems: "center", border: 0, padding: 0, background: "transparent", color: "var(--text, #121526)", cursor: "pointer", flexShrink: 0 };
const textButton: CSSProperties = { font: "inherit", fontSize: 12.5, height: 28, display: "inline-flex", alignItems: "center", gap: 5, padding: "0 8px", border: 0, borderRadius: 7, background: "transparent", color: "var(--text, #121526)", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 };
const countChip: CSSProperties = { minWidth: 16, height: 16, borderRadius: 8, background: "var(--panel-3, #e5e8f1)", fontSize: 10.5, display: "inline-grid", placeItems: "center", color: "var(--dim, #5a5f7a)" };
const divider: CSSProperties = { width: 1, alignSelf: "stretch", margin: "4px 3px", background: "var(--line, #e0e3ec)", flexShrink: 0 };
const menuCard: CSSProperties = { minWidth: 160, padding: 4, background: "var(--panel, #fff)", border: "1px solid var(--line, #e0e3ec)", borderRadius: 8, boxShadow: "0 10px 28px rgba(18,21,38,.18)", display: "grid", gap: 1, fontSize: 12.5, color: "var(--text, #121526)" };
const menuItem: CSSProperties = { font: "inherit", display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", border: 0, borderRadius: 5, background: "transparent", textAlign: "left", cursor: "pointer", color: "inherit" };
/** The properties panel: a card over the board's right edge, under the top-right bar. */
const panel: CSSProperties = { position: "absolute", top: 46, right: 8, bottom: 8, width: 260, maxWidth: "calc(100% - 16px)", boxSizing: "border-box", background: "var(--panel, #fff)", border: "1px solid var(--line, #e0e3ec)", borderRadius: 10, boxShadow: "0 8px 24px rgba(18,21,38,.14)", flexDirection: "column", minHeight: 0, overflow: "hidden" };
const tabButton: CSSProperties = { font: "inherit", fontSize: 12, padding: "8px 8px 7px", border: 0, background: "transparent", cursor: "pointer" };
const input: CSSProperties = { font: "inherit", fontSize: 12, border: "1px solid var(--line, #e0e3ec)", borderRadius: 6, padding: "2px 7px", background: "var(--panel, #fff)", color: "var(--text, #121526)", minWidth: 0 };
const hint: CSSProperties = { margin: 12, fontSize: 12, color: "var(--dim, #5a5f7a)" };
const layer: CSSProperties = { display: "block", width: "100%", textAlign: "left", font: "inherit", fontSize: 12, padding: "4px 2px", border: 0, background: "transparent", color: "var(--text, #121526)", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
