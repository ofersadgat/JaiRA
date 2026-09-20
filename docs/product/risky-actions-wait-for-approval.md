---
id: product/risky-actions-wait-for-approval
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can let agents work in my repository knowing that anything that destroys history is refused and anything risky, such as pushing, publishing, reaching the network or touching secrets, waits for my approval, so that an agent cannot do damage I did not sanction."
importance: 0.85
audience: user
metrics:
  - "Commands that destroyed history and reached the repository from an agent: falls"
  - "Commands the rules hold for approval that ran without a person allowing them: falls"
  - "Work refused because its agent could not be supervised under the project's rules: falls"
requires: [product/hand-work-to-agents]
related: [product/agents-act-only-where-allowed, product/only-approved-code-runs, product/everything-waiting-on-you-together, product/chat-with-agents, product/decisions-stay-yours]
verified_by: []
---

# Agents cannot destroy history, and anything risky they try waits for your approval

> As a developer, I can let agents work in my repository knowing that anything that destroys history is refused and anything risky, such as pushing, publishing, reaching the network or touching secrets, waits for my approval, so that an agent cannot do damage I did not sanction.

## Without this, letting an agent run commands in your repository means trusting it with everything

The person is a developer who lets coding agents run commands in their real
repository. An agent that can run commands can force-push over published
history, throw away uncommitted work, publish a package or read credentials by
misreading its task. Unbounded, the only safe choice is to let it run nothing.

## History-destroying commands are refused, and risky ones stop until a person allows them

Every command an agent runs is judged by what it would actually do. A
destructive command hidden inside a wrapper or placed after a harmless one is
still caught, and the strictest judgement of anything in the command decides.

Commands that rewrite or destroy version history, discard uncommitted work or
delete untracked files are refused. Commands that push or merge, change where
work is published, change settings for every repository, reach the network,
publish or install packages, deploy, or touch credentials stop and wait. The
person sees the exact command and why it stopped, and allows or denies it. A
command that cannot be understood waits too and is never treated as safe.

A project's own rules for which commands are allowed, wait or are refused are
consulted before the built-in ones, so a project can tighten or loosen any of
them, or turn the built-in ones off.

Stopping the work denies whatever was waiting and anything asked afterwards, and
closing its project denies whatever was waiting. Agents are refused the files where the product keeps
a project's processes and records. Work whose agent cannot be supervised this
way is refused rather than run unguarded. Every command an agent asks to run is
recorded with what was decided and whether a rule or a person decided it.

## The worst an agent can do must be bounded before it gets a real repository

Handing an agent a real repository is reasonable only when the worst it can do
is known in advance. With history protected and risky commands waiting for a
yes, the damage a person fears most cannot happen without them.

## Success shows as no destroyed history and no risky command running unallowed

| Metric | Read from | Success |
| --- | --- | --- |
| Commands that destroyed history and reached the repository from an agent | The record of every command an agent asked to run and what was decided about it | Stays at zero |
| Commands the rules hold for approval that ran without a person allowing them | The record of every command an agent asked to run and what was decided about it | Stays at zero |
| Work refused because its agent could not be supervised under the project's rules | The record of work refused before it started and the reason for each | Falls as setups are fixed |
