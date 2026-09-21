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

It ships empty. The chat states and the self-test move in with step 2 of the
decision; until then they are still installed into `~/.jaira`.
