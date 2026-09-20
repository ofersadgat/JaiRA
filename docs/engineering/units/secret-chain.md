---
id: engineering/units/secret-chain
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/bring-your-own-models-and-agents, ux/patterns/secret-goes-in-never-comes-back]
layer: core
owns_contracts: [engineering/contracts/secret-sources]
requires: [engineering/units/project-layout, engineering/units/project-sessions, engineering/units/app-shell]
implemented_by: [packages/runtime/src/secrets.ts, packages/shared/src/executors.ts, packages/app/src/main/service.ts]
verified_by: [packages/runtime/test/secrets.test.ts, packages/app/test/settings.test.ts]
siblings: [engineering/units/model-routing, engineering/units/agent-executors, engineering/units/project-config]
---

# Secret chain

## The secret chain resolves a credential name to a value and stores one, and never hands a value back to the renderer

`SecretResolver` in `@jaira/runtime` `secrets.ts` answers a name:

- `lookup(name)` walks eight links and returns the first non-empty value as a `SecretHit` `{value, source, file?}`: the injected keychain, `<project>/.jaira/.env.local`, `<project>/.jaira/.env`, `<project>/.env.local`, `<project>/.env`, `<base>/.env.local`, `<base>/.env`, then the environment.
- `describe(name)` returns the same hit as a `SecretOrigin` `{source, file?}` with the value removed. That is the only shape that crosses to the renderer.
- `parseEnvFile(text)` reads the `.env` dialect, skipping any line it cannot read.
- Each `.env` file is parsed once per resolver instance and cached.

The wire types `SecretSource`, `SecretOrigin`, `SecretTarget`, `SECRET_SOURCE_LABELS` and `SECRET_TARGET_LABELS` live in `@jaira/shared` `executors.ts` so the renderer can name them.

`AppService` in `service.ts` stores and anchors:

- `secretResolver(target?)` builds a fresh resolver per call, anchored on the named session or the one open user project, with the shared root, and with `keychain.get` only while `keychain.available()` is true.
- `secretCapabilities()` answers `secret:capabilities` with `{keychain, keychainReason?}`.
- `setSecret({name, value, target, project?})` answers `secret:set`: it refuses a name not matching `^[A-Za-z_][A-Za-z0-9_.-]*$`, writes to the keychain or through `writeEnvEntry` to `<base>/.env.local` or `<project>/.jaira/.env.local`, removes the entry when `value` is empty, and returns `{name, target}`.
- `KeychainPort` is the synchronous port the Electron main process injects.

It deliberately does not own:

- Which name a route or executor asks for and what a missing key means: [model-routing](model-routing.md) and [agent-executors](agent-executors.md).
- The Electron adapter `electronKeychain` and its `userData/secrets.json`: [app-shell](app-shell.md).
- Writing the name into a configuration layer after a key is stored. The Settings store's `saveCredential` does that through `config:write` when the name is new: [project-config](project-config.md).
- Where the files sit: [project-layout](project-layout.md).

## The resolver is runtime code with the keychain injected, and the app and the CLI each build their own

- Layer `core`, package `@jaira/runtime`. It reads files with `node:fs` and imports only `JAIRA_DIR_NAME` and types from `@jaira/shared`.
- The keychain arrives as a function because `safeStorage` is Electron's and the runtime is shared with the CLI. The CLI builds one resolver per run in `cli.ts` with `projectDir` and the shared root and no keychain.
- Boundary: renderer and main. A value enters over `secret:set` and no channel returns one; probes and Settings carry `SecretOrigin` only.
- Boundary: derived and committed. The template `.gitignore` ignores `.env.local`; a `.env` is not ignored, so a value in `<project>/.jaira/.env` or `<project>/.env` is committable.
- Upstream seam: none of its own. `modelRouterOptions` in [model-routing](model-routing.md) puts `lookup` values into `@declarative-ai/llm` `ModelRouterOptions`, and probes receive the resolver as `ProbeOptions.secrets`.

## The keychain and the files are the truth, and a resolver holds a snapshot of the files it has read

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| Keychain entries | read through `KeychainPort.get`; written and removed by `setSecret` with target `keychain` | `safeStorage` ciphertext in `userData/secrets.json` | [app-shell](app-shell.md) owns the file |
| `<base>/.env.local` | read; written by target `base-env-local` | the file | hand edits |
| `<project>/.jaira/.env.local` | read; written by target `project-env-local` | the file | hand edits |
| `<project>/.jaira/.env`, `<project>/.env.local`, `<project>/.env`, `<base>/.env` | read only | the files | hand edits and the project's own tooling |
| The environment | read from `options.env` or `process.env` | the process | provider SDKs |
| Parsed file cache | filled on first read of each file | the files at that moment | nothing; it dies with the resolver |

## The invariants fix the order, keep blanks from shadowing a key, and keep values out of every report

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | The keychain beats every file and the environment, and with no keychain injected it is skipped | `secrets.test.ts` "prefers the keychain over every file and the environment", `"skips the keychain entirely when none is injected — the CLI's situation"` |
| 2 | Inside a project the `.jaira/` pair beats the pair at its root, and in every pair `.env.local` beats `.env` | `secrets.test.ts` "prefers the project's .jaira/ pair over the pair at its root", "prefers .jaira/.env.local over .jaira/.env, exactly as the root pair does", "prefers the project's .env.local over its .env", "prefers the shared root's .env.local over its .env" |
| 3 | Every project link beats every shared root link, and the environment comes last | `secrets.test.ts` `"prefers the project over the shared root — the reason the order is narrowest first"`, "falls back to the environment last", "reports nothing when no link supplies it" |
| 4 | An empty value never shadows a later link | `secrets.test.ts` "treats an empty value as absent, so a blank line does not shadow a real key" |
| 5 | `describe` reports the source and file and never the value | `secrets.test.ts` "reports the origin and the file, and never the value", "is undefined for a secret nothing supplies" |
| 6 | A line the dialect cannot read is skipped without throwing, and escapes decode inside double quotes only | `secrets.test.ts` "reads the conventions these files already use", "decodes escapes in double quotes only", "skips a line it cannot understand instead of throwing" |
| 7 | An empty value removes a stored key, and a `.env.local` write replaces that key's line while every other line and comment survives | `settings.test.ts` "stores a key in the keychain, and clears it with an empty value", "writes a .env.local entry without disturbing the rest of the file" |
| 8 | A name that is not an environment-variable name is refused before anything is written | `settings.test.ts` "refuses a name that is not usable as one" |
| 9 | The keychain's absence is reported with its reason | `settings.test.ts` "reports the keychain as available when one is injected", "explains the absence rather than silently offering fewer options" |
| 10 | A key stored and then named by a configuration write is found by the next probe without a reopen | `settings.test.ts` "finds a credential named by a config write, without a reopen" |
| 11 | A keychain write while no keychain is available is refused and never falls back to a plaintext file | unasserted |

## Every failure reads as a missing or wrong key where the key is used

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A `.env` line does not match the dialect | skipped silently, so the name is not found there | fix the line | the route or executor reports its key missing |
| Two writers: two processes, or a hand edit and a save to one `.env.local` | `writeEnvEntry` reads, filters and rewrites the whole file with no lock | none | the other edit is lost |
| The process is killed mid-write of a `.env.local` | the file is truncated; lines after the cut are gone, and a cut entry such as `KEY="abc` reads as the unquoted value `"abc` | store the key again | the provider refuses the key |
| A read meets a file being written by another process | that resolver caches what it read for its whole life | the app's next call builds a new resolver; a CLI run keeps the snapshot | one probe or one CLI run uses the partial file |
| A file changes while a resolver lives | the cached parse is used | the app rebuilds per call; start the CLI run again | a CLI run uses the old value |
| A retry stores the same key again | the old line is removed and the new one appended at the end with a blank line before it; removing a key leaves blank lines | none | the file grows blank lines; no duplicate key |
| A stored value holds a backslash | written with the backslash doubled and read back doubled, because `parseEnvFile` decodes only `\n` and `\"` | write the line by hand in single quotes | the provider refuses the key |
| A keychain blob cannot be decrypted, as under another OS user or after a keyring reset | the adapter answers undefined and the chain falls through | store the key again | the key reads as missing or from a lower link |
| `secret:set` targets `project-env-local` without naming a project while zero or several are open | refused with "no project is open" or "several projects are open, so this call must name one"; the Settings store sends no `project` | open only that project | the save shows the refusal |
| Two or more user projects are open and a caller passes no target | the resolver has no project links, so availability and probes ignore every project `.env` file | close all but one project | a route with a key in a project file reads as unavailable |
| A caller checks a route with no resolver | `routeKeyOrigin` in `modelRoutes.ts` reads `process.env` directly and counts an empty value as found | pass a resolver | the route reads as usable and fails when called |
| A key is stored for an agent executor's `credential` | only `describe` reads it, for the probe; no code passes the value to the agent | none | the probe reports the key found while the agent runs on its own sign-in and environment |

## Nothing migrates, and a key in any link keeps resolving

- A key in `<project>/.env.local` or `<project>/.env` resolves unless the same name is set in a narrower link.
- `setSecret` writes project keys only to `<project>/.jaira/.env.local` and never moves a key found elsewhere. Nothing rolls back.

## Credentials are read from a keychain and files before the environment

- architecture.md places secrets in the environment. The chain reads the keychain and six `.env` files first, because a key typed into Settings must be storable without editing a shell, and narrower links must beat machine-wide ones.
