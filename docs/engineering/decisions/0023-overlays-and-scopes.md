---
id: engineering/decisions/0023-overlays-and-scopes
type: decision
status: built
updated: 2026-11-04
decides_for: [engineering/units/tool-policy, ui/components/permissionSet-card, ui/components/composer-setting-chip, ui/components/command-approval, ui/surfaces/settings-tools]
---

# 0023. Layers and places

The person, 2026-11-02, while the approval dialog's per-line panel was being redesigned: "lets do the
full redesign i have in mind instead of just piece meal. … 1. I want to be able to "overlay" a
permission set on top of another. … 2. I want to add a property to permissions: scope. A file
permission might have directory scope. A web permission might have a domain scope."

Mockups: https://claude.ai/artifact/PbWkvqTYHhA3iHZ3kBNGjQ (today's renderings first).

Built 2026-11-02, uncommitted. Every question is ruled, and §7 holds the last four, accepted as
proposed. It was checked in the real app with a real agent (`packages/app/shots/runner-approval.mts`).

## Rulings (2026-11-02)

On round 1, the person: "I think it makes more sense to have mode as something like:
`type PermissionMode = 'allow'|'ask'|'deny'|{[scope: string]: 'allow'|'ask'|'deny'}` that way it
overlays cleanly. … for the overlay, we can have it so that the most recent wins. that way, if you have
{mode: 'deny'} as a base and then {mode: {'C:': 'allow'}} that will allow only C: and deny anything
else. This essentially allows the user to choose the default per tool."

This replaced round 1's "an overlay fills only the asks". A newer layer can now loosen or tighten
anything. Then, on the questions that followed:

1. **Most specific wins across layers.** "this doesnt take power away from the latest layer as it can
   always override the same specific path to make sure it can get what it wants."
2. **Anything that is not `ask`, `allow` or `deny` is a function.**
3. **A bare folder is a path,** meaning that folder and everything under it. Credentials are protected
   by specificity, with no rule of their own.
4. **A fourth mode, `unavailable`:** the tool is not visible to the model.
5. **The order is agreed** (§2.6). The permission selector should also let a person compose layers.

On the mockups that followed:

6. **Everything is a layer**, including the presets: "everything should be a layer including the base
   "ask first" "read only" etc. in fact that should be more visible and easy to switch in this ui."
   There is no separate base. The bottom layer is usually a preset, and switching it must be quick.
7. **The approval panel is 4D**, with deny added. What, Where and How far are chosen first, then the
   answer is a Deny or an Allow button, and How far applies to either: once, this run, or a layer.
8. **The stack lives in the composer**, as joined segments (round 4, design 5). "We can even add
   'tools' as the last layer in that stack." It needs a way to handle a stack too long to show, and a
   way to see a stack's definition. "A stack is just a permission set. The sets might have various
   scopes (i.e. global, project, runtime, etc) but theyre essentially the same otherwise." A bucket
   belongs to the set that is in it, not to the stack: "the 'chat >' folder path at the top is
   actually scoped just to the ask first stack."
9. **Each chip adjusts its own layer** (round 6): "the bottom individual chips open to let you adjust
   that one chip, and there is a tools chip at the end that lets you adjust tools individually using
   the ui that existed previously. perhaps there is a plus chip at the end that allows you to add a
   layer. that said there should also be a way to open the entire combined list to see the full view
   showing everything."
10. **A set is a file, chosen by browsing** (round 7): "each permission set is a file on a path, each
    one has an icon, therefore, selecting a permission set should follow some of the folder browser
    ui. The "contents" of a permission is the tool mappings. That UI should look like what we already
    have in 2, just with anything unset being filtered out."
11. **Compact, with an expanded mode that stays** (round 8): "starts like 5/7, but has a button that
    causes it to toggle to an expanded mode (and stay that way until toggled back) like 2/8." Of the
    eight pairings, the person picked **design 6**.
12. **The last four items are accepted as proposed** (§7): "Yes, as proposed".

## Amended 2026-11-03, after using it

The person, looking at the built stack: "1. the shield button should bring up the full expanded
permission ui … 3. i dont like how runtime and tools are separate. tools should show the full list, but
have the runtime modified elements visually differentiated. 4. swapping permissions / permission sets /
layers / etc should reevaluate the current permission prompts under the new permission strategy. 5.
when the composer gets smaller, the permission pill ui should collapse and be the shield with a +1, +2".
Asked what the shield and the count should be, they picked the browser with the stack in its tree, and
a count of the layers over the bottom plus one for what the conversation changed.

13. **The shield opens the browser, with this stack at the top of its tree**: each layer oldest first,
    then `tools`, above the scopes. A layer picked shows its contents with its crumbs and actions;
    `tools` is the Tools card; a set from a scope can be laid on top. It opens on `tools`.
14. **No `runtime` segment.** The run's answers are counted on `tools` (`tools · 9 · 3`, the count in
    `--accent`), and the Tools card marks each on the line it is about (`this run · allow in packages`,
    with a `×`). The engine's stack still has a runtime layer: an approval's rows still say `this run
    allows`.
15. **Changing the stack decides what waits again.** A layer swapped, added, moved, removed or pinned, a
    run answer let go of, or another call answered for this run: every call of the task still waiting
    on the person is decided again under the stack as it is now (`ApprovalHub.rejudge`, `rejudgeCall`).
    One it now allows or denies is answered, by `permissions` (the record says so); one still asking
    stays, its rows redrawn. A part a function now decides leaves the question as it is. A run's calls
    are decided again only at its root state, and only once the person has picked a stack for it — a
    state's own block is the engine's.
16. **Collapsed**, a narrow composer's stack is one segment: the shield, the bottom's icon and `+n`,
    where `n` is the layers over the bottom, plus one when the conversation has lines of its own or
    this run has answers. Pressed, it opens the shield's browser.

## Amended 2026-11-04: the agent's own folder, and reads the gate allows

The person, 2026-11-04: "many of the permissions are limiting read scope a little too narrowly … claude
codes own files are unable to be read when they should be able to", and on a conversation where a
`read_file` of the agent's memory was refused and the agent's PowerShell `Get-Content` of the same file
then went through: "powershell Get-Content should be the same as read_file, right?". They named the
place `$AGENT_WORKSPACE`, as `$AGENT` "would seem to mean the agent name".

The shell part WAS judged as `read_file`. What differed was everything around the judgement:

17. **A tool a place can narrow is never pre-approved.** A delegated agent pre-approves every tool whose
    mode, read with no input, is `allow`. §3.10 hands the gate a line at its loosest, so under
    `chat/read-only` (`$PROJECT: allow`) `read_file`, `glob` and `grep` were pre-approved, and the
    narrowing never ran on any read: not outside the project, and not at `**/.env`. The engine hands a
    delegated agent its raw tools and its own gate, so nothing else stood in front of them. Upstream's
    `ScopeNarrowing` gains `narrows(tool, block)`, and `ToolGate.modeOf` reports an `allow` that a
    narrowing may tighten as `smart`, which is not pre-approved. JaiRA's narrowings say a tool narrows
    when its line has places, the executor floor holds a tool that acts somewhere, or the tool is a
    shell, an MCP tool or one that always asks. A narrowing that does not say narrows.
18. **A read goes where the gate let it.** `read_file`, `glob` and `grep` refused every path outside the
    workspace on their own, a rule older than places. So a read the set asks about outside the project
    (§7.1) was asked and then refused, and only the shell could reach there. Where a read may go is the
    set's to say, at its places, and the executor floor is the sandbox: these tools now read and search
    an outside path where it is, by the path the call named. `.jaira/` is refused anywhere, `~/.jaira`
    included. Writes keep the workspace: `write_file` and `edit` place files through the artifact
    destination, which is the workspace's.
19. **`$AGENT_WORKSPACE` is a named place, and each agent declares it.** The person: "the agents
    themselves should declare what their workspaces are. This way, chatgpt can have a different workspace
    than claude." An agent's declaration says the folder it keeps for itself while it works in a folder
    (`AgentToolDeclaration.workspace`). Claude Code: `~/.claude/projects/<the worktree, else the project,
    as the agent spells it>` (memory, transcripts, saved tool results). Codex: its transcripts,
    `~/.codex/sessions` (its memories are a database, not files). Neither is the folder that holds the
    sign-in. The place is resolved per call, for the agent that made it: the agent's wrapper notes its
    declaration against each call's input, so Claude's folder opens to Claude's calls only, and a call no
    agent made (JaiRA's own) has none. The `chat` sets read there at their project
    mode, and `~/.claude/.credentials.json` and `~/.codex/auth.json` join the credential places that ask
    in every set.

Conversations kept before 0023 held the whole map as their composer setting, some with
`{ function: … }` values, and so showed no `chat/…` layer. They were migrated by hand, 2026-11-03: each
became the chat preset it was (a plain decision that the preset now writes as places, at `**` or at
`$PROJECT`, counts as that preset's line), with a tools layer of whatever still differed. The two task
files in this checkout became `chat/full`, and seven chat records' settings became `chat/full` or
`chat/auto`.

## 0. Where this starts

- A permission set maps a subject to a mode (`allow`, `ask`, `deny`, or `{ "function": … }`), with
  `other` for anything it does not name. A call answers to the most specific line that names it: a
  command entry by its words, then the subject, then `other` ([tool-policy](../units/tool-policy.md)).
- A layer's copy of a set is `{ "$ref": "$SYSTEM/…", "shell": "allow" }`: the lower set with these
  lines replacing its own. Nothing else composes two sets.
- Places exist, but never on a line. An executor's `scopes` and a state's `permissions.scopes` are
  place-first tables (`scopes.ts`), which only the feature workflow writes and nothing on screen shows.
  No set says anything about where, so `read_file: "allow"` reads anywhere on the disk except
  `.jaira/`.
- "For this run" answers live in `CommandGrants`: in memory, per task, by width, and never shown.

## 1. A line's value

```ts
type Decision = "allow" | "ask" | "deny" | "unavailable" | FunctionName; // any other string names a function
type PermissionMode = Decision | { [place: string]: Exclude<Decision, "unavailable"> };
```

- **A string is a decision.** The four words are modes, and any other string names a function:
  `"web_fetch": "smart"`. `{ "function": "smart" }` migrates to `"smart"` in every file. The reader of
  the old form is then deleted. No function may be named `allow`, `ask`, `deny` or `unavailable`.
- **An object is a place map**, from a place to a decision: `"write_file": { "src": "allow", "infra": "deny" }`.
  A map speaks only at its places (§3.4).
- **`unavailable`** means the model is not handed the tool at all. It is written on a tool, an MCP
  server or an MCP tool, and on `shell` (no shell at all). It cannot be written on a command, a
  runner, `script` or a place: the model cannot be shown part of a shell, and visibility is per tool,
  not per place. The linter refuses it there. It is what the composer's Tools card writes when a tool
  is unticked over a layer that offers it.

## 2. Layers: the newest wins, line by line

**2.1 A stack of sets, merged.** A conversation or a state is judged under a stack of permission sets,
oldest first. The stack is merged into one set, line by line, and the result is judged exactly as one
set is judged today:

```ts
function merge(lower: PermissionMode | undefined, upper: PermissionMode): PermissionMode {
  if (typeof upper === "string" || lower === undefined) return upper; // a plain decision covers everywhere and clears the places below it
  if (typeof lower === "string") return { "**": lower, ...upper };    // the lower decision becomes the fallback
  return { ...lower, ...upper };                                      // places combine; the same place takes the newer decision
}
```

So a base `read_file: "deny"` under a newer `read_file: { "C:": "allow" }` comes to
`{ "**": "deny", "C:": "allow" }`. Every tool gets its own default, chosen by whichever layer last
says one.

**2.2 A merge is right because newest wins per line.** A newer layer's `git: allow` does not override
an older `git push: ask`, because it did not name `git push`. The merged set holds both, and
`git push`, being more specific, still asks. A newer layer that means otherwise writes `git push`
itself.

**2.3 What a layer leaves out says nothing.** A line a layer does not write falls through to the layers
under it. At the bottom of the stack, a tool no layer names is not offered, as today, and `other` is
the line for an agent's native tools with no equal and for MCP. A layer that writes `other` replaces
the `other` under it, as with any line. A set meant only to add lines should therefore not write one,
and `declOfPermissionSet` stops writing `other` when the set it describes had none.

**2.4 What no layer can change.** The destructive floor, `.jaira/`, a piece the parser cannot read
(which asks at least), and an executor's floor all stand above every layer.

**2.5 A layer's copy is a layer.** `{ "$ref": lower, …lines }` is the stack [lower, these lines]. It is
merged by §2.1, so a copy that names one place no longer replaces the whole map below it, as
upstream's sibling replacement would. `resolvePermissionSetDecl`, which already follows `$ref`
itself, does the merge. A set file may also name a stack: `"layers": [ref, …]`, judged oldest first,
with the file's own lines as the newest layer. This is how a composition is saved.

**2.6 The order (agreed).** Every set is a layer (ruling 6), and "the base" in this decision means
whatever layer is at the bottom, usually a preset. Two presets may be stacked like any other two
layers. A stack with nothing in it offers nothing. Oldest to newest:
1. the bottom layer, usually a preset (`ask-first`, `read-only`, `auto`, `full`)
2. the bucket's standing layers, from layered settings:
   `"permissions": { "layers": { "chat": ["$/permission-sets/project/build-safe"] } }`
3. the layers a state names, or the conversation's own (`ChatSettings.permissionSet` gains `layers`,
   kept on the task like the rest of the composer's settings)
4. **runtime**: the answers the person gave in this task, at their widths and places, still in
   memory and still emptied when a run opens the gate
5. **tools**: the conversation's own lines, meaning what the composer's Tools card ticks and moves
   (ruling 8)

Every layer is a permission set (ruling 8). What differs is where it lives, its *scope*: `built in`
(what ships), `global` (`~/.jaira`), `project` (`.jaira/`), `runtime` (this task's memory) and
`this conversation` (the tools layer, kept on the task). A set's id carries its own bucket
(`chat/ask-first`, `app/build`), and the stack has none. In this decision "scope" means where a set
lives, and "place" means where on a line a decision applies.

**2.7 Who said it.** Every answer can name the layer it came from. The merge keeps a provenance per
line and per place, and the approval rows, the card and the composer show it: `build-safe allows`,
`ask-first asks · no layer above names one build`.

**2.8 Where "Add to" writes.** Any layer in the stack, with this project's standing layer for the
bucket as the default. A newer layer can loosen a base, so "this build is safe in this project" can
now hold even under `read-only`. Writing it into `read-only` itself changes that set for every user of
it, and the menu says so.

## 3. Places

**3.1 What a place is belongs to the tool.** Each tool declares the kind of place its calls are about
(`ToolSpec.scope`, beside `pathArgs` and `urlArgs`), so the matcher, the card and the dialog know how
to read and offer them:

| Place | Tools and lines | Read off the call |
| --- | --- | --- |
| path | `read_file`, `glob`, `grep`, `edit`, `write_file`, `show_artifact`; `script` (the file run); `shell`, every command line and `runner:*` (where it runs, and every path it names as a file tool) | the path arguments; a command's working directory and file arguments |
| site | `web_fetch`; network programs in the shell (`curl`, `wget`, `Invoke-WebRequest`) | the URL's host, then path |
| branch | `git_push`, `git_merge`, `git push` in the shell | the remote and branch pushed to, or the branch merged into |
| repository | merge-request and CI tools | `owner/name` on the forge |
| workflow | `start_task`, `move_task` | the workflow id |
| program | `stop_process`, `control_service`, `open_app` | the process, service or app name |
| host | `runner:ssh` | the host |
| none | `web_search`, `screenshot` | — (a query names no place) |

A map on a line whose tool takes no place is refused by the linter. An MCP tool the configuration maps
to a standard tool takes that tool's place.

**3.2 Paths.**
- A bare path is that folder and everything under it: `"C:"`, `"src"`, `"~/.ssh"`. A path containing
  `*`, `?` or `{` is a glob. A path that names a file names that file. Relative paths are relative to
  the project, and `$PROJECT`, `$WORKTREE` (the task's), `$AGENT_WORKSPACE` (the agent's own folder for
  the folder it works in, ruling 19), `$TEMP` and `~` are named places.
- **The most specific place wins, whatever layer it came from (ruling 1).** In order:
  1. A place that pins the file beats a folder that holds it. `**/.env` and `*.pem` beat `C:` and
     `$PROJECT`, which is how credentials stay asked about under a broad allow, with no rule of their
     own (ruling 3).
  2. Among folders, the deeper one wins.
  3. Among file patterns, the one with more literal segments before its wildcard wins:
     `src/generated/**/*.ts` beats `src/**/*.ts`.
  4. `**` is the least specific place of all.
  5. The same place in two layers was already settled by the merge, so the newer one stands. Two
     different places that rank the same take the stricter answer.
- A newer layer that wants a place it does not get writes that place itself. To allow a credential
  file, it writes `**/.env`.

**3.3 Sites and branches.**
- **Sites:** `github.com` is the host. `*.github.com` is its subdomains, not the host itself.
  `github.com/anthropics/**` is a host and a path. A host with a path beats the bare host, which beats
  a wildcard host, which beats `**`. `localhost` and IP addresses match exactly or not at all.
- **Branches:** `main`, `claude/**`, optionally with a remote (`origin:claude/**`). An exact name beats
  a glob, and a longer literal prefix beats a shorter one.

**3.4 The line first, then the place, then less specific lines.** A call picks the most specific line
that names it, as today, and then the most specific of that line's places that matches. Where none of
them matches, the call falls to the next less specific line. `"npm run build": { "packages/app": "allow" }`
answers for `packages/app`, and elsewhere `npm run build` is `script`'s, then `shell`'s, then
`other`'s. A `**` entry is how a line gives itself a default. A part with no line naming its program
answers as the file tool it is (`rm x` as `write_file` on `x`), at that line's places.

**3.5 Several places in one call** (`cp a b`, a command's directory and its file arguments) take the
strictest answer, as today.

**3.6 Package scripts.** A package script is judged in its package's directory already
(`scriptRunsOf`). So "this workspace's build is safe", the written form 2026-11-01 left open, is
`"npm run build": { "packages/app": "allow" }`.

**3.7 State tables move onto lines.** A state's `permissions.scopes` becomes place maps on the lines of
the state's set. The feature workflow's five `docs/` folders become
`"read_file": { "**": "deny", "docs/product": "allow", … }`. Then the key and its reader are deleted.
An executor's `scopes` stay as the floor (§7.2).

**3.8 Answers remember a place.** "For this run" and "Add to" keep an answer at a subject width and a
place width. `CommandGrants` keys become (width, place). The dialog offers the place widths it reads
off the call:
- a path: `this file` · `its folder` · `the package` (where a `package.json` is above) ·
  `this project` · `anywhere`
- a URL: `this page` · `the host` · `*.{parent}` · `anywhere`
- a branch: `this branch` · `{prefix}/**` · `any branch`

**3.9 Agents' own tools.** For Claude Code, place maps compile into permission rules (`Read(src/**)`,
`Edit(…)`, `WebFetch(domain:github.com)`), as scope tables do today (`compileClaudeScopeRules`), and
`unavailable` is a removed native. Codex has only coarse switches: a line with places serves JaiRA's
own tool to codex and displaces its native.

**3.10 Gate modes compile loose and narrow per call.** Upstream's narrowing only tightens. So the mode
lowered into `baseline.tools` for a tool is the loosest answer any of its places can give, and the
narrowing works out each call's answer. Shell parts already work this way through `decideCommand`.
A tool whose answer a narrowing may tighten is therefore never pre-approved (ruling 17).

## 4. On screen

All of this is drawn on the mockups linked at the top.

**4.1 The stack lives in the composer (rulings 8–11; round 8, design 6).** The composer's Permissions
chip becomes the stack. It is one joined segment per layer, oldest to newest:
`chat/ask-first ⌄` · `app/build` · `web/docs-sites` · `runtime · 3` · `tools · 9` · `+`.
- **Every segment is a permission set**, named by its full id with its bucket, since a bucket belongs
  to its set and not to the stack. The set's icon shows on its file. The preset is the first segment,
  usually.
- **A segment opens to adjust its own layer**, compact first:
  - The head is the set's path as **crumbs that are pickers**: `Built in › chat › ask-first.json`. Each
    crumb drops what sits beside it: the scopes, a scope's buckets, or a bucket's sets. So swapping
    `ask-first` for `read-only` is two presses.
  - Under the head are the set's **contents**, drawn as the permission set card with places (§4.2),
    filtered to the lines the file writes.
  - Under those are the layer's actions: move earlier or later, pin to this project, edit a copy,
    remove.
- **⤢ expands it into a browser.** The popover widens into a tree of scopes, buckets and files, each
  file with its set's icon, beside the selected file's contents. The crumbs stay above both panes, in
  step with the tree's selection. **Use as this layer** swaps the segment's set. The mode is
  remembered, so expanded stays expanded on every segment until ⤡ is pressed.
- **`runtime`** opens this run's answers, each removable, with `clear`.
- **`tools`**, the last layer, opens today's Tools card unchanged. These are the conversation's own
  lines.
- **`+`** opens the same browser to pick a set to lay on top.
- **The full view** is the `tools` chip's Tools card switched to **Everything**: the merged stack in
  the same rows, each tagged with the layer that decided it, with "save this stack as a set"
  (`"layers": […]`) in its head (§7.4).
- **A stack too long for the composer** keeps its first segment and its last three (`runtime`,
  `tools`, `+`) and folds the middle into `⋯ {n}`. That segment lists the folded layers, and each one
  opens as its own segment would (§7.4).

**4.2 The card's lines take places.** A line with a place map folds like a command group. Its head
reads `{n} places`, and its mode button is the map's `**` where it has one, else
`elsewhere: as {line}`. Open, there is one row per place, most specific first: a glyph for the kind
(file, folder, site, branch), the place in the data face with a named place's words beside it, a minus
and the place's mode button. The last row is `+ add a place`, whose menu offers places of the line's
kind and `another…`. The mode menu gains `unavailable`: "not offered — the agent never sees it".

**4.3 Settings → Tools shows what a stack comes to.** A set's detail gains `Show it in a stack`, a base
picker that draws what each call comes to: the base's answer, the layer's, the result, and who said
it. The bucket heading in the rail lists its standing layers.

**4.4 The approval panel (ruling 7, design 4D).** A line's `asks ⌄` opens a panel of choices that
answer nothing until a button is pressed:
- **What:** `one build` · `every one command`
- **Where:** `packages/client` · `packages` · `this project` · `anywhere`
- **How far**, as radios: `Once` · `For this run` · `Add to [build-safe ⌄]`. The picker lists the
  stack's layers, newest first, and marks the bottom preset as changing that set for everyone who
  uses it. The line it would write is shown before an answer is chosen.
- The panel ends in **Deny** and **Allow**. Pressing one answers the line at the chosen reach, so a
  refusal can be once, for this run, or written into a layer as `"one build": { "packages": "deny" }`.
  A denied line refuses the whole command, and the answers on the other lines are kept.

Each row says who answered or who asked. The bottom Allow / Deny (Continue / Cancel once a line is
answered by hand) stays as the 2026-11-02 rounds set it.

## 5. Build order

1. Values: the `PermissionMode` union, `unavailable`, and functions as strings. Then migrate
   `{ "function": … }` and delete its reader.
2. Places: `ToolSpec.scope`, per-kind matchers in `scopes.ts` with §3.2's ranking, and line → place →
   less specific line in `decideCommand` and the narrowing. Migrate state `scopes` and delete them.
3. Layers: `merge` with provenance, `$ref` copies and `layers` through it, standing layers in settings,
   the conversation's `layers`, and `this run` as the top layer.
4. Agents: Claude rules from places and `unavailable`, and codex displacement.
5. The card: place rows, the add-a-place menu, and `unavailable` in the mode menu.
6. The composer: the stack's segments; a segment's compact popover (crumb pickers, filtered contents,
   actions); the remembered expanded browser; `runtime`, `tools` and `+`; the Tools card's
   Everything switch with "save this stack as a set"; the `⋯ {n}` fold.
7. The dialog: Where, provenance on rows, and "Add to" over the stack.
8. Settings: `Show it in a stack`, and standing layers in the rail.
9. What ships gains places (§7.1).

## 6. Invariants this adds

- A layer's line decides only what it names, and a less specific newer line never beats a more
  specific older one.
- The most specific place decides, a file-pinning place beats any folder, and a place that matches
  nothing falls to a less specific line, never to a guess.
- `unavailable` is never written on a command, a runner, `script` or a place.
- Nothing in any layer reaches past the destructive floor, `.jaira/`, an unreadable piece, or an
  executor's floor.
- Lowered gate modes are never stricter than a per-call answer can be, and the narrowing never widens.

## 7. Settled last (ruling 12)

1. **What ships gains places.** The four `chat` sets get:
   - `read_file`, `glob` and `grep` at the set's mode in `$PROJECT`, `$WORKTREE` and `$AGENT_WORKSPACE`
     (ruling 19), and `ask`
     elsewhere in `read-only`, `ask-first` and `auto`. `full` keeps `allow`.
   - `**/.env`, `**/.env.*`, `**/*.pem`, `**/id_rsa*`, `~/.ssh`, `~/.aws`, `~/.claude/.credentials.json`
     and `~/.codex/auth.json` at `ask` in every set,
     `full` included.
   - In `auto`, `git_push` at `smart`, with `main`, `master` and `release/**` asking.
2. **Executor `scopes` stay a separate floor,** an operator's sandbox no layer widens. An executor
   does not name a permission set as its floor.
3. **Standing layers live in settings, per bucket (§2.6),** not in each set file's `layers`.
4. **The full combined view, and a stack too long for the composer (ruling 9).** Today's Tools card
   gains a head switch, **This conversation** | **Everything** (round 6, design 7). Everything draws the merged stack in the same rows, each tagged with the layer
   that decided it, and holds "save this stack as a set". A long stack keeps its first segment and its
   last three (`runtime`, `tools`, `+`) and folds the middle into `⋯ {n}`, which lists the folded
   layers (round 6, design 8).
