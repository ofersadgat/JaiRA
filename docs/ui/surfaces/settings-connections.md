---
id: ui/surfaces/settings-connections
type: ui-surface
status: shipped
updated: 2026-09-23
kind: screen
realizes: [ux/patterns/checked-status-with-the-fix, ux/patterns/inherited-unless-set-here, ux/patterns/secret-goes-in-never-comes-back, ux/patterns/name-it-where-it-will-live, ux/patterns/verbs-on-the-thing-itself, ux/patterns/absence-is-stated]
serves: [product/bring-your-own-models-and-agents, product/share-processes-across-projects, product/review-changes-before-they-land]
components: [ui/components/provider-row, ui/components/settings-header, ui/components/switch, ui/components/settings-field, ui/components/schema-form, ui/components/icon]
mockups: []
siblings: [ui/surfaces/settings-view, ui/surfaces/settings-models, ui/surfaces/settings-tools]
---

# Settings connections

The Connections page of the [Settings view](settings-view.md): everything JaiRA can reach and who it reaches it as — the agents that answer by running, the model APIs that answer for a key, the models that run on this machine, the MCP servers whose tools an agent can call, and the forges a review can be opened on — as five sections of [provider rows](../components/provider-row.md), each row with its last check on the left and its credentials as boxes on the right. It is the second page in the Settings list and the page Settings opens on the first time after launch.

## The page is five sections, in the order a person sets them up

- **Head.** `Connections`, the lead `What JaiRA can reach, and as whom.` followed by the layer sentence, and the [layer switch](../components/settings-header.md) at the head's top-right.
- **Agents.** The built-in `claude-code`, `claude-cli` and `codex-cli`, then every agent program registered in either layer, named as registered. The section head carries, at its right edge, when the checks last ran in `--dim` and a ghost `Re-check`. The card ends in a closed `Add an agent CLI` disclosure, `· any other coding-agent binary`: a hint, `Registry name` and `Command` as [settings fields](../components/settings-field.md), and `Add it`.
- **Model APIs.** `Anthropic` and `OpenRouter`.
- **Local models.** `Local server`, with the servers the usual ports answered listed under it, and `Embedded weights`, with each named weights file and whether it is there.
- **MCP servers.** One row per server any layer configures, named as configured, then an `Add a server` row, and under it the servers other tools on this machine already run. The section head carries, at its right edge, when the servers were last asked for their tools and its own `Re-check`.
- **Forges.** `GitLab · gitlab.com` and `GitHub · github.com`, then every connection either layer adds, then an `Another host` row whose only box adds one.

Each section is a quiet sentence-case heading with an `ⓘ` over one bordered card of rows, at most 740px wide.

## Every row is what it is on the left, who it connects as in the middle, and its switch on the right

- **Left.** The vendor mark with its status dot, the name, then one sentence: the state word, ` — ` and what the check found, and `→ {fix}` on its own line in `--accent`. An agent's version sits under it in the data face.
- **Boxes.** 158px each, 8px apart, right-aligned and wrapping as the row narrows; the switch and chevron keep one column, so the boxes line up down a card.
  - **A login.** An agent's account: its initial in a mark, the account, its plan, `via {method}` and its organisation where they add to the name, and `Log out`. With several logins the one in use carries an `in use` tag and an outline. A login a run's call was refused on carries a `refused` tag, `The last run's call was refused: {reason}` and a filled `Sign in again`.
  - **A forge account.** The account the token belongs to, tagged `OAuth` or `token`, its scopes, the secret it is filed under and where it was found, and `Disconnect`.
  - **A stored key.** A lock mark, the secret's name in the data face, and `in {store}` or `not found anywhere`; a key that is named and not found is tinted `--tint-bad`. An MCP server's secret says where it is sent first — `env {KEY}` or `header {KEY}`.
  - **The + box.** Dashed, last: `Sign in` or `Switch account` for an agent, with `or an API key` under it where the agent also takes one; `Sign in with GitLab` or `Sign in with GitHub` with `or paste a token` for a forge; `Add a key` or `Replace the key` with the secret's name for a model API; `Store a secret` with the names it is sent under for an MCP server that names one; `Add a server` · `a name, and a command or an address` on the last MCP row. An agent that takes no key and has nobody signed in reads `Sign in` · `opens the sign-in page`.
- **Right.** A [switch](../components/switch.md) that stops using the row in the layer being edited, and a chevron that opens its settings across the row.
- **Across the row.** The key or token entry, opened from a + box; the local servers; the weights; the servers other tools run; the opened settings.

The local servers are a bordered table under `Asked the usual ports for a model list (GET /v1/models)` · `when this page opens, and on Re-check`: one line each for `Ollama` (11434), `LM Studio` (1234), `llama.cpp server` (8080), `vLLM` (8000) and `Jan` (1337), a dot green while it answers, its address, and the models it lists, `no models loaded` or why nothing answered. The server the route points at carries `in use`; any other that answers offers `Use`.

The weights are rows of a model id, the `.gguf` path in `--dim`, and `found · {size}` in `--ok` or the reason the file is missing in `--bad`, with `Remove`; a last row takes a new model id and path with `Add`. When the loader is not installed, a `--warn` line above them says so.

An MCP server's row says `ready` — `stdio · {command} · {n} tools` or `HTTP · {address} · answered with {n} tools` (`SSE` for an older server) — `failed` with the reason and `→ {fix}`, `not started` for one waiting for a secret, `not checked` before the first answer, or `turned off`. Opened, its settings are the [schema form](../components/schema-form.md) for how it is reached — `command`, `arguments`, `environment` and `working directory` for a server JaiRA starts, `address` and `headers` for one it calls — each value a string or the name of a stored secret, then `Remove`. `Add a server` opens the same form with `name`, `command`, `arguments` and `address`, and `Add it`. Under it, a bordered table headed `Servers other tools on this machine already run` · `read when this page opens — none is started`: one line per place looked — Claude Code's own list and this project's entry, `.mcp.json`, Claude Desktop, Cursor, VS Code, Figma's Dev Mode port — with where it is and the servers it lists, and `Add` or `Add {n}` for the ones not configured yet, `added` once they all are.

## The page shows the last checks, a sign-in waiting on the browser, an entry open, or that it cannot read

| State | Surface shows |
| --- | --- |
| listing | Every row with its last check, a login box per signed-in account, key boxes where a secret is named, and the + boxes. |
| loading | Not a look of its own: until the startup check reports, a row reads `not checked` with a `--dim` dot and the Agents head reads `not checked yet`; after `Re-check` the button reads `checking…`. |
| signing in | The agent's or forge's + box turns into a waiting box: a spinner, `Finish in your browser`, `Nothing opened? Run {login command}.` for an agent or `Enter {code}` for a forge, and `Cancel`. A refused login signing in again shows the same inside its own box. |
| entry open | A + box's entry spans the row under it: what the value is filed under, a masked value, the store, then `Store the key` or `Store the token` and `Cancel`. A key with no conventional name first asks for `Secret name`. |
| refused sign-in | A login box in the warning look with the reason and `Sign in again`; the row's sentence reads `sign-in expired`. |
| forge sign-in refused | The reason and its fix in `--warn` across the row, such as the OAuth app it needs. |
| just you | On `Just you` · `What you changed`: only the agent, model, local, MCP server and forge rows the personal layer states, and no agent CLI, MCP server or forge host to add. |
| writing | While a settings change is being written: every switch, box button, field and `Add it` at half strength and inert. Chevrons and the disclosure still open and close. |
| error | The settings cannot be read: `The configuration could not be read.` in `--dim` in place of each section's rows. |
| empty | Cannot occur: the built-in agents, the two model APIs, the two local routes and the two built-in forges are always listed. MCP servers with none configured holds only `Add a server` and the servers other tools run. |

| Where | String |
| --- | --- |
| Section heads | `Agents` · `Model APIs` · `Local models` · `MCP servers` · `Forges` |
| Section notes, behind `ⓘ` | `They answer by RUNNING — reading files, executing commands — on their own subscription or key. A model id's prefix names one: claude-cli/sonnet.` · `They return a completion for a key. A model id's prefix names one — anthropic/claude-sonnet-5 goes to the first of these.` · `What runs on this machine: an OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM, Jan), found by asking the usual ports for a model list, and GGUF weights loaded into JaiRA itself.` · `Servers whose tools an agent can call: a command JaiRA starts, or a URL it calls. Every agent run is handed the ones that are on, and a permission set says what each of their tools may do (Settings → Tools).` · `Where a review can also be opened as a merge request. A project's git remote picks the connection by host.` |
| Check age | `not checked yet` · `checked just now` · `checked {n} min ago` · `checked {n} h ago` · `Re-check` · `checking…` |
| State words | `ready` · `not working` · `not set up` · `turned off` · `not checked` · `not signed in` · `sign-in expired` |
| Login box | `{Plan} plan` · `via {method}` · `in use` · `refused` · `The last run's call was refused: {reason}` · `Sign in again` · `Log out` |
| Log out, asked in place | `Sign {binary} out on this computer? Its terminal sessions lose this login too.` · `Log out` · `Keep` |
| + boxes | `Sign in` · `Switch account` · `opens the sign-in page` · `signs in as someone else` · `or an API key` · `Add a key` · `Replace the key` · `usually none` · `name it, then paste it` · `Sign in with GitLab` · `Sign in with GitHub` · `or paste a token` · `Add a host` · `host, kind and a token` |
| Waiting | `Finish in your browser` · `Nothing opened? Run {command}.` · `Enter {code}` · `Finish signing in in your browser` · `Cancel` |
| Key entry | `Replaces the value of {NAME}.` · `Storing one also writes the name {NAME} into this layer, so it is actually looked up.` · `the value of {NAME} — empty clears it` · `Store the key` · `Cancel` |
| Token entry | `Filed under {NAME}.` · `Store the token` · `Cancel` |
| Forge account | `OAuth` · `token` · `{NAME} · {store}` · `Disconnect` |
| Local servers | `Asked the usual ports for a model list (GET /v1/models)` · `when this page opens, and on Re-check` · `no models loaded` · `not running` · `in use` · `Use` |
| Weights | `No weights named yet — add a model id and the .gguf it loads.` · `found · {size}` · `file missing` · `not checked` · `Remove` · placeholders `model id` · `/models/name.gguf` · `Add` · `{module} is not installed, so no weights can be loaded — {reason}.` |
| MCP servers | `ready` · `failed` · `not started` · `not checked` · `turned off` · `stdio · {command} · {n} tools` · `HTTP · {address} · answered with {n} tools` · `not asked yet` · `Store a secret` · `env {KEY}` · `header {KEY}` · `Filed under {NAME}.` · `the value of {NAME} — empty clears it` · `Store the secret` · `Remove`, titled `delete this server from the layer being edited` · switch `stop handing {name} to agents` · `hand {name} to agents again` |
| Add a server | `Add a server` · `not set up — a command JaiRA starts (stdio), or a URL it calls (HTTP)` · `a name, and a command or an address` · `Add it` · `Cancel` · `give the server a name` · `there is already a server called '{name}'` |
| Other tools' servers | `Servers other tools on this machine already run` · `read when this page opens — none is started` · `Add` · `Add {n}` · `added` |
| Another host | `Another host` · `not set up — a self-hosted GitLab or GitHub Enterprise` · `Add it` · `Cancel` · `give the connection a name` · `there is already a connection called '{name}'` |
| Add an agent CLI | `Add an agent CLI` · `· any other coding-agent binary` · `Registry name`, hint `How a workflow will name it.` · `Command`, hint `The executable, or a full path.` · `Add it` |
| Unreadable | `The configuration could not be read.` |

## A person arrives from the sidebar, and every change but a typed value is written at once

- `Connections` in the sidebar shows this page with the last check results and running no check; the local ports and the weights files are asked each time it opens, on `Re-check`, and after a settings write. The MCP servers are asked for their tools when the page opens and whenever the settings change, answered from main's cache unless the servers' block changed, and started over on the section's own `Re-check`; the other tools' lists are read, and nothing they name is started.
- A switch writes `enabled: false` into the layer being edited, or removes it. `Use` on a local server writes that server's address as the route's URL.
- `Sign in` runs the agent's own login in the browser and the box waits until it reports; the new login appears as a box. `Log out` runs the agent's own logout, which is machine-wide, after the question in the box.
- `Sign in with GitLab` or `Sign in with GitHub` starts the forge's device sign-in: the page opens at the forge, the box shows the code to type there, and the account box appears once the token is stored. gitlab.com and github.com sign in through JaiRA's own apps; any other host needs an OAuth app registered there, whose client ID goes in the connection's `sign-in app` field (`integrations.forges.<name>.oauthClientId`, under the row's chevron). Without one the row says so and `or paste a token` is the way in.
- An MCP server's switch writes `enabled: false` into the layer being edited, or removes it; `Add it`, `Add` on another tool's servers, a field of an opened server and `Remove` write the server into, or delete it from, the layer being edited. `Store the secret` stores the value and asks the servers again, since one waiting for it may start now.
- `Store the key` and `Store the token` send the value to the chosen store and never show it again; with no name configured, the name is written into the layer as well.
- `Re-check` runs every check again, and every row and box takes its new result.
- Switching the layer redraws the page from that layer and closes every open row and entry, discarding their typing.

## The page keeps its width, wraps its boxes, and holds nothing typed across a visit

- **Resize.** Sections stop at 740px. Boxes wrap onto a second line, still right-aligned, before the left column gives up its words; the sentence wraps anywhere.
- **Theme.** Dots, tags, box grounds, the dashed + box and the probe table are tokens in both themes. Vendor logos keep their own colours.
- **Focus.** Nothing takes focus on entry. Tab moves down the rows: each box's buttons, then the switch and the chevron, then anything open across the row.
- **Unsaved work.** A row's opened settings, a key, token or secret being typed, and the `Add an agent CLI` and `Add a server` boxes are dropped on leaving the page or switching the layer, without a prompt.

## The page departs from the direction in its logos and a registry name

- Vendor logos keep their brand colours, so the near-black Anthropic and OpenAI marks all but vanish on the dark ground.
- An agent's registry name is data but is set in the app face.
