---
id: ui/components/executor-tree
type: ui-component
status: shipped
updated: 2026-09-23
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/pick-from-what-exists, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/absence-is-stated]
serves: [product/bring-your-own-models-and-agents, product/share-processes-across-projects]
surfaces: [ui/surfaces/settings-models, ui/surfaces/settings-tools]
reuses: [ui/components/llm-config-form, ui/components/schema-form, ui/components/settings-field, ui/components/switch]
implemented_by: [packages/app/src/renderer/executorTreePane.tsx]
verified_by: []
mockups: [ui/assets/executor-tree/derived.html, ui/assets/executor-tree/rules.html, ui/assets/executor-tree/pinned.html, ui/assets/executor-tree/empty.html, ui/assets/executor-tree/disabled.html]
siblings: [ui/components/provider-row, ui/components/llm-config-form, ui/components/schema-form]
---

# Executor tree

A tall stack of pale blue banners headed `OPERATION`, `ROUTER` and `AGENT`, with indented bands such as `FUNCTIONS`, `PROMPTS` and `ROUTES (3)` behind grey left rules, green and red numbered rule rows, dashed route cards carrying a grey `derived` or green `pinned` chip, and ruled `Around …` disclosures that open onto four numbered step cards.

## The tree shows the whole default executor and pins only the fields a person changes

**Use when.** The thing being configured is a composition that is worked out from what is available: every level of it is drawn expanded, each value reads as derived or pinned, and a change writes only that one field into the layer being edited. On [Settings → Models](../surfaces/settings-models.md) its route cards are the Routes section and the whole tree is the Advanced section's disclosure; on [Settings → Tools](../surfaces/settings-tools.md) its rule list is the reach rules of the functions a workflow calls.

**Do not use when.** One provider or agent is being set up with its key and its check: use [provider-row](provider-row.md). A plain block of settings with no derived values: use [schema-form](schema-form.md) or [settings-field](settings-field.md) rows. Only call settings are edited: use [llm-config-form](llm-config-form.md).

## Each level announces what it is, and the levels nest in the order a call passes through them

- **Banner.** A `--tint-accent` band with `--control-radius` corners and 6px by 9px padding: the level's kind in uppercase app text at 700 in `--accent`, the name of what it builds in dim mono, and a one-line hint in `--dim` that wraps under them when narrow.
- **Bands.** `FUNCTIONS` and `PROMPTS` are indented behind a 2px `--line` rule, and inside Prompts so are `DEFAULT CALL SETTINGS` and `ROUTES ({n})`. `CALL SETTINGS` inside a route carries no rule. Each band has an uppercase `--dim` title and a hint.
- **Functions.** A `Rules` row whose control is the rule list, then `Around every function call`. The rule list sits in the row's right-hand rail of at most 240px, so every rule row and the add row wrap into a narrow column. Drawn under Models, where Tools holds the rules, the row is replaced by `Which functions this executor may reach is Settings → Tools → Functions, the available column.`
- **Rule row.** 1px `--line` border, 5px by 8px padding: an 18px numbered circle, then either the word `everything` or `nothing` in bold mono, or an `allow` or `deny` choice and a mono pattern box; then ghost `↑`, `↓` and a red `Remove`. `everything` and allow rows are on `--tint-ok`, `nothing` and deny rows on `--tint-bad`, a blank rule on `--tint-warn`.
- **Add row.** Ghost `+ everything` and `+ nothing`, an `allow` or `deny` choice, a `— pick a function` list of the built-in functions and the project's agents, a mono box to type a name, and `Add`.
- **Router.** Its banner, `Default call settings` with a mono `Default model` box over an [llm-config-form](llm-config-form.md), `Routes ({n})`, then `Around every routed call`. Drawn under Models, the top router shows `Its defaults and its routes are the Defaults and Routes sections above.` in place of its defaults and routes, which the page draws as sections of their own; a nested router still shows its own.
- **Route card.** `--panel` ground, 1px border with 8px corners, dashed while derived and solid once pinned. One line: the prefix as `{prefix}/…` in bold mono, a one-line summary ellipsised in `--dim`, a chip with a 6px dot reading `derived` in `--dim` on `--panel-2` or `pinned` in `--ok` on `--tint-ok`, and a ghost `Configure` or `Done`. Opened, a rule and the route's own level below.
- **Route level.** An `AGENT` or `PROVIDER` banner, rows for `Agent` or `Provider` which cannot be edited, `Model` and `May only run`, `CALL SETTINGS` over an llm-config-form, and `Around this route's calls`.
- **Step disclosure.** A 1px `--line` rule over a line whose ▶ caret, title and `· {layers}` note sit centred across the row. Open, four cards in fixed order. An off card is `--panel-2` at 72% strength with a grey number and `Add`; an on card is `--panel` with an accent-tinted border, an `--accent` number and `Remove`, and its fields below a rule as a layered schema form, each led by a [switch](switch.md).

## Every state shows the whole tree and changes what is pinned and what is open

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | No route can answer a prompt: `Routes (0)` holds one `--warn` sentence naming the three ways to get one. The rest of the tree still draws. | [empty.html](../assets/executor-tree/empty.html) |
| loading | Cannot occur in the tree: until the startup check has resolved it, the section shows `Not resolved yet — the startup check has not finished.` in its place. | |
| partial | Cannot occur as its own look: a tree with some fields pinned is the pinned state. | |
| error | Cannot occur as its own look: a blank rule is tinted `--warn` in the rules state, and a value the settings refuse is reported by the section. | |
| derived | Nothing pinned: the rule list says `No rules — everything the workflow registers.`, every route card is dashed and `derived`, and every step disclosure is closed with `· no layers`. | [derived.html](../assets/executor-tree/derived.html) |
| rules | The Functions rule list with a baseline, a deny, an allow and a blank rule, the first `↑` and last `↓` inactive, and `SET HERE` on `Rules`. | [rules.html](../assets/executor-tree/rules.html) |
| pinned | A route opened with `Done`: solid border, green `pinned` chip, a summary naming the pinned model and layers, `SET HERE` on `Model`, and its step disclosure open because a layer is on, with Retry's fields below it. | [pinned.html](../assets/executor-tree/pinned.html) |
| disabled | While a settings change is being written: every box, choice, rule button, `Add` and `Remove` at half strength. `Configure`, `Done` and the disclosures still open and close. | [disabled.html](../assets/executor-tree/disabled.html) |

## Every edit pins one field at once, and opening and closing changes nothing stored

| On | Does | Feedback |
| --- | --- | --- |
| Click `+ everything` or `+ nothing` | Appends that baseline rule | A numbered row appears in green or red and `SET HERE` shows on `Rules` |
| Choose a function in `— pick a function` | Appends `allow` or `deny` of it, by the sign chosen beside | A row appears and the list returns to `— pick a function` |
| Type a name, then click `Add` | Appends the typed name or pattern with the chosen sign | A row appears and the box clears. `Add` is inactive while the box is empty |
| Change a rule's sign or pattern | Rewrites that rule | The row's tint follows the sign |
| Click `↑`, `↓` or `Remove` on a rule | Moves or deletes it | The list renumbers. Removing the last rule unpins the list |
| Click `Configure` or `Done` | Opens or closes a route card | The route's level appears under a rule, or goes |
| Type in `Model`, `May only run` or `Default model` | Pins that field in the layer; an emptied box unpins it | `SET HERE` appears or goes, the card turns solid and `pinned`, and its summary follows |
| Change call settings | Pins the call settings of that node | As in [llm-config-form](llm-config-form.md) |
| Click a step disclosure | Opens or closes it | The caret turns a quarter |
| Click `Add` or `Remove` on a step | Pins an empty layer, or unpins the whole layer | The card lights up with its fields, or dims |
| Switch a step field on or off | Pins or unpins that one field | The field's box appears, or `not set` stands in its place |

Every write goes to the layer at once. The open cards and disclosures are not kept: a route card opens closed each time the section draws, and a disclosure opens by itself only when a layer under it is on.

## The copy names each level, then says what its values mean

| Where | String |
| --- | --- |
| Banner kinds and what they build | `Operation` · `OperationExecutor`; `Router` · `PromptRouterExecutor`; `Provider` · `PromptExecutor`; `Agent` · `AgentApiExecutor / AgentCliExecutor / AgentCodexExecutor`; drawn uppercase |
| Banner hints | `The top. Dispatches on the KIND of operation a state runs — a prompt, or a registered function — and holds one executor for each.` · `Dispatches a prompt on its model id's PREFIX. Its routes are derived from everything available, so a provider or agent you set up appears here without being added.` · `One serving route — a remote fleet, a local server, embedded weights — reached through the model router.` · `One agent runtime, answering the prompt by running rather than by returning a completion.` |
| Bands | `Functions` · `Prompts` with `How a prompt state is answered.` · `Default call settings` with `What a state that names nothing is filled in with — applied BEFORE the prefix is read, which is what lets a default reach an agent at all.` · `Routes ({n})` with `Derived from everything available, so a provider or agent you set up appears here by itself. Configuring one pins only what you changed.` · `Call settings` with `Merged under a state's own config.` |
| Rules | `Rules` with `Walked in order, last match winning. Start with a baseline — everything or nothing — then add or subtract. Empty means everything the workflow registers.` · `No rules — everything the workflow registers.` |
| Rule controls | `everything` · `nothing` · `allow` · `deny` · box `name or pattern` · tooltips `earlier`, `later` · `Remove` · `+ everything` · `+ nothing` · `— pick a function` · `{name} — {what it is}` such as `run_command — tool — run a shell command, under the project's policy` · `…or type a name / pattern` · `Add` |
| No routes | `Nothing can answer a prompt here yet — no provider key, no local server, and no agent that runs. Set one up under Connections and a route appears.` |
| Route head | `{prefix}/…` · summary `router over {n} route(s)` or `{kind} {owner} · {model or "its own default"} · only {patterns} · {layers} · {call settings}` · `derived` · `pinned` · `Configure` · `Done` |
| Route fields | `Provider` or `Agent` with `What actually serves the call. Derived from the route this sits under.` · `Model` with `As it knows it — bare, because the route's own name is already the prefix. Empty means the runtime's own default.` and example `the runtime's own default` · `May only run` with `One pattern per line. 'opus' restricts a model; 'openrouter/*' restricts a provider. A state asking for anything else is refused before it runs.` and example `anything` · `Default model` example `left to the state` |
| Step disclosures | `Around the whole executor` · `Around every function call` · `Around every routed call` · `Around this route's calls`, each with `· no layers` or `· {layers joined by " → "}` |
| Step cards | `Memoize` · `Retry` · `Rate limit` · `Deadline`, each with its hint and where it sits, such as `Outermost, so a hit costs nothing else — no slot acquired, no retry loop entered.` · `Add` · `Remove` |
| Step fields | `transient attempts`, `base backoff (ms)`, `max backoff (ms)`, `schema repair`, `window (ms)` and the rest, each unset one reading `not set` or `not set here — inherits {value}` |

## The tree is long and narrow in places, and nothing in it shrinks the page sideways

- Resize: the tree takes the section's width, up to 740px. Banner hints wrap under the kind and build names. Route summaries ellipsise on one line and the head wraps its chip and button when narrow. The rule list stays in a rail of at most 240px at every width, with its controls wrapping one under another. Setting rows stack in a box narrower than 380px.
- Theme: banners, tints, chips, borders and the dimmed cards are tokens in both themes.
- Focus: controls follow the tree top to bottom; the step disclosures announce whether they are open. The route `Configure` button does not announce whether its card is open. Rule rows have no keyboard reordering beyond their `↑` and `↓` buttons.
- Long or missing content: a long pattern or model fills its box and scrolls within it. A route with no model says `its own default`.

## The tree departs from the direction in three places

- An off step card is dimmed by opacity rather than by a colour token.
- Band titles, banners, chips and rule text use size ratios of their own rather than the registers.
- The names of what each level builds are shown as data beside app words in the banner.
