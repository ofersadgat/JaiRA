---
id: product/work-inside-wsl
type: product-feature
status: shipped
updated: 2026-09-13
story: "As an operator on Windows, I can have a project's agents, commands and git run inside a Linux distribution, so that work happens in the environment the project is actually built for."
importance: 0.3
audience: operator
metrics:
  - "Work failing on path or environment mismatches in projects that run inside Linux: falls"
requires: [product/parallel-work-without-collisions]
related: [product/bring-your-own-models-and-agents, product/risky-actions-wait-for-approval]
verified_by: []
---

# On Windows, a project's agents, commands and git run inside the Linux it is built for

> As an operator on Windows, I can have a project's agents, commands and git run inside a Linux distribution, so that work happens in the environment the project is actually built for.

## Without this, agents on Windows work in an environment the project does not run in

The person is an operator on Windows whose project builds and tests on Linux.
Agents, commands and git running natively on Windows check their work in an
environment that does not match where the project runs, and a path means
something different on each side.

## A project names a Linux distribution, and everything for that project runs inside it

A project can name a Linux distribution on the machine. From then on every
command, git operation and agent for that project runs inside that
distribution, and paths are translated between Windows and Linux in both
directions. Git is never run from Windows against the Linux files.

Nothing about a process changes to run there. The same process runs on Windows
or inside Linux depending only on the project it runs in. Commands agents run
are judged for risk as the Linux shell would read them.

## Work is only trustworthy when it is done where the project runs

Many projects build and test correctly only on Linux. A test an agent ran on
Windows says little about such a project, and a change that passes there can
fail where the project actually runs. Setting this once per project removes
that gap for every piece of work in it.

## Success shows as fewer failures from Windows and Linux disagreeing

| Metric | Read from | Success |
| --- | --- | --- |
| Work failing on path or environment mismatches in projects that run inside Linux | The record of why work failed, for projects set to run inside a Linux distribution | Falls |
