---
id: engineering/units/app-shell
type: engineering-unit
status: shipped
updated: 2026-09-23
implements: [ui/surfaces/app-window, ui/components/context-menu, product/find-out-why-the-app-misbehaves, product/read-what-work-produced, ux/patterns/secret-goes-in-never-comes-back]
layer: service
owns_contracts: [engineering/contracts/artifact-frame-protocol]
requires: [engineering/units/ipc-bridge, engineering/units/project-sessions, engineering/units/app-log, engineering/units/user-settings, engineering/units/project-config, engineering/units/uri-and-artifact-reads, engineering/units/project-layout, engineering/units/project-store]
implemented_by: [packages/app/src/main/index.ts, packages/app/entry.cjs, packages/app/build.mjs, packages/app/src/renderer/index.html]
verified_by: [packages/app/test/csp.test.ts, packages/app/test/service.test.ts, packages/cli/test/home.test.ts]
siblings: [engineering/units/ipc-bridge, engineering/units/project-sessions, engineering/units/app-log, engineering/units/uri-and-artifact-reads]
---

# App shell

## The shell owns the Electron process around the service: the window, its policies, the crash hooks, the keychain adapter, startup and quit

Everything Electron owns lives in `index.ts`, and `AppService` stays Electron-free:

- **Process hooks, at module load.** `crashReporter.start({uploadToServer: false})`; `unhandledRejection` and `uncaughtException` print the stack to the console and call `service.recordCrash`; `warning` calls `service.recordWarning`. None of them exits.
- **The service and its ports.** `index.ts` builds the one `AppService` with `baseDir` from `takeHomeFlag`, the guarded `publish`, `electronKeychain()`, `probeOnStart: true`, `reveal` through `shell.showItemInFolder` and `chooseDirectory` through `dialog.showOpenDialog`. It then files the launch record through `recordApp("info", "JaiRA <version> started", {argv, home, baseDir, pid, platform, electron, chrome, node, logLevel})`.
- **The window.** `createWindow` makes a 1440 by 900 `BrowserWindow`, hidden until loaded, painted with the ground colour `PALETTE_FRAME` gives for the look `service.windowAppearance()` answers — the shared root's `appearance` with the personal layer's over it, never a project's — with `titleBarStyle: "hidden"` and an overlay 34 px high that `repaintTitleBar` recolours after every `config:write` and when the OS switches between light and dark (`nativeTheme` `updated`), which a `system` mode follows. `webPreferences` are `nodeIntegration: false`, `contextIsolation: true`, `sandbox: false` and the bundled `preload.cjs`. `Menu.setApplicationMenu(null)` removes the menu bar.
- **The window policy.** `renderer/index.html` declares `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'self' blob:; font-src 'self'; frame-src jaira-artifact:`.
- **The artifact scheme.** `jaira-artifact` is registered privileged before ready, as `standard` and `secure` with no fetch API and no CORS. `registerArtifactProtocol` serves the body `service.servedArtifact(token)` holds, with a policy that admits inline script only when the grant was interactive. The response is [artifact-frame-protocol](../contracts/artifact-frame-protocol.md).
- **Renderer hooks.** `did-finish-load` sets `rendererAlive`. `render-process-gone` clears it, files the reason, exit code and dump directory, and calls `reloadAfterCrash`. `unresponsive`, `did-fail-load` and each distinct console message at level 3 or above, up to 50, are filed as `renderer` crashes. `context-menu` is forwarded as a `frame:contextMenu` push.
- **OS verbs.** `saveFile` shows a save dialog proposing the name's basename and writes the base64 bytes, answering `{file: null}` when dismissed. `download` hands a URL to Chromium's downloader when its scheme is `data:`, `blob:`, `file:`, `http:`, `https:` or `jaira-artifact:`. `copyImageAt` and `edit` call the window's `webContents`, which acts on the focused frame.
- **Startup and quit.** On ready: register the scheme handler, remove the menu, `registerIpc`, `service.restore()`, open `startupProject()`, create the window, and screenshot to `JAIRA_CAPTURE` when set. `before-quit` is prevented once, files `quitting: draining runs and closing the databases`, and quits when `service.close()` settles.
- **`entry.cjs`.** It calls `process.setSourceMapsEnabled(true)` and then requires `dist/main.cjs`, so stacks in the log name source files. `build.mjs` emits `main.cjs`, `preload.cjs`, `tsProjectWorker.cjs` and `mcpBridgeWorker.cjs`.

It deliberately does not own:

- The channel table and the push guard: [ipc-bridge](ipc-bridge.md).
- Minting artifact tokens and what a grant may read: [uri-and-artifact-reads](uri-and-artifact-reads.md).
- Which projects restore and in what order, and what closing drains: [project-sessions](project-sessions.md).
- The log, its policy and its file: [app-log](app-log.md).
- The credential chain the keychain is one link of: [secret-chain](secret-chain.md).
- The crash screen a render error draws, which is the renderer's.

## The shell is the only Electron code in main, and it calls the service and nothing below it

- Layer `service`, `packages/app`. It may call `AppService`, `takeHomeFlag` from [project-layout](project-layout.md) and `isProject` from [project-store](project-store.md).
- Boundary: renderer and main. The renderer gets no Node and runs with `contextIsolation`; `sandbox` is off.
- The window sets no navigation handler, no window-open handler and no permission handler, and the app takes no single-instance lock.
- Upstream seam: none. Electron's `safeStorage`, `protocol`, `dialog`, `shell` and `crashReporter` are its platform.
- The base root is `--home <dir>`, else `JAIRA_HOME`, else the `baseDir` saved in the default root's `user-settings.json`, else `~/.jaira`.
- The startup project is `JAIRA_PROJECT`, else the first command-line argument that does not start with `-` and exists, else the working directory when it holds `.jaira/`.

## The shell holds one file of its own and the window's liveness in memory

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `userData/secrets.json`, `{<name>: base64 safeStorage ciphertext}` | read whole on every `get`, `set` and `remove`; written whole with `writeFileSync` on `set` and `remove` | the file, unreadable without the OS keyring entry | [secret-chain](secret-chain.md) reads and writes through `KeychainPort` |
| Crash dumps | written by crashpad under `app.getPath("crashDumps")`, never uploaded | that directory | named in the `renderer` crash entry |
| `window`, `rendererAlive`, `closing`, `reloadedAt` | set by the window and quit hooks | `index.ts` memory | [ipc-bridge](ipc-bridge.md) reads `window` and `rendererAlive` before every push |
| `appearance` in `<base>/settings.json` and `<base>/personal-settings.json` | read through `AppService.windowAppearance` at window creation, after every `config:write` and on `nativeTheme` `updated` | the files | [project-config](project-config.md) |
| Launch, `app`, `crash` and `runtime` entries | filed through `recordApp`, `recordCrash`, `recordWarning` | the app log | [app-log](app-log.md) |

`KeychainPort` is `available(): boolean` checked on every call against `safeStorage.isEncryptionAvailable()`, `reason` `this system provides no OS-backed encrypted store, so secrets must go in a .env.local file`, `get(name)`, `set(name, value)` and `remove(name)`.

## The invariants keep remote code out of the window and every failure on record

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | The window declares a content policy | `csp.test.ts` "is declared at all" |
| 2 | WebAssembly compiles through `'wasm-unsafe-eval'`, and `'unsafe-eval'` is never admitted | `csp.test.ts` "permits WebAssembly, which the TextMate tokenizer needs" |
| 3 | `default-src` is `'none'` and no script source names a remote origin | `csp.test.ts` "still admits no remote code" |
| 4 | What the shell does is filed under source `app` with its detail | `service.test.ts` "records what the SHELL did, which the service could not have seen" |
| 5 | A process crash is filed at `error` under source `crash` with its stack, and a Node warning at `warn` under `runtime` with its stack | `service.test.ts` "records a crash under its OWN source, with the stack", "records a Node warning with the stack that names where it came from" |
| 6 | The crash reporter never throws, whatever it is handed | `service.test.ts` "never throws out of the crash reporter, whatever it is handed" |
| 7 | `--home <dir>` is lifted out wherever it sits and resolved, a command line without it is left as it was, and a flag with no directory after it is malformed and consumes only itself | `home.test.ts` "lifts the flag out of the arguments wherever it sits, and resolves the path", "leaves a command line that never mentions it exactly as it was", "reports a flag with nothing after it, and one followed by another flag" |
| 8 | An artifact frame is served a script-permitting policy only for a grant whose record claimed `interactive` | unasserted |
| 9 | A renderer that dies again within 30 s of a reload is not reloaded | unasserted |
| 10 | A quit does not proceed until `service.close()` settles | unasserted |
| 11 | `download` starts nothing for a URL whose scheme is not on its list | unasserted |

## The failures leave the window standing where they can, and none of them loses a run

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The renderer process dies | filed with reason, exit code and dump directory; reloaded once, unless the reason is `clean-exit` or the app is quitting | the reloaded page reads everything again | the window goes blank, then comes back |
| The renderer dies again within 30 s of that reload | files `the renderer died again within 30s of being reloaded; leaving the window as it is` | quit and relaunch | a blank window |
| The renderer hangs or the page will not load | filed as a `renderer` crash; nothing else | quit and relaunch | a frozen or blank window |
| A run never settles while quitting | `service.close()` waits for it with no timeout, so `app.quit` is never called | end the process | no window, and the process keeps running |
| Two app instances run against one base root | no lock; each rewrites `user-settings.json` and `secrets.json` whole from what it read, and each opens the same project databases | none | a preference or stored key the other instance wrote disappears |
| The process is killed while `secrets.json` is written | the write is not atomic; a truncated file parses as `{}`, every key reads absent, and the next `set` writes only its own key | enter the keys again | providers read as missing their keys |
| A ciphertext was written under another OS user or a reset keyring | `decryptString` throws and `get` answers `undefined`, so the chain falls through | enter the key again | the key reads as missing |
| The command line holds `--home <dir>` | `startupProject` takes `<dir>` as the project argument, and its open fails unless `<dir>` holds `.jaira/` | pass the root through `JAIRA_HOME` instead | a `failed to open <dir>` error in Logs at every launch |
| Restoring the remembered projects throws | filed `failed to re-open the remembered projects: <message>` with the stack; the window still opens | reopen the project | the window opens without its projects |
| A save or a download is asked for twice | each call opens its own dialog or starts its own download | none needed | a second dialog |

## The budgets are fixed in `index.ts`

- Window 1440 by 900 px, and a title bar overlay of `TITLE_BAR_HEIGHT` 34 px.
- `RELOAD_BACKOFF_MS` 30 000 ms between reloads after a renderer death.
- `RENDERER_CONSOLE_LIMIT` 50 distinct renderer console errors filed per window.
- `JAIRA_CAPTURE_DELAY_MS` 1200 ms before a capture, by default.

## The shell departs from Node's defaults so that a failure is recorded rather than fatal

- The process handlers never exit, because the run loop already fails the run a failure belongs to and exiting would take down the Logs view someone needs next.
- The hooks are installed at module load, before `AppService` exists, because constructing the service can itself throw; each wraps its call to the service in `try`.
