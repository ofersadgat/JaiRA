---
id: engineering/decisions/0009-self-updating-catalog
type: decision
status: accepted
updated: 2026-09-24
decides_for: [engineering/units/model-routing, engineering/units/agent-executors]
---

# 0009. The model catalog updates itself, one refresher per route

## Context

The catalog (`@declarative-ai/llm/model-catalog`, `ModelInfo`) was designed as a table the client keeps
current. It is keyed by `${route}/${model}`, has `upsert`/`remove`/`load`, and `refreshModelCatalog`
returns "the full row set — what the caller persists to the `models` table". Nothing calls any of that
at runtime. Every launch starts from the committed snapshot (`model-catalog-data.generated.ts`), which
only a developer running `npm run update:model-info` can change. That script scrapes Anthropic's docs
pricing page and is unreliable.

What that leaves behind:

- **Hand-written stand-ins for missing rows.** `AHEAD_OF_CATALOG` (`runtime/src/modelRoutes.ts`) lists
  models the snapshot doesn't have yet: `claude-opus-5-5`, `claude-fable-5-1` and `gpt-5.6-*`.
- **Parameters are names only.** `supportedParameters` / `requiredParameters` are string arrays in
  OpenRouter's naming. They say a model takes `reasoning`, never which levels. So the effort levels are
  hand-coded in four places:
  - `REASONING_EFFORTS` (duplicated in shared and llm)
  - `llmConfigForm.tsx`
  - `operationFields.tsx` (missing `xhigh`)
  - `composer.tsx`
- **Agent routes have no rows.** `claude-cli`, `claude-code` and `codex-cli` borrow the vendor's API
  rows, but a CLI and an API accept different things for the same model.
  - The CLI takes `--effort max`.
  - `codex exec` has no reasoning channel. So the built-in `coder` and `planner` presets
    (`effort: high`) are refused on a codex-only machine (`codexRefusal`).
- **Local routes have rows only on paper.** `discoverLocalServers` lists a local server's model ids for
  Settings only. `catalogRowForGguf` builds an embedded row from a GGUF header but has no caller.
- **`schemaProfile` is not this.** It describes only how a transport handles a JSON Schema for
  structured output. It says nothing about effort levels or context windows.

What every route can report about itself, checked live on 2026-09-24:

| Route | Source | What it gives |
|---|---|---|
| `openrouter` | `GET openrouter.ai/api/v1/models`, public | ~460 models: prices, including the 1h cache write and long-context `overrides` tiers; `context_length`; `supported_parameters`; and a `reasoning` object per model with `supported_efforts`, `default_effort` and `mandatory` |
| `anthropic` | `GET api.anthropic.com/v1/models`, needs a key | Per model: `max_input_tokens`, `max_tokens`, and `capabilities`. Capabilities include the effort levels, thinking types (Opus 5.5 is `adaptive` only, so it can't take `budgetTokens`) and `structured_outputs`. No prices. |
| `openai` | `GET api.openai.com/v1/models`, needs a key | Ids only |
| `claude-cli`, `claude-code` | The SDK's initialize response `models: ModelInfo[]`, from the binary the route runs. Spawns `claude`, sends no prompt. | Per entry: `value`, `resolvedModel`, `supportedEffortLevels`, `supportsFastMode`. The SDK's bundled 2.1.223 resolves aliases (`default` → `claude-opus-5[1m]`). The installed 2.1.142 returns bare aliases, and its `sonnet` lacks `xhigh`. |
| `codex-cli` | `codex app-server`, JSON-RPC `model/list`. Works on 0.147. | Per model: `supportedReasoningEfforts` with a description per level (including `max` and `ultra`), `defaultReasoningEffort`, `inputModalities`, `serviceTiers` |
| `local` | `GET {baseURL}/models` (the existing `discoverLocalServers`) | Ids only |
| `embedded` | The GGUF header (the existing `catalogRowForGguf`) | Context length, quantization, weights size. Price 0. |

Two traps these results expose:

- **A CLI's list is only its picker menu, not everything it can run.** Neither CLI lists
  `claude-opus-5-5`, yet both accept it by id. So "not listed" must not mean "refused".
- **OpenRouter's `anthropic/*` prices match the docs scrape exactly** on input, output, cache-read and
  5-minute write. The scrape is redundant.

pingdotgg/t3code solves the neighbouring problem with a model manifest its maintainers hand-edit and
every client downloads from their `main` branch. The person ruled that out: the client updates itself
from the sources above and never waits on a manifest someone publishes.

## Options

| Option | For | Against |
|---|---|---|
| A. A hand-published manifest the client downloads (t3code) | One file to fix a model's data. Works offline via a bundled copy. | Someone must publish every change. Duplicates facts each route already reports. Ruled out. |
| B. Keep the string arrays, add a `reasoningEfforts` field | Small change | One field per question: next it's budgets, service tiers, fast mode. Nothing a form or validator can use directly. |
| C. One JSON Schema per row describing the params it accepts and their values; every route refreshes its own rows | SchemaForm draws the settings; the validator checks a config against the model; one mechanism covers effort, budgets and anything later | Every consumer of `supportedParameters` moves. The generated snapshot gets heavier. |

## Decision

**C.** The deciding reason: a schema is what the rest of the system already speaks. SchemaForm draws it,
the validator checks it, and the config search enumerates it. A per-question field would need its own
code at each of those.

### 1. `parameters`: one JSON Schema per row

`parameters?: JsonSchema` replaces `supportedParameters` and `requiredParameters`. It is an object schema
whose property names are **`LlmCallConfig` fields**, not wire names:

- `temperature`, `topP`, `topK`, `stopSequences`, `seed`, `maxOutputTokens`
- `reasoning: { effort, budgetTokens }`

Each source's names are translated once, when its rows are imported (`WIRE_PARAMETER_NAMES`, built as
`parametersFromNames`). Because the names match, the schema validates the config an author writes, and
SchemaForm draws the call settings straight from it.

`response_format` and `structured_outputs` are not call parameters. They move to their own row field,
`structuredOutput: "schema" | "object" | false`, which is what the structured-output profile is
derived from (`profileForCaps`).

- **A listed property is accepted,** and its schema says what it may be. For example
  `reasoning.effort: { enum: [...], default: "high" }`, or `maxOutputTokens: { maximum: 128000 }`.
- **An unlisted property is not accepted** (`additionalProperties: false`).
- **`{}` means accepted, values unknown.** This is all a name-only source (OpenRouter's
  `supported_parameters`, a local server) can say. An effort whose levels are unknown is
  `{ type: "string", examples: [...] }`: SchemaForm offers the usual levels as suggestions without the
  schema claiming the model takes all of them.
- **`required` holds mandatory parameters.** For example, OpenRouter's `reasoning.mandatory`.
- **Absent `parameters` means unknown.** The row accepts everything, as an unknown row does today.

### 2. Every route has its own rows

The route part of the key widens from `ModelRoute` to any route name, so there are rows such as
`claude-cli/claude-opus-5`, `codex-cli/gpt-5.6-terra`, `local/qwen3-32b` and
`embedded/qwen3-32b-q4_k_m`. A row describes what **that transport** accepts, as that transport reports it.

- **Prices are joined by `canonicalId`.** A row without its own price takes one from the API row with the
  same `canonicalId`. Agent routes need this to price API-key-billed usage.
- **CLI rows are keyed by the id the CLI takes.** Where the CLI resolves an alias, the key is
  `resolvedModel`, and the alias is kept in `aliases`. `[1m]` variants are their own rows, since their
  context window differs. An old CLI that returns only aliases gets alias rows, with no `canonicalId`
  and so no joined price.

### 3. One refresher per route, beside its transport

Each refresher is a `CatalogSource` (`fetchRows(): Promise<ModelInfoInterface[]>`) for its route. It
lives next to the code that runs the route, since that code knows how to reach it:

- **In `llm`:**
  - `makeOpenRouterSources` is two sources over one fetch: OpenRouter's own rows, and `nativeMirrors`,
    its `anthropic/*` and `openai/*` rows restated as the native routes.
  - `makeAnthropicModelsSource` reads `/v1/models`.
- **In `agents-cli`:**
  - `claudeModelsSource` reads claude's `initialize` answer from the binary the route runs: the
    installed `claude` for `claude-cli`, the SDK's bundled one for `claude-code`.
  - `codexModelsSource` reads `app-server`'s `model/list`.
  - Both refreshers sit beside the usage probe that makes the same no-prompt exchange.
- **In JaiRA's runtime:** `local` and `embedded`, around the existing `discoverLocalServers` and
  `catalogRowForGguf`.

As built (2026-09-24):

- **No OpenAI `/v1/models` source.** It returns ids only, TTS, Whisper and image models among them, and
  OpenRouter's `openai/*` mirrors carry strictly more: prices, levels, context.
- **Sources MERGE rather than replace.** A row's fields come from whichever source states them, in the
  order the sources run.
  - The mirrors FILL (`CatalogSource.fills`): they refresh a row's prices and supply what it lacks, and
    never overwrite what Anthropic's own list said. A refresh that cannot reach Anthropic keeps its
    capabilities.
  - OpenRouter states every rate it charges. So a cached read with no write is recorded as a write of
    0, which is how OpenAI's caching works, instead of Anthropic's 1.25× default.
- **Rates are optional on a row.** An agent row, or a model a provider lists before any price source
  does, is priced by the row with the same `canonicalId` that has rates (`ModelInfo.pricedRow`).
  - The native route wins over OpenRouter's relay.
  - A `local` row prices nothing but itself.
  - `canonicalIdFor` drops a snapshot date and claude's `[1m]` mark, so `claude-cli/claude-opus-5[1m]`
    and `anthropic/claude-haiku-4-5-20251001` join their API rows.
- **An agent's reasoning is fitted too.** `AgentExecutor` fits the call's request against the agent's
  row, as the API path does, so a level above what `claude` or codex reported is clamped before the
  binary could refuse it.

`refreshModelCatalog` keeps its rule: a source that fails to fetch, parse or validate is skipped, and
the rows it wrote before stand.

**The Anthropic docs scrape is deleted, and so is the hand-written seed** (`CORE_SEED_MODELS`).
`update:model-info` runs the provider sources (OpenRouter, and Anthropic's list when
`ANTHROPIC_API_KEY` is set) over the current snapshot to regenerate it. That snapshot is now only the
first-launch and offline seed.

### 4. JaiRA keeps the table in the database and refreshes it

- **Where it lives.** A `models` table in the shared project's database, `~/.jaira/system/jaira.db`.
  That is the database JaiRA's own runs already use, and models are a fact about the machine, not a
  project. Ruling of 2026-09-24: the table belongs in the database, not in a JSON file.
  - The catalog code's comments already speak of "the `models` table", but no such table existed. The
    comments came from the app declarative-ai was extracted from.
  - The table is a new `CREATE TABLE IF NOT EXISTS` in `SCHEMA`. A new table needs no migration step.
  - One row per `${route}/${model}` key: the row as JSON, the route, the source that wrote it and when.
  - At startup it is loaded into `ModelInfo.instance` over the seed. Every refresh upserts it.
- **When routes refresh.** Each route refreshes in the background:
  - at startup
  - daily
  - when something that changes its answer happens: a sign-in or key change, a CLI whose `--version`
    changed, Re-check on local servers, weights finishing a download
  - on a Refresh on the Models page
- **Nothing blocks.** A call reads whatever the table holds.

As built (2026-09-24):

- **The store.** `modelStoreAt` in `@jaira/persistence` opens the base root's database on its own handle,
  as the module approvals do. Reading with `create: false` never creates a `~/.jaira` that doesn't
  exist; the first refresh with something to keep does.
- **What is asked.** `catalogSources` in `@jaira/runtime` builds this machine's sources from config and
  the last executor check:
  - OpenRouter, always.
  - Anthropic's list, when the anthropic route's key resolves through the secret chain.
  - `claude-cli` (the configured binary), `claude-code` (the SDK's bundled one, `sdkClaudeBinary`) and
    `codex-cli`, each only once its check passed.
  - The `local` server's `/models`: its rows are free and their parameters unknown.
  - The `embedded` weights' GGUF headers.

  Each source carries a FINGERPRINT of what its answer depends on: the key's hash (never the key), the
  agent's command, `--version` and sign-in, the local URL, the weights paths.
- **When.** `CatalogRefresher` asks a source again when its fingerprint changed, when its answer is a
  day old (an hour after a failure), or when Re-check forces it. Requests that arrive during a pass
  collapse into one follow-up with the latest inputs. It saves only the rows the pass changed.
- **The app.** `AppService` does this only with `refreshCatalog` (set by the app, never by tests):
  - It loads the store at construction.
  - It kicks a refresh at the end of every availability pass (startup, project open, config writes,
    sign-in), which is how a key or sign-in change reaches the catalog, and hourly on a timer.
  - Re-check (`refreshAvailability({recheck: true})`) forces every source.
  - A pass that changed rows publishes the `availability` invalidate.
- **The CLI** loads the store at process start (`loadCatalogFrom`), read-only.
- **`AHEAD_OF_CATALOG` is deleted.** `knownModels` is the catalog, minus rows a source marked
  unavailable.
- **Not yet built:** the Models page's Refresh button, and a refresh when downloaded weights land.
  Both belong with the settings UI.

### 5. What reads the schema

- **Parameter checks.** `ModelInfo.paramAcceptance`, the single gate that both the plan and the call use,
  reads `parameters`.
  - A parameter the model doesn't accept is **dropped with a note**, for reasoning as for sampling. This
    is the existing sampling rule extended to reasoning, for a route that genuinely can't take it
    (haiku through the CLI, a local server).
  - An out-of-range value is a plan finding.
- **Clamping.** An effort above the model's top level takes the highest level listed at or below the
  request, as `ReasoningSpec` already promises. `fitReasoning` is the one place this happens: it clamps
  a level, turns a budget into a level for a model with no budget (and back), and drops a request the
  model takes none of, returning the notes the plan reports.
- **Anthropic's thinking mode follows the schema.** A model whose schema takes `budgetTokens` gets
  `thinking: {type: "enabled", budgetTokens}`. One that takes only levels gets
  `thinking: {type: "adaptive"}` plus `effort`. Measured from Anthropic's `/v1/models` on 2026-09-24:
  - Every Claude from 4.7 on is adaptive-only, so the budget the adapter always sent asked for a mode
    those models don't have.
  - 4.6 takes both modes.
  - 4.5 and Haiku 4.5 take only a budget.

  A model with no schema keeps the old behaviour: a budget on Anthropic, and a level clamped to
  `low`–`high` elsewhere.
- **The effort vocabulary.** `REASONING_EFFORTS` is the ORDER used for clamping. It widens to
  `none < minimal < low < medium < high < xhigh < max < ultra`, which covers OpenRouter's and codex's
  levels. Which levels a given model takes comes from its schema, never from this list.
- **The UI.** The composer, `llmConfigForm` and `operationFields` draw effort through SchemaForm from the
  chosen model's schema. The four hand-coded lists and `AHEAD_OF_CATALOG` are deleted.

### 6. Codex reasoning works

Ruling of 2026-09-24: codex gets reasoning, not a drop. Verified against `codex-cli` 0.147 on
2026-09-24:

- **Effort.** It travels as `-c model_reasoning_effort="<level>"`. `--strict-config` accepts the key, and
  `-c` is the spelling both `exec` and `exec resume` accept (the same reason `model` and `sandbox_mode`
  go that way). `codexRefusal` stops refusing `reasoning.effort`.
- **Codex doesn't check the level itself.** It passes the value to the API, which rejects an unknown one
  (`invalid_enum_value`, listing `none`, `minimal`, `low`, `medium`, …). The `codex-cli` rows' schema,
  filled from `model/list`, is what catches a bad level before the call. Clamping to the model's
  levels happens before the call as for every route.
- **Budgets.** Codex has no token budget. The schema omits `budgetTokens`, so a budget-only request is
  dropped with a note.
- **Thinking in the conversation.** `-c model_reasoning_summary="auto"` makes the `--json` stream carry
  `{"type":"reasoning","text":…}` items. `codexQuery`'s reader drops them today, keeping only
  `agent_message`; it maps them to the same thinking parts the claude transports produce, so they draw
  in the conversation as claude's do.
- **Usage.** `turn.completed.usage.reasoning_output_tokens` is read into the usage figures.

## Consequences

- **Easy.** A new model, or a new effort level, appears once the route that serves it reports it, with no
  release. A new kind of parameter is a schema property, not a field plus four UI edits.
- **The built-in presets run on codex with their effort** (§6), instead of being refused.
- **Harder.** Every reader of `supportedParameters` moves in one change (llm's `call`, `plan`, schema
  `profiles`, the config search). Per the no-back-compat rule, the string arrays are deleted outright.
  The generated snapshot grows: 460 rows, each with a small schema.
- **Refreshing costs a little.**
  - The claude refresher spawns the binary: about one second, and no prompt is sent.
  - Codex starts `app-server` briefly.
  - Both run in the background.
- **Foreclosed.** A hand-maintained list anywhere in JaiRA of which models exist or what they accept.

## Revisit when

- A source stops reporting what this relies on: OpenRouter drops `reasoning`, Anthropic's
  `capabilities` changes shape, or the SDK's initialize response loses `models`.
- A route appears whose transport can't be asked about itself. It would be the first to need rows
  someone writes by hand.
