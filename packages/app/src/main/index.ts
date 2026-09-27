/**
 * Electron main process: the desktop window, or — with `--serve` — the engine as a windowless server
 * (decision 0012 §5-§6). One bundle for both, so the server runs the very Electron, keychain and
 * `userData` the desktop does; each module is evaluated only when it is the one started.
 */
if (process.argv.includes("--serve")) require("./serve");
else require("./desktop");
