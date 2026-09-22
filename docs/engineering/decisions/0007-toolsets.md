---
id: engineering/decisions/0007-toolsets
type: decision
status: built
updated: 2026-09-22
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
   `smart` with its mode among the subjects. *UI half built 2026-09-21*
   ([command-approval](../../ui/components/command-approval.md)): the
   line in the colours of its parts, a row per part, the two split
   buttons, and "add to the toolset". What was decided while building:
   - **Which toolset asked** is carried, because nothing downstream of
     lowering knew: lowering writes `permissions.source` beside
     `subjects`, the reference the state named its toolset by, or
     `inline`; the policy puts it on the approval. A `$ref` with siblings
     counts as `inline`, since a sibling is an entry no file holds and
     would shadow a line written to the file.
   - **Past four parts** the four hues repeat in source order, and
     pointing at a row lights its words on the line.
   - **Several asking parts** get one width choice per distinct set of
     widths (two `git commit`s are one choice; `script` is listed with
     nothing to choose), and one reach for all of them.
   - **The write**: a layer that holds the toolset gets the line added in
     place, layout kept; a layer that does not gets an override that
     keeps following the nearest lower layer's by its explicit root,
     `{ "$ref": "$SYSTEM/toolsets/<bucket>/<name>", "<subject>": "<mode>" }`.
     Only a bare `$/toolsets/<bucket>/<name>` reference says which file;
     an inline map, an explicit-root or relative reference, and a YAML
     file offer once and this run, and say why. The answer also remembers
     the widths for the run, since a started task reads its pinned
     snapshot.
4. **Buckets** in `$SYSTEM/toolsets/**` (needs 0006): the four `chat`
   toolsets as data; `chat_control`. *Built 2026-09-21*
   ([tool-policy](../units/tool-policy.md)): eight files under
   `packages/shared/builtin/toolsets/`. The `chat` four are held by a test
   to the maps the function presets wrote, and `other` is what each preset
   gave a name it had never heard of. The `chat_control` four hold the
   eight workflow tools of [0005](0005-connect.md) §3 and `other: "deny"`.
   Those tools were not built, so the standard list named them in a new
   category, Tasks & workflows, with the mark `unserved`: a toolset could
   hold one and the linter knew it, while lowering, the agent plan and the
   runtime's registration each left it out, so nothing was handed a tool
   nobody served. **[0005](0005-connect.md) step 6 built them (2026-09-21),
   and deleting the mark was indeed the whole change**: `TOOL_SPECS` carries
   none now, the eight are in the list lowering writes and in what
   `planAgentTools` injects, and `registerWorkflowTools` registers them. The
   `unserved` mechanism stays for the next tool named before it is served.
   Two things went with the mark: the composer's "· not served yet" suffix,
   and the frozen-preset test's claim that `chat_control` hands nobody
   anything. **The four `chat` toolsets grew the eight lines**, because a
   session holds the project's tools AND the workflow tools ([0005](0005-connect.md)
   §3) and `chat/ask-first` asks before every tool a conversation holds. The
   rule that keeps one bucket from drifting from the other, and what the
   frozen-preset test now asserts: a `chat/<name>` gives a workflow tool
   whatever `chat_control/<name>` gives it, while the nine project tools stay
   exactly the maps the four function presets wrote.
   The function presets are gone; "which preset is this" is
   `matchToolset`. Two things a file has no place for are kept beside the
   code instead: the shipped toolsets' labels, hints and glyphs, and the
   order the four names are listed in. The workflow tools were first named
   `start`, `move`, `stop` and so on, which shadowed the shell programs of
   those names as command subjects; they were renamed to `start_task`,
   `move_task`, `stop_task` and the rest (2026-09-21), and a toolset can
   name `start`, `move` and `stop` as commands again.
5. **The composer**: Permissions rows from the bucket, the bucket picker,
   `+`; Execution's command lines. *Built 2026-09-21*
   ([composer-setting-chip](../../ui/components/composer-setting-chip.md)):
   both cards read one `Toolset` and every edit sends the whole map as
   `ChatSettings.toolset`, so a turn a person touched is a map and is held
   to it (§3), where an untouched one still inherits its state's list. The
   plan carries every toolset on the search path, references followed, and
   the bucket to open on. **That bucket is found by match, not read off
   the state**: a loaded state holds what its toolset lowered to, and the
   reference is gone, so the card opens on the first bucket holding a
   toolset the inherited map exactly is, and on `chat` otherwise. `chat/agent`
   still declares a list of three tools, which is no shipped toolset, so a
   new conversation reads `custom` until it names
   `$/toolsets/chat/ask-first`. A program's mode button is the entry for
   the bare program and is not derived from its subcommands, which is
   where the build departs from the mockup's `custom` on `git`. An
   unticked tool has no line in a map, so the mode its row shows is kept
   beside the map for as long as the composer lives and is never sent.
   `+` writes through `toolset:save`, which refuses the built-in layer, a
   name or bucket a reference could not carry, a map that does not parse,
   and an id the layer already holds. The name, the place and a new
   command are asked through the schema form, so the `+` form is taller
   than the mockup's single line.
6. **Settings → Toolsets.** *Built 2026-09-21*
   ([settings-toolsets](../../ui/surfaces/settings-toolsets.md),
   [toolset-card](../../ui/components/toolset-card.md),
   [tools-field](../../ui/components/tools-field.md)): the rail is the bucket
   hierarchy, the detail is the toolset drawn as the composer's Tools card is,
   and the layer picker gained the third segment 0006 left for it. What the
   build settled:
   - **The rows are the composer's, moved out and not copied.** `toolsetRows.tsx`
     holds `ToolRow`, `CategoryRow`, `SubjectRow`, `CommandGroupRow`,
     `ModePicker`, `ImplPicker`, `AddLine` and the mode and icon tables;
     `composer.tsx` imports them. Two props carry the whole difference between
     the hosts: `held` (the card lists what the toolset HOLDS, so the name is
     text and a red minus starts the line, where the composer lists every tool
     and ticks it) and `readOnly`. A third piece, `AddMenu`, is new, because a
     card that lists only what it holds needs a way back to what it does not.
   - **A section's mode button is not drawn on a toolset being edited.** It
     cascades onto every line under it, which in the composer includes unticked
     ones; on a file, the lines ARE the statement and a head that re-moded them
     is a second way to do what each line's own button does.
   - **A reading leaves an empty section out** rather than drawing a heading
     over nothing — the opposite of the composer, where an empty category is a
     fact about the project worth stating.
   - **What a save IS depends on the layer**, and is chosen by the writer and
     named in the answer (`ToolsetWriteKind`): `edit` in place, format kept;
     `override` holding only the lines that differ, by the lower layer's explicit
     root; `create`; and `detach` — because a line LEFT OUT of an override means
     "as the lower layer says", so a draft that drops one cannot be written as
     an override at all. The pane says which before the save, not after.
   - **"Override here" writes `{ "$ref": … }` and nothing else.** An override
     that says nothing is still an override: it is how a person takes a shipped
     toolset into a layer they own without freezing today's version of it.
   - **Reset is refused where there is nothing below.** Deleting a toolset that
     states name is the Files view's act, with its own question about referrers.
   - **"Used by" is a best-effort SCAN and says so**: every `workflows/**` file
     under `paths.roots`, first layer winning per state id, searched for a
     `tools` key naming `…/toolsets/<id>`. It does not see a relative reference,
     one reached through another toolset's `$ref`, or a state that inherits its
     tools from an ancestor's `environment` — the ancestor is listed, its
     descendants are not.
   - **`ToolsetLayerFile.decl` is the RESOLVED map**, references followed, which
     is why an override's decl always contains what it follows. `overridesOf`
     is what turns a whole map back into siblings.
   - **The state editor's one field is chosen by the DOCUMENT, never inferred**:
     `showsToolsField` says yes for a `tools` that is a reference, a `$ref` with
     siblings, or a map, and only where no old `permissions` block carries a
     profile, a default or a tool map. An unmigrated state keeps both old fields
     and is untouched, which is what leaves step 7 the only place a state
     changes meaning.
   - **A sibling the field cannot read is carried through**, not dropped, and
     said under the card: the linter reports it, and a form that deleted what it
     could not draw would be deleting the evidence.
   - **Lines over a toolset never write `other`.** `declOfToolset` always does,
     because a whole toolset should say what happens to everything it does not
     name; a state's lines say only what they CHANGE, and a written catch-all
     would override the toolset's own on every state ever opened in the form.
   - **The field's toolsets arrive by context**, read once per project with
     `usedBy: false` — the pane's "used by" scan reads every state file, and the
     field wants the toolsets alone.
7. **Migration**: `"profile": "read-only"` → a reference to a read-only
   toolset; `permissions.tools` / `default` → entries and `other`. A
   mechanical rewrite of authored workflows, `~/.jaira` included.
   *Built 2026-09-21* ([tool-policy](../units/tool-policy.md),
   [jaira-cli](../contracts/jaira-cli.md)):
   `jaira workflow migrate-toolsets [--project <dir> | --base]`, a dry run
   unless `--write`. **It is not a mechanical rewrite, and could not be.** A
   list is a grant and a map is a fence, so rewriting what a state SAYS takes
   claude's own `Glob`, `Grep`, `WebFetch` and `WebSearch` off every read-only
   state in the tree. What the migration writes is derived from what the state
   **does**: `handedToClaude` runs one effective block through the engine, the
   agent wrapper and the upstream executor to the options a real `claude` would
   be spawned with, and every rewrite is held to that measurement — per state,
   per chain, per level, before and after. A file any state fails under is taken
   back out and the rest measured again, so what is written is what passed.
   What was decided while building:
   - **The two things a map cannot say about the shell**, each refused until it
     is named, because migrating is where a state's author chooses.
     `unlisted-shell`: the list never granted `bash` and claude kept its own,
     which no map can hold, so the map takes the shell away. `shell-judged`: the
     list pinned the shell to a mode of its own and asked before every line,
     which a RUN cannot be told — lowering puts the authored mode in
     `permissions.subjects` and `literalPermissions` hands the policy a state's
     `tools`, `default`, `other` and `scopes` and drops the rest, so the line is
     judged by the project's command policy. The second is §4's own destination
     and still opt-in, since it may run what a person used to be asked about.
   - **A map's `bash` is the one entry not read off the measurement.** It is the
     answer for "any other command", not a mode for the tool, and `smart` there
     means "the policy decides" — which is what a list that named the shell and
     gave it no mode got from the baseline. So it is the mode the legacy reading
     resolved, `smart` where nothing said, and the measurement then says whether
     that preserved anything.
   - **`chat/read-only` is no base for a state with no shell.** It holds
     `"bash": "deny"`, and a held entry is a door: the tool is offered and
     lowers as `smart`. A line cannot take a subject out of a map, so such a
     state gets an inline map instead. The shipped file is the preset's map and
     is held to it by invariant 17; this is that trap, met from the other side.
   - **Equality is of reach and decision**, not of mechanism: claude's `Glob`
     under the gate and JaiRA's `glob` at the same mode are one grant, a way in
     that is refused is not a way in, a shell every line of which is refused is
     not a shell, and a native removed up front and one refused at the callback
     are one answer.
   - **`--base` never opens the shared root as a project**, because opening one
     creates its layout; `--write` there takes `--shared-root` beside it and
     copies `workflows/` to a timestamped backup before the first byte.
   - The dry run for `~/.jaira` is
     [0007-assets/migration-dry-run.txt](0007-assets/migration-dry-run.txt): 33
     blocks in 33 files, 2 as a reference plus lines and 19 inline, 12 refused
     for the shell alone, 0 unproven; with both consents, all 33 migrate. 19 of
     them are the same map, which wants a toolset file of its own. Nothing under
     `~/.jaira` was written.

### Amended 2026-09-22: a denied shell is withheld, and a run reads the map's shell

Steps 3 and 7 left a safety defect, recorded as a failure row in
[tool-policy](../units/tool-policy.md): `"bash": "deny"` is a present entry,
so the shell was offered and lowered as `smart` with the authored mode in
`permissions.subjects`, and a RUN never saw `subjects` (upstream
`literalPermissions` hands the policy a block's `tools`, `default`, `other`,
`profile` and `scopes` only). In a run the deny was lost: claude's lines were
judged by the project's command policy, and codex's writing sandbox was
turned on by a held shell. The shipped `chat/read-only` handed an agent a
shell. What changed:

- **A shell the map denies outright is withheld.** `"bash": "deny"` with no
  command subject or `script` entry that allows, asks or defers (`smart`)
  anything is held and handed to nobody (`shellWithheld`): it is left off the
  lowered `tools` list, the gate answers `deny` for it, claude's `Bash` is on
  the deny list and codex's writing sandbox stays off. The entry is still
  what the author wrote and reads back as held, so a toolset still matches
  itself (invariant 43). A `cat` or `ls` that a file tool would have allowed
  through the shell goes with it; the file tools serve those directly.
  Measured with `handedToClaude`: `chat/read-only` now hands claude no shell.
- **"No shell but these commands" is judged by the map in a run too.** When a
  command subject does let something through (`"bash": "deny", "git status":
  "allow"`) the shell stays offered, and lowering carries the subjects a
  second time in a key of `permissions.tools`, `jaira:shell:{…}`, which
  `literalPermissions` passes whole. The policy's narrowing reads that key
  where `subjects` is gone. Upstream merges `permissions.tools` per key, so a
  child can inherit a parent's key beside its own; the line is then judged
  under each and the strictest answer kept. A pair of marks,
  `jaira:bash-deny±`, tells a run's gate that the offered shell's own entry is
  `deny`, so codex's sandbox follows the authored mode as a conversation
  turn's does. This is host-side and needs no upstream change; the upstream
  change that would retire the key is for `literalPermissions` to pass
  `subjects` and `source` through. A refusing run was considered and not
  chosen: the map can be enforced, so refusing it would only take away a
  toolset the decision's own §1 example writes.
- **Consequences for the migration (step 7).** `chat/read-only` IS now a base
  for a state with no shell, and the migration picks it by reference where it
  measures the same. `shell-judged` changes meaning: a map's `bash: "ask"`
  now asks in a run as it does in a conversation, so a list that asked before
  every line and whose tools all ask needs no consent; what still needs it is
  a line whose parts the map answers differently from how the list answered
  the whole line (a policy-judged `rm` the map does not hold, a `cat` that
  asked beside a `read_file` that allowed). The dry run above predates this.
- **`chat/read-only` does not ship `git status`, `git log` or `git diff`.**
  §1's example had them. They are left out on purpose: `git diff --output=<file>`
  and `git log --output` write a file, `--ext-diff` and a configured pager run
  another program, and `git diff --no-index` reads outside the workspace
  where no scope table sees it — a per-part judgement of `git diff` cannot
  tell those apart without flag entries nobody has written, and a toolset
  named read-only should not need them. Its shell is withheld instead, and
  the file tools do the reading. A person who wants them adds the lines with
  "add to the toolset"; that map is then safe in a run by the carried key.
  Invariant 17 is unchanged: the shipped file is the preset's map.
- A task started before this keeps its pinned snapshot, lowered the old way,
  and runs as it did.

### Amended 2026-09-22 (later): a run is handed the state's block

The upstream change the amendment above named is made (declarative-ai
`3f5e5cc`, additive): `literalPermissions` passes every key of a `permissions`
block it does not read through verbatim, so the gate's and the narrowing's
`authored` carry `subjects`, `source` and `implementations`; and the engine
publishes the state's resolved block on `ExecServices.authored` beside the
gate, with or without an approver, cleared for a call whose environment
carries none. JaiRA reads it in a run exactly as a conversation turn reads its
toolset (`viewOfServices` through `toolsetOfEnvironment`). Four failure rows
in [tool-policy](../units/tool-policy.md) closed, each measured with
`handedToClaude` (and a new `handedToCodex`) through the real chain:

- **A written `other: "ask"` forces `Task`, `Agent` and `SlashCommand` to the
  callback in a run.** The block says whether `other` was written; the gate's
  last-resort `ask` still forces nothing.
- **`implementation: "native"` holds in a run.** The built-in is kept under an
  ask rule and the tool is taken out of the copy of `ctx.tools` the executor is
  handed, so ours is not injected beside it. A claude agent reached as a
  FUNCTION still gets ours: a function call has nowhere to write the ask rule a
  kept built-in needs.
- **A child's own shell entries win over its parent's.** Nothing writes the
  `jaira:shell:` key or the `jaira:bash-deny±` pair any more: `subjects` merges
  per key of `permissions`, so a child's replaces its parent's, where a carried
  key inherited per key of `tools` sat beside the child's own and the line was
  judged under both. The readers stay — a block with `subjects` is judged by
  them alone, and one without (a snapshot pinned between the amendment above
  and this, handed over by an older engine) by its carried keys, strictest
  kept — so a task pinned in that window keeps running as it did.
- **An agent reached as a function is held to its toolset.**
  `holdAgentFunction` wraps the claude, codex and generic CLI functions: codex
  gets `permissionMode: "plan"` (`--sandbox read-only`) over the call's own
  where the toolset leaves the writing switch off, and a generic CLI refuses a
  toolset that denies anything, as their prompt routes do.

`TOOLSET_MARKERS` stay: they are the map/legacy discriminator, now read off the
block, and a key of their own would inherit down the chain just as they do
while changing every migrated state's lowered block. Two consequences worth
naming. A run with NO approver (`jaira run`) is now held to its map — the
block is published without a gate — where it used to be read as legacy. And a
task pinned before the first amendment, whose snapshot has `subjects` and no
carried key, now has its shell lines judged by its map rather than by the
project's policy alone; a `bash: "deny"` with nothing allowed is still
offered there (it was lowered as `smart`), and refuses every part the map does
not allow.

### Amended 2026-09-22 (last): the list form and the migration tool are removed

The migration (step 7) has been run on every workflow there is: all 32 blocks
under `~/.jaira` are maps, the project's own `.jaira` holds none in the old
form, and the one shipped state still written as a list, `chat/agent`, was
rewritten to the inline map the migration measured for it. So the code that
existed only to keep the old form working is gone:

- **The list form of `tools` and the old `permissions` block are refused.**
  A list (written, or in a file a reference names), and a `permissions` block
  that says `tools`, `default`, `other` or `profile`, are lint **errors**, and
  a run will not start under either; `permissions` holds `scopes` and nothing
  else. `toolsetOfLegacy`, `applyLegacyProfile`, the frozen
  `LEGACY_NON_READ_ONLY_TOOLS` / `LEGACY_NARROWING_PROFILES`, `Toolset.legacy`
  and the rule that a list-form toolset keeps the agent natives it never
  mentions are deleted. The state editor's old Permissions control (profile,
  default, per-tool rows) is gone; a `tools` value the Tools field cannot draw
  shows read-only.
- **The readers kept for snapshots lowered the old way are deleted**: the
  `jaira:shell:{…}` key, the `jaira:bash-deny±` pair (`SHELL_DENIED_MARKERS`),
  the strictest-of judgement across carried keys, and `viewOfServices`'
  fallback for an engine without `ExecServices.authored`.
- **`jaira workflow migrate-toolsets` is removed**, with `toolsetMigration.ts`,
  `toolsetMigrateEdit.ts` and `handedDifferences`. `handedToClaude` and
  `handedToCodex` stay, as the measurement tests of the map hold the chain to.
  [0007-assets/migration-dry-run.txt](0007-assets/migration-dry-run.txt) is
  kept as the record of what the migration measured, and nothing reads it.
- **`TOOLSET_MARKERS` stay, for a different reason.** A map no longer needs
  telling from a list, but it still needs telling from a state that declares
  no toolset at all — which is not the statement "nothing": an empty map
  removes every built-in, and saying nothing leaves the agent as its executor
  built it, under the gate. Both lower to a block with no tools in it. The
  marks stay a pair, where one would do, because every block lowered since the
  migration carries the pair and a pinned snapshot's map must not start
  reading as no declaration.

A task pinned to a snapshot lowered before the migration now reads as the new
form. In a RUN its block has no marks, so its agent is handed on untouched, as a
state that declares no toolset — which is what the list form got too — and the
engine still seeds a `profile` such a block carries. In a CONVERSATION TURN
continuing it, the inherited list and block are read back as a map: the agent
loses the built-ins the list does not name, and a `profile` or `default` in the
block is no longer read, so a listed tool with no mode of its own (a `bash` an
old `read-only` profile used to refuse) falls to the project baseline. A carried
`jaira:shell:` key or `jaira:bash-deny±` pair is read as an un-offered tool
entry of that name and judges nothing. Starting the task again pins the map.

## Open

- `smart` on a command subject: what the approver is shown for one part of
  a line.

## Revisit when

`other` is answering most calls — the standard list has fallen behind what
agents have — or people keep wanting two toolsets at once, which `$ref`
plus siblings cannot say.
