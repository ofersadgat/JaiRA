---
id: engineering/contracts/secret-sources
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: public
kind: format
owned_by: [engineering/units/secret-chain]
consumers: ["@jaira/runtime modelRoutes.ts, for route keys and route probes", "@jaira/runtime executors.ts, for executor probes", "@jaira/app main service.ts secret:capabilities, secret:set and every run it wires", "@jaira/cli runs", "the renderer Settings panes, through ProbeResult.credential and SECRET_SOURCE_LABELS", "people keeping keys in .env files"]
siblings: [engineering/contracts/settings-json, engineering/contracts/jaira-layout, engineering/contracts/ipc-channels]
---

# Secret sources

The places a credential named in `settings.json` is looked up, in order, the report of which one supplied it, the `.env` dialect those files are read in, and the two channels that store a key and say where one can go.

## A caller reaches for the chain to turn a credential name into a value, and never to learn the value in the renderer

**Use when.** Resolving a `credential` or a conventional variable such as `ANTHROPIC_API_KEY` in main or the CLI with `SecretResolver.lookup`. Telling a person where a key was found with `describe`. Storing or clearing a key from Settings with `secret:set`.

**Do not use when.** Choosing which name a route or executor uses: that is its `credential` field in [settings-json](settings-json.md). Holding a non-secret setting: [settings-json](settings-json.md). Showing a value anywhere: no channel carries one.

## The shape is an ordered chain, an origin report, a line dialect and two channels

### The chain has eight links, and the first non-empty value wins

A link is skipped when its file is absent or unreadable, when it holds no such key, or when the value is the empty string. The project links exist only when a project directory is given, and the shared root links only when a base directory is given.

| Link | `source` | File | Written by `secret:set` target |
| --- | --- | --- | --- |
| 1 | `keychain` | none; the injected keychain, present only in the app while `available()` is true | `keychain` |
| 2 | `project-jaira-env-local` | `<project>/.jaira/.env.local` | `project-env-local` |
| 3 | `project-jaira-env` | `<project>/.jaira/.env` | none |
| 4 | `project-env-local` | `<project>/.env.local` | none |
| 5 | `project-env` | `<project>/.env` | none |
| 6 | `base-env-local` | `<base>/.env.local` | `base-env-local` |
| 7 | `base-env` | `<base>/.env` | none |
| 8 | `environment` | none; the injected `env`, else `process.env` | none |

### An origin names the link and the file, and never the value

`SecretOrigin` in `@jaira/shared` `executors.ts`, returned by `describe` and carried as `ProbeResult.credential`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `source` | `SecretSource`, one of the eight `source` values above | yes | the link that supplied the value |
| `file` | string | for links 2 through 7 | the absolute path of the file that supplied it |

`SecretHit`, returned by `lookup` inside a process only, is `SecretOrigin` plus `value: string`. `SECRET_SOURCE_LABELS` maps each source to the words Settings shows, such as `project .jaira/.env.local`.

### A .env file is read one line at a time in a small dialect

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| line ending | `\n` or `\r\n` | yes | separates entries; each line is trimmed |
| blank line, or a line starting `#` | text | no | ignored |
| `export ` prefix | `export` and whitespace | no | ignored |
| key | `[A-Za-z_][A-Za-z0-9_.-]*` | yes | the secret name; a later line with the same key wins |
| `=` | with optional whitespace around it | yes | a line without one is skipped |
| double-quoted value | `"…"` | no | the quotes are removed and `\n` becomes a newline and `\"` a quote; no other escape is decoded |
| single-quoted value | `'…'` | no | the quotes are removed and the rest is literal |
| unquoted value | text | no | whitespace followed by `#` and the rest of the line is dropped, then the value is trimmed |

A value that is empty after this is absent for the chain.

### secret:set stores or clears one key at one of three targets

`SetSecretRequest` in `@jaira/shared` `ipc.ts`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string matching `^[A-Za-z_][A-Za-z0-9_.-]*$` | yes | the secret name |
| `value` | string | yes | the value; the empty string removes the key from the target |
| `target` | `"keychain"`, `"project-env-local"` or `"base-env-local"` | yes | where it is stored |
| `project` | `ProjectRef` | for `project-env-local` when zero or several projects are open | which project's `.jaira/.env.local` |

The response is `{name, target}`. A `.env.local` write removes every line that assigns `name`, with or without `export `, appends `name="<value>"` with `\` and `"` escaped by a backslash, creates the directory when needed, and ends the file with a newline.

### secret:capabilities says whether the keychain link exists here

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `keychain` | boolean | yes | whether a keychain is injected and `available()` is true |
| `keychainReason` | string | no | present when the keychain is unavailable and the port gives a reason |

### The keychain is a five-member port the Electron main process fills

`KeychainPort` in `@jaira/app` `service.ts`: `available(): boolean`, `reason?: string`, `get(name): string | undefined`, `set(name, value)`, `remove(name)`. The Electron adapter keeps `{<name>: <base64 safeStorage ciphertext>}` in `userData/secrets.json`, and its `get` answers undefined for a blob it cannot decrypt.

## A refusal comes from secret:set, and a missing key is reported by whoever needed it

| Condition | Response | Caller does |
| --- | --- | --- |
| `name` does not match the name pattern | `Refusal` `'<name>' is not a usable secret name` | fix the name |
| `target` is `keychain` and no keychain is available | `Refusal` with the port's reason, or `no encrypted store is available here`; nothing is written | choose a `.env.local` target |
| `target` is `project-env-local` and the project cannot be found | `Refusal` `project '<ref>' is not open`, `several projects are open, so this call must name one` or `no project is open` | name an open project |
| The target file or directory cannot be written | the filesystem error is thrown | fix permissions |
| No link supplies the name | `lookup` and `describe` return undefined | report the key missing: an executor probe sets `credentialMissing`, and a route probe fails with a `fix` |
| A `.env` file is unreadable or a line is malformed | the file reads as empty, or the line is skipped | nothing; the name is simply not found there |

## Reordering links or changing the dialect silently changes which key every project uses, and there is no deprecation path

- Moving a link changes the winning value for any name set in two links, with no error anywhere.
- Renaming a `SecretSource` breaks `SECRET_SOURCE_LABELS` and every renderer that switches on the source.
- Changing a target's file strands every key already stored at the old file, though the chain may still find it through another link.
- Changing the dialect changes the value read from existing files. Keys are never migrated.

## Target names, quoting and the CLI each behave differently than the names suggest

- The target `project-env-local` writes `<project>/.jaira/.env.local`, which `describe` reports as `project-jaira-env-local`. The source `project-env-local` is a different file, `<project>/.env.local`.
- A stored value containing a backslash reads back with the backslash doubled, because the writer escapes `\` and the reader does not decode it.
- A double-quoted value followed by an inline comment, such as `KEY="abc" # note`, reads as `"abc"` with its quotes. An unterminated quote is part of the value.
- Every write moves the key's line to the end of the file and leaves one more blank line before it, and removing a key leaves its blank lines behind.
- The CLI has no keychain link. A key kept only in the keychain works in the app and is missing in `jaira`.
- `secret:set` does not write the name into `settings.json`. The Settings store writes `credential` itself when the name is new; any other caller must.
- The template `.gitignore` ignores `.env.local` only, so a key in `<project>/.jaira/.env` or `<project>/.env` is committed unless the project ignores it.
- An executor's `credential` is only described, for probes. No code passes its value to the agent.
