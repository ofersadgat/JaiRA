---
id: engineering/contracts/fan-out-host-answers
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: internal
kind: api
owned_by: [engineering/units/fan-out-host]
consumers: ["@declarative-ai/hw engine, which asks through EngineConfig.fanOut and settles the mount with the answer", "@jaira/app main service.ts startRun, which builds one host per parent run", "@jaira/persistence load.ts, which hands the mirrored rows back as request.loaded on resume"]
siblings: [engineering/contracts/journal-events, engineering/contracts/task-file, engineering/contracts/task-channels]
---

# Fan-out host answers

How JaiRA's `fanOutHostFor` in `packages/app/src/main/fanOut.ts` reads an upstream `FanOutRequest`, and the `FanOutOutcome` it answers for each case.

## The engine asks this host only for a hosted mount, and nothing else calls it

**Use when.** A mount's wire says `each: "task"` or `each: "split"` and the run was started by the app, which passes `fanOut` and the task's `split` entries to `executeWorkflow`.

**Do not use when.** The wire is `each: "inline"` or `each: true`, which the engine runs itself. The run is a `jaira` CLI run, which passes no host, so the engine fails the mount. Reading what a batch made, which is the `fanout.made` row in [journal-events](journal-events.md) and `origin`, `split` and `dependsOn` in [task-file](task-file.md). What the host does around each answer, and how it fails and resumes, is [fan-out-host](../units/fan-out-host.md).

## The shape is the request fields the host reads and the five answers it gives

### The host reads every request field, and derives each element from the first axis

`FanOutRequest` in `@declarative-ai/hw` `engine.ts`.

| Field | Type | Required | Meaning to this host |
| --- | --- | --- | --- |
| `kind` | `"task"` or `"split"` | yes | which of the two answer paths runs |
| `instanceId`, `stateId` | string | yes | the mounting instance; `fanout.made` carries both, and mirrored rows name `instanceId` as their parent |
| `key`, `occurrence` | string, number | yes | the batch's identity: finds a recorded `fanout.made` and a made task's `origin`; `occurrence` 0 is omitted from `origin` |
| `state` | string | yes | the mounted state: a `"task"` element's `workflow`, the bundle's re-rooted `rootId`, and the `stateId` of every mirrored row and a copy's entry |
| `elements` | `{inputs}[]` | yes | each element's resolved inputs, by index |
| `loaded` | `LoadedInstance[]` | no | the mirrored rows a resumed parent recorded, keyed by `element`, absent read as 0; a `"task"` element reuses the row's `id` as its task id |
| `spawn` | `SpawnFields {id, title, requires, start}` | yes | the property names read from each element's item, and whether a split's copies start themselves |
| `exprs` | `Record<input, string>` | yes | the first key is the axis: an element's item is `inputs[axis]`, and a split's entries record `exprs[axis]` |
| `async` | boolean | yes | `"task"` runs every element together when true, else one after another |
| `signal` | `AbortSignal` | yes | aborting cancels the element tasks a `"task"` host waits on, and ends a holding split with `canceled` |

From the item, when it is an object: `id` is `item[spawn.id]` as a non-empty string or a number, else the element's index as a string; `title` is `item[spawn.title]` the same way, else `<parent title> · <key> <index + 1>`; `requires` is `item[spawn.requires]` keeping only strings and numbers, as strings.

### The answers are four for a split and one for a task batch, plus the error every throw becomes

`FanOutOutcome` in `@declarative-ai/hw` `engine.ts`.

| Case | Answer | What exists when it is given |
| --- | --- | --- |
| `"split"` over zero elements | `{outcome: "success", outputs: {tasks: []}}` | nothing made and nothing recorded |
| `"split"`, and every task element 0 requires has completed, or it requires none | `{outcome: "continue", index: 0}` | `fanout.made` recorded; a queued copy per other element; the task's own `split`, `title` and `dependsOn` written once; copies that require nothing started unless `spawn.start` is `"manual"` |
| `"split"`, and the signal fires while element 0 holds | `{outcome: "canceled"}` | the same, and the task held for keeps running |
| `"split"`, and a task element 0 requires ends other than completed | `{outcome: "error", failure: {classification: "permanent", reason: "element '<id>' waits for '<title>', which ended <status>"}}` | the same |
| `"task"` | upstream `combineElements(key, bundle.states[state], terms)` over one termination per element run | `fanout.made` recorded when there is at least one element; a task per element; an `instance.entered` mirror per element not in `loaded`; an `instance.terminated` mirror per element whose row was absent or live |
| Anything thrown on either path | `{outcome: "error", failure: {classification: "permanent", reason: "child '<key>': <message>"}}`, after the log line `child '<key>' (each: "<kind>") failed: <message>` at `error` | whatever was made before the throw |

### A `"task"` element's termination is read from its task's row

| Row | Termination |
| --- | --- |
| `status` `completed` with `outcome` absent or `success` | `{outcome: "success", outputs}` from the row's `outputsJson`, or `{}` |
| `status` `canceled`, or `outcome` `canceled` | `{outcome: "canceled", failure}` |
| anything else | `{outcome: "error", failure}` |
| the signal fired before the element's task was started or waited on | `{outcome: "canceled"}` |

`failure` is the row's `failureJson`, else `{classification: "permanent", reason: "task '<taskId>' ended <status>"}` with ` (<outcome>)` appended when the row has one. A sequential batch stops at the first termination that is not `success`.

## Every error is answered, never thrown into the engine

| Condition | Response | Caller does |
| --- | --- | --- |
| A split request has no axis in `exprs` | `error`, reason `child '<key>': a split has no axis` | the engine fails the mount |
| A split request carries `loaded` rows | `error`, reason `child '<key>': a split's mount is continued from its own element, never from recorded rows` | the same |
| An index below the batch size has neither `elements` inputs nor a `loaded` row | `error`, reason `child '<key>': element <index> was never recorded and the list cannot be re-read now` | the same |
| Two elements share an id | `error`, reason `child '<key>': two elements share the id '<id>' (field '<spawn.id>')` | the same; nothing is made |
| A `requires` names an id outside the batch | `error`, reason `child '<key>': element '<id>' requires '<other>', which is not in the batch (field '<spawn.requires>')` | the same; nothing is made |
| `requires` form a cycle | `error`, reason `child '<key>': the requires of <a → b → a> form a cycle` | the same; nothing is made |
| A made task's row is gone when its element runs | `error`, reason `child '<key>': task '<taskId>' made for element <index> is gone` | the same |
| Starting a made task is refused | `error`, reason `child '<key>': <the refusal's message>` | the same |
| A split's own dependency ends other than completed | `error`, reason `element '<id>' waits for '<title>', which ended <status>`, with no `child` prefix | the same |

## A change to an answer or to what it records breaks resume for existing tasks, and no deprecation path exists

- The host finds its own earlier work by the `fanout.made` row for `(key, occurrence)` and by `origin` on a task's meta. Renaming either breaks a resumed parent's reuse of its ids, and nothing migrates stored rows or task files.
- A mirrored row's instance id is the element's task id. Changing that breaks `loaded` on resume, which reuses the row's `id` as the task id.
- Answering `continue` for a `"task"` request, or for a split asked with `loaded` rows, is booked by the engine as a failed child, so a new answer path has to keep that rule.
- The reason texts are read by people and never matched by code.

## Items, axes and ids are read more loosely than the request's types suggest

- Only the first key of `exprs` is the axis. A mount wired over several inputs takes each element's item, and so its id, title and requires, from the first input alone.
- An item that is not an object has no id, title or requires: ids fall back to indexes and titles to the parent's title.
- A `requires` entry that is neither a string nor a number is dropped without a word, so a malformed dependency makes a task that holds for nothing.
- `continue` always names index 0: the task that split keeps the first element, whatever its id.
- A `"task"` mount over zero elements records no `fanout.made`, and `combineElements` answers success with every declared output as an empty array.
- The engine's `combineElements` puts its own `child '<key>' element <n>: ` prefix on a failed element's reason, so a `"task"` answer's reason reads differently from the host's own errors.
- `fanout.made.runs[].runId` holds a task id, as [fan-out-host](../units/fan-out-host.md) records.
