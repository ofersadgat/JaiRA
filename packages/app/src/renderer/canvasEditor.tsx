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
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { applyMove, editStyle, editText, formatStyle, parse, readStyle, removeElement, setPropDefault, wrapElement, type Moved } from "@jaira/dc-runtime/source";
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

const SHORTCUT: Record<string, CanvasTool> = { v: "pointer", h: "hand", t: "text", a: "artboard", n: "note", p: "pen", r: "rect", o: "oval", l: "line", c: "comment" };

/** The colour of a running artboard's ring and its controls. */
const RUN = "#0f7a45";

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
   * The editor's own width. Narrow — a conversation's column, the side panel — the properties panel is
   * closed and opened over the board on demand (Claude Design's own toggle, Ctrl+\): drawn beside a
   * board in 500 px it pushed the board and the top bar's controls out of the column.
   */
  const shellBox = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  useEffect(() => {
    const el = shellBox.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => setWidth(el.clientWidth));
    watch.observe(el);
    setWidth(el.clientWidth);
    return () => watch.disconnect();
  }, []);
  const narrow = width > 0 && width < 760;
  useEffect(() => {
    const el = board.current;
    if (el === null) return;
    if (!moved.current) fitNow.current();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => {
      if (!moved.current) fitNow.current();
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [full]);

  /**
   * The person has panned or zoomed since the last fit: the view is theirs, and stays where they put it
   * when the board's box changes size. Until then the canvas is fitted again as the box changes — it
   * opens in a column that is still being laid out (narrow, the panel closes after the first measure),
   * and a fit made once, from the first width, left the artboards wider than the board.
   */
  const moved = useRef(false);
  /** Every artboard in what the board shows, 24 px clear, between 5% and 100%; never from a box not yet measured. */
  const fit = (): void => {
    const el = board.current;
    const boxes = Object.values(index.boards);
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

  const touch = (path: string): void => setDirty((was) => new Set(was).add(path));
  const changeIndex = (next: (index: CanvasIndex & Record<string, unknown>) => CanvasIndex & Record<string, unknown>): void => {
    setIndex((was) => next(was));
    touch("project/canvas.json");
  };
  const changeSource = (file: string, next: string): void => {
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
      const data = event.data as { type?: string; id?: number; rect?: Rect; at?: { x: number; y: number }; tag?: string; style?: string; text?: string | null; href?: string };
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (editingText !== null || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
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
      if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
        e.preventDefault();
        setPanelOpen((was) => !was);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const picked = e.shiftKey && e.key.toLowerCase() === "l" ? "arrow" : SHORTCUT[e.key.toLowerCase()];
      if (picked !== undefined) setTool(picked);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [remove, editingText, running, full]);

  // --- the board's gestures --------------------------------------------------------------------------

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
    if (tool === "hand" || e.button === 1) {
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
      const dx = p.x - gesture.from.x;
      const dy = p.y - gesture.from.y;
      setIndex((was) => ({ ...was, boards: { ...was.boards, [gesture.file]: { ...was.boards[gesture.file]!, x: Math.round(gesture.at.x + dx), y: Math.round(gesture.at.y + dy) } } }));
    } else if (gesture.kind === "resizeBoard") {
      setIndex((was) => ({
        ...was,
        boards: { ...was.boards, [gesture.file]: { ...was.boards[gesture.file]!, w: Math.max(40, Math.min(8000, Math.round(gesture.size.w + p.x - gesture.from.x))), h: Math.max(40, Math.min(8000, Math.round(gesture.size.h + p.y - gesture.from.y))) } },
      }));
    } else if (gesture.kind === "moveNote") {
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
    if (g.kind === "moveBoard" || g.kind === "resizeBoard" || g.kind === "moveNote") {
      touch("project/canvas.json");
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
    setTool("pointer");
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
  const order = (index.order ?? []).filter((f) => index.boards[f] !== undefined);
  const layerOn = tool !== "pointer" && tool !== "text" && tool !== "comment";
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
      <div ref={fullBox} style={{ ...shell, ...style }}>
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

  return (
    <div ref={shellBox} style={{ ...shell, ...style }}>
      {/*
        One line, always the same height: a bar that wrapped grew and shrank as the status changed and
        controls came and went, and every change of the board's height fitted the canvas again under the
        pointer. The words give way first (an ellipsis, the whole in the tooltip); past that it scrolls.
      */}
      <div style={{ ...bar, overflowX: "auto", scrollbarWidth: "thin" }}>
        <span style={{ ...barText, ...shrinks, flexShrink: 2, fontWeight: 600 }} title={index.title ?? "Canvas"}>
          {index.title ?? "Canvas"}
        </span>
        <span style={{ ...barText, ...shrinks, color: status?.tone === "refused" || status?.tone === "error" ? "#d6453d" : "#5a5f7a" }} title={status?.words}>
          {status?.words ?? (dirty.size > 0 ? "Unsaved" : `v${base}`)}
        </span>
        {status?.tone === "refused" ? (
          <button type="button" style={button} onClick={onReload}>
            Reload
          </button>
        ) : null}
        <span style={{ flex: 1 }} />
        {interactive.length > 0 ? (
          running.size > 0 ? (
            <button type="button" style={{ ...button, background: RUN, borderColor: RUN, color: "#fff" }} title="Stop every running artboard (Esc)" onClick={() => setRunning(new Set())}>
              ■ Stop
            </button>
          ) : (
            <button type="button" style={{ ...button, color: RUN }} title="Run every interactive artboard where it sits" onClick={() => setRunning(new Set(interactive))}>
              ▶ Run canvas
            </button>
          )
        ) : null}
        {selection?.kind === "board" || selection?.kind === "element" ? (
          <>
            {onExport !== undefined ? (
              <>
                <button type="button" style={button} onClick={() => onExport(selection.file, "png", { width: index.boards[selection.file]!.w, height: index.boards[selection.file]!.h })}>
                  PNG
                </button>
                <button type="button" style={button} onClick={() => onExport(selection.file, "pdf", { width: index.boards[selection.file]!.w, height: index.boards[selection.file]!.h })}>
                  PDF
                </button>
              </>
            ) : null}
          </>
        ) : null}
        <button type="button" style={button} onClick={fit} title="See every artboard">
          Fit
        </button>
        <span style={{ ...barText, minWidth: 40, textAlign: "right" }}>{Math.round(view.z * 100)}%</span>
        {narrow ? (
          <button type="button" style={{ ...button, background: panelOpen ? "var(--panel-3, #e5e8f1)" : button.background }} aria-label="Properties panel" aria-pressed={panelOpen} title="Properties, tweaks, layers and comments (Ctrl+\)" onClick={() => setPanelOpen((was) => !was)}>
            Panel
          </button>
        ) : null}
      </div>
      <div style={{ display: "flex", flex: 1, minHeight: 0, position: "relative" }}>
        <div role="toolbar" aria-label="Tools" aria-orientation="vertical" style={tools}>
          {TOOLS.filter((t) => t.tool !== "comment" || onComment !== undefined).map((t) => (
            <button
              key={t.tool}
              type="button"
              title={`${t.label} (${t.key})`}
              aria-label={t.label}
              aria-pressed={tool === t.tool}
              onClick={() => setTool(t.tool)}
              style={{ ...toolButton, background: tool === t.tool ? "var(--panel-3, #e5e8f1)" : "transparent", color: tool === t.tool ? "var(--text, #121526)" : "var(--dim, #5a5f7a)" }}
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={t.path} />
              </svg>
            </button>
          ))}
        </div>
        <div ref={board} style={{ position: "relative", flex: 1, minWidth: narrow ? 0 : 280, overflow: "hidden", background: "#eceef3", backgroundImage: "radial-gradient(#cfd3de 1px, transparent 1px)", backgroundSize: `${16 * view.z}px ${16 * view.z}px`, backgroundPosition: `${view.x}px ${view.y}px` }}>
          {/* Under the frames and notes: a press here pans, and empties the selection. */}
          <div onPointerDown={onLayerDown} onPointerMove={onLayerMove} onPointerUp={onLayerUp} style={{ position: "absolute", inset: 0, cursor: tool === "hand" ? "grab" : "default" }} />
          <div style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
            {Object.entries(index.notes ?? {}).map(([id, n]) => (
              <EditableNote
                key={id}
                note={n}
                selected={selection?.kind === "note" && selection.id === id}
                editing={editingText !== null && "note" in editingText && editingText.note === id}
                onPress={(e) => {
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
                      e.stopPropagation();
                      setSelection({ kind: "board", file });
                      e.currentTarget.setPointerCapture(e.pointerId);
                      setGesture({ kind: "moveBoard", file, from: at(e), at: { x: b.x, y: b.y } });
                    }}
                    onPointerMove={onLayerMove}
                    onPointerUp={onLayerUp}
                    style={{ position: "absolute", left: 0, bottom: "100%", paddingBottom: 6, fontSize: 13 / Math.max(view.z, 0.25), lineHeight: 1.2, color: chosen ? "#4a4fd1" : "#5a5f7a", whiteSpace: "nowrap", cursor: "move", userSelect: "none", display: "flex", gap: 6, alignItems: "center" }}
                  >
                    {b.is_interactive === true ? <span style={{ width: 8, height: 8, borderRadius: 4, background: "#4a4fd1", display: "inline-block" }} /> : null}
                    <span style={running.has(file) ? { color: RUN, fontWeight: 600 } : undefined}>
                      {b.title ?? file.replace(/\.dc\.html$/, "")}
                      {running.has(file) ? " · running" : ""}
                    </span>
                    {b.is_interactive === true ? (
                      <RunControls
                        running={running.has(file)}
                        onRun={() => run(file)}
                        onStop={() => stop(file)}
                        onFull={() => {
                          stop(file);
                          setFull(file);
                        }}
                      />
                    ) : null}
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
            <Popover anchor={pinRef} side="right" align="start" gap={8} style={{ width: 260 }} onPointerDown={(e) => e.stopPropagation()}>
              <CommentBox draft={draft} onChange={setDraft} onSubmit={submitDraft} onCancel={() => setDraft(null)} />
            </Popover>
          ) : null}
          {openComment !== undefined && draft === null ? (
            <Popover anchor={pinRef} side="right" align="start" gap={8} style={{ width: 260 }} onPointerDown={(e) => e.stopPropagation()}>
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
          {layerOn ? <div onPointerDown={onLayerDown} onPointerMove={onLayerMove} onPointerUp={onLayerUp} style={{ position: "absolute", inset: 0, cursor: tool === "hand" ? "grab" : "crosshair" }} /> : null}
        </div>
        <aside style={narrow ? { ...panel, display: panelOpen ? "flex" : "none", position: "absolute", top: 0, right: 0, bottom: 0, boxShadow: "-8px 0 24px rgba(18,21,38,.14)" } : panel}>
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
    </div>
  );
}

/** An interactive artboard's controls on its label: ▶ runs it where it sits; running, ■ stops it and ⤢ fills the editor with it. */
function RunControls({ running, onRun, onStop, onFull }: { running: boolean; onRun: () => void; onStop: () => void; onFull: () => void }): JSX.Element {
  // The label drags its artboard: a press on a control is the control's.
  const own = { onPointerDown: (e: ReactPointerEvent) => e.stopPropagation() };
  const chip: CSSProperties = { font: "inherit", fontSize: "0.85em", lineHeight: 1.25, padding: "0 0.4em", borderRadius: "0.3em", border: `1px solid ${RUN}`, cursor: "pointer" };
  return running ? (
    <>
      <button type="button" {...own} onClick={onStop} title="Stop running it" aria-label="Stop" style={{ ...chip, background: RUN, color: "#fff" }}>
        ■
      </button>
      <button type="button" {...own} onClick={onFull} title="Run it on its own, filling the editor" aria-label="Run it on its own" style={{ ...chip, background: "#fff", color: RUN }}>
        ⤢
      </button>
    </>
  ) : (
    <button type="button" {...own} onClick={onRun} title="Run it where it sits" aria-label="Run" style={{ ...chip, background: "#fff", color: RUN }}>
      ▶
    </button>
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
const tools: CSSProperties = { width: 44, flexShrink: 0, borderRight: "1px solid var(--line, #e0e3ec)", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "8px 0", background: "var(--panel, #fff)" };
const toolButton: CSSProperties = { width: 30, height: 30, borderRadius: 7, display: "grid", placeItems: "center", border: 0, cursor: "pointer" };
const panel: CSSProperties = { width: 250, flexShrink: 0, borderLeft: "1px solid var(--line, #e0e3ec)", background: "var(--panel, #fff)", display: "flex", flexDirection: "column", minHeight: 0 };
const tabButton: CSSProperties = { font: "inherit", fontSize: 12, padding: "8px 8px 7px", border: 0, background: "transparent", cursor: "pointer" };
const input: CSSProperties = { font: "inherit", fontSize: 12, border: "1px solid var(--line, #e0e3ec)", borderRadius: 6, padding: "2px 7px", background: "var(--panel, #fff)", color: "var(--text, #121526)", minWidth: 0 };
const hint: CSSProperties = { margin: 12, fontSize: 12, color: "var(--dim, #5a5f7a)" };
const layer: CSSProperties = { display: "block", width: "100%", textAlign: "left", font: "inherit", fontSize: 12, padding: "4px 2px", border: 0, background: "transparent", color: "var(--text, #121526)", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
