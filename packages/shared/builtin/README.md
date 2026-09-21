# The built-in layer (`$SYSTEM`)

What JaiRA ships, as the **last** layer of the search path (decision
[0006](../../../docs/engineering/decisions/0006-built-in-layer.md)):

```text
<project>/.jaira/    wins here
~/.jaira/            wins on this machine
$SYSTEM/             what ships          <- this directory
```

It has the authored half of a layer root's shape and none of the generated half:

```text
workflows/   state files, by id
prompts/     fragments a state refers to as $/prompts/...
functions/   operation documents and .ts callees
toolsets/    toolsets/<bucket>/<name>.json (decision 0007)
```

Rules that hold for everything in here:

- **Read-only.** Nothing in JaiRA writes to this directory, and every write
  surface that takes a layer refuses this one. A person changes a built-in by
  putting a file with the same id in `~/.jaira/` or in the project.
- **Trusted.** A `.ts` module under this directory is not put to the module
  approval gate - it is the app's own code. A person's copy that shadows one is
  gated like any other module.
- **Pinned like anything else.** A task's snapshot stores the resolved
  definition, whichever layer supplied it, so an app upgrade that changes a file
  here does not change a task that already started.

## Where it lives at run time

This directory is the source of truth. `packages/cli/build.mjs` and
`packages/app/build.mjs` copy it to `dist/builtin/` beside their bundles, and
`defaultBuiltInDir()` in `../src/paths.ts` finds it: `<resources>/builtin` in a
packaged Electron app, `builtin/` beside a bundle, or this directory when running
from source (tsx, vitest).

## What is in it

| Id | Is |
| --- | --- |
| `chat/agent` | what the Chat view starts: a conversation that works in the project, every tool call asking first |
| `chat/assistant` | a conversation with a model and no tools; kept so conversations started as one keep running |
| `debug/hello_world`, `/say`, `/check` | the Debug view's self-test. Its scripted replies are in `packages/app/src/renderer/debugWorkflow.ts` and match these prompts by text |
| `toolsets/chat/{ask-first, read-only, auto, full}` | the composer's four permission presets, written down: every tool a conversation can be handed, a mode on each, and `other`. `packages/shared/test/permissionPresets.test.ts` holds them to the maps the presets wrote |
| `toolsets/chat_control/{ask-first, read-only, auto, full}` | its own versions of the same names: only the task and workflow tools (decision 0005 §3), and `other: "deny"`. Those tools are named in `toolVocabulary.ts` and marked `unserved` until they are built |

A toolset file is a map from a subject to a mode and nothing else, so what a
shipped one is called on the composer's Permissions card, and the sentence under
it, live in `../src/toolsetBuckets.ts`. When a tool is added to the standard
list, add it to the four `chat` files, or it answers to their `other`.

Nothing installs these anywhere. Earlier builds wrote them into `~/.jaira`; such
a copy still wins, and the app offers to delete one whose value is a version it
shipped. When a file here changes, add the value it HAD to `SUPERSEDED` in
`packages/app/src/main/shippedStates.ts`, so copies of it stay recognisable.
