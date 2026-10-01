---
id: engineering/decisions/0012-local-server
type: decision
status: accepted
updated: 2026-09-27
decides_for: [engineering/units/ipc-bridge, engineering/units/app-shell, engineering/units/cli, engineering/units/secret-chain]
---

# 0012. One engine per person, a local server, and how the desktop and CLI find it

This is the local step. Remote connections come after it ("after that, we can worry about remote
connections"). The person's rulings of 2026-09-26 are quoted where they settle something.

## Context

The engine is `AppService` (`packages/service/src/service.ts`, about 12k lines). It imports no Electron.
The capabilities only Electron has are injected: `publish`, `keychain`, `reveal` and `openExternal`.

The desktop reaches it through one bridge:

- `window.jaira.invoke(channel, request)` over about 137 channels, plus one push channel
  ([ipc-bridge](../units/ipc-bridge.md)).
- The renderer touches that bridge only in `renderer/store.ts`.
- Main's `handlers` table maps each channel to one service method.

The CLI does not use `AppService`. It opens projects and drives runs itself, through `runTaskNow`, with
approvals asked at the terminal ([cli](../units/cli.md)). The two already share the per-project
databases, and they keep out of each other's runs only through the run claims in the `jobs` table
([process-claims](../units/process-claims.md)). Two engines on one machine is therefore possible today
and merely tolerated.

t3code (read 2026-09-26) runs its engine as a server that every client reaches over a WebSocket, even
the desktop's own window. That is the reference for the remote step, not a model to copy here: the
person chose to keep the engine in the desktop by default.

## Rulings (2026-09-26)

1. **Where the engine runs by default:** "1a (with a setting that allows the user to choose b)". The
   desktop runs the engine in its own process, as today. A setting makes it start a separate server and
   connect to that instead.
2. **Quitting:** "2 setting". Whether a server the desktop started keeps running after the desktop quits
   is a setting.
3. **CLI commands:** "3 yes". They go through the running engine when there is one.
4. **The command:** "4 installer", and the npm package stays, "as the cli should also be capable of
   starting the server".
5. **The local transport:** a per-user pipe carries the whole local connection. A TCP port exists only
   for network access, in the remote step ("2 yes").
6. **One engine per person:** "3 yes". The desktop's own engine answers CLI commands too.
7. **Discovery order:** "we should look through the process list first, then try ipc to get the info,
   if that doesnt work, fallback to a specific port, if that doesnt work, fallback to the file
   solution." The person does not want the server found only through a known file.

## Decision

### 1. `@jaira/service`: the engine as a package

`AppService`, its options and the `handlers` table move out of `packages/app` into a new
Electron-free package, `packages/service`.

- The desktop's main process and `jaira serve` both construct it.
- The table becomes the one dispatch that every transport shares: Electron IPC and the pipe.
- The OS verbs stay with whoever has an OS to act on. That is the desktop's main process: `shell:*`,
  the `project:choose` dialog, `reveal`, `openExternal`, the frame and the title bar.
- A server has no window, so it answers those channels with a refusal. The desktop client answers them
  locally even when connected to a server.

### 2. The engine host: one per person

**The host is whichever process holds the engine:** the desktop (the default) or `jaira serve`. There is
at most one per user and per `JAIRA_HOME`.

**The claim:**

- A process becomes the host by creating the pipe:
  - Windows: `\\.\pipe\jaira-<user>-<hash of JAIRA_HOME>`.
  - Elsewhere: a Unix socket in a `0700` directory under `$XDG_RUNTIME_DIR`, or `/tmp/jaira-<uid>/`.
    Unix socket paths are limited to about 104 bytes on macOS, so the socket does not live under a
    long home path.
- Whoever creates the pipe first is the host, and everything else connects to it.

**To verify at build:**

- Windows grants a named pipe's first instance only with `FILE_FLAG_FIRST_PIPE_INSTANCE`. It must be
  confirmed that Node's `net` listen refuses a second host.
- **Windows' default named-pipe DACL lets other accounts read.** The pipe must be created with a DACL
  for the current user only, or connections from another user refused. (As built, they are refused:
  Node cannot set the DACL, so `hello` needs a token only the person can read. See Built, step 2.)
- A stale Unix socket file is replaced only after a connect to it fails.

**When a client loses its host,** for example because `jaira serve` was stopped, it runs discovery (§4)
again. If it finds nothing, it becomes a host by the same rules as at start.

### 3. The pipe protocol

The pipe carries the existing contract unchanged:

- A request is `{id, channel, request}` and its answer is `{id, result}` or `{id, error}`.
- Pushes are frames of the `PushMessage` union.
- Framing is length-prefixed JSON.
- The first exchange is `hello`, which carries the contract version, the app version and the host kind.
  On a mismatch, the client says so and offers to restart the host on its own version, instead of
  guessing.

**The desktop as a client:** the renderer is untouched. Main swaps its `handlers` for a forwarder that
relays each request to the pipe and each push back to the window. `store.ts` does not know which kind
of host it is talking to.

**Several clients at once:**

- The host sends every push to every client.
- State that belongs to one window becomes per connection: the current project (`project:current` /
  `restore()`) and `limits:watch`, which is a single boolean today.
- An approval or question is answered by whichever client answers first. The others receive
  `…:resolved`.

**Reconnecting:**

- A local pipe rarely drops. When it does, the client refetches through the existing `store:invalidate`
  path.
- Resuming from `afterSeq` on the journal is left to the remote step, where connections drop for real.

### 4. Finding the host, in the person's order

1. **The process list.** Is a JaiRA process running?
   - On Windows this is read with the toolhelp snapshot, never WMI, which can hang.
   - Windows gives executable names, not command lines. A server started from the npm CLI shows as
     `node`, so the list is a hint and never the answer.
   - What it adds is the case where a JaiRA process exists but nothing answers on the pipe. That case
     is reported to the person as stuck, with its process id. No second engine starts beside it.
2. **The pipe.** Connect and `hello`. This is both how the details are asked for and, from then on, the
   connection itself.
3. **A fixed loopback port.** A port only a host started with network access, or one that could not
   create its pipe, listens on. Examples: a server inside WSL reached from a Windows desktop, or a
   sandbox without pipes.
   - The port answers `hello` without a token, but it says only who and what version it is.
   - Using it needs the token from step 4.
4. **The file.** `~/.jaira/system/engine.json`, mode `0600`, holding
   `{pid, pipe, port?, token?, version, startedAt}`. The host writes it and deletes it when it stops.
   A leftover file whose `pid` is gone is stale and ignored.

If every step finds nothing, there is no host.

### 5. Who starts a host

- **The desktop, by default:**
  - It runs discovery at start.
  - If it finds a host, it connects to it, whatever the setting says. The person: "make the desktop app
    connect to / use the local server if its running".
  - If it finds none, it hosts the engine itself.
- **The desktop with `engine.separateServer` on:**
  - Instead of hosting itself, it starts `jaira serve` detached and connects to it.
  - `engine.keepServerRunning` decides whether that server stops when the desktop quits.
  - Both settings live in the personal ("Just you") layer, and both default to off.
- **`jaira serve`:** hosts until it is stopped. `jaira server status` and `jaira server stop` answer
  through the pipe.
- **Any other CLI command** that touches the engine goes through the host when there is one:
  `run`, `task …`, `board` and `prune`.
  - Its terminal approvals come from the pushes and are answered like any client's.
  - Commands that only read files, such as `workflow lint` and `workflow check`, need no host.
  - With no host, the command runs in-process and holds the claim while it runs (last section).

### 6. The keychain in a server

- **Where the keychain lives today:** Electron's `safeStorage` over `userData/secrets.json`. It works
  only in Electron's main process, not in Node mode.
- **A server the desktop or the installer's `jaira` starts** therefore runs the app's Electron binary
  as a windowless main process, not with `ELECTRON_RUN_AS_NODE`. It then has `safeStorage` and the
  same `userData`, so the keychain is the same one.
- **The installer's other commands** still run in Node mode (0011 §7). A windowless Electron main has
  no usable console on Windows, and a command needs one.
- **The npm CLI's `jaira serve`** runs on plain Node and has no keychain. The secret chain already
  handles that case (`keychain.available()` is false), and Settings says why a keychain secret is not
  seen.

## Build order

1. Move `AppService` and `handlers` into `@jaira/service`, with no change in behaviour. The desktop
   still runs it in-process.
2. The pipe protocol and host claim, with the desktop as a host that answers on the pipe.
   - Verify the DACL and the first-instance behaviour on Windows.
   - Clients get per-connection state and every push.
3. Discovery in the ruled order.
4. The desktop as a client: the forwarder in main and the `hello` version check.
5. `jaira serve` and `jaira server status|stop`, as a windowless Electron main from the installer or
   plain Node from npm.
6. CLI commands through the host, with terminal approvals over pushes.
7. `engine.separateServer` and `engine.keepServerRunning`. Their Settings rows are drawn first.

## Built

**Step 1, 2026-09-27: the engine is `@jaira/service`, with no change in behaviour.**

- **What moved:** everything in `packages/app/src/main` without Electron in it went to
  `packages/service/src`: `service.ts`, `session.ts`, `limits.ts`, `waiting.ts`, `health.ts`,
  `diagnostics.ts`, the TypeScript worker and the rest. Only `index.ts` and `preload.ts` import
  Electron.
- **What stayed with the desktop:** `index.ts` and `preload.ts`, plus the updater (`updates.ts`) and the
  `jaira` command's status (`cliCommand.ts`), which are the installed app's concerns.
- **How it is reached:** the package exports `.` and `./*`. Tests reach a module as
  `@jaira/service/<module>` (70 imports rewritten). `tsconfig.base.json` paths and the vitest aliases
  resolve it to this checkout's sources, as for the other `@jaira/*` packages, and `npm run typecheck`
  checks it.
- **The one dispatch:** `serviceHandlers(service)` (`handlers.ts`) answers the 136 channels that are the
  service's. `HOST_CHANNELS` lists the 15 a host answers itself:
  - Electron's save dialog, download, image copy and editor launch;
  - the licence file;
  - the updater;
  - plugins;
  - the `jaira` command.
  
  The desktop merges its own over the service's, typed `Record<IpcChannel, Handler>`, so a channel
  missing from both still fails to compile.
- **Plugins stay a host channel for now.** Their downloads, and the progress main keeps for them, move
  when a server needs them (step 5).
- **The worker bundle:** the app's `build.mjs` now builds the TypeScript worker from
  `../service/src/tsProjectWorker.ts`. The workers are still found beside whichever bundle includes the
  service (`__dirname`).
- **Verified:** typecheck, the full suite (351 files), and the packaged app's probe, command and smoke
  test.

**Step 2, 2026-09-27: the desktop hosts the engine on the pipe.**

- **The pieces** are three modules in `@jaira/service`:
  - `enginePipe.ts`: the paths, `engine.json`, the frames and `ENGINE_CONTRACT`;
  - `engineHost.ts`: `claimEngine` and `EngineHost`;
  - `engineClient.ts`: `connectEngine` and `EngineClient`, for steps 4 and 6.
- **The claim is the listen, measured.** On Windows a second `listen` on the same pipe name fails with
  `EADDRINUSE`, in the same process and from another one, so `claimEngine` answers `undefined` and
  nothing else is needed.
  - On POSIX a socket file that nothing answers on is removed and the listen tried once more.
  - A Windows pipe goes with its process. A hard-killed desktop left its `engine.json` behind, and the
    next launch claimed the pipe and wrote over it.
- **Other accounts are kept out by a token, not a DACL.** Node's `net` cannot set a pipe's DACL.
  - The host writes a random 32-byte token into `engine.json`, in the person's profile, `0600` where
    modes exist.
  - The host sends nothing until a client's `hello` carries that token; it is compared in constant time.
  - So a client that cannot read the person's files cannot get past `hello`.
- **The frames:**
  - Client to host: `hello {token, contract, version, client}`, then `req {id, channel, request}`.
  - Host to client: `welcome {host}` or `refused {reason}`, then `res {id, ok, result | error}` and
    `push {message}`.
  - Every frame is length-prefixed JSON (4 bytes, big-endian), at most 256 MB.
- **The contract** is a hash of the sorted channel names. A client with another is refused, with both
  versions named. Offering to restart the host on the client's version is the desktop client's job
  (step 4).
- **What the pipe answers:**
  - The pipe answers the service's channels (`serviceHandlers`), plus the desktop's follow-up to
    `config:write` (the title bar and the update channel).
  - It does not answer the host's own channels (dialogs, the clipboard, the updater, plugins), which
    belong to the window.
  - Every push to the window also goes to every client that is past `hello`.
- **The desktop:**
  - It claims the pipe once IPC is registered, and closes it first on quit, before the service drains.
  - A second desktop logs which process holds the pipe, and runs its own engine beside it until step 4.
  - Per-connection state (`project:current`, `limits:watch`) is left for step 4, which has more than one
    window to keep apart.
- **Found on the real app:**
  - The host used to log "`client` connected" before sending the welcome. That log line is itself a
    push, so a client's first frame was not its welcome. The welcome now goes first, and a test holds
    that order.
  - Separately, `--home <dir>`'s value was being opened as the startup project. The project is now
    read from the arguments left once `--home` is taken out.
- **Verified:**
  - Six pipe tests.
  - Against the built app: a separate process said hello with `engine.json`'s token, got the welcome,
    asked `project:current`, was refused `shell:saveFile`, and heard the pushes.
  - A second instance logged the holder, and a relaunch after a hard kill reclaimed the pipe.
  - The full suite.

**Steps 3–7, 2026-09-27 (the person: "do all the steps").**

- **Discovery (step 3), `engineDiscovery.ts`**, in the ruled order:
  - The process list is STARTED first. On Windows it is `Get-Process` through PowerShell, which reads the kernel's list without WMI: about 0.5 s measured, against 2 s for `tasklist`. Elsewhere it is `ps`.
  - The list is awaited only to judge a host that does not answer. When a host answers, it is aborted, so a command does not wait on it. `server status` awaits it to name other JaiRA processes.
  - Then `who` on the pipe, and `who` on the loopback port (`ENGINE_PORT` 47317). A host listens on that port only when it cannot create its pipe. Each host says which base root it serves (`home`), because the port is shared by every root.
  - Then `engine.json`: the pipe or port it names, when those are not the ones already tried. A host started under another `XDG_RUNTIME_DIR` is found this way.
  - The verdicts:
    - `found`.
    - `stuck`: `engine.json` names a live JaiRA process that answers nothing, and no second engine starts beside it.
    - `none`: a leftover `engine.json` whose process is gone is removed.
- **The host (steps 2–3, extended):**
  - `who` is answered before `hello`, with the host's info and no token.
  - A client with another contract is admitted `limited`. It may ask only the `engine:*` channels, which is enough to say who runs what and to stop a server. It hears no pushes.
  - A connection gets its own answers (`EngineConnections`, `connections.ts`):
    - `project:current` is the project that connection opened last, while it is open.
    - `limits:watch` watches while ANY connection does.
    - The desktop's own window is one connection too.
  - `hostEngine.ts` is the one way to host. The engine is built before the claim or after it, and each `engine:*` channel of `enginePeerHandlers` is added.
  - Those channels are the desktop main process's needs as a client: its launch and crash records, the health board items of the updater and plugins, `activeWork`, `suspendForUpdate`, probes, served artifacts and `restore`. Plus `engine:info` and `engine:stop`.
  - The desktop, the Electron server and the npm server use `hostEngine`, and so does a CLI command's claim. That claim builds no engine unless a client asks it something.
- **The desktop as a client (step 4):**
  - `index.ts` now only chooses: `--serve` starts `serve.ts`, and everything else starts `desktop.ts`. Both are in one bundle and evaluated lazily.
  - The window reaches the engine through an `EngineLink` (`engineLink.ts`): `localLink` over this process's `AppService`, or `remoteLink` over an `EngineClient`. IPC answers `HOST_CHANNELS` itself and forwards everything else.
  - `establishEngine` runs in this order:
    1. A found host is used whatever the setting says.
    2. With `engine.separateServer` on, the window starts the server and connects to it.
    3. Otherwise it claims the engine and only then builds its own. A claim lost to a process that started at the same moment is looked for again.
    4. With no pipe and no port at all, the window runs its engine anyway and says why.
  - A host running another contract:
    - A server gets a dialog, "Restart it on <version>". The server drains, and its runs resume.
    - A window or a command gets "Try again / Quit".
  - A `stuck` host gets "End it and continue / Try again / Quit".
  - A host that goes away (`takeOver`): the window looks again and becomes the host or another host's client, re-opens the remembered projects and reloads the page.
  - The frame's look, the update track and the engine choice come from `machineSettings(baseDir)`, which needs no engine. `resolveBaseDir` is the service's own resolution, used before an engine exists.
  - The updater's `busy` is now async. Runs in another process count only when an install would replace the executable they run on (`sameInstall`).
  - On quit, a server this window started stops unless `keepServerRunning` is on. A server on this very executable stops when an update is about to install.
- **`jaira serve` (step 5):**
  - `serve.ts` is the app's Electron as a windowless main. It has the keychain (`keychain.ts`, shared with the desktop), no GPU and no renderer sandbox. It re-opens the remembered projects and hosts until `engine:stop` or a signal, then drains like a quit.
  - The installed command's `jaira serve` runs it: in the foreground, or with `--detach` returning once it answers. The npm command hosts on plain Node, with no keychain.
  - `jaira server status` prints the host, how it was found and who else is connected. `jaira server stop` waits for the host's process to end. A window or a command refuses to be stopped this way.
  - Plugins still download where a window or command asks. The store is on disk and shared, and a server loads what is there.
- **Commands through the host (step 6), `viaEngine.ts`:**
  - `run` (durable), `task create|start|list|status|cancel|move`, `board` and `prune` go through a found host. They open their project with `remember: false`, so a command does not add it to the window's remembered projects (a new field on `project:open`).
  - Runs are started with `--fake` and `--interactions` as `task:start` takes them, and followed by pushes:
    - Approvals and questions are asked at the terminal, one at a time.
    - A prompt is dropped when another client answers first.
    - Everything is refused at once under `--approve deny`.
    - Nothing is answered with no terminal: the window answers.
    - Ctrl-C cancels the run.
  - Refused function files are approved as `task start` approves them, and the start is tried again.
  - Two things are refused or left out through a host:
    - `--repair-turns` belongs to this process's engine, so it is refused rather than dropped.
    - `task status --events` reads the journal in-process, so through a host the events are left out, with a note.
  - With no host, the old in-process path runs, holding the claim: ruling "a".
  - The CLI bundles now carry the engine: `__dirname` in the banner, the TypeScript worker beside the bundle, and a version define.
  - `ajv/dist/2020` became `ajv/dist/2020.js`, which an ESM bundle needs for an external package.
- **The settings (step 7):**
  - `engine.separateServer` and `engine.keepServerRunning` are machine settings (`JairaEngineConfig`, `parseEngineConfig`, a `configSchema` entry). The window reads them from the built-in, base and personal layers.
  - About → Engine shows where the engine runs now (`engine:status`, pushed as `engine:changed`) and the two switches. They are written to the personal layer, with ↺ like the update track.
  - They take effect at the next start, because moving a running engine would cut its runs. Keep is disabled unless Separate is on.
  - This was drawn with the page's existing row and switch, not mocked up first: the person had asked for all the steps.
- **Verified:**
  - Tests: 11 hosting tests, 3 CLI-through-a-host tests, 3 run-following tests, the updater's with async `busy`, and the full suite.
  - On the dev build:
    - A windowless server hosted the engine, and a window became its client and drew from it.
    - `engine:stop` on the server made the window take the engine over.
    - With `separateServer` the window started a server and stopped it on quit. With `keepServerRunning` too, the server stayed up.
  - The npm CLI:
    - With no host, a run went in-process.
    - `serve --detach`, then a run, `task list`, `task status`, `board`, `prune` and `task cancel` all went through the server.
    - `server stop` drained it.
  - The packaged app's smoke test: `jaira serve --detach` started JaiRA.exe windowless, and `server status` and `server stop` reached it and ended it.
  - The About page was photographed (`shots/about.mts`, `engine.png`). (That script went with the DOM page on 2026-10-01, [0015](0015-one-universal-client.md); the page is the `settings-about` scene of `shots/parityWorld.mts`.)
- **Not yet exercised:**
  - The contract-mismatch and stuck dialogs by hand.
  - POSIX sockets and the loopback port on a real machine without pipes.
  - macOS.
  - A desktop connecting to a command's claim mid-run. The lazily built engine is covered by a test.

## Consequences

**Easier:**

- The remote step adds a transport, a WebSocket with tokens, and discovery on another machine. The
  engine, the protocol and the per-connection state are already in place.
- There are never two engines writing one project's databases.

**Harder:**

- The desktop has two roles, host and client, and must handle switching from one to the other when its
  host disappears.
- Every channel must be sorted into engine or OS verb.

**Foreclosed:** a window-bound assumption inside `AppService`. Anything per window must now be per
connection.

## Revisit when

- The remote step starts. Add `afterSeq` resume, tokens and the WebSocket transport.
- Host switching proves flaky in practice. Then reconsider making the separate server the default,
  which is t3code's model.

## A CLI command with no host (ruled 2026-09-26: "a")

The command runs in-process as today, **and holds the host claim for its duration**. A desktop started
meanwhile connects to it, and becomes the host itself when the command ends, by §2's "lost its host"
rule.

The alternative was to start a detached `jaira serve` and go through it. It would have made the CLI a
pure client, but it leaves a server running after the command ends.
