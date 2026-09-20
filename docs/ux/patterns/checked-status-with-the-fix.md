---
id: ux/patterns/checked-status-with-the-fix
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/bring-your-own-models-and-agents, product/find-out-why-the-app-misbehaves]
siblings: [ux/patterns/refuse-with-the-reason-and-the-fix, ux/patterns/secret-goes-in-never-comes-back, ux/patterns/inherited-unless-set-here]
---

# Checked status with the fix

Each model provider and coding agent the product can use shows what its last check found, in one word: ready, not working, not set up, turned off, or not checked. Beside the word are the detail and the concrete fix, and the list says how long ago the checks ran. A check never spends anything: it asks an agent for its version, or confirms that a key is present, a server connects, or model weights exist, and never asks a model for a response. Checks run by themselves at startup, when a project opens and after every settings change, and the person can run them again. A capability switched off says so rather than reading as broken.

## Use it when the product depends on outside tools or accounts that can stop working unnoticed

**Use when.** Work depends on a provider, agent or account that can break between runs, and the person needs to know which one before work fails on it.

**Do not use when.** Checking would cost money or change something: the check must be free and read-only. An action was refused: use [refuse-with-the-reason-and-the-fix](refuse-with-the-reason-and-the-fix.md).

## The person reads the last result, applies the fix, and the next check confirms it

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Opens the list of providers and agents | Shows what the last check found for each, and when the checks ran | What works, and how fresh that is |
| 2 | Changes a setting, stores a key, or asks to check again | Checks again within short time limits, and says it is checking when asked | The new status once the check reports |
| 3 | Applies the fix shown | Checks again after the change | Whether the fix worked |

## Every state names the status and what would make it ready

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Until the startup check reports, what the app would use says it is not resolved. If that check fails, it keeps saying so | Check again |
| empty | With nothing able to answer a prompt, the list says so and names the three ways to get one: a provider key, a local server, or an agent that runs | Add one |
| loading | A requested check says it is checking. A check asked for during another runs once that one finishes | Wait |
| partial | Some are ready and some are not. The time since the check is as of when the list was drawn and does not advance while it stays open | Fix the rest |
| error | Not working, with the detail and the suggested fix. If the results cannot be fetched, nothing says so and the last results stay | Apply the fix and check again |
| denied | Turned off, with a switch to use it again | Turn it back on |
| success | Ready, with the version where there is one | Use it |

## A check changes nothing, so only switching a capability off has anything to undo

Checking is read-only and can be repeated at no cost. Switching a capability off is undone by switching it back on. Leaving the list loses nothing.

## The status is read as a word, and every check has a time limit

**Keyboard only.** Each entry opens with a control that says whether it is open. Each on-off switch is a real switch.

**Screen reader.** The status is announced as its word. A switch is named for this project even when the shared layer is being edited.

**Small window.** Entries are not rearranged for a narrow window.

**Slow machine.** An agent check gives up after 10 seconds and a connection check after 1.5 seconds.

## This departs from the UX principles in one place

A startup check that fails leaves the result saying it is not resolved, so that wait has no end.
