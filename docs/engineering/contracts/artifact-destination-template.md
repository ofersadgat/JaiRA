---
id: engineering/contracts/artifact-destination-template
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: public
kind: schema
owned_by: [engineering/units/artifact-placement]
consumers: ["people and the Settings view writing artifacts.destination in settings.json", "@jaira/runtime artifactSink.ts artifactWiring and persistEngineArtifacts", "@jaira/runtime fileTools.ts write_file, edit and show_artifact", "@jaira/app main service.ts startRun and runChatMessage", "@jaira/cli cli.ts runTaskNow"]
siblings: [engineering/contracts/settings-json, engineering/contracts/jaira-layout, engineering/contracts/host-tool-vocabulary, engineering/contracts/storage-files]
---

# Artifact destination template

The string in `artifacts.destination` that says which backend keeps an artifact and how its path is built from a closed set of variables, parsed by `parseDestination` and resolved per artifact by `resolveDestination` in `packages/runtime/src/artifactPath.ts`.

## A project sets the template to move where artifacts land without changing any workflow

**Use when.** Choosing whether a run's produced files land in the work tree, under the task's directory in `system/`, at a hand-written location, or nowhere on disk. A workflow runs unchanged under any template, because producers always address the logical path.

**Do not use when.** Deciding whether producing a file asks first: that is `artifacts.askAboveBytes` and [tool-policy](../units/tool-policy.md). Deciding how much content the record keeps inline: `artifacts.inlineMaxBytes` in [settings-json](settings-json.md). Naming where a model may write at all: a scope table, in [settings-json](settings-json.md).

## The shape is an optional scheme, then a path of literal text and variables

### A scheme names the backend, and none means disk

A scheme is a letter followed by letters, digits, `+`, `.` or `-`, then `:`, matched without regard to case. A single letter before `:` is a drive, not a scheme.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `virtual:` | prefix, with nothing after it | no | memory: nothing is written to disk and the record keeps the content whatever its size |
| `file:` or `file://` | prefix | no | disk, the same as no scheme |
| path | text with variables | yes for disk | where the bytes go; empty is refused |

### Three aliases spell the usual placements

Aliases expand before anything else, in at most 4 passes, and may be written inside a longer template.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `$DEFAULT` | `$WORKTREE/$RELPATH` | no, the default | the work tree, at the path the producer named |
| `$CENTRAL` | `$SYSTEM/$ARTIFACT_DIR/$TASK_ID/$RELPATH` | no | the task's directory under `system/`, keeping the producer's directories |
| `$CENTRAL_FLAT` | `$SYSTEM/$ARTIFACT_DIR/$TASK_ID/$INSTANCE_ID-$SLOT.$EXT` | no | the task's directory, one flat file per producing instance and slot |

### An anchor variable leading the template fixes its base

A variable is `$` followed by an uppercase letter or `_`, then uppercase letters, digits or `_`. A template led by none of these anchors hangs off `$WORKTREE`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `$WORKTREE` | absolute path | no | the task's workspace: its worktree, or the project directory when unbound |
| `$PROJECT` | absolute path | no | the project directory |
| `$JAIRA` | absolute path | no | `<project>/.jaira` |
| `$SYSTEM` | absolute path | no | `$JAIRA/system`, joined with `/` |

### The other variables are filled per artifact, and three come from the producer

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `$ARTIFACT_DIR` | text | no | `artifacts.dir`, default `artifacts`, substituted as written |
| `$TASK_ID` | one segment | no | the task id |
| `$INSTANCE_ID` | one segment | no | the producing instance; empty when the producer carries none |
| `$STATE_ID` | one segment | no | the producing state, dotted as the engine names it; empty when the producer carries none |
| `$SLOT` | one segment | no | the output slot; empty when the producer carries none |
| `$RELPATH` | path | no | the logical path, with `\` turned into `/` and a leading `./` removed; its directories are kept |
| `$BASENAME` | one segment | no | the last segment of the logical path before its final dot |
| `$EXT` | one segment | no | the text after that dot; empty when there is none |

In a one-segment variable, `/` and `\` become `-` and `..` becomes `-`.

### Two containment rules bound what a template may reach

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| root | directory | derived | the template up to the last separator before the first `$RELPATH`, `$BASENAME` or `$EXT`, substituted and resolved against the base |
| root rule | refusal | always, unless the template is absolute | the root must stay inside its base, so an `artifacts.dir` of `../../x` is refused |
| path rule | refusal | always | the resolved path must stay inside the root, so a logical path of `../../src/a.ts` is refused rather than clamped |

## Every error is a DestinationError, surfaced where the template is first used

| Condition | Response | Caller does |
| --- | --- | --- |
| Blank template | `artifact destination is empty` | set a template |
| A scheme other than `virtual` or `file` | `unknown artifact destination scheme '<scheme>:'`, followed by the schemes it accepts | use one of the two, or none |
| `virtual:` followed by text | `'virtual:' takes no path, got '<text>'` | write `virtual:` alone |
| An uppercase variable outside the lists above | `unknown variable '$<name>' in artifact destination '<template>'`, followed by every known alias and variable | fix the spelling |
| A scheme with nothing after it | `artifact destination '<template>' has no path` | add a path |
| The root climbs out of its base | `artifact destination '<template>' resolves its root to '<root>', outside '<base>'`, followed by a hint to write an absolute path | fix `artifacts.dir` or the template, or write it absolute |
| A logical path climbs out of the root | `artifact path '<path>' resolves to '<absolute>', outside the destination root '<root>'` | name a path inside it |
| Any of these while a run starts or a turn is sent | `artifactWiring` throws: a run start is refused after the task was marked running, and a turn's send is refused | fix the template; the next open marks the task `interrupted` |
| Any of these in `write_file`, `edit` or `show_artifact` | `{error: <message>}` returned to the model | the model names another path |
| Any of these while placing a returned blob | reported through `onError`: an unjournaled `artifact.failed` push in the app, a `warning: could not store artifact` line in the CLI | fix the template and run again |

## A renamed or removed variable refuses every project that names it

- Renaming or removing a variable or alias makes every `settings.json` that names it refuse its next run with an unknown-variable error, so the documents are migrated first.
- Changing an alias's expansion moves where every project using it places new artifacts. Existing records keep the absolute `physical_path` they were written with.
- Loosening either containment rule lets a model's path or a configured value write outside what the template names.

## Variables, roots and producers each mean less than the template suggests

- The template is checked only when a run starts, a turn is sent or a blob is placed. A project with a broken template opens, and `settings.json` saves it.
- A lowercase `$name` is not a variable and is kept as literal text, so `$worktree/$RELPATH` writes into a directory named `$worktree` inside the workspace.
- The file tools carry no instance, state or slot, so under `$CENTRAL_FLAT` every `write_file` and `edit` resolves to `<taskId>/-.<ext>`, and writes with one extension share one file.
- `show_artifact` ignores the template and uses `$CENTRAL`, unless the template is `virtual:`.
- A returned blob's logical path is `<slot>.<ext>`, so two states returning the same slot share one logical path and one record under every template, and under `$DEFAULT` the blob lands at the work tree's top level.
- A template with no `$RELPATH`, `$BASENAME` or `$EXT` resolves every artifact to one path.
- An absolute template skips the root rule. Both rules compare paths as text and resolve no symlink.
- The record keeps the resolved absolute path, so a moved checkout or a committed row file from another machine points at a location that no longer holds the bytes.
- The Settings view describes `artifacts.dir` as relative to the workspace, while `$CENTRAL` and `$CENTRAL_FLAT` put it under `$SYSTEM`.
