---
id: product/bring-your-own-models-and-agents
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can connect the model providers and coding agents I already use, by subscription or by API key, check that each one works, and choose which does which work, so that my processes run on the accounts and tools I already have."
importance: 0.8
audience: user
metrics:
  - "Work that fails because a model or agent could not be reached or had no key: falls"
  - "Keys found in what a project commits: falls"
  - "Time from first opening the app to the first piece of work that finishes: falls"
requires: []
related: [product/hand-work-to-agents, product/chat-with-agents, product/share-processes-across-projects]
verified_by: []
---

# Your processes run on the model accounts and coding agents you already have

> As a developer, I can connect the model providers and coding agents I already use, by subscription or by API key, check that each one works, and choose which does which work, so that my processes run on the accounts and tools I already have.

## Without this, agent work means another account or a key copied into the repository

The person is a developer who already pays for model access, through a
subscription to a coding agent, an API key with a provider, or both. A tool that
needs its own account makes them pay twice. A tool that wants a key written into
the project puts a secret where it may be committed. A connection nobody checked
is found broken by the first piece of work that relies on it.

## You connect what you already use, see whether it works, and say which does what

A person connects model providers and the coding agents installed on their
machine, including agents that run on a subscription with no API key at all. A
connection can be turned off without being removed.

Every connection is checked when a project opens or its setup changes, and again
whenever the person asks. The answer says whether it is ready, not working, not set up or
turned off, and when it is not working, what is wrong and what would fix it.
Checking never asks a model to do any work, so it costs nothing.

A key never has to go into anything the project commits. The app can keep it
encrypted on the machine, and work also finds keys where developers already keep
them. Once given, a key is not shown again, only that it is there and where it
is kept.

A person decides which model or agent does work by default for every project on
the machine, for one project, or for one part of a process, and the narrower
choice wins. Where nothing names a model, work goes to one this machine can
serve it with. Work that nothing connected can serve is refused before it
starts.

## Paying twice or exposing a key stops people starting, and a broken connection fails mid-run

Using the accounts a person already has means the first piece of work can start
the day they install. Knowing which connections work means work does not fail
hours in on a missing key.

## Success shows as fewer runs failing on access and a shorter way to first finished work

| Metric | Read from | Success |
| --- | --- | --- |
| Work that fails because a model or agent could not be reached or had no key | The record of each failure and its reason | Falls |
| Keys found in what a project commits | The project's committed history, searched for keys | Falls to zero |
| Time from first opening the app to the first piece of work that finishes | The record of when the app was first opened and when work first finished | Falls |
