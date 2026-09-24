# Scoped permissions — a permission is about a place, not only about a tool

**Status: BUILT (2026-08-15)** — every step of §9, wired end to end.

Author a table in `config.executors.<name>.scopes` (parsed and validated by `shared/src/config.ts`)
or on a state's `environment.permissions.scopes` (carried by hw's `ExecEnvironmentDecl`), and it
reaches: the permission gate for both routes a call travels — a wrapped tool and a delegated agent's
callback (`scopeNarrowingFor`); the RESULTS of `glob` and `grep`, which withhold what an open would
refuse (§6); `bash`, scoped by its working directory and every path it names (`commandSubjects`);
and the agent's OWN permission rules, compiled by `compileClaudeScopeRules` and folded over every
prompt call by `withSecurityFloor` on both the run and chat paths.

The model and its resolution are `shared/src/scopes.ts`. The upstream seams are
`ToolDecisionOptions.scopeOf` / `ExecPolicy.scopeOf`, `ScopeDecl` and `ProfileTable` in
`@declarative-ai/permissions`: upstream owns the DATA shape so a workflow can author it, and the
resolution — globs, specificity, inheritance, what unmatched means — deliberately stays here.

**Three things this document got wrong and the code corrected**, each recorded where it bites:
resolution had to be specificity-dominant, because the order stated in §1.2 made `default: deny`
nearly inert; a trailing `/**` had to cover its own directory (§1.3), or a project path fell outside
its own sandbox; and unmatched-denies turned out to be right for a SANDBOX and wrong for a NARROWING
layered under one (§7) — a state adding a single `deny` would otherwise have refused every other path
in the project. The third was found by a test failing, not by reasoning about it.

**What is not built**: no authoring UI — the menu's scope selector (§7) does not exist, so a table is
written by hand in JSON. And no end-to-end run against a real agent with a table in force; every
assertion is unit-level, which matters most for `bash`, whose path extraction is best-effort by
construction.

---

## 0. Why

Today a permission answers one question — *may this agent call `write_file`?* — and the answer is
the same everywhere. That is the wrong shape for how anyone actually works. A person opening a repo
to an agent means something like: read anything under the checkout, write only under `app/`, never
touch `infra/`. There is no way to say it, so the only expressible approximations are "write:
allow" (too much) and "write: ask" (a prompt per file, which is how people learn to click through
prompts).

The observed failure is sharper than the ergonomic one. A `read-only` sync run watched an agent
glob and read twenty files and never asked, because `Glob` was a name nothing had — that gap is
closed. What is still open is that once `read_file` is granted, it is granted over the whole
workspace, including `.env`, including whatever the checkout happens to contain. A profile narrows
by *capability*. Nothing narrows by *place*.

So: **a scope is a place plus what may happen there**, and the resolved permission for a call is a
function of the tool AND the path it is about.

---

## 1. The model

### 1.1 A scope table is `pathGlob → tool → mode`

```jsonc
"permissions": {
  "profile": "read-only",
  "scopes": [
    // No root entry, and none is needed: what this table does not name is denied (§3). The sandbox
    // is the consequence of what you wrote, not of a deny rule you remembered to add.
    { "path": "/mnt/c/work/**", "tools": { "read_file": "allow", "glob": "allow", "grep": "allow" } },
    { "path": "/mnt/c/work/app/**", "tools": { "edit": "ask", "write_file": "ask" } },
    { "path": "/mnt/c/work/infra/**", "default": "deny" },

    // Web tools scope by URL, not by path — see §2.3.
    { "url": "https://docs.internal.example/**", "tools": { "web_fetch": "allow" } }
  ]
}
```

An entry names a place (`path` or `url`, never both), the modes for tools named explicitly, and
optionally a `default` for tools it does not name. `other` stays where it is — on `permissions`,
not on a scope: "a tool nobody has a name for" is a question about the vocabulary, not about a
directory.

### 1.2 Resolution: most specific wins, per tool, with inheritance

For a call `(tool, path)`:

1. Collect every scope whose glob matches `path`.
2. Order them by **specificity** — the number of leading literal (non-wildcard) segments —
   most specific first, ties broken by document order with the later entry winning.
3. Walk that order and take the **first scope that says anything about `tool`**: its explicit entry
   if it has one, otherwise its own `default`.
4. No scope said anything — **deny** (§3).

**Specificity dominates, and it has to.** The plausible alternative — every scope's explicit entries
considered first, then every scope's defaults — reads naturally and is wrong: it lets a broad
`{"path": "work/**", "tools": {"read_file": "allow"}}` override a nested
`{"path": "work/infra/**", "default": "deny"}`, which leaves `default: deny` governing only the tools
no ancestor happened to name. "Deny everything here" has to mean it, or the root-deny-then-widen
shape this design exists for cannot be written at all.

Inheritance survives because a scope that says *nothing* is skipped rather than answering. In the
table above, `/mnt/c/work/app/**` names `edit` and carries no `default`, so a `read_file` there falls
through to `/mnt/c/work/**` while an `edit` resolves at `/mnt/c/work/app/**`. That is what "the
nested directory inherits and widens" means, and it means it without a merge step that could produce
a mode neither entry contains.

Specificity rather than document order because the mental model is *the directory's permissions*,
and a table that changes meaning when two rows are reordered is one where a well-meaning edit is a
silent policy change.

### 1.3 A trailing `/**` covers its own directory

`/mnt/c/work/**` is how anybody writes "the sandbox is `/mnt/c/work`", so it matches that directory
as well as everything under it. Under the strict glob reading it would not, and the consequences are
immediate: the project path falls outside its own sandbox (§3.1 would warn about a correct table),
and a `bash` cwd of exactly that directory matches nothing and is therefore denied.

Only when trailing. `a/**/b` keeps its ordinary meaning.

---

## 2. What "the path" is, per kind of tool

This is the whole difficulty. A scope is only as good as the answer to *what is this call about*,
and the three kinds of tool answer differently.

### 2.1 Path-taking tools — the easy case

`read_file`, `write_file`, `edit`, `glob`, `grep` take a path (or a pattern and a root). The path
is the subject, normalised the way `logicalKey` already normalises it, and checked after
`withinWorkspace` has refused anything escaping the root.

A tool taking a *pattern* rather than a path (`glob`, `grep`) is scoped by the **directory it walks
from** — its `path` argument, defaulting to the workspace root. A pattern is not a place; the tree
it is unleashed on is. A `grep` at the root under a table that denies `infra/**` must not return
hits from `infra/`, which means the scope also **filters the walk**, not merely the call: see §6.

### 2.2 `bash` — the sandbox is the working directory, and every path it names

The glob is a sandbox, so:

- The command is scoped by **the directory it runs from**. `cwd` when the tool is given one; the
  workspace root otherwise. A command that changes directory changes its scope — `cd infra && ls`
  is judged at `infra/`, not at the root, and the existing splitter (which already judges every
  command on a line separately, strictest verdict winning) is where `cd` tracking belongs.
- **Every path argument is also resolved**, and the **most restrictive** of {cwd-scope, each
  path-scope} wins.

Worked, with a table of `/mnt/c/test → allow`, `/mnt/c → ask`, and the command running from
`/mnt/c/test`:

| command | paths resolved | verdict |
| --- | --- | --- |
| `ls -al /mnt/c/test` | cwd `allow`, arg `allow` | **allow** |
| `ls -al /mnt/c/test /mnt/c` | cwd `allow`, args `allow` + `ask` | **ask** — the minimum |
| `cd /mnt/c && ls -al` | cwd becomes `/mnt/c`, `ask` | **ask** |

Restrictiveness orders `deny > ask > smart > allow`. `smart` sits under `ask` because it may still
escalate to a human but is not guaranteed to, so it cannot dominate an explicit `ask`.

The cwd is always in the minimum, not merely a fallback when no path is named. A command that names
one innocuous path while running somewhere it should not be is still running somewhere it should
not be.

Path *extraction* is best-effort and must fail closed. The command parser already models programs,
subcommands, flags and arguments (`packages/runtime/src/policy.ts`); what it does not do is decide
which arguments are paths. The rule: an argument that is not a flag and resolves to an existing
path, or contains a `/`, is treated as a path. An argument the parser cannot model at all already
resolves to `ask` under the existing "unparsable ⇒ ask" rule, and that rule is what keeps the
best-effort part honest — the failure mode is a prompt, not a silent pass.

This is the part of the design most likely to be wrong in practice, and it should ship last (§9).

### 2.3 Web tools — the glob is a URL glob

`web_fetch` and `web_search` have no path. A scope entry for them carries `url` instead, matched
against the request URL with the same glob grammar (`**` crossing `/`, `*` not). A web tool whose
call matches no `url` scope is denied by the same §3 rule that denies an unmatched path — which
makes the default posture "no network" and an allowlist the way to open it, rather than the
reverse.

`web_search` is scoped on the **configured endpoint**, not on the query: the query is not a place.
Whether the *results* should then constrain a following `web_fetch` is deliberately out of scope —
see §9.

---

## 3. Unmatched is denied, and nothing is required

§1.2 step 4 is the load-bearing rule, and it is also the whole default policy. Inheritance widens
downward from whatever the table covers; anything the table does not cover is refused.

**No entry is required, least of all a root one.** A table that says only

```jsonc
{ "path": "/mnt/c/test/**", "tools": { "read_file": "allow", "edit": "ask" } }
```

is a complete and safe policy: `/mnt/c/test` is the sandbox, and any call about a path outside it is
denied without anybody writing a deny rule. That is what people want most of the time, and making it
the consequence of an omission rather than of a declaration is what makes it hard to get wrong — the
mistake that produces an over-permissive table has to be a mistake somebody *typed*.

Opting out is explicit and looks like what it is:

```jsonc
{ "path": "**/*", "default": "ask" }    // everything else: ask me
```

A root entry is therefore a widening, and reads as one. An earlier draft of this section had it
backwards — required the root entry and asked a validator to warn when it was missing — which made
the safe posture the one you had to remember to ask for.

### 3.1 The project path should be in the sandbox — a warning when it is not

The one thing a table is expected to cover is the place the work is. A sandbox that excludes the
open project is a table that will deny everything the run was started to do, and it is far more
likely to be a mistake — a path typed for another machine, a floor left behind after the project
moved — than an intention.

So: **warn when no scope matches the project path.** Not an error, because there is a legitimate
reading (an executor deliberately bounded somewhere else entirely, driven by a workflow that only
touches that place), and refusing would make that unexpressible. But it is the one shape worth
saying something about unprompted, and it is what lets §8.2 resolve the input-free question at the
project path without a second rule for when that answer is absurd.

Note where this warning is and is not. Not on "you wrote no root entry" — that is the ordinary safe
case and warning about it would train people to widen tables to silence a warning, which is the
opposite of the point (§3). Here, on "your sandbox does not contain your project", where the config
is probably *wrong* rather than merely narrow.

### 3.2 Globs may be absolute or workspace-relative

`/mnt/c/test/**` and `C:/work/**` are absolute; `code/**` is relative to the workspace root. A call's
path is resolved to absolute before matching, so the two forms compare against the same thing and an
author can write whichever they mean. An absolute sandbox is the more useful form when the point is
to bound the agent to somewhere other than the checkout — which is exactly the case `withinWorkspace`
cannot express, because it only knows about the workspace.

---

## 4. Where this sits in the decision order

`decideToolCall` today is: **profile scope → mode (ledger + authored) → smart → human**. Scoping
inserts one step and changes nothing else:

```
profile scope  →  PATH SCOPE  →  mode (ledger + authored)  →  smart  →  human
```

The two narrowings compose as narrowings: the strictest of the profile's answer and the scope's
answer is the mode that then resolves. A `read-only` profile plus a scope allowing `write_file`
under `app/` still denies the write — a profile is a statement about capability and a scope is a
statement about place, and neither is a licence to overrule the other.

Fortunately the seam already carries what this needs: `decideToolCall(tool, input, opts)` takes the
**input**, so the path is in hand at the point of decision. No signature change; a `scopes` option
and a per-tool path extractor.

---

## 5. The ledger is unchanged, and that is a decision

An approval is remembered per `(tool, run)`, as today. The path plays no part.

This is safe only because of the ordering in §4: the scope resolves *before* the ledger is
consulted, so a remembered allow can satisfy an `ask` and can never upgrade a `deny`. Approving
`edit` in `code/app/` and later editing `infra/x` does not reach the ledger at all — `infra/**`
resolves to `deny`, and deny is not a question.

What it does mean: approving `edit` once in `code/` covers every later `edit` in any scope that
also resolves to `ask`. That is accepted for now. Per-state approval scoping is a plausible later
refinement and is orthogonal to path.

---

## 6. Scopes filter, they do not only refuse

A denied `read_file` is a refusal a model can read and route around. A denied *region* is different:
`glob` and `grep` walk a tree, and returning matches from a denied directory leaks exactly what the
scope exists to withhold, even if a subsequent read is refused.

So the two walking tools apply the table to their results: a path whose resolved mode for that tool
is `deny` is dropped from the walk. Silently — a listing that says "and 12 results were withheld"
tells the model precisely where to aim. The count belongs in the journal, not in the tool result.

This is the one place a permission is enforced inside a tool rather than around it, and it is worth
the exception: the alternative is a gate that refuses reads while a search enumerates the filenames.

---

## 7. Authoring, and what the menu shows

**Two layers, and the floor lives in the executor configuration.** `config.executors.<name>` is
already a TREE whose nodes configure every level (`executorTree.ts`), and a default scope table
belongs there rather than in a standalone key: what an executor is allowed to touch is a property of
that executor, it should inherit down the tree like every other node setting, and putting it beside
`enabled` and `credential` means the screen that configures an executor is the screen that bounds
it. A table at the tree root is the default every route under it inherits; a route may narrow.

A state's `environment.permissions.scopes` then narrows *that*. Narrowing only — a state cannot
widen past the executor's floor, for the same reason it cannot widen past its profile. The two are
resolved SEPARATELY and the stricter answer kept; concatenating them into one table would let a
state's more specific entry outrank the floor's, which is the widening the floor exists to forbid
arriving through the specificity rule that is right within one table and wrong across two.

**And unmatched means different things in the two layers.** The floor is the sandbox, so what it
does not name is refused (§3). A table layered UNDER a floor is a narrowing, and there "says nothing
about this path" has to mean no opinion — otherwise a state adding one `deny` for `infra/` would
refuse every other path in the project, having meant to add a rule rather than replace the sandbox.
A lone table is still a sandbox, so nothing about the single-layer case changes. This was found by
the layering test failing, not by reasoning about it.

The practical shape this gives: an operator bounds `claude-cli` to `/mnt/c/work/**` once, in
settings, and no workflow anyone authors later can reach outside it.

**The menu** gains a scope selector above the category list — the place whose permissions the rows
below are showing, defaulting to `**/*`. Switching it re-reads the same categories against that
scope, so the control people already know is unchanged and gains a subject. Adding a scope is
adding a row to the table; the categories, `Other`, and the app/native axis are untouched by any of
this.

The chip's summary line becomes the count of scopes when there is more than one — `read-only, 3
scopes` — because a permission posture that varies by place cannot be honestly summarised by one
word.

---

## 8. What it costs, and the shortcut that makes it cheap

### 8.1 A scope table COMPILES into the agent's own rules

**Verified against `claude 2.1.142`: its permission rules are path-scoped.** With
`{"permissions":{"deny":["Read(outside/**)"]}}`, a `-p` run refused `outside/b.txt` ("it's outside my
allowed working directory") and read `inside/a.txt` under the same rule without complaint.

So for a delegated agent the table is not only something our callback consults — it is something we
can hand over. Each scope entry becomes `allow` / `ask` / `deny` rules over the agent's *native*
names (the claude executor's own declaration, `CLAUDE_TOOLS`, read in reverse), emitted through the `settings` escape hatch both transports
already carry. Scope enforcement then happens in the agent's own gate, up front, without a
round-trip per call. Our callback stays underneath as the floor for everything the rules cannot
express — `bash` path extraction (§2.2) above all.

Two traps found while testing, both worth writing into the compiler:

- **Precedence is `deny > ask > allow`.** A bare `ask: ["Read"]` beats a scoped
  `allow: ["Read(inside/**)"]`, so a compiled table must be scoped at *every* level rather than
  mixing a bare rule with a specific one. My first test got this wrong and read as "path rules do
  not work".
- The rules govern the agent's **native** tools. Our injected `mcp__dai__*` tools are gated by
  `withPermission` at execution instead, so the two halves need not agree on syntax — only on the
  table they were both derived from.

### 8.2 `modeOf` with no path: resolve at the project path

`ToolGate.modeOf(tool)` answers *without an input* — it is what upstream consults to decide what may
be pre-approved onto the agent's allow-list, and what may be withdrawn up front. Under scoping a
tool has no single mode, so the question needs a path to resolve against.

**The path is the project path.** It is the place the call is about when nothing says otherwise, and
it makes the input-free question a special case of the ordinary one rather than a second rule.

This is not §2.2's multi-path minimum, which is a per-call minimum across the paths ONE call names.
Both take a minimum; they take it over different sets, and only `modeOf` has no set to take it over
until a default path supplies one.

Composed with §8.1, the conservatism I first worried about disappears: the pre-approval carries the
path, so a tool resolving to `allow` at the project path goes on the allow-list **as a scoped rule**
(`Read(/mnt/c/work/**)`), not as a blanket one — and the table's narrower entries ride along as
`ask`/`deny` rules that outrank it by precedence.

`deny` needs no special case either. Upstream treats `modeOf(tool) === "deny"` as *withdraw the tool
entirely* — filtered out of the offered set and added to `disallowedTools` — and that is the right
reading when the project path resolves to `deny`: a tool that may do nothing where the work is is a
tool this run has no use for. The configuration in which that answer is wrong is the one §3.1 warns
about rather than the one this function accommodates.

### 8.3 The rest

- `@declarative-ai/permissions` gains a `scopes` option on `ToolGate` / `decideToolCall`, plus a
  path extractor per tool supplied by the caller (JaiRA knows what its tools take; the permissions
  package should not have to).
- The existing `profiles`/`ProfilePredicate` replacement (`ToolProfile`, already designed in
  `toolVocabulary.ts`) should land first — scoping on top of a predicate that cannot classify an
  agent's built-ins would inherit that hole.

---

## 9. Build order

1. **The table and resolution**, pure and tested, in `shared` beside the vocabulary — glob
   matching, specificity ordering, inheritance, unmatched-denies. No enforcement.
2. **Path-taking tools** (§2.1) — the extractor, the gate option, enforcement for
   `read_file`/`write_file`/`edit`. The narrowest useful slice, and the one that makes
   "read anywhere, write under `app/`" expressible.
3. **The walk filter** (§6) for `glob`/`grep`.
4. **The rule compiler** (§8.1) — the table into the agent's own `allow`/`ask`/`deny` rules, so
   native tools are scoped up front rather than one callback at a time.
5. **Web URL scopes** (§2.3).
6. **`bash`** (§2.2) — last, because it is the least certain and the one whose failure mode is a
   false sense of containment.
7. **The menu's scope selector** (§7), once there is something behind it.

Steps 1–2 are shippable on their own and are most of the value.

---

## 10. Deliberately not in this

- **Per-state approval scoping.** Orthogonal to place (§5), and worth revisiting separately.
- **Content-derived scoping** — "deny any file containing a secret". A permission has to be
  decidable before the read, and that one is not.
- **Constraining a `web_fetch` by what a `web_search` returned.** Tempting and a different
  mechanism: it is taint tracking, not scoping.
- **Scoping the agent's own built-ins directly.** They reach us as native names through the
  permission callback and are asked about by their standard name (`withAgentPermissionSet`, from the executor's declaration), so they resolve through the same table as our tools —
  provided the ask-rules are on (`claudeAskSettings`). That is a wiring question, not a design one.
