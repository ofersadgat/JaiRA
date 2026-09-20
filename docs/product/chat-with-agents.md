---
id: product/chat-with-agents
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can hold an ordinary conversation with a model or with a coding agent that works in my project, choosing the model, how hard it thinks and what it may touch for each message, under the same safety rules and record as my processes, so that ad-hoc work is kept, resumable and reviewable like everything else."
importance: 0.75
audience: user
metrics:
  - "Conversations continued on a later day: rises"
  - "Conversations started again from scratch after a wrong turn instead of edited, rewound or branched: falls"
  - "Agent actions in conversations that bypassed the project's approval rules: falls"
requires: [product/bring-your-own-models-and-agents]
related: [product/watch-agents-work-live, product/steer-agents-mid-task, product/rewind-to-where-it-went-wrong, product/try-another-direction, product/risky-actions-wait-for-approval, product/complete-record-of-every-run, product/read-what-work-produced, product/keep-track-of-everything]
verified_by: []
---

# Conversations with models and agents are kept, guarded and recoverable like any process

> As a developer, I can hold an ordinary conversation with a model or with a coding agent that works in my project, choosing the model, how hard it thinks and what it may touch for each message, under the same safety rules and record as my processes, so that ad-hoc work is kept, resumable and reviewable like everything else.

## Without this, ad-hoc agent work is the unguarded and unrecorded exception

The person is a developer who does much of their agent work by talking rather
than by running a process: asking a model a question, or asking a coding agent
to change something in the repository. If those conversations sit outside the
product, they get none of what the processes get. Risky actions are not held for
approval, nothing is recorded beside the rest of the work, and a conversation
that went wrong can only be abandoned.

## You talk to a model or a coding agent, choosing for each message what it runs on and what it may touch

A person starts a conversation by saying what they want, with a model or with a
coding agent that works in the project, in one of their projects or apart from
all of them. The conversation is named from what they asked, or by the name the
agent gives it.

For each message the person chooses the model, how much it thinks, which tools
the agent may use and whether each use waits for their approval, and can see
where each of those settings came from. They can include files and refer to
files in the project by name.

What an agent does in a conversation goes through the same approval rules as work
on a process, and every exchange is kept in the same record. Questions and
approvals a conversation raises wait for the person like any others.

A person can send a message while the agent is still answering, or stop the
answer. They can change an earlier message and send it again with the original
reply still readable, take the conversation back to an earlier point, or branch a
new conversation from any message. Conversations are found again by name, can be
renamed or deleted, and carry on from where they were on any later day.

## Much agent work is a conversation, and it needs the same guard and record as a process

An agent asked in passing to change something can do as much damage as one
following a process, and a conversation that went well is as worth keeping.
Holding conversations to the same rules, record and recovery as processes means
the person never has to choose between the convenient way to work and the safe
one.

## Success shows as conversations kept going, recovered rather than restarted, and never outside the rules

| Metric | Read from | Success |
| --- | --- | --- |
| Conversations continued on a later day | The record of each conversation's messages and the days they were sent | Rises |
| Conversations started again from scratch after a wrong turn instead of edited, rewound or branched | The record of new conversations that repeat an earlier one's opening, against edits, rewinds and branches | Falls |
| Agent actions in conversations that bypassed the project's approval rules | The record of every action an agent took in a conversation and the rule that allowed it | Falls to zero |
