/**
 * A design canvas drawn as a board (decision 0020 §5): Claude Design's files — `project/canvas.json`
 * and one `.dc.html` per artboard — laid out as that index says, each artboard RUNNING in a frame of
 * its own, under the grant the host asked for (`base`, `jaira-artifact://<token>/`).
 *
 * The board is JaiRA's; what is inside each frame is the model's artboard, drawn by JaiRA's `.dc.html`
 * runtime (`support.js`). Read here, nothing is changed: pan by dragging the board, zoom with the wheel
 * held with Ctrl (or a trackpad's pinch) or two fingers' pinch on a touch screen, Fit to see every
 * artboard, and double-click an artboard to see it alone at its own size.
 *
 * Where nobody can save — a version a newer one replaced, the phone — this is what a canvas is drawn as
 * (decision 0024; on a computer the newest version opens in the editor). An interactive artboard still
 * RUNS here: ▶ on its label hands it the pointer where it sits, and a link in it moves the run to the
 * artboard it names.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";

/**
 * The view after a wheel turned at (`px`, `py`), the pointer's place in the board's box: Ctrl (or a pinch,
 * which Chromium reports as Ctrl) zooms about the pointer; else it pans. The board's own wheel and one an
 * artboard passed up (`dc:wheel`) both go through here.
 */
export function wheelView<V extends { x: number; y: number; z: number }>(v: V, px: number, py: number, dx: number, dy: number, ctrl: boolean): V {
  if (!ctrl) return { ...v, x: v.x - dx, y: v.y - dy };
  const z = Math.min(4, Math.max(0.05, v.z * Math.exp(-dy * 0.0015)));
  return { ...v, z, x: px - ((px - v.x) * z) / v.z, y: py - ((py - v.y) * z) / v.z };
}

/** A place a frame reported in its own pixels, in the window: by where the frame stands, at its scale, now. */
export function framePoint(frame: HTMLIFrameElement, x: number, y: number): { x: number; y: number } {
  const box = frame.getBoundingClientRect();
  const scale = frame.offsetWidth > 0 ? box.width / frame.offsetWidth : 1;
  return { x: box.left + x * scale, y: box.top + y * scale };
}

/**
 * A wheel an artboard passed up (`dc:wheel`: where in its pixels, by how much, Ctrl held), or null. A
 * wheel over a frame is the frame's document's and never reaches the board's own listener.
 */
export function frameWheel(data: unknown): { x: number; y: number; dx: number; dy: number; ctrl: boolean } | null {
  const d = data as { type?: unknown; x?: unknown; y?: unknown; dx?: unknown; dy?: unknown; ctrl?: unknown } | null;
  if (d?.type !== "dc:wheel" || typeof d.x !== "number" || typeof d.y !== "number" || typeof d.dx !== "number" || typeof d.dy !== "number") return null;
  if (![d.x, d.y, d.dx, d.dy].every(Number.isFinite)) return null;
  return { x: d.x, y: d.y, dx: d.dx, dy: d.dy, ctrl: d.ctrl === true };
}

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
  /** Drawn over the board's top edge, right: what the host adds (the editor's toolbar, later). */
  chrome?: ReactNode;
}

export function CanvasBoard({ index, base, style, chrome }: CanvasBoardProps): JSX.Element {
  const box = useRef<HTMLDivElement | null>(null);
  const [page, setPage] = useState<string | undefined>(index.launch?.page ?? first(index));
  const [view, setView] = useState<{ x: number; y: number; z: number } | null>(null);
  const [focused, setFocused] = useState<string | null>(index.launch?.view === "focused" ? (index.launch.file ?? null) : null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  /** The interactive artboards running where they sit: the pointer is theirs, not the board's. */
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  /** A middle-button pan begun inside a running frame: where the pointer last was, in the window. */
  const framePan = useRef<{ x: number; y: number } | null>(null);
  /** An artboard that stops is drawn again from its source (its key): a run is a trial, its state and scroll not kept. */
  const [fresh, setFresh] = useState<Record<string, number>>({});
  const wasRunning = useRef<ReadonlySet<string>>(running);
  useEffect(() => {
    const stopped = [...wasRunning.current].filter((file) => !running.has(file));
    wasRunning.current = running;
    if (stopped.length > 0) setFresh((was) => ({ ...was, ...Object.fromEntries(stopped.map((file) => [file, (was[file] ?? 0) + 1])) }));
  }, [running]);
  const extent = useMemo(() => extentOf(index, page), [index, page]);
  const order = useMemo(() => {
    const listed = (index.order ?? []).filter((f) => index.boards[f] !== undefined);
    return [...listed, ...Object.keys(index.boards).filter((f) => !listed.includes(f))];
  }, [index]);

  /**
   * The person has panned or zoomed since the last fit: the board then stays where they put it when its
   * box changes size. Until then it fits again as the box grows.
   */
  const moved = useRef(false);
  /**
   * Fit every artboard of the page in the box, 32 px clear, between 5% and 100%. A box not yet measured
   * (a column that fills, first drawn 0 tall) is not fitted: a zoom worked out from it is negative, and
   * a negative scale draws the board turned over.
   */
  const fit = (): void => {
    const el = box.current;
    if (el === null || el.clientWidth <= 0 || el.clientHeight <= 0) return;
    moved.current = false;
    const room = (side: number): number => Math.max(side - 64, side / 2);
    const z = Math.max(0.05, Math.min(1, room(el.clientWidth) / Math.max(extent.w, 1), room(el.clientHeight) / Math.max(extent.h, 1)));
    setView({ z, x: (el.clientWidth - extent.w * z) / 2 - extent.x * z, y: (el.clientHeight - extent.h * z) / 2 - extent.y * z });
  };
  const fitNow = useRef(fit);
  fitNow.current = fit;
  useLayoutEffect(fit, [extent.x, extent.y, extent.w, extent.h]);
  // The box measured, grown or turned: fitted again, unless the person has moved the board.
  useEffect(() => {
    const el = box.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => {
      if (!moved.current) fitNow.current();
    });
    watch.observe(el);
    return () => watch.disconnect();
    // The box is drawn again when an artboard is focused and back: watched from each.
  }, [focused]);

  // A link to another artboard (format.md, "Links between artboards"): opened alone, the view follows it;
  // running on the board, the run moves to it and it is brought into view.
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: string; href?: string; phase?: string; x?: number; y?: number } | null;
      // The middle button dragged inside a running frame: where the pointer is, placed in the window by
      // where the frame stands now; the board pans by how far that moved, committed at once.
      if (data?.type === "dc:pan" && typeof data.x === "number" && typeof data.y === "number") {
        const el = [...frames.current.values()].find((f) => f.contentWindow === event.source);
        if (el === undefined) return;
        const box = el.getBoundingClientRect();
        const scale = el.offsetWidth > 0 ? box.width / el.offsetWidth : 1;
        const p = { x: box.left + data.x * scale, y: box.top + data.y * scale };
        const was = framePan.current;
        framePan.current = data.phase === "end" ? null : p;
        if (data.phase === "start" || was === null) return;
        moved.current = true;
        flushSync(() => setView((v) => (v === null ? v : { ...v, x: v.x + p.x - was.x, y: v.y + p.y - was.y })));
        return;
      }
      const wheel = frameWheel(data);
      if (wheel !== null) {
        const el = [...frames.current.values()].find((f) => f.contentWindow === event.source);
        if (el === undefined) return;
        // Opened alone: the box around the artboard scrolls; nothing zooms.
        if (focused !== null) {
          if (!wheel.ctrl) el.parentElement?.scrollBy(wheel.dx, wheel.dy);
          return;
        }
        const host = box.current;
        if (host === null) return;
        const p = framePoint(el, wheel.x, wheel.y);
        const rect = host.getBoundingClientRect();
        moved.current = true;
        setView((v) => (v === null ? v : wheelView(v, p.x - rect.left, p.y - rect.top, wheel.dx, wheel.dy, wheel.ctrl)));
        return;
      }
      if (data?.type !== "dc:navigate" || typeof data.href !== "string") return;
      const from = [...frames.current.entries()].find(([, el]) => el.contentWindow === event.source)?.[0];
      const target = data.href.replace(/^\/?project\//, "");
      const b = index.boards[target];
      if (from === undefined || b === undefined) return;
      if (focused === from) {
        setFocused(target);
        return;
      }
      if (!running.has(from)) return;
      setRunning((was) => {
        const next = new Set(was);
        next.delete(from);
        next.add(target);
        return next;
      });
      if (b.page !== undefined && b.page !== page) setPage(b.page);
      const el = box.current;
      if (el !== null) {
        moved.current = true;
        setView((v) => (v === null ? v : { ...v, x: (el.clientWidth - b.w * v.z) / 2 - b.x * v.z, y: (el.clientHeight - b.h * v.z) / 2 - b.y * v.z }));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [index, focused, running, page]);

  // The wheel: Ctrl (or a pinch, which Chromium reports as Ctrl) zooms about the pointer; else it pans.
  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      moved.current = true;
      const rect = el.getBoundingClientRect();
      setView((v) => (v === null ? v : wheelView(v, e.clientX - rect.left, e.clientY - rect.top, e.deltaX, e.deltaY, e.ctrlKey)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Safari's own pinch (`gesture*`, WebKit only) would zoom the page around the board; the board zooms itself.
  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    const stop = (e: Event): void => e.preventDefault();
    for (const name of ["gesturestart", "gesturechange"]) el.addEventListener(name, stop, { passive: false });
    return () => {
      for (const name of ["gesturestart", "gesturechange"]) el.removeEventListener(name, stop);
    };
  }, []);

  // Fingers and the mouse: one pointer down drags the board; two pinch it, zooming about the point
  // between them and following it as it moves.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; bx: number; by: number; z: number } | null>(null);
  const viewNow = useRef(view);
  viewNow.current = view;
  const spanOf = (): { d: number; mx: number; my: number } | null => {
    const [a, b] = [...pointers.current.values()];
    const rect = box.current?.getBoundingClientRect();
    if (a === undefined || b === undefined || rect === undefined) return null;
    return { d: Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1), mx: (a.x + b.x) / 2 - rect.left, my: (a.y + b.y) / 2 - rect.top };
  };
  /** Begin what the pointers now down ask for, from the view as it stands. */
  const begin = (): void => {
    const v = viewNow.current;
    drag.current = null;
    pinch.current = null;
    if (v === null) return;
    const [only] = [...pointers.current.values()];
    if (pointers.current.size === 1 && only !== undefined) drag.current = { x: only.x, y: only.y, vx: v.x, vy: v.y };
    const span = pointers.current.size >= 2 ? spanOf() : null;
    // The board's point under the fingers' middle stays under it.
    if (span !== null) pinch.current = { d: span.d, bx: (span.mx - v.x) / v.z, by: (span.my - v.y) / v.z, z: v.z };
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // The left button drags the board, and the middle one too (as on every canvas).
    if (view === null || (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    begin();
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current !== null || drag.current !== null) moved.current = true;
    const p = pinch.current;
    if (p !== null) {
      const span = spanOf();
      if (span === null) return;
      const z = Math.min(4, Math.max(0.05, (p.z * span.d) / p.d));
      viewNow.current = { z, x: span.mx - p.bx * z, y: span.my - p.by * z };
      setView(viewNow.current);
      return;
    }
    const d = drag.current;
    if (d === null) return;
    setView((v) => (v === null ? v : { ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointers.current.delete(e.pointerId)) return;
    // A finger lifted from a pinch: the one left drags on from where the board now is.
    begin();
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
        </div>
        <div style={{ flex: 1, overflow: "auto", background: "#eceef3", display: "flex", justifyContent: "center", padding: 24 }}>
          <iframe
            key={focused}
            ref={(el) => {
              if (el !== null) frames.current.set(focused, el);
              else frames.current.delete(focused);
            }}
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
      </div>
      <div
        ref={box}
        onPointerDown={onDown}
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        // `clip`, not `hidden`: a hidden box can be scrolled (by focus), and the pointer's place read off it is then off.
        style={{ position: "relative", flex: 1, overflow: "clip", cursor: drag.current !== null ? "grabbing" : "grab", background: "#eceef3", backgroundImage: "radial-gradient(#cfd3de 1px, transparent 1px)", backgroundSize: "16px 16px", touchAction: "none" }}
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
                      <span style={running.has(file) ? { color: RUN, fontWeight: 600 } : undefined}>
                        {b.title ?? file.replace(/\.dc\.html$/, "")}
                        {running.has(file) ? " · running" : ""}
                      </span>
                      {b.is_interactive === true ? (
                        <button
                          type="button"
                          // The board drags under a press; a press here is the button's.
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() =>
                            setRunning((was) => {
                              const next = new Set(was);
                              if (next.has(file)) next.delete(file);
                              else next.add(file);
                              return next;
                            })
                          }
                          title={running.has(file) ? "Stop running it" : "Run it where it sits"}
                          aria-label={running.has(file) ? "Stop" : "Run"}
                          style={{ font: "inherit", fontSize: "0.85em", lineHeight: 1.25, padding: "0 0.4em", borderRadius: "0.3em", border: `1px solid ${RUN}`, background: running.has(file) ? RUN : "#fff", color: running.has(file) ? "#fff" : RUN, cursor: "pointer" }}
                        >
                          {running.has(file) ? "■" : "▶"}
                        </button>
                      ) : null}
                    </div>
                    <iframe
                      key={`${file}#${String(fresh[file] ?? 0)}`}
                      ref={(el) => {
                        if (el !== null) frames.current.set(file, el);
                        else frames.current.delete(file);
                      }}
                      title={b.title ?? file}
                      src={frameSrc(file)}
                      sandbox="allow-scripts allow-same-origin allow-popups"
                      allow="clipboard-write"
                      loading="lazy"
                      // The board pans and zooms under the pointer; an artboard is used running, or opened alone.
                      style={{
                        width: b.w,
                        height: b.h,
                        border: 0,
                        display: "block",
                        background: "#fff",
                        pointerEvents: running.has(file) ? "auto" : "none",
                        borderRadius: b.radius ?? 0,
                        outline: running.has(file) ? `${2 / view.z}px solid ${RUN}` : "none",
                        boxShadow: running.has(file) ? `0 0 0 ${6 / view.z}px rgba(15,122,69,.14)` : b.frameless === true ? "none" : "0 1px 3px rgba(18,21,38,.12)",
                      }}
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

/** The colour of a running artboard's ring and its control. */
const RUN = "#0f7a45";

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
