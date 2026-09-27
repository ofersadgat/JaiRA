---
id: engineering/decisions/0012-local-server
type: decision
status: accepted
updated: 2026-09-26
decides_for: [engineering/units/ipc-bridge, engineering/units/app-shell, engineering/units/cli, engineering/units/secret-chain]
---

# 0012. One engine per person, a local server, and how the desktop and CLI find it

This is the local step. Remote connections come after it ("after that, we can worry about remote
connections"). The person's rulings of 2026-09-26 are quoted where they settle something.

## Context

The engine is `AppService` (`packages/app/src/main/service.ts`, about 12k lines). It imports no Electron.
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
  for the current user only, or connections from another user refused.
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
