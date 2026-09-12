---
id: product/keep-track-of-everything
type: product-feature
status: proposed
updated: 2026-09-11
story: "As a developer with many agents and conversations going at once, I can keep track of everything that is going on and get to any of it in seconds, so that nothing is lost and nothing depends on my memory."
importance: 1.0
audience: user
metrics:
  - "Runs a person keeps going at the same time: rises."
  - "Work started and then never returned to: falls."
  - "Time from wanting a particular piece of work to being in it: the median falls."
  - "Work restarted from the beginning rather than resumed: falls."
requires: []
related: [product/nothing-stalls-in-silence]
verified_by: []
---

# You can see everything that is going on, and reach any of it in seconds

> As a developer with many agents and conversations going at once, I can keep track of everything that is going on and get to any of it in seconds, so that nothing is lost and nothing depends on my memory.

## How much you can have going is capped by how much you can remember

The person is the developer in [principles.md](principles.md): someone who hands
work to coding agents and wants it reproducible, interruptible and reviewable.

An agent works for minutes or hours without you, and you start the next thing
while it does. Within an hour there are runs in several workflows, conversations
you were in the middle of, and one of them is waiting for a decision. The limit
on all this is not the machine. It is that keeping track of it is yours to do,
and the moment you lose one you lose it completely: it holds a workspace and a
branch, it may have been waiting on you since morning, and nothing will mention
it again.

So people run less at once than they could, keep a list on the side, and go
looking through the product for things they know are in there somewhere.

## Everything you have going is accounted for, and getting to it is not a search

Every run and every conversation you have is accounted for, including the ones
you would have to look up because you no longer remember what they were called.
Reaching any of them is direct. You do not open somewhere in order to start
looking.

What is going on is grouped under the workflow it came from, so you can tell how
each of your workflows is doing without opening any of them, and a workflow in
trouble looks like a workflow in trouble rather than several unrelated bad runs.
Work an agent started for its own purposes is accounted for under the work that
started it, so what you see is the work you asked for and not the machinery
underneath it.

Work you are in the middle of is never buried under work that is over. How
recent something is means the last time it actually moved, whether that was an
agent taking a step or you sending a message. Something typed and not sent
changed nothing and did not move.

You decide what your work is grouped by and what counts as most relevant.
Unless you say otherwise, that is whatever changed most recently. What you chose
holds when you come back tomorrow. Where only one arrangement makes sense you
are not asked: work belonging to a workflow is always grouped by workflow. The
words for states are the same words everywhere states appear, so there is one
vocabulary and it holds throughout.

Looking at your work never changes it. Nothing is answered, stopped or renamed
in the act of finding it.

## Parallel work is the reason to be here, and it is only worth having if you can hold it

The point of handing work to agents is that several of them work while you do
something else. That returns nothing if the price is holding them all in your
head, because then the number you can safely have going is the number you can
remember, which is what you had before.

It is also what makes the guarantees real. Work that stops rather than guess is
only a benefit if you come back to it, and a promise you keep by remembering is
not a promise the product is keeping.

## Success shows as more going on at once and less of it lost

| Metric | Read from | Success |
| --- | --- | --- |
| Runs a person keeps going at the same time | The record of what was running when | Rises, because the cap was attention rather than capacity |
| Work started and then never returned to | The record of what was started against what was opened | Falls |
| Time from wanting a particular piece of work to being in it | The record of when work was looked for and when it was opened | The median falls |
| Work restarted from the beginning rather than resumed | The record of work that repeats work already done | Falls, because what was unfinished was found |

If people do not end up with more going on at once, attention was not the
constraint and this should be withdrawn rather than extended.

## This assumes helping people keep track earns its place

The principles do not yet say what is optimized for. This asserts that effort
spent on keeping people on top of their work is worth it, on the grounds that
work nobody can find is not interruptible in any sense the person experiences.
