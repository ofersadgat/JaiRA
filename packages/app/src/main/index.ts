/**
 * Electron main process: the desktop window, or — with `--serve` — the engine as a windowless server
 * (decision 0012 §5-§6). One bundle for both, so the server runs the very Electron, keychain and
 * `userData` the desktop does; each module is evaluated only when it is the one started.
 */
import { app } from "electron";
import { pidAlive } from "@jaira/service";
import { enableChromiumLog } from "./chromiumLog";
import { claimProfile } from "./profile";

// The Chromium profile and its log file, both before either mode loads: `sessionData` and the logging
// switches must be set before `ready`, and a window and a server alike are a process that would
// otherwise share them. See `profile.ts` and `chromiumLog.ts`.
const userData = app.getPath("userData");
let profile: number | undefined;
try {
  const claimed = claimProfile(userData, process.pid, pidAlive);
  if (claimed.dir !== undefined) app.setPath("sessionData", claimed.dir);
  process.on("exit", claimed.release);
  profile = claimed.index;
} catch {
  // No pool (a `userData` that cannot be written): the default profile, shared as it always was.
}
try {
  enableChromiumLog(app, userData, profile);
} catch {
  // Chromium's lines stay on stderr only, where they always were.
}

if (process.argv.includes("--serve")) require("./serve");
else require("./desktop");
