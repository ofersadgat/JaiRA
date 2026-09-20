---
id: product/agents-act-only-where-allowed
type: product-feature
status: shipped
updated: 2026-09-13
story: "As an operator, I can say which places in a project each agent may read, write or run commands in, so that an agent's reach is limited to where its work is."
importance: 0.5
audience: operator
metrics:
  - "Approval requests per piece of work: falls"
  - "Actions an agent took in a place its limits refuse: falls"
requires: [product/risky-actions-wait-for-approval]
related: [product/parallel-work-without-collisions, product/share-processes-across-projects, product/bring-your-own-models-and-agents]
verified_by: []
---

# Each agent's reach is limited to the places its work belongs

> As an operator, I can say which places in a project each agent may read, write or run commands in, so that an agent's reach is limited to where its work is.

## Without this, an agent allowed to write can write anywhere

The person is an operator setting up a project for agents. Permission to use a
tool is otherwise all or nothing: an agent allowed to write files can write any
file, and one allowed to run commands can run them anywhere. The only other way
to keep it out of a place is to be asked about every action, and a question for
every file is noise people learn to allow without reading.

## You say what an agent may do in each place, and everywhere you did not name is refused

An operator says, for each agent, what it may do in which places in a project:
read, write or run commands. In each place an action can be allowed, wait for a
person's approval, or be refused. An agent can be allowed to read anywhere but
write only under one folder, or to run commands only inside one working
directory. Addresses on the network can be limited the same way for the tools
that fetch from them.

The most specific limit for a place wins. Once places are set for an agent, a
place no limit covers is refused. An action that concerns more than one place
gets the strictest answer any of those places gives.

A search an agent runs does not reveal files it would not be allowed to open.
The same limits hold whether the agent uses the tools the product gives it or
the tools it came with. A single step of a process can narrow an agent's reach
further but never widen it.

## Limits on places let safe work go ahead and keep the rest out of reach

Most of an agent's work happens in a few places where it is harmless. Saying so
once lets that work go ahead without a question, and makes everywhere else
unreachable rather than one careless approval away.

## Success shows as fewer questions per piece of work and nothing done outside its places

| Metric | Read from | Success |
| --- | --- | --- |
| Approval requests per piece of work | The record of every approval asked for and the work that asked it | Falls once places are set |
| Actions an agent took in a place its limits refuse | The record of every permission decision made for an agent's actions | Stays at zero |
