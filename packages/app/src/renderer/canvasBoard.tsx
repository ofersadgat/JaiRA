/**
 * A design canvas drawn as a board (decision 0020 §5): Claude Design's files — `project/canvas.json`
 * and one `.dc.html` per artboard — laid out as that index says, each artboard RUNNING in a frame of
 * its own, under the grant the host asked for (`base`, `jaira-artifact://<token>/`).
 *
 * The board is JaiRA's; what is inside each frame is the model's artboard, drawn by JaiRA's `.dc.html`
 * runtime (`support.js`). Read here, nothing is changed: pan by dragging the board, zoom with the wheel
 * held with Ctrl (or a pinch), Fit to see every artboard, and double-click an artboard to see it alone
 * at its own size. `onOpen` asks the host for the editor.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

/** One artboard's entry in `canvas.json`'s `boards`. */
export interface CanvasBoardEntry {
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
  page?: string;
  expand?: string;
  is_interactive?: boolean;
  radius?: number;
  frameless?: boolean;
}

/** A note on the board: a title over several artboards, a sticky, or one of a person's shapes. */
export interface CanvasNote {
  x: number;
  y: number;
  text?: string;
  kind?: string;
  w?: number;
  h?: number;
  maxW?: number;
  size?: string | number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  fill?: string;
  page?: string;
  /** A line or arrow's other end, and a pen stroke's points — as the editor writes them. */
  x2?: number;
  y2?: number;
  points?: Array<[number, number]>;
}

export interface CanvasIndex {
  v?: number;
  title?: string;
  boards: Record<string, CanvasBoardEntry>;
  order?: string[];
  notes?: Record<string, CanvasNote>;
  pages?: Array<{ id: string; name: string }>;
  launch?: { view?: string; page?: string; file?: string };
}

/** `canvas.json` read leniently: a file the model got wrong draws what it can rather than nothing. */
export function readCanvasIndex(text: string | undefined): CanvasIndex {
  try {
    const parsed = JSON.parse(text ?? "") as Partial<CanvasIndex>;
    const boards = parsed.boards !== null && typeof parsed.boards === "object" ? parsed.boards : {};
    return { ...parsed, boards: boards as Record<string, CanvasBoardEntry> };
  } catch {
    return { boards: {} };
  }
}

/** The sticky colours `canvas.json` names, in this board's own light tones. */
const STICKY: Record<string, string> = {
  gray: "#ececea",
  red: "#fbd9d6",
  orange: "#fde3c8",
  green: "#d9f0d3",
  teal: "#d2efec",
  blue: "#d8e6fb",
  purple: "#e6dcf8",
  pink: "#f9dbe9",
};
const INK: Record<string, string> = {
  gray: "#6b6b68",
  red: "#d6453d",
  orange: "#d97a1e",
  green: "#2f8a3a",
  teal: "#178a85",
  blue: "#2a6fd6",
  purple: "#7a4fd6",
  pink: "#d0457f",
};
const SIZE: Record<string, number> = { xs: 11, s: 13, m: 16, l: 20, xl: 28, xxl: 40 };

/** Every artboard's frame and every note, in board space: what Fit fits. */
function extentOf(index: CanvasIndex, page: string | undefined): { x: number; y: number; w: number; h: number } {
  const boxes: Array<[number, number, number, number]> = [];
  for (const [, b] of Object.entries(index.boards)) if ((b.page ?? first(index)) === page) boxes.push([b.x, b.y - 24, b.w, b.h + 24]);
  for (const n of Object.values(index.notes ?? {})) if ((n.page ?? first(index)) === page) boxes.push([n.x, n.y, n.w ?? n.maxW ?? 240, n.h ?? 120]);
  if (boxes.length === 0) return { x: 0, y: 0, w: 800, h: 600 };
  const x = Math.min(...boxes.map((b) => b[0]));
  const y = Math.min(...boxes.map((b) => b[1]));
  return { x, y, w: Math.max(...boxes.map((b) => b[0] + b[2])) - x, h: Math.max(...boxes.map((b) => b[1] + b[3])) - y };
}
const first = (index: CanvasIndex): string | undefined => index.pages?.[0]?.id;

export interface CanvasBoardProps {
  index: CanvasIndex;
  /** The grant every artboard is framed from: `jaira-artifact://<token>/`. */
  base: string;
  /** The box the board fills. */
  style?: CSSProperties;
  /** The host's editor, when there is one to open. */
  onOpen?: (() => void) | undefined;
  /** Drawn over the board's top edge, right: what the host adds (the editor's toolbar, later). */
  chrome?: ReactNode;
}

export function CanvasBoard({ index, base, style, onOpen, chrome }: CanvasBoardProps): JSX.Element {
  const box = useRef<HTMLDivElement | null>(null);
  const [page, setPage] = useState<string | undefined>(index.launch?.page ?? first(index));
  const [view, setView] = useState<{ x: number; y: number; z: number } | null>(null);
  const [focused, setFocused] = useState<string | null>(index.launch?.view === "focused" ? (index.launch.file ?? null) : null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const extent = useMemo(() => extentOf(index, page), [index, page]);
  const order = useMemo(() => {
    const listed = (index.order ?? []).filter((f) => index.boards[f] !== undefined);
    return [...listed, ...Object.keys(index.boards).filter((f) => !listed.includes(f))];
  }, [index]);

  /** Fit every artboard of the page in the box, 32 px clear, never above 100%. */
  const fit = (): void => {
    const el = box.current;
    if (el === null) return;
    const z = Math.min(1, (el.clientWidth - 64) / Math.max(extent.w, 1), (el.clientHeight - 64) / Math.max(extent.h, 1));
    setView({ z, x: (el.clientWidth - extent.w * z) / 2 - extent.x * z, y: (el.clientHeight - extent.h * z) / 2 - extent.y * z });
  };
  useLayoutEffect(fit, [extent.x, extent.y, extent.w, extent.h]);

  // The wheel: Ctrl (or a pinch, which Chromium reports as Ctrl) zooms about the pointer; else it pans.
  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      setView((v) => {
        if (v === null) return v;
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

  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (view === null || e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d === null) return;
    setView((v) => (v === null ? v : { ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
  };
  const onUp = (): void => {
    drag.current = null;
  };

  const frameSrc = (file: string): string => `${base.replace(/\/+$/, "")}/project/${file.split("/").map(encodeURIComponent).join("/")}`;

  if (focused !== null && index.boards[focused] !== undefined) {
    const b = index.boards[focused]!;
    return (
      <div style={{ ...frameBox, ...style }}>
        <div style={bar}>
          <button type="button" style={button} onClick={() => setFocused(null)}>
            ← Board
          </button>
          <span style={{ ...barText, fontWeight: 600 }}>{b.title ?? focused}</span>
          <span style={{ flex: 1 }} />
          {chrome}
          {onOpen !== undefined ? (
            <button type="button" style={button} onClick={onOpen}>
              Edit
            </button>
          ) : null}
        </div>
        <div style={{ flex: 1, overflow: "auto", background: "#eceef3", display: "flex", justifyContent: "center", padding: 24 }}>
          <iframe
            title={b.title ?? focused}
            src={frameSrc(focused)}
            sandbox="allow-scripts allow-same-origin allow-popups"
            allow="clipboard-write"
            style={{ width: b.expand === "fill" ? "100%" : b.w, height: b.h, border: 0, background: "#fff", flexShrink: 0, borderRadius: b.radius ?? 0 }}
          />
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...frameBox, ...style }}>
      <div style={bar}>
        <span style={{ ...barText, fontWeight: 600 }}>{index.title ?? "Canvas"}</span>
        {index.pages !== undefined && index.pages.length > 1 ? (
          <select aria-label="Page" value={page ?? ""} onChange={(e) => setPage(e.target.value)} style={select}>
            {index.pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : null}
        <span style={{ flex: 1 }} />
        {chrome}
        <button type="button" style={button} onClick={fit} title="See every artboard">
          Fit
        </button>
        <span style={{ ...barText, minWidth: 40, textAlign: "right" }}>{view === null ? "" : `${Math.round(view.z * 100)}%`}</span>
        {onOpen !== undefined ? (
          <button type="button" style={button} onClick={onOpen}>
            Edit
          </button>
        ) : null}
      </div>
      <div
        ref={box}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        style={{ position: "relative", flex: 1, overflow: "hidden", cursor: drag.current !== null ? "grabbing" : "grab", background: "#eceef3", backgroundImage: "radial-gradient(#cfd3de 1px, transparent 1px)", backgroundSize: "16px 16px", touchAction: "none" }}
      >
        {view === null ? null : (
          <div style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
            {Object.entries(index.notes ?? {})
              .filter(([, n]) => (n.page ?? first(index)) === page)
              .map(([id, n]) => (
                <Note key={id} note={n} />
              ))}
            {order
              .filter((f) => (index.boards[f]!.page ?? first(index)) === page)
              .map((file) => {
                const b = index.boards[file]!;
                return (
                  <div key={file} style={{ position: "absolute", left: b.x, top: b.y, width: b.w, height: b.h }} onDoubleClick={() => setFocused(file)}>
                    <div style={{ position: "absolute", left: 0, bottom: "100%", paddingBottom: 6, fontSize: 13 / Math.max(view.z, 0.25), lineHeight: 1.2, color: "#5a5f7a", whiteSpace: "nowrap", display: "flex", gap: 6, alignItems: "center" }}>
                      {b.is_interactive === true ? <span title="Works: its controls respond" style={{ width: 8, height: 8, borderRadius: 4, background: "#4a4fd1", display: "inline-block" }} /> : null}
                      {b.title ?? file.replace(/\.dc\.html$/, "")}
                    </div>
                    <iframe
                      title={b.title ?? file}
                      src={frameSrc(file)}
                      sandbox="allow-scripts allow-same-origin allow-popups"
                      allow="clipboard-write"
                      loading="lazy"
                      // The board pans and zooms under the pointer; an artboard is used opened alone.
                      style={{ width: b.w, height: b.h, border: 0, display: "block", background: "#fff", pointerEvents: "none", borderRadius: b.radius ?? 0, boxShadow: b.frameless === true ? "none" : "0 1px 3px rgba(18,21,38,.12)" }}
                    />
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}

/** A note as `canvas.json` keeps it: a title over several artboards, a sticky, or a person's shape. */
function Note({ note: n }: { note: CanvasNote }): JSX.Element | null {
  const size = typeof n.size === "number" ? n.size : SIZE[n.size ?? "m"] ?? 16;
  const ink = INK[n.color ?? ""] ?? n.color ?? "#d6453d";
  if (n.kind === "title1") {
    return (
      // `max-content`: placed absolutely in a layer of no size, it would shrink to its longest word.
      <div style={{ position: "absolute", left: n.x, top: n.y, width: "max-content", maxWidth: n.maxW, fontSize: 72, fontWeight: 700, lineHeight: 1.05, color: n.color !== undefined ? ink : "#121526", fontStyle: n.italic === true ? "italic" : "normal", whiteSpace: "pre-wrap" }}>
        {n.text}
      </div>
    );
  }
  if (n.kind === "rect" || n.kind === "oval") {
    return <div style={{ position: "absolute", left: n.x, top: n.y, width: n.w ?? 120, height: n.h ?? 80, border: `2px solid ${ink}`, borderRadius: n.kind === "oval" ? "50%" : 2, background: n.fill !== undefined ? STICKY[n.fill] ?? n.fill : "transparent" }} />;
  }
  if (n.kind === "line" || n.kind === "arrow" || n.kind === "pen") {
    const points = n.kind === "pen" ? (n.points ?? []) : [[0, 0] as [number, number], [(n.x2 ?? n.x + 100) - n.x, (n.y2 ?? n.y) - n.y] as [number, number]];
    if (points.length < 2) return null;
    const d = points.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px} ${py}`).join(" ");
    const [ex, ey] = points[points.length - 1]!;
    const [sx, sy] = points[points.length - 2]!;
    const angle = Math.atan2(ey - sy, ex - sx);
    const head = (a: number): string => `M${ex} ${ey} L${ex - 12 * Math.cos(angle + a)} ${ey - 12 * Math.sin(angle + a)}`;
    return (
      <svg style={{ position: "absolute", left: n.x, top: n.y, overflow: "visible" }} width={1} height={1} aria-hidden="true">
        <path d={d} fill="none" stroke={ink} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        {n.kind === "arrow" ? <path d={`${head(0.45)} ${head(-0.45)}`} fill="none" stroke={ink} strokeWidth={2.5} strokeLinecap="round" /> : null}
      </svg>
    );
  }
  if (n.kind === "image") return null;
  // A sticky: no kind.
  const w = n.w ?? 220;
  return (
    <div style={{ position: "absolute", left: n.x, top: n.y, width: w, maxHeight: (w * 4) / 3, overflow: "auto", padding: "12px 14px", background: STICKY[n.fill ?? n.color ?? ""] ?? "#fdf3c4", boxShadow: "0 1px 2px rgba(0,0,0,.12)", borderRadius: 2, fontSize: size, fontWeight: n.bold === true ? 700 : 400, fontStyle: n.italic === true ? "italic" : "normal", color: "#2b2a24", whiteSpace: "pre-wrap", lineHeight: 1.35 }}>
      {n.text}
    </div>
  );
}

const frameBox: CSSProperties = { display: "flex", flexDirection: "column", width: "100%", boxSizing: "border-box", border: "1px solid var(--line, #e0e3ec)", borderRadius: 6, overflow: "hidden", background: "var(--panel, #fff)", height: 420 };
const bar: CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderBottom: "1px solid var(--line, #e0e3ec)", minHeight: 30, boxSizing: "border-box" };
const barText: CSSProperties = { fontSize: 12, color: "var(--text, #121526)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const button: CSSProperties = { font: "inherit", fontSize: 11.5, color: "var(--text, #121526)", background: "var(--panel, #fff)", border: "1px solid var(--line, #e0e3ec)", borderRadius: 6, padding: "1px 8px", cursor: "pointer" };
const select: CSSProperties = { ...button, padding: "1px 4px" };
