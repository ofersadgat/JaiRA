/**
 * While an agent uses the mouse and keyboard (decision 0018, ruling 6): a band above every other window,
 * at the top of the screen, saying so — with Stop.
 *
 * A window of its own rather than a strip inside JaiRA's, because while an agent drives, JaiRA's window is
 * the one it is NOT using: the app it clicks in is in front, and a strip in JaiRA would be behind it. The
 * band is always on top and never takes the keyboard (`focusable: false`), so showing it does not move
 * the focus the agent is typing into; a click still lands on it. It is JaiRA's own window, so the agent's
 * own clicks never reach it (`control_input` refuses JaiRA's windows).
 *
 * The page is a `data:` URL with no preload and no Node: Stop is a link to `jaira-band://stop`, and the
 * navigation is caught here, never made.
 */
import { BrowserWindow, screen } from "electron";
import type { DesktopDriving } from "@jaira/shared";

const WIDTH = 460;
const HEIGHT = 46;
const STOP_URL = "jaira-band://stop";

let band: BrowserWindow | undefined;

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; overflow: hidden; background: #1c2029; color: #e6e9ef; font: 13px/1.3 "Segoe UI", system-ui, sans-serif; user-select: none; }
  .band { box-sizing: border-box; height: 100%; display: flex; align-items: center; gap: 12px; padding: 0 8px 0 14px; border: 1px solid #3b4356; border-top: 0; border-radius: 0 0 10px 10px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #ffc857; flex: none; }
  .words { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  a { flex: none; text-decoration: none; color: #fff; background: #c02c1f; padding: 6px 14px; border-radius: 7px; font-weight: 600; }
  a:hover { background: #d63a2c; }
</style></head>
<body><div class="band"><span class="dot"></span><span class="words">An agent is using your mouse and keyboard</span><a href="${STOP_URL}">Stop</a></div></body></html>`;

/** Show the band while `driving` says an agent is at it, and take it down when it is not. `stop` is the band's Stop. */
export function showDrivingBand(driving: DesktopDriving | null, stop: () => void): void {
  if (driving === null) {
    if (band !== undefined && !band.isDestroyed()) band.destroy();
    band = undefined;
    return;
  }
  if (band !== undefined && !band.isDestroyed()) return;
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const win = new BrowserWindow({
    x: Math.round(area.x + (area.width - WIDTH) / 2),
    y: area.y,
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#1c2029",
    title: "JaiRA — an agent is using your mouse and keyboard",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (url === STOP_URL) stop();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.showInactive();
  });
  win.on("closed", () => {
    if (band === win) band = undefined;
  });
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  band = win;
}
