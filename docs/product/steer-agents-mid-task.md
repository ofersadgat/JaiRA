---
id: product/steer-agents-mid-task
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can send an agent another message while it is still working, or after a step has finished, and have it taken into that same conversation, so that I can correct or extend its work without stopping it and starting again."
importance: 0.5
audience: user
metrics:
  - "Messages sent to an agent while it was still working: rises"
  - "Work stopped and started again with a similar instruction moments later: falls"
requires: [product/chat-with-agents]
related: [product/watch-agents-work-live, product/pick-up-where-it-left-off, product/rewind-to-where-it-went-wrong]
verified_by: []
---

# You correct an agent while it works, in the same conversation, without stopping it

> As a developer, I can send an agent another message while it is still working, or after a step has finished, and have it taken into that same conversation, so that I can correct or extend its work without stopping it and starting again.

## Without this, a one-sentence correction costs everything the agent had worked out

The person is a developer watching an agent that is about to take a wrong turn,
or that finished a step and needs one more thing. Without a way to talk to it
where it is, the only move is to stop it and start again with a better
instruction, which throws away what the agent had read and reasoned and pays for
it a second time.

## Your message reaches the agent's conversation at once or right after its current turn, and you know which

While an agent is working, a person can send it another message. Where the agent
can take messages mid-turn, the message joins the turn in progress and the agent
takes it into account as it goes. Where it cannot, the message waits and is sent
as soon as the turn ends. The person knows which will happen before they send.

The same holds for a step of a process that holds a conversation with a model or
an agent, while the step runs and after it has finished. The message goes into that step's own
conversation, under the settings the step runs with unless the person changes
them for that one message. A message sent after the step finished continues its
conversation but does not change what the step already handed on to the rest of
the process.

A person can also stop an agent's current turn, and what it had written up to
that moment is kept.

## Most course corrections are a sentence, and saying one should not cost the work so far

An agent that has read the code and formed a plan is worth more than a fresh one
given a better instruction. Being able to add the missing sentence keeps that
work, and turns a wrong direction caught early into a small correction rather
than a restart.

## Success shows as more corrections sent mid-turn and fewer stops followed by a restart

| Metric | Read from | Success |
| --- | --- | --- |
| Messages sent to an agent while it was still working | The record of each message a person sent and whether an agent was working when it arrived | Rises |
| Work stopped and started again with a similar instruction moments later | The record of stops and of the next message or start on the same work | Falls |
