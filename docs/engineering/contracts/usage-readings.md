---
id: engineering/contracts/usage-readings
type: engineering-contract
status: shipped
updated: 2026-09-24
visibility: internal
kind: api
owned_by: ["declarative-ai: json/src/usage.ts, exec/src/limits.ts, agents-api/src/claudeUsage.ts, agents-cli/src/claudeUsageProbe.ts, agents-cli/src/codexUsage.ts", "packages/shared/src/usage.ts", "packages/app/src/main/limits.ts, packages/app/src/main/waiting.ts", "packages/app/src/renderer/usageMeters.tsx, packages/app/src/renderer/limitsStore.ts"]
consumers: ["the preset rule `most-left` (`coder`, `planner`) — a preset's candidate with the most allowance left", "the composer: the conversation's ring and the account's number after the model chip", "the conversation view: each answer's reading on its rail, the compaction line, each state header's delta", "Settings → Connections: each sign-in card's weekly ring", "`model_limits` for a `$pick` expression (NAMES.md §6) — not built yet"]
siblings: [engineering/contracts/exec-observer]
---

# Usage readings

Two provider-neutral readings — how full a conversation's context is, and how much of an account's allowance is spent — normalized once at the agent seam so that choosing a model and drawing a meter read the same numbers.

Built 2026-09-24 in both repos; "As built" at the end says where the build departed from the plan above it. The provider facts below were read on 2026-09-19 from the installed `@anthropic-ai/claude-agent-sdk` 0.3.223 types, from `codex-cli` 0.147.0's own session files on this machine, and from the vendors' published docs; each says which.

## Two readings, because they have different owners and different lifetimes

A **context reading** belongs to one conversation and changes on every model response. A **limit reading** belongs to an account on a route and changes whenever anything anywhere spends from it. Keeping them apart is what lets one be stored with a turn and the other be kept per route.

### `ContextReading`: how full one conversation is, after a response

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `used` | `number` | yes | tokens the conversation now holds: the last response's input (cached and uncached) plus its output |
| `window` | `number \| null` | yes | the model's context window; `null` when the provider does not say |
| `model` | `string` | yes | the model that answered, as dispatched |
| `breakdown` | `ContextPart[]` — `{ name, tokens, parts?, note? }` | no | what the tokens are, when the provider offers it, each category broken down further where it says (tools one by one, MCP tools by server, tool results by tool) |
| `autoCompactAt` | `number` | no | where the agent compacts by itself, in tokens |
| `at` | ISO-8601 | yes | when it was read |

### `LimitReading`: how much of an account's allowance is spent

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `route` | `string` | yes | the executor route it was read on (`claude-cli`, `codex-cli`, `anthropic`, …) |
| `plan` | `string \| null` | yes | the provider's plan word (`max`, `plus`, …), `null` for an API key |
| `windows` | `LimitWindow[]` | yes | every window the provider reported; may be empty |
| `status` | `"ok" \| "warning" \| "exhausted"` | yes | the provider's own verdict where it gives one, else derived: exhausted at 100 |
| `source` | `"stream" \| "query" \| "headers" \| "file"` | yes | how it was learned, so a reader can weigh it |
| `at` | ISO-8601 | yes | when it was read |
| `complete` | `boolean` | no | `true` when it names every window the account has (a query); a sparse update — a stream event names one window — is merged into what was known |
| `overage` | `boolean` | no | the account is drawing on extra, paid usage: spent does not mean waiting |

`LimitWindow` is `{ id, label, minutes, usedPercent, resetsAt, model? }`: `id` is the provider's own word (`five_hour`, `seven_day`, `primary`), `minutes` the window's length or `null`, `usedPercent` 0–100 or `null`, `resetsAt` ISO-8601 or `null`, and `model` present when the window counts one model only.

**The unit is percent of a window, never tokens.** That is what both subscription providers report, and it is the only unit comparable across model families. An API-key route reports remaining tokens and requests in response headers; its adapter converts to percent against the limit the same headers carry, and keeps the raw numbers out of this contract.

## They travel as two neutral events, not inside `provider_event`

`ExecEvent` (upstream `exec/src/contract.ts`) gains `{ type: "context"; reading }` and `{ type: "limits"; reading }`. The union's own comment lists "rate-limit windows" among the provider events `exec` "cannot act on"; that stops being true the moment a `$pick` and a meter act on them, which is the test that comment sets for naming a variant. The raw provider event keeps flowing as `provider_event` beside it, unchanged.

**A context reading is stored with the turn it follows** — as an attribute of that turn's entry in the record's one `entries` array, appended when it arrives, never a parallel structure. That is what makes "the context at every turn" a read of the record rather than a second stream to keep in step.

## Who holds the limits: the session layer reports, one board holds

A limit is global to the account behind a route — not to a session, a task or a project. Two pieces
hold it, because there are two scopes to get right.

**An executor is a composite of concerns** (`withMemoize`, `withRetry`, `withDeadline`,
`withRecord`, `withSessionPosition`, …), and limits belong to the concern responsible for
**sessions**: upstream `exec/src/record.ts`'s `withSessionPosition`, the one layer every
conversation-bearing call passes through — a prompt op and a delegated agent alike — and the one
that already sees what comes back on the stream. It takes a second seam beside its
`sessions: SessionStore`: `limits: LimitsBoard`. It does not grow a store of its own.

**The board is the one thing more global than any executor.** There can be several executors on
one account (the Agent SDK route and the `claude` CLI route share a subscription), several
accounts, or no executor at all — and a meter still has to have somewhere to ask. So one
`LimitsBoard` exists per host process, handed to every executor's session layer through services,
and it holds a `LimitState` **per account**: keyed by provider and account where the provider says
who the account is, and by route where it does not.

| `LimitState` field | Type | Meaning |
| --- | --- | --- |
| `reading` | `LimitReading \| null` | the latest reading from any session on any executor of this account |
| `updatedAt` | ISO-8601 \| null | when that reading arrived |
| `lastSentAt` | ISO-8601 \| null | when any executor of this account last sent a message |
| `refreshing` | `boolean` | a manual refresh is in flight; a second is never started beside it |

**Any session feeds it.** Whenever a call passing through the session layer returns limit
information — a `rate_limit_event`, a `token_count`, a response's rate-limit headers — the layer
reports it to the board with the time it arrived. Latest wins; which session it came from is not
recorded, because it does not matter.

**Two rules decide when to ask rather than wait**, one in each piece, and they answer different
failures:

1. **Sent since heard — the session layer's rule.** On every send the layer stamps `lastSentAt`
   and compares it with `updatedAt`. If messages have been going out for longer than
   `refreshAfterSending` (default 5 minutes) with no update coming back, the account is being
   spent and the number is not moving, so it refreshes manually. This is the case a provider
   creates by reporting limits only "when they change" or only at a warning threshold.
2. **Too old, whatever happened — the board's rule.** A separate timer on the board knows only
   how long ago each `updatedAt` was. Past `refreshAfter` (default 30 minutes), or as soon as the
   earliest `resetsAt` in a reading has passed — a reading describing a window that no longer
   exists — it asks for a manual refresh. This is the case rule 1 cannot see: nothing sent from
   here, while another machine or the provider's own app spends the same account.

The board's timer is not a poller. It runs only while something is listening — a meter on screen
— and otherwise rule 2 is applied on demand: a `model_limits` read that finds a state too old
refreshes first and then answers. With nobody listening and nothing asking, nothing is fetched.

**A manual refresh is something an executor's session layer offers the board**, registering it per
account when the executor is built; the board calls whichever is registered, and an account may
have none:

| Executor | Offers |
| --- | --- |
| Claude Code (both routes) | the `get_usage` control request, sent to a claude process started for nothing else (`-p --input-format stream-json`, `initialize`, `get_usage`, close stdin — no prompt, no turn spent). MEASURED 2026-09-24: the SDK's bundled claude 2.1.223 answers it; the installed claude 2.1.142 refuses it ("Unsupported control request subtype: get_usage"), so the refresh runs the SDK's binary. Signed out, it answers `rate_limits: null` |
| Codex CLI | today: re-read the newest `token_count` in the account's session files — which only helps if some Codex session on this machine has run since. With app-server: `account/rateLimits/read` |
| API-key routes | nothing — the numbers exist only on a response |

With nothing registered the reading stays as it is and its age shows. A refresh that fails is not
an error anyone sees; the state simply stays old.

```ts
interface LimitsBoard {
  report(account: AccountKey, reading: LimitReading): void;     // from any session layer
  sent(account: AccountKey): void;                               // rule 1's stamp
  offerRefresh(account: AccountKey, refresh: (signal?: AbortSignal) => Promise<void>): Disposable;
  state(account: AccountKey): LimitState;                        // never throws; reading may be null
  all(): ReadonlyMap<AccountKey, LimitState>;                    // works with no executor at all
  subscribe(listener: (account: AccountKey, state: LimitState) => void): Disposable;  // starts rule 2's timer
}
```

The host persists the board under the shared root (`~/.jaira/system`), not under a project — the
account does not change when the project does — so a restart, the CLI and the app all start from
the last thing any of them learned.

`model_limits(candidate)` resolves the candidate's route to its account, applies rule 2 on
demand, and returns `{ remaining, status, windows, ageSeconds }`: `remaining` is
`100 - max(usedPercent)` over the windows that apply to the candidate's model — the account-wide
ones plus any whose `model` matches — and `null` when there is no reading. `ageSeconds` is always
present, so a `$pick` that cares how fresh a number is can say so. It registers
`memoizable: false`. The composer's meter subscribes to the same board; there is no second copy
for the two to disagree about.

## Where each provider's numbers come from

| | Context | Limits | Without spending a turn |
| --- | --- | --- | --- |
| **Claude Code** (SDK and CLI) | each assistant message's `usage`, against `modelUsage[model].contextWindow` on the result; the `get_context_usage` control request adds a per-category `breakdown` and `autoCompactThreshold` (MEASURED: claude 2.1.142 answers it over stdin, before or after a turn) | the stream's `rate_limit_event` whenever the limits change — MEASURED in 10 stored records: `status`, `resetsAt`, `rateLimitType`, `isUsingOverage`, and **never `utilization`**, so the stream gives the state and the reset but not the percent; the percent comes from `get_usage` (`rate_limits.five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet`, each `{ utilization, resets_at }`, plus `subscription_type`) | `get_usage` on a process started only to ask (see the refresh table); `getContextUsage()` needs the conversation's own process, so a breakdown is read at the end of each turn |
| **Codex CLI** | the `token_count` event's `info.last_token_usage` against `info.model_context_window` | the same event's `rate_limits`: `primary` and `secondary`, each `{ used_percent, window_minutes, resets_at }`, plus `plan_type` and `credits` | `codex app-server`: request `account/rateLimits/read` — ChatGPT-login auth only (an API key is refused), and the docs call app-server experimental |
| **API-key routes** | the call's reported usage, against the model table's window | the provider's rate-limit response headers, per call | no |

Codex, checked against openai/codex main (commit `392f56a`, 2026-09-19) and this machine’s codex-cli 0.147.0:

- **`codex exec --json` carries neither reading.** Its events are `thread.started`, `turn.started`, `turn.completed { usage }`, `turn.failed`, `item.*`, `error`; `usage` is the THREAD’s cumulative total (not the turn’s), has no window, and nothing in `exec/src` mentions a rate limit. The TypeScript SDK wraps the same stream. Upstream’s `codexQuery.ts` drives exactly this, so today it sees neither.
- **The session file carries both**, one `token_count` record per model response (always persisted: `rollout/src/policy.rs`). Read here: `"model_context_window": 258400`, `"primary": { "used_percent": 2.0, "window_minutes": 300, "resets_at": 1789600313 }`, `"secondary": { "used_percent": 33.0, "window_minutes": 10080, … }`, `"plan_type": "plus"`. `resets_at` is unix seconds. The file is found from the `thread_id` that `thread.started` reports, and JaiRA already reads a provider’s own session file at close for Claude. The format is internal.
- **`codex app-server` carries both live**, as JSON-RPC notifications `thread/tokenUsage/updated { tokenUsage: { total, last, modelContextWindow } }` and `account/rateLimits/updated` (a sparse update to merge into the last read), and answers `account/rateLimits/read` with no turn at all. Documented, but the docs call the command experimental and unsupported for production.
- The numbers originate in `x-codex-primary-*` / `x-codex-secondary-*` response headers, which is why they exist for a ChatGPT login and (unverified) not for an API key.
- Codex’s own “context left” is `last_token_usage.total_tokens` against `model_context_window` with a 12,000-token baseline taken off both: `(W−12000 − max(0, used−12000)) / (W−12000)`. The window it reports is already the usable one. `ContextReading` carries the raw pair; a meter that wants to agree with `/status` applies the baseline itself.

So for Codex the order is: the session file now (no change of transport), app-server when it stops being experimental — which would also give the adapter the mid-run approval channel `exec` lacks.

Neither Claude surface is in the published docs: both ship in the SDK's types, and one is experimental by name. The only documented surface for remaining quota is the interactive status-line JSON, which JaiRA cannot read. Treat every source as able to vanish: a missing reading is an ordinary value, a `$pick` falls through to its first usable alternative, and a meter draws empty.

## What the screens show

Settled with the person over six rounds of mockups (https://claude.ai/artifact/MCjDTEjMLkBjL3xL6LTXk1, 2026-09-23 to 24), and built as described.

- **Composer, right edge: a ring for the conversation.** It shows `used / window` from the last turn's `ContextReading` and turns amber at 80%. With no reading yet it is an empty dashed ring; with `window: null` it shows the tokens instead. Clicking it opens the conversation's popover: the percent and tokens, a bar with a tick where the agent compacts by itself, **Compact now** (the agent's own `/compact`, with a ▾ to say what to keep; while a turn runs it waits for the turn to end), and one row per category that opens its detail on hover (tools one by one and by MCP server, and tool results and calls by tool).
- **Composer, after the model chip: the account's percent used, as a number.** It shows the tightest window that applies to the chosen model. It is ink-coloured at rest, amber from 80% and red at 100%. Clicking it opens the account: every window with when it resets, the reading's age and source, Refresh when a refresh is offered, and the person's other accounts.
- **No usage left is decided by the reading, never guessed.** When the account's `status` is `exhausted`, the composer says so ("claude-cli has no usage left until 14:05. What you send now waits until then.") and Send becomes a clock. A message sent then **waits for the reset**, with **Send now anyway** under it. Deleting a waiting message cancels it; it has no Cancel button of its own.
- **Try again at …** appears only after an actual refusal: Send now anyway was refused, a limit nobody knew about, or a run refused mid-turn (the run keeps its place). It is a checkbox, and a checked box sends again at the reset. It starts checked; that default is a setting in Settings → Runs, "When usage runs out" (proposed key `limits.retryOnReset`, layered like every other setting).
- **Every answer shows the context after it**, on its rail beside the time, with the breakdown on hover. A compaction is a line of its own ("context 84% → 21%, compacted automatically at 166k").
- **A run's state headers show what the state added** (`+30k`): the reading after its last turn minus the reading before its first. It is always at the right, before the time, whether the header is open or folded, and it replaces the cost a folded header shows today. The session's top line keeps the running total.
- **Settings → Connections: each sign-in card is a fixed 200px.** Line one: the icon, the email, and Log out as an icon. Line two: the plan, then a ring with the **weekly** window's percent (Claude: `seven_day`, all models; Codex: the secondary window). Line three, right-aligned: "Weekly · resets Mon 09:00", red when the week is used up. Clicking the ring opens the same account popover as the composer. If the 5-hour window is spent but the week is not, the card does not change; the composer says so.
- **The model menu** puts the account's tightest-window percent on each route row. A model row shows the same bar and number, with no words, only when a window counts that model alone (Opus weekly). Presets pick the candidate with the most left.

## As built

What the screens needed from this contract, and where the build departed from the plan above:

- **The compaction line needs no new record.** Claude's `compact_boundary` already rides the stream as a `provider_event` and is already stored as an event entry, so the renderer reads `trigger`, `pre_tokens`, `post_tokens` and `duration_ms` off that entry (`compactionOfEvent`). Codex reports none; a reading more than 40% below the one before, with no compaction between, draws a line that says the context got smaller and the agent did not say why.
- **`ContextReading.breakdown` is nested** (`ContextPart`: `{ name, tokens, parts?, note? }`) and it gained **`autoCompactAt`**. Both come from `get_context_usage`, asked of the conversation's OWN process as the turn ends — before stdin closes on the CLI route, before the result is handed on for the SDK — and bounded at 3 s, so a process that never answers settles the turn as before.
- **`LimitReading` gained `complete` and `overage`.** A stream event is SPARSE — it names one window and never its percent (measured) — so it merges into what was known (`mergeLimitReadings`: a figure the update leaves `null` keeps the last known one). `overage` (`isUsingOverage`) means spent does not mean waiting.
- **The session layer does not read the event stream; it hands down a reporter.** The stream has ONE consumer, and in JaiRA it is `withTurnStream`, inside the session layers. So `withSessionPosition({ sessions, limits, accountOf })` puts `ctx.usage` (`UsageReporter`: `sent(route)`, `limits(reading)`) on every call below, and the agent executor calls it directly. It reaches the function path too, whose events nobody drains.
- **The board separates listening from watching, and backs off.** `subscribe(listener, { watch: false })` hears changes without starting rule 2's timer, which is how the app persists and pushes. An account whose refresh learned nothing is not asked again by the rules for `refreshAfterMs`; a person pressing Refresh always asks.
- **Accounts are keyed by route family** (`accountOfRoute`): both claude routes are `claude`, codex is `codex`, every other route is its own. Who is signed in comes from the sign-in probe and is shown beside the account, not folded into the key.
- **A refusal on a spent window is `usage_limit`**, classified `out-of-credits` so no retry wrapper sleeps on it, with `retryAfterMs` and `detail.resetsAt`. JaiRA turns it into a refused waiting item.
- **Refreshing claude uses the SDK's bundled binary when it can find it**, then the configured `claude`. An older claude that refuses `get_usage` is reported as "this version of claude cannot report usage — update claude to see how much is left".
- **Not built:** readings from an API-key route's response headers (the account popover lists such an account without figures), and `model_limits` for a `$pick` expression. The preset rule `most-left` is the consumer that exists.
