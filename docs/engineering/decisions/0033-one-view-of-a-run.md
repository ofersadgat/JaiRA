---
id: engineering/decisions/0033-one-view-of-a-run
type: decision
status: built in part
updated: 2026-11-22
decides_for: [engineering/decisions/0029-workflows-that-learn-from-corrections, engineering/units/chat-turns, engineering/units/live-turns, engineering/units/interaction-hub, engineering/units/workflow-authoring, ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/components/computed-state-body, ui/components/transcript, ui/components/work-row]
---

# 0033. One view of a run: chat and the task view are one component, every call is drawn by a renderer for its function and role, and a script can hint how with `renderUI`

## The person's words

The person, 2026-11-22, on the task view of a Session:

> i dont quite like the way that the task view of session looks like. on the one hand I like how clear
> it is in terms of seeing what happened at a function call level, but on the other hand it looks like a
> programming trace. I wonder if we can improve this by having renderers for function results. Ideally
> we can make this view look similar to the chat view (because they actually represent the same thing)
> by having renderers for individual functions. [...] Ideally we can use the exact same components.

Over the first answer (the views show different things; two paths drift):

> they are two views of the fundamental same thing. I think that there is drift between them that we
> should aim to close. [...] we should aim for a single component which renders both, possibly with
> different options for some things being folded by default in one and not the other. [...] start_task
> is essentially starting a nested workflow which I believe we designed to be able to render in chat.
> We can also potentially display things like conversation_digest as a tool call. perhaps in one view
> any function without an explicit renderer becomes a tool call? [...] I wonder if a better paradigm
> would be to add a "render" function. The render function can be used to wrap any other function but
> provide rendering parameters which will be used to override the default rendering.

Over the second (interrupts, a promise argument, roles, the double message):

> if an llm call is running, it should be able to be interrupted by a new input. we currently have a few
> ways of interrupting an llm call: interrupt with the message, interrupt the llm call with no message,
> stop. then, we also potentially want to be able to queue a message without interrupting. these are
> all things chat does right now that we need to be able to replicate in the task view. [...] render is
> simply a UI hint for how to show/render the UI. it shouldnt be changing anything about execution,
> right? I'm open to having role labels for render, but I dont like having hardcoded role types. [...]
> I think that generally the LLM renderer will only render the result, not the input.

Over the third (targets, scopes, the queue, naming):

> if there is more than one valid target, prompt the user with options. [...] the llm call should take
> an AbortSignal the same way that promises do [...] When we're rendering a workflow we should know the
> call path, right? [...] I think we should have the function + role as part of the lookup to
> renderers. [...] We can also have a renderer which is partially bound [...] adopt the claude code
> practice of having the message appear in the UI immediately with a button underneath it that says
> "send now" [...] i dont think this is meant to be user configurable (at least not now). [...] this
> function should be called renderUI.

Over the fourth (the signal, the queue, lookup order):

> I meant more the pattern instead of the literal instance. We can call it InterruptSignal. [...] the
> signal itself can be implemented as a unique number or unique label that unique identifies the
> runtime caller [...] the llm call registers with a registry under that label/id and signaling means
> sending a message to that id. [...] steer the running reply [...] answer one in order. [...] starting
> with literals is ok. [...] any role should be explicit by registering "*"

And the last: "put role before function. 1. agree 2. agree 3. sure. 4. rendering a workflows entry
parameters makes sense. 5. yes." Then, over the draft's fallback for Send now: "if you queue a message
and the target cant be steered, send now shouldnt appear and it should just be a queued message".

## Context

- **A Session is a program** ([0029](0029-workflows-that-learn-from-corrections.md) §1–2). Every
  `llm()`, `input()` and `$REGISTRY` call in `$SYSTEM/workflows/session.ts` is compiled to a state of
  its own: the reply, `conversation_digest`, the `notice` check, `start_task` for a lesson, the wait.
- **The task view draws a state per sheet.** A state with a conversation draws its transcript; one
  without draws `SilentState` / `CallBlock` (`packages/universal/src/components/panel/RunTranscript.tsx`,
  specified as [computed-state-body](../../ui/components/computed-state-body.md)): a Σ, the function's
  name, its arguments as name-over-value pairs and a `RETURNED` value. That is the trace.
- **Chat draws one session.** `chatThreadModel.ts` reads the conversation the program threads through
  its replies (`conv`), and nothing else the program did. It already shares `Transcript`
  (`SessionTranscript.tsx`) with the task view, so a reply looks the same in both.
- **There are already per-function renderers, in two unrelated places.** A program call has one: a
  settled `notify` is a "told you:" line (`toldOf`, `runConversationModel.ts`). A model's tool call has
  several in `WorkRows.tsx`, among them `start_task` as a `ChildRunLine` (`chat/ChildRun.tsx`). So the
  program's own `start_task` (a lesson) is not in chat, and the model's is.
- **`label` is a display name only.** The compiler reads it from `llm` / `input` / `agent` options when
  it is a literal (`labelOf`, `hw/src/scriptCompile.ts`), and it names the state on the board, in the
  Steps index and on the record. It is not part of identity; the state's key is its call site. Without
  one, the name is the hook and the first 48 characters of the prompt.
- **A message to a running program** (`answerProgramInput`, `service.ts`) answers a waiting `input()`,
  or is steered into a running call's conversation when its transport can take it (recorded there as a
  joined message), or is seeded for the next `input()`. Seeds live in memory
  (`InteractionHub.seed`, `runtime/src/interaction.ts`): an app restart loses them. Steering wins
  whenever it can. "Stop the reply" (`chat:cancel`) ends only the call; the program goes on because
  `session.ts` catches it.
- **A value that lives across a cut must be plain data** (`checkWires`, `scriptCompile.ts`), so a live
  `AbortController` cannot be carried from one state to the next.
- **The patterns this needs exist.** `QueuedMessage.tsx` draws a message that is not sent yet (a bubble,
  a "queued · 2 min" pill, Edit and Delete). The offline outbox (`PendingSend.tsx`) keeps an answer
  across a restart with a way to take it back. `stillRunning.ts` and `WorkSummary.tsx` show that folded
  work is still going.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. Renderers for the task view only | Small; chat untouched | Two pictures of one run stay two code paths and keep drifting; the program's `start_task` still never reaches chat |
| B. One component at two levels of detail, one renderer registry for program calls and tool calls, and `renderUI` hints from the script | One path; a function looks the same wherever it is called from; chat gains what the program did; the task view gains chat's controls | The largest change: the task view's sheets, chat's thread model and hw's compiler all move |
| C. Chat as the only view of a program | Least to build | Loses the step-level record the person likes; nothing for workflows that are not conversations |

## Decision

**B.** The deciding reason is the person's: the two views are of the same run, so they should be the
same component, and the difference between them is only what is folded.

## Rulings

### 1. A run is drawn by one component, at two levels of detail

Chat and the task view render the same stream of rows for a run: the messages of its conversations,
its calls, the notes for entering and moving between states, and whatever asks the person. Chat-only
affordances (the composer, the live edge) come from the host, and the task view gets them too (§7, §9).

| | Chat | Task view |
| --- | --- | --- |
| A state's letterhead | hidden; consecutive replies in one session read as one thread | shown |
| Calls between two messages | folded into a summary row, as an agent's tool calls are | open rows |
| A call whose role is hidden in this view | not drawn | drawn, folded |
| A waiting `input()` | the composer | the composer |
| Parallel branches | the task view's bands | the task view's bands |

Consecutive pieces of the same session join without a seam in both, so a Session's task view reads
like its chat with the program's steps between the messages.

### 2. One renderer registry, for a program's calls and a model's tool calls alike

- **Keyed by (function, role).** The function is its full reference; the role is an open string (§3).
  `"*"` is stored explicitly: registering a function alone stores `(function, "*")`, and a renderer
  for any function stores `("*", role)`.
- **Lookup order:** `(function, role)` → `("*", role)` → `(function, "*")` → `("*", "*")`. The last is
  the tool-call row, whose open body is today's `CallBlock`. So any function without a renderer reads
  as a tool call, in both views, and the trace look is gone.
- **An entry is data: a renderer's id and the options bound to it.** Renderers are app code; the same
  renderer configured differently is two entries with different bound options.
- **A model's tool name is mapped to the function it calls before lookup** (`mcp__jaira__start_task` is
  `start_task`), so the model's and the program's calls of one function find one renderer.
- **Not configurable by the person for now.** The registry is the app's, plus what scripts say (§4).
- **Renderers get actions as well as data** — the targets of §7.

### 3. Roles fold and hide; they do not erase

- A role carries, per view, whether its calls are shown, folded or hidden — separately from which
  renderer draws them. `renderer: null` in `renderUI` is the explicit "draw nothing".
- Hiding is presentation, never data: the record is untouched, and the task view can always show
  everything.
- A hidden or folded call that **asks the person** or **fails** is drawn anyway. One that is
  **running** shows on its parent row as still working, with the existing still-running pattern.

### 4. `renderUI` is a hint from the script, and nothing executes differently because of it

```ts
import { llm, renderUI } from "@declarative-ai/hw/script";

const reply = await renderUI(llm({ prompt: text, session: conv, withSession: true }), { title: "Reply" });

await renderUI(async () => {
  const recent = await conversation_digest({ session: conv, last: 4 });
  const seen = await llm<Verdict>({ prompt: "…", system: NOTICE });
  // …
}, { role: "aside", title: "Checking for a correction" })();
```

- **Two forms.** Given a call (a call, a promise, `await` of a call), it configures that call. Given a
  function, it returns the function configured: a scope whose `title`, `label`, `role`, defaults and
  registry overrides apply to every call inside that does not say otherwise — including the tool calls
  the model makes inside a wrapped `llm`.
- **Matched by the compiler, from the source.** `renderUI(<call>, …)` is tied to that call site, so the
  hint is known before the call runs and a hidden call never flashes. A first argument the compiler
  cannot tie to a call site (a variable holding an earlier promise) is a compile warning, not a silent
  no-op. Run without the engine, `renderUI` returns its argument.
- **Configs are literals**, to start. They live in the compiled script, beside `label`.
- **Resolved when drawn**, by walking the call's path up through the run's instances — a helper that is
  not inlined is its own instance, and an inlined one has its own call sites — in the **version of the
  script the call ran under**, so a lesson that changes a hint does not redraw history. The nearest
  scope with any match wins; within it, the order of §2.
- **The engine never reads it.** It is not part of a call's identity, replay, or what must survive an
  `input()` across versions (0029 §3). Changing it changes the file's hash, so the script is approved
  again — on purpose, since a hint can hide.
- **`label` stays** the state's name everywhere (board, Steps, logs, costs); `title` overrides it only
  where the call is drawn in a conversation.

### 5. What each function draws by default

| Function | Drawn as |
| --- | --- |
| The workflow's entry | its parameters, by their own renderers — `session(message, …)` draws `message` as the person's bubble |
| `input()` | the person's message on the right, with the settings chosen for it on its rail; while waiting, the composer |
| `llm()` | what the call added after its prompt: replies, tool calls, steered messages, approvals asked in it. Never its prompt in chat; the task view can show the prompt, folded |
| `start_task`, a mounted workflow | a child-run line (`ChildRunLine`), walking into the run |
| `notify` | the "told you:" line |
| `now`, `random`, `log` | the role hidden |
| anything else | the tool-call row |

The person's message is drawn once: by `input()` (or the entry), never by the `llm` that reads it.
Edit and rewind on it belong to that row, and rewind the run to it. A steered message has no `input()`
behind it: it cannot be edited, and rewinding from it goes to before its call.

### 6. `InterruptSignal`: an id, registered and messaged

- `interruptSignal()` is a recorded hook, like `now()`: it returns a fresh id the first time and the same
  id on replay. The id is plain data and crosses cuts.
- A call registers under its own id always, and under any signal it is handed
  (`llm({ …, interrupt: s })`, or a `renderUI` scope's `interrupt: s`). Its record lists the ids, which
  is how a renderer knows what it may interrupt.
- Signalling sends a message to the id, from the UI or from the script, within the task only. It is
  delivered to the calls registered under it at that moment, and waits only while the scope holding the
  signal is still running.
- An interrupted call fails with `Interrupted { reason }`, recorded with the call, so a replay takes the
  same branch. A run that does not catch it ends **stopped**, not failed.
- **Steering is not interrupting.** A message joining a running call keeps the reply's work; it is an
  action on an `llm` call with a conversation, not on a signal.

### 7. A message or an interrupt resolves its target the same way everywhere

The composer and a renderer's controls resolve the calls that can take the action: a waiting `input()`,
a running `llm` that can be steered, the calls registered under a signal. One target is acted on; more
than one asks the person, naming each by its `title`, else its `label`. A workflow that wants to be
specific hands its renderer a signal (§6).

### 8. Four ways in, in both views

| Action | Does |
| --- | --- |
| Send while a call runs | queued (§9) |
| Send now, on a queued message | steered into the running reply; offered only when it can be steered |
| Interrupt | the call is interrupted with no reason |
| Interrupt with a message | the call is interrupted with the message as its reason |
| Stop | the run is stopped |

### 9. A queued message is shown at once, saved, and answers one `input()`

- A message sent while a call runs is drawn immediately as a queued bubble (`QueuedMessage`) with Edit
  and Delete. Steering is no longer automatic.
- **Send now** is there only while a running call can take a steered message, and steers it. When none
  can, it is not shown, and the message is simply queued.
- Queued messages are saved, as the offline outbox's answers are, and survive a restart.
- Each answers one `input()`, in the order sent.
- In a run with no `input()`, there is nothing to queue for: the composer only steers.

## Chosen, not ruled

- The names `renderUI`, `interruptSignal`, `Interrupted`, and the option names `role`, `title`,
  `interrupt`, `renderers`.
- `now`, `random` and `log` registered under a role named `hidden`, in the app's registry.
- No rename: hw exports no `render`. The word appears only in SCRIPTS.md's prose for filling a template,
  and the one helper is already `renderTemplate` (`script/src/standalone.ts`).

## Found on the way, to check

- `session.ts` passes only `next.text` to the reply. If a later message's `files` are not added some
  other way, they never reach the model.

## Consequences

- The program's own work reaches chat: a lesson started is a child-run line; a correction check is a
  folded aside. The task view gains chat's composer, queue, steering and interrupts.
- One function looks the same wherever it is called from, and a new function is legible on day one as
  a tool-call row.
- `chatThreadModel.ts`'s separate projection of one session goes, and with it a class of drift. The
  task view's per-state sheets go for calls; letterheads stay as an option.
- hw grows `renderUI` and `interruptSignal`, and the compiler learns to tie a hint to a call site.
- Hints can hide, and lessons edit scripts — so hiding never erases, and a changed hint is re-approved.
- [computed-state-body](../../ui/components/computed-state-body.md) is superseded as a surface: its
  block survives as the tool-call row's open body. [chat-view](../../ui/surfaces/chat-view.md),
  [run-conversation](../../ui/surfaces/run-conversation.md), [transcript](../../ui/components/transcript.md)
  and [work-row](../../ui/components/work-row.md) change with it.

## Build order

1. **The registry.** One lookup for program calls and tool calls, keyed (function, role) with explicit
   `"*"`; `toldOf`, `ChildRunLine` and `WorkRows`' cases move into it; the tool-call row is the fallback.
2. **The task view as rows.** Calls drawn by the registry in place of `SilentState` sheets; consecutive
   pieces of one session joined; letterheads an option; roles folded per view.
3. **hw.** `renderUI` (both forms, compiler tie-in, literal configs, scopes resolved by call path in the
   call's version) and `interruptSignal` (recorded id, registration, `Interrupted`, stopped-not-failed).
4. **Targets and the queue.** Actions resolved per §7; a saved queue answering `input()` in order; Send
   now; the composer in the task view.
5. **Chat on the shared component**, keeping its composer and live edge; its thread model retired.
6. **The record.** The component and surface specs above, mockups, and parity shots for both levels.

## Built (2026-11-22)

The person: "implement it".

- **The registry** (`packages/app/src/renderer/callRenderers.ts`): entries keyed (function, role), `"*"`
  stored explicitly, looked up (function, role) → ("*", role) → (function, "*") → ("*", "*"), the last
  the tool-call row; roles say per view whether a call is shown, folded or hidden; `now`, `random` and
  `log` default to `hidden`; `withOverrides` lays a scope's entries over it; a model's tool name is
  read as the function it calls (`functionNameOf`).
- **A program's calls among its messages** (`programCalls.ts`): `programCallsOf` reads every call a
  program made off its states and their records, its `renderUI` config resolved down the call path
  (`presentationOf`, nearest winning, `renderers` adding up, a renderer the app does not have left out);
  `weaveProgramCalls` places each where it happened, drawn by its renderer: `input()` and the reply add
  nothing the thread already holds, a check is a row with its answer, `start_task` the child-run row,
  `notify` the told line, anything else a tool-call row.
- **One component.** Chat weaves them at `chat` detail (`chatThreadModel.ts`). The task view of a
  program read from its root is the Chat view's own thread and composer at `task` detail
  (`RunConversation.tsx`'s `ProgramChat`, through `usePaneChatSurface(…, "task")`) — its queue, its
  stop and its edits with it. The per-state sheets are no longer drawn for a program.
  At `task` detail every summary of work starts open, each phase under its head (`WorkOpenContext`),
  and can still be folded by hand; chat keeps them folded.
- **hw** (declarative-ai, SCRIPTS.md §18): `renderUI` (both forms, tied to its call site by the compiler,
  written on the call's state as `present`, literal configs, a warning where no call can be found),
  `interruptSignal()` (a recorded id), `Interrupted`. JaiRA carries `present` through the board's
  shape and the projection onto every instance (`shape.ts`, `projection.ts`, `InstanceNode.present`).
  `session.ts` draws its correction check and its digest as asides.
- **Interrupts** (`liveHandles.ts`): a call in flight is registered under its state and the signals it
  was made under (read off `config.interrupt` and taken out before a model sees it); `task:interrupt`
  fails every call a target reaches, canceled with `interrupted: <reason>`. In the thread, Stop asks which
  when a program has several calls going (`InterruptChoices`), "Interrupt with this message" is offered
  while a reply is written and the box holds one, and a running program call's row carries its own
  Interrupt (`CallInterruptContext`).
- **The queue** (`queuedMessages.ts`, `~/.jaira/system/queued.json`): a message sent while a call runs is
  queued, not steered; a program parking at `input()` takes the oldest; `chat:queue` / `chat:queueAct`;
  the thread draws each with Send now (only while the reply can take it), Edit and Delete.

- **The coarser modes** (`"phases"`, `"state"`): `renderUI(promise, config)` tells the host which call
  the promise is, and the config is recorded on its `script.call.settled` (`present`); a script's
  `operation.dispatched` names its `site`. JaiRA projects both (`OperationCall.site`,
  `InstanceNode.scriptCalls`), and `programCallsOf` reads every recorded call a state made — each named and
  drawn by what was said at its site — rather than the first.
- **A scope's `interrupt`**: the one field of a config that may be computed; every `llm()` and `agent()`
  inside is registered under it unless it names its own (SCRIPTS.md §18.1).
- **Every step**: a switch over the program's thread at `task` detail, off at first, that draws every
  call as a row of its own — the waits and the replies the thread already says among them. This is the
  ruling's "a state's letterhead, shown in the task view": the step, named, in place, without its sheet.
- **The record**: chat-view, run-conversation, transcript, work-row and computed-state-body say all this.

- **A program however compiled**: the task detail says so (`TaskDetail.program`, from its pinned bundle), so a
  script compiled as one state is read as its conversation too.

**Seen in the app** (2026-11-22, a studio of its own, fake models; the person: "Yes, do both"): queued
messages drawn at once with Send now, Edit and Delete — each pressed; Stop asking "Interrupt which?" over a
program with two calls going, one picked; a running check's row with its own Interrupt, pressed; "Interrupt
with this message" stopping a reply, the message answered next; Every step at `task` detail. What it
found, fixed: a queued message was not drawn until the page was read again (the change named no task, and
a view about a task is read again by its task); a message sent now vanished until the reply it joined
landed (drawn as sent now); one that could not join fell to the unsaved hand-off (queued now); a running
call's record already holds what it has said, so its row looked answered and offered no Interrupt; the
Interrupt was a button inside the row's button (beside it now); a wait offered Interrupt; an interrupted
call was said "Not sent" under the thread; the Every step switch scrolled away with the thread (over the box
now).

**Scenes**: `conversation-program` and `task-program` (`parityWorld.mts`) reach a program's thread in chat
and as its task. Their reference pictures are accepted in the goldens' world
(`pair.mts --accept --scene conversation-program,task-program`), which this machine does not hold.

## Revisit when

- A workflow needs a hint computed at runtime that a literal cannot say — then hints are recorded per
  call, not compiled.
- People ask to set roles themselves — then the registry gains a layer the person edits.
- A view needs a function to look different by where it is called from in a way roles and scopes cannot
  express.
