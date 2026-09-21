---
id: engineering/decisions/0007-toolsets
type: decision
status: proposed
updated: 2026-09-21
decides_for: [engineering/units/tool-policy, engineering/units/host-tools, engineering/units/agent-executors, engineering/units/executor-tree, engineering/units/chat-turns, engineering/contracts/host-tool-vocabulary, engineering/contracts/settings-json]
---

# 0007. A toolset is the permission model: subject → mode, in buckets; one shell line is several requests

## Context

What a state's agent may do is said in four places that overlap:

- `environment.tools` — a list of names. On a delegated agent it is a
  *grant*, not a fence: the agent keeps its own built-ins beside it.
- `environment.permissions` — a mode per tool, a `default`, and a
  `profile` (`read-only` | `plan` | `full`), which exists to restrain those
  built-ins through whatever channel the transport has.
- `ToolSpec.readOnly`, from which the profiles are generated.
- The composer's four presets, which are *functions* of `readOnly`
  (`tool.readOnly ? "allow" : "deny"`) spent the moment they are clicked.

[0006](0006-built-in-layer.md) first proposed naming two of these —
toolsets and permission sets — and every example needed one of each:
`workflow` with `control`, `session` with `session`. Two things that only
travel together are one thing, and the shipped Tools card already says so:
a tool's line carries its tick, its implementation and its mode together.

Two pieces exist and stay:

- **Native names.** `TOOL_SPECS` carries `natives: { claude: "Read" }`, and
  `planAgentTools` turns a grant into what is injected, which natives are
  forced through the permission callback, and which are denied. The
  per-tool *implementation* choice (ours or the agent's) is in the card.
- **A shell parser.** `parseCommand` splits a line on separators and
  unwraps `sh -c`, `env`, `sudo`, `npx`; `decideCommand` judges every
  command on the line and keeps the strictest verdict; a line it cannot
  model is never allowed without asking.

19 authored states declare `"profile": "read-only"`, one `"full"`, none
`"plan"`.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. Toolsets and permission sets as two named fragments (0006 as first written) | Mirrors the two fields that exist | They only ever travel in pairs; two pickers, two editors, and `profile` needs a name in the UI |
| B. One set: subject → mode, with `readOnly` classes (`@read`, `@write`) so a rule covers tools registered later | Keeps the presets' "a new tool is covered" property | Keeps `readOnly` as a second source of truth about what a tool is; "read-only" means two things |
| C. One set: subject → mode, as plain data; "read-only" *is* a toolset; `other` covers what is not named (**chosen**) | One concept, one picker, one editor; nothing to derive a meaning from but the map a person can read | A tool registered later falls to `other` until a set names it; the shipped sets have to be kept current |
| D. Categorize shell commands (read / write / network) and map categories to modes | Small maps | A category is a judgement somebody else made; `git commit` and `rm` both "write" and deserve different answers |

## Decision

**C.**

### 1. A toolset is a map from a subject to a mode

```jsonc
// $SYSTEM/toolsets/chat/read-only.json
{
  "read_file": "allow", "glob": "allow", "grep": "allow",
  "web_fetch": "ask",
  "bash": "deny",
  "git status": "allow", "git log": "allow", "git diff": "allow",
  "other": "deny"
}
```

- **Present means offered, with that mode. Absent means not offered.**
  Modes are the four that exist: `allow`, `ask`, `deny`, `smart`.
- A **subject** is a standard tool (`read_file`), a command (`git commit`,
  §4), `script` (§4), or **`other`** — everything no entry names, which is
  also where a native tool with no standard equivalent lands (§3).
- A value may be an object when the implementation is chosen too:
  `"write_file": { "mode": "ask", "implementation": "native" }`.
- **A state names one**: `"tools": "$/toolsets/chat/read-only"` — a bare
  string in an object position is already a reference (WORKFLOWS.md §2.2).
  It may start from one and say more, which is also already there:
  `{ "$ref": "$/toolsets/chat/read-only", "write_file": "ask" }`. A
  toolset file starts from another the same way. An inline map is legal.
- `readOnly`, `TOOL_PROFILES`, `permissions.profile` and the presets'
  `modeFor` **go**. "Read-only" is the toolset of that name and nothing
  else. `plan` goes with them; nothing uses it.
- `environment.permissions` is folded in: `tools` become entries,
  `default` becomes `other`. The old list form of `tools` and the old
  `permissions` block are still read, so an unmigrated state runs as it did.

### 2. Toolsets live in buckets

```text
toolsets/chat/ask-first.json        toolsets/chat_control/ask-first.json
toolsets/chat/read-only.json        toolsets/chat_control/read-only.json
toolsets/chat/auto.json             toolsets/chat_control/auto.json
toolsets/chat/full.json             toolsets/chat_control/full.json
```

A **bucket** is a folder: a place with its own versions of the same names.
`chat/ask-first` asks before every tool a conversation holds;
`chat_control/ask-first` holds only the task and workflow tools
([0005](0005-connect.md)) and asks before those. A bucket may nest
(`feature/implementation/…`). Buckets layer like everything else (0006):
what ships is `$SYSTEM/toolsets/**`, and a file at the same path in
`~/.jaira/` or `.jaira/` wins.

`chat/session` names `$/toolsets/chat/ask-first`; `chat/control` names
`$/toolsets/chat_control/ask-first`. The four that ship in `chat` are
today's four presets written down as data.

### 3. An agent gets the toolset and nothing else

- **Each agent executor declares its native tools and which standard tool
  each one is** — `{ Read: "read_file", Bash: "bash", Edit: "edit", … }` —
  and, for a transport whose only channel is coarse, which standard
  subjects each switch unlocks (codex: `workspace-write` ⇐ `write_file`,
  `edit`, `bash`). The `natives.claude` column leaves the central table;
  the table keeps being the one standard list, and it is expected to grow
  toward what agents actually have.
- For a call, per standard tool: **not in the toolset → the native is
  removed** (the deny list, the sandbox switch left off). **In it →** our
  implementation is injected and displaces the native, which stays the
  default; or, where the entry says `native`, the built-in is kept and
  forced through the permission callback, so the entry's mode still
  decides. The choice stays a button on the tool's line.
- **A native with no standard tool answers to `other`.** It is not removed
  up front; it is asked about, allowed or denied as `other` says.
- An agent is never handed a tool its toolset does not hold.

### 4. One shell line is several requests

A `bash` call is not judged as a tool. It is **taken apart, and each part
is a request of its own**, checked against the same map:

`rm foo.txt && git commit -m wip` → a `write_file` request on `foo.txt`,
and a `git commit` request.

- **Apart at:** `&&`, `||`, `;`, `&`, `|`, newlines, `( … )`, `{ … }`;
  command substitution `$( … )`, backticks, process substitution `<( … )`.
- **Redirects are requests:** `>`, `>>`, `2>`, `&>`, a here-doc target —
  `write_file` on the target; `<` — `read_file` on the source.
- **Embedders are opened, recursively:** `sh` / `bash` / `zsh -c`,
  `powershell -Command`, `eval`, `exec`, `find … -exec` / `-execdir` /
  `-ok`, `xargs`, `env`, `sudo`, `nohup`, `time`, `timeout`, `nice`,
  `watch`, `parallel`, `ssh host …`, `docker exec …`, `git -c alias.…`,
  `git submodule foreach`, `npx` / `pnpm dlx`. The list is data and is
  expected to grow; an embedder it does not know is a command like any
  other, and what it embeds is not seen — which is what `other` is for.
- **What a part is a request *for*:**
  - a file utility is the **standard tool on its path** — `cat`, `head`,
    `tail`, `less` → `read_file`; `ls`, `find`, `tree` → `glob`; `grep`,
    `rg` → `grep`; `rm`, `mv`, `cp`, `touch`, `mkdir`, `chmod`, `tee`,
    `sed -i` → `write_file`; `curl`, `wget` → `web_fetch`. Path scopes
    therefore apply to the shell exactly as they do to the tools. `cd`,
    `echo`, `pwd`, `test`, `true` are no request at all. This table is the
    shell's own native mapping, and lives beside the executors' (§3);
  - **running a file is `script`** — `./x.sh`, `bash x.sh`, `python x.py`,
    `node x.js`, `npm run <name>`, `make <target>`. What a script does
    cannot be read off the line, so it is its own permission;
  - **anything else is a command subject**: the program and its subcommand,
    in the matcher shape the policy rules already use — `git commit`,
    `git log`, `npm install` — refined by a flag where an entry says so
    (`git push --force`). A program with no entry of its own falls to the
    `bash` entry, which is what "any other command" means.
- **The line runs only if every part may.** Any part denied → the line is
  refused. Any part asking → one approval.
- **The approval shows the line in the colours of its parts**, and under it
  one row per part in the same colour: what was typed, what it is a request
  *for*, and whether the toolset allows it or asks. What joins the parts
  (`&&`, `|`, a space) is dim. **The tint is the whole part; the underline
  is only the words that matched** the toolset's line — `git commit` and not
  its flags, `rm` in `-exec rm {}`, the program alone when nothing but the
  shell's own line matched.
- **One Allow and one Deny**, each with an arrow. The menu asks two things
  in order. **What the answer covers**: this subcommand (`git commit`) or
  every command of the program (`git`) — which is how a program the toolset
  has never heard of (`terraform plan`) gets a line at the width the person
  means. Then **how far it reaches**: *once* (the button itself), *for this
  run* (the ledger, nothing written), or **add to the toolset** — which
  writes that line (`"git commit": "allow"`, or `"git": "allow"`) into the
  toolset that asked, in this project or for all projects. It is the asking
  **parts** that are remembered, never the line.
- A line that cannot be taken apart is never allowed without asking, and
  the built-in destructive floor (`rm -r .git`, a force push) stays above
  every toolset. Both are existing invariants.

### 5. The composer keeps both cards

- **Permissions keeps its look and holds toolsets.** Its rows are the
  toolsets of one bucket — for `chat`: ask first, read-only, auto, full
  access, as today. Where the head said where the value came from, it has
  a **picker of the bucket hierarchy**; choosing a bucket changes the rows.
  A **`+`** in the head keeps the current map as a new toolset in that
  bucket. Picking a row writes its ticks, implementations and modes onto
  the Tools card.
- **Tools is unchanged**: tick, implementation, mode, per tool and per
  section. Execution lists the shell, `script`, and the commands the
  toolset names **grouped under their program**: `git` is a line that opens
  onto `git status`, `git log`, `git commit`, `git rm`, each with its own
  mode, the group's own mode standing for any other `git`. A last line adds
  a subcommand to a group, or a command to the section.
- **A label is a match, never a memory.** Permissions reads a toolset's
  name while the map is exactly that toolset's, and `custom` otherwise —
  which is what it does today. Tools counts, as it does today.

### 6. Settings → Toolsets

One pane, layered (0006), in **the rail-and-detail layout Settings already
uses** for a model's configuration. The rail is the bucket hierarchy — a
bucket's name and the layer that defines it, then its toolsets, each with a
line of summary and a dot where this layer sets it, then "+ toolset"; "+
bucket" closes it. The detail is the toolset, **drawn as the composer's
Tools card is**: its path, where its value comes from and which states use
it; the card's sections; a line per subject with its implementation and its
mode; commands grouped under their program, the group's own mode standing
for the rest of that program. Every held line starts with **a red minus in
a circle at the far left**, and each section and group ends with a line
that adds one. The built-in layer reads the same and offers only the two
overrides.

### What draws

Mockups: [0007-assets/](0007-assets/), published with the others at
<https://claude.ai/artifact/QSSuGXa9XPVuZdTgauzAqT>.

Beside this decision and not part of it, the same folder has
`presets-tabs.html`: Settings → Executors → **Presets** redrawn as nested
vertical tabs — a rail of presets to the left of the rail of sections that
ships, then the detail — so that two presets are no longer two editors
stacked. That one is built: what ships is described in
[ui/surfaces/settings-executors](../../ui/surfaces/settings-executors.md).

## Consequences

**Easy.** One thing to pick, read, edit and override. "Why was this
allowed?" is answered by one file. A shell line is held to the same paths
and the same modes as the tools it imitates.

**Hard.** The shipped toolsets are a list somebody has to keep current as
tools are added; until then a new tool is `other`. The opener list (§4) is
never complete, and what an unknown embedder hides is only caught by
`other`. Upstream's `permissions.profile` stops being emitted, so the
transports' restraints have to be re-derived from §3's tables — the codex
sandbox most of all.

**Foreclosed.** Categories of command (D). A `profile` anybody names. A
preset that is a function.

## Build order

1. **The map**: `tools` as subject → mode, `$ref` + siblings, `other`;
   the reader for the old list and `permissions` block. *Built 2026-09-20*
   ([tool-policy](../units/tool-policy.md)): a map-form state is lowered
   to the list and block the engine takes before it loads; command
   subjects, `script` and a run's `native` are carried and not enforced.
2. **Executors declare natives** and coarse switches; `planAgentTools`
   reads them; `other` for unmapped natives. `readOnly` and the profiles
   go when nothing reads them. *Built 2026-09-21*
   ([tool-policy](../units/tool-policy.md),
   [agent-executors](../units/agent-executors.md)): the declarations sit
   beside the executors and `withAgentToolset` applies the plan at each
   agent route, through the two fields the upstream executor already
   builds its deny list from. **Removal is a map's rule.** A state still
   written as a list is the legacy reading and runs exactly as it did —
   the agent keeps the built-ins the list does not mention — until the
   migration (7), which is where a state chooses; a lowered map carries
   two marks in `permissions.tools` so a run can tell the two apart
   through the gate, which is all it sees. An old `profile` is read as the
   map it meant and no lowering writes one; a list-form file still reaches
   the engine with its profile in it. Two things it does not do, because
   the engine hands an executor a state's resolved tools and gate and not
   its block: a run's `implementation: "native"` still injects ours, and a
   run cannot tell a written `other: "ask"` from the gate's last resort.
3. **Shell**: redirects, substitutions and the embedder list in
   `parseCommand`; the utility → standard-tool table; `script`; parts as
   requests, and the approval that lists them. *Engine half built
   2026-09-21* ([tool-policy](../units/tool-policy.md)): a line is taken
   apart with spans, each part judged against the toolset under the rules
   and the floor, and an approval request carries the parts and remembers
   them at a width for the run. What composes how is written there — an
   entry that names the program replaces a built-in ask; `bash` lowers as
   `smart` with its mode among the subjects. The approval's drawing, and
   writing a remembered line into a toolset file, are not built.
4. **Buckets** in `$SYSTEM/toolsets/**` (needs 0006): the four `chat`
   toolsets as data; `chat_control`.
5. **The composer**: Permissions rows from the bucket, the bucket picker,
   `+`; Execution's command lines.
6. **Settings → Toolsets.**
7. **Migration**: `"profile": "read-only"` → a reference to a read-only
   toolset; `permissions.tools` / `default` → entries and `other`. A
   mechanical rewrite of authored workflows, `~/.jaira` included.

## Open

- `smart` on a command subject: what the approver is shown for one part of
  a line.

## Revisit when

`other` is answering most calls — the standard list has fallen behind what
agents have — or people keep wanting two toolsets at once, which `$ref`
plus siblings cannot say.
