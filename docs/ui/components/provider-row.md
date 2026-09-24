---
id: ui/components/provider-row
type: ui-component
status: shipped
updated: 2026-09-23
realizes: [ux/patterns/checked-status-with-the-fix, ux/patterns/secret-goes-in-never-comes-back, ux/patterns/inherited-unless-set-here]
serves: [product/bring-your-own-models-and-agents]
surfaces: [ui/surfaces/settings-connections]
reuses: [ui/components/icon, ui/components/switch, ui/components/settings-field]
implemented_by: [packages/app/src/renderer/providersPane.tsx, packages/app/src/renderer/integrationsPane.tsx, packages/app/src/renderer/providerSpecs.ts, packages/app/src/renderer/controls.tsx]
verified_by: [packages/app/test/providerSpecs.test.ts, packages/app/test/executorConfig.test.ts]
mockups: [ui/assets/provider-row/status.html, ui/assets/provider-row/open.html, ui/assets/provider-row/dirty.html, ui/assets/provider-row/disabled.html]
siblings: [ui/components/executor-tree, ui/components/settings-field, ui/components/status-pill]
---

# Provider row

A row of a settings card in three columns: on the left a vendor mark with a small coloured dot on its corner, the name, and one dim sentence that starts with `ready`, `not working`, `not set up`, `turned off`, `not signed in` or `not checked`; in the middle, right-aligned, a box per credential it connects with — a login, an account, a stored key — and a dashed + box that adds one; on the right an on-off switch and a chevron.

## A provider row is one thing this machine can connect to, with its last check and who it connects as

**Use when.** One agent, model API, local model route or forge connection is listed with what its last check found, who it connects as, a switch to stop using it in the layer being edited, and its settings behind a chevron. Every row of [Settings → Connections](../surfaces/settings-connections.md) is one.

**Do not use when.** The thing is a route that decides which provider answers a call: that is a route card in [executor-tree](executor-tree.md). The status is a run's or a task's: use [status-pill](status-pill.md). A setting stands on its own outside a provider: use [settings-field](settings-field.md).

## Identity and state read on the left, credentials in the middle, and the settings wait behind the chevron

- **Head.** A 20px mark holding the vendor's logo or initial, drawn by [icon](icon.md), with an 8px dot on its top-left corner ringed in `--bg`: `--ok` ready, `--bad` not working, `--warn` not set up or not signed in, `--dim` turned off or not checked. Then the name at 600 in the app face.
- **Sentence.** Indented 30px to sit under the name. The state word in `--text`, or `--bad` when not working, then ` — ` and the check's detail in `--dim`. A fix, when there is one, takes its own line in `--accent` starting `→`. An agent's version sits under it in mono `--dim` when the check reported one.
- **Boxes.** 158px each, 8px apart, right-aligned and wrapping. A login box is an agent's account: its initial, the account, its plan and how it signed in, and `Log out`; a forge's account box carries `OAuth` or `token` and `Disconnect`; a key box is a lock, the secret's name in the data face and where it was found, tinted `--tint-bad` when it is not found anywhere. The + box is dashed and last: `Sign in` or `Switch account`, `Add a key` or `Replace the key`, `Sign in with {forge}`, each with a smaller second way in or a note under it. A runtime that uses no key draws no key box.
- **Controls.** A [switch](switch.md) and a quiet chevron in their own column, so the boxes line up down a card.
- **Across the row.** The key or token entry, opened from a + box, and whatever the provider found — a local server's answering ports, embedded weights with their files — take the row's full width under the three columns.
- **Body, when open.** Indented under the name, 12px between parts: the provider's one-line description, then one band per level of what it is, such as `AGENT PROVIDER`, `CLI AGENT` and `CODEX`. The second and third bands are indented behind a 2px `--line` rule. Each band holds [settings-field](settings-field.md) rows, then the empty-box note, a problem line when there is one, and `Save`, `Revert` and, for a generic CLI, `Remove`.
- **Ground.** The card's, with a `--line` hairline between rows.

## Every state keeps the head and changes the dot, the words and what opens below

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a row exists only for a provider or agent this machine knows. A group with none is an empty list drawn by the section. | |
| partial | Cannot occur: a row with no version, no detail or no fix leaves those parts out and draws the rest whole. | |
| status | The check results side by side; `not signed in` reads as `not set up` does, with its fix. `not checked` is the loading look, with a `--dim` dot and the word alone. `not working` is the error look, `--bad` dot and word with the detail and the fix. `ready` is the success look, with the version where there is one. `not set up` has a `--warn` dot. `turned off` dims the name and the mark to 55%, hides the detail and the fix, and shows the switch off. | [status.html](../assets/provider-row/status.html) |
| open | The chevron turned over, the body below the sentence with its level bands and fields. Fields this layer states carry a `SET HERE` tag; empty ones show the inherited value as placeholder. `Save` and `Revert` are inactive until something is typed. | [open.html](../assets/provider-row/open.html) |
| dirty | A field has been typed in: `Save` filled and `Revert` active. A value that cannot be written leaves the layer unchanged and puts its reason in `--warn` above the buttons. | [dirty.html](../assets/provider-row/dirty.html) |
| key entry | The + box gives way to an entry across the row: what the value is filed under, a `Secret name` field when no name is known, a masked value field, a choice of store, `Store the key` and a ghost `Cancel`. | |
| signing in | The + box waits: a spinner, `Finish in your browser`, how to finish by hand, and `Cancel`. A refused login's own box shows `Sign in again` and then waits the same way. | |
| disabled | While a settings change is being written: the switch, every field, `Save` and every box button at half strength. The chevron still opens and closes. | [disabled.html](../assets/provider-row/disabled.html) |

## Each control writes to the layer being edited, and the next check shows the result

| On | Does | Feedback |
| --- | --- | --- |
| Click the switch | Turns the provider off in the layer being edited, or removes that override so it is used again | The knob moves; turned off, the name and mark dim and the sentence reads `turned off`; turned on, the check's result returns once the checks rerun |
| Click the chevron | Opens or closes the settings | The chevron turns over in 120ms and the body appears or goes. Typing in a closed body is kept |
| Type in a field | Holds a draft in this row | `Save` fills and `Revert` becomes active |
| Click `Save` | Writes only the fields that changed to the layer; an emptied box removes that setting from the layer | `SET HERE` tags follow the layer and the checks rerun. A malformed value writes nothing and shows its reason above the buttons |
| Click `Revert` | Puts back the saved values | The buttons go inactive and any problem line clears |
| Click `Remove`, generic CLI only | Deletes that CLI from the layer being edited | The row disappears |
| Click `Add a key`, `Replace the key` or `or an API key` | Opens the key entry across the row | The + box goes while the entry is open |
| Click `Sign in` or `Switch account` | Runs the agent's own login in the browser | The + box waits; the login appears as a box when it reports |
| Click `Log out`, then `Log out` again | Runs the agent's own logout, which is machine-wide | The login box goes |
| Click `Store the key` | Checks the name, sends the value to the chosen store, writes the name into the layer | The entry closes and the key box and sentence change when the next check reports. A bad name keeps the box open with its reason under the buttons; a store that fails is reported by the [error-notice](../surfaces/error-notice.md) after the box has closed |
| Click `Cancel` | Closes the entry | The typed value is discarded |

Leaving the section or switching the layer closes every row and drops unsaved typing without a prompt. Escape closes nothing.

## The copy states what the check found, then how to fix it

| Where | String |
| --- | --- |
| State words, also the dot's tooltip | `ready` · `not working` · `not set up` · `turned off` · `not checked` · `not signed in`; `sign-in expired` when a login was refused |
| Sentence | `{state word} — {detail}`, then `→ {fix}` on its own line; `turned off` alone |
| Details and fixes, examples | `'ANTHROPIC_API_KEY' resolves` · `no value was found for 'OPENROUTER_API_KEY'` with `→ store a key under OPENROUTER_API_KEY, or turn this route off` · `'claude' responded — it signs itself in, so no key is needed` · `no server URL is configured, so nothing is served on this route` with `→ set a server URL — http://localhost:11434/v1 for Ollama, http://localhost:1234/v1 for LM Studio` |
| Names | `Anthropic` · `OpenRouter` · `Local server` · `Embedded weights`; an agent is named by its registry name, such as `claude-cli` or `codex-cli`; a forge as `{GitLab or GitHub} · {host}` |
| Switch, tooltip and announced | `stop using {name} in this project` · `use {name} again` |
| Chevron | tooltip `Configure` · `Done`; announced `configure {name}` · `hide {name}'s settings` |
| Descriptions | `Claude models, billed to an API key. Serves every model id starting anthropic/.` · `One key for many vendors. Serves every model id starting openrouter/.` · `An OpenAI-compatible server on this machine — Ollama, LM Studio, llama-server, vLLM.` · `GGUF weights loaded into this process. Needs the optional node-llama-cpp package.` |
| Level bands | `API provider` · `Local server` · `Embedded weights` · `Agent provider` · `CLI agent` · `Claude CLI` · `Codex` · `A generic CLI` · `In-process SDK` |
| Level with no fields | `Nothing to configure at this level.` |
| Empty-box note | `An empty box removes the setting from this layer, so it goes back to whatever the other layer or the built-in default says.` |
| Empty field placeholder | `{inherited value} (inherited)`, else the field's own example, else `—` |
| Buttons | `Save` · `Revert` · `Remove` with tooltip `delete this CLI from the layer being edited — a built-in can only be turned off` |
| Problems | `'{name}' is not a usable secret name — it NAMES the key (like ANTHROPIC_API_KEY), it does not hold it` · `{label} is not valid JSON: {reason}` · `{label} must be a JSON object` · `'{line}' is not a NAME=value line` |
| Key box | `{NAME}` · `in {source}`, sources such as `OS keychain`, `project .jaira/.env.local`, `shared .env.local`, `environment variable` · `not found anywhere` |
| + box | `Sign in` · `Switch account` · `opens the sign-in page` · `signs in as someone else` · `or an API key` · `Add a key` · `Replace the key`, with the secret's name, `usually none` or `name it, then paste it` under it |
| Login box | `{Plan} plan` · `via {method}` · `in use` · `refused` · `The last run's call was refused: {reason}` · `Sign in again` · `Log out` · `Sign {binary} out on this computer? Its terminal sessions lose this login too.` · `Keep` |
| Key entry | `Replaces the value of {NAME}.` · `Storing one also writes the name {NAME} into this layer, so it is actually looked up.` · `Store the key` · `Cancel` · `Secret name` with hint `What this key is filed under. Config stores this NAME; the value goes to the store you pick below.` and example `LOCAL_API_KEY` · value placeholder `the value of {NAME or "the secret"} — empty clears it` |
| Stores | `OS keychain (encrypted)` where the machine has one · `this project's .jaira/.env.local` with a project open · `the shared root's .env.local` |

## The row keeps its head on one line and lets the sentence wrap

- Resize: the row fills the card, which stops at 740px. The boxes wrap onto another line, still right-aligned, before the left column gives up its words; the switch and chevron never shrink. The sentence wraps anywhere, even inside a URL. Fields keep their control on a right-hand rail of 140px to 240px and stack into one column when the body is narrower than 380px.
- Theme: the dot, words, fix and grounds are tokens. Vendor logos keep their brand colours, so the near-black Anthropic and OpenAI marks all but vanish on the dark ground.
- Focus: each box's buttons, the switch, the chevron, then in an open body each field, `Save`, `Revert` and `Remove`; in the key entry the name, the value, the store, `Store the key` and `Cancel`. The chevron announces whether it is open. The dot is hidden from screen readers and the state word is read in the sentence. The switch names this project even while the shared layer is being edited. The masked value and the store choice have no names of their own.
- Long or missing content: a long detail wraps under the name, and a long account name ellipsises in its box. A provider with no key use shows no key box.

## The row departs from the type registers in three places

- The name, the sentence and the boxes use size ratios of their own rather than the registers.
- An agent's registry name is data but is set in the app face.
- A turned-off row dims its name and mark by opacity rather than with a colour token.
