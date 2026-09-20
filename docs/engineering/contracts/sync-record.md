---
id: engineering/contracts/sync-record
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: public
kind: format
owned_by: [engineering/units/description-sync]
consumers: ["@jaira/app main service.ts syncStatus, through readSyncRecord", "@jaira/app main service.ts commitSyncRecord, through commitSync", "teammates who pull a branch carrying the committed file"]
since: 2026-08-04
siblings: [engineering/contracts/jaira-layout, engineering/contracts/workflow-sync-channels, engineering/contracts/storage-files]
---

# Sync record

The last accepted agreement between each workflow description in a layer root and the state files it owns, kept as `system/sync.json` in that root.

## A caller reads the record to learn which side moved since the last accepted sync, and nothing else

**Use when.** Deciding whether a description, its states, both or neither changed since a person last accepted a sync, and which side a sync should rewrite.

**Do not use when.** Locking a sync, which is the in-memory `SyncHolder.syncTask`. Remembering a proposal nobody has accepted, which is the in-memory `pendingSync`. Reading the history of past syncs, which are tasks in the system project. Where the file sits beside the rest of `.jaira/`: [jaira-layout](jaira-layout.md).

## The shape is one map of records keyed by lower-cased description path

The file is `.jaira/system/sync.json` for a project layer and `<shared root>/system/sync.json` for the shared root. It is UTF-8 JSON written with two-space indentation and a trailing newline, and it is committed with the layer.

### The file holds one map

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `documents` | object of record by key | yes | one record per description; the key is the description's layer-root-relative path, lower-cased |

### A record holds both sides' hashes as of one acceptance

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `document` | string | yes | the description's path relative to the layer root, such as `workflows/feature.md`, in its written case |
| `documentHash` | string, 32 hex characters | yes | the first 32 hex characters of SHA-256 over the description's text with CRLF folded to LF and trailing whitespace at the end removed |
| `states` | object of hash by path | no, read as `{}` | one hash per state file the description owned at acceptance, keyed by path relative to that layer's `workflows/`, hashed as `documentHash` is |
| `at` | number, epoch ms | no, read as 0 | when the sync was accepted |
| `direction` | `"document"` or `"states"` | no, read as `"document"` | which side that sync rewrote |

### A legacy file holds one record at the top level

A file with no `documents` key is read as a single record, and a well-formed one becomes a one-entry map under its lower-cased `document`. Only the next write replaces it with the `documents` shape.

## Errors are never raised: anything unreadable is no record

| Condition | Response | Caller does |
| --- | --- | --- |
| The file is absent, does not parse, or is not an object | every description reads as having no record | nothing; the next accepted sync writes a valid file |
| `documents` is not an object | every description reads as having no record | nothing |
| A record lacks a string `document` or `documentHash` | that record is skipped | nothing |
| A record exists only under another description's key | the description asked about reads as having no record | nothing |

## A change to the hash, the keys or the shape makes every stored record read as drift, and nothing migrates

- Changing the normalisation in `hashText` makes every committed record report both sides changed.
- Changing how `ownedFiles` scopes a description's states changes which keys a status compares, so existing records report added or removed states.
- A new top-level shape must keep reading `documents` and the legacy single record, as there is no migration step and committed files live on every branch.

## Several things fail silently or mean less than the field names suggest

- The write is read, modify and rewrite with no lock and no atomic rename. Two processes accepting at once lose one record, and a process killed mid-write leaves a file every description reads as never synced.
- Keys are lower-cased, so two descriptions whose paths differ only in case share one record and each reports drift against the other's baseline.
- A project's record covers only that project's own state files. States a project resolves from the shared root are never hashed into it, so a change to them never reads as drift there.
- A record moves only when a person accepts: saving every proposed file, a review whose final round merged everything, or a sync that found nothing to change. Running a sync does not move it.
- `at` and `direction` are informational. Drift is decided by the hashes alone.
- The record is taken from disk at acceptance, so a sync that judged unsaved text and found nothing to change records the saved file's hash.
- `states` values are not checked to be strings, and a malformed value simply reads as an edited file.
