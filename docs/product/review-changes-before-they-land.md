---
id: product/review-changes-before-they-land
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can go through the changes an agent made or proposes one at a time, and keep, drop, edit or comment on each, down to single lines, before any of them land, so that nothing reaches my code unread."
importance: 0.8
audience: user
metrics:
  - "Changes applied that the person never opened: falls"
  - "Reviews that keep some changes and refuse others rather than all or nothing: rises"
requires: [product/decisions-stay-yours]
related: [product/parallel-work-without-collisions, product/decide-with-the-context-in-front-of-you, product/keep-process-and-description-in-step, product/read-what-work-produced]
verified_by: []
---

# Every change an agent makes or proposes is yours to keep, drop or rewrite before it lands

> As a developer, I can go through the changes an agent made or proposes one at a time, and keep, drop, edit or comment on each, down to single lines, before any of them land, so that nothing reaches my code unread.

## Without this, agent changes are taken or thrown away whole, often unread

The person is a developer whose agents change code. A piece of work's changes
arrive as one lump: accept all of it, including the parts nobody read, or throw
all of it away for one bad edit. Either code nobody read reaches the repository,
or good work is lost with the bad.

## You decide each change, down to single lines, and only what you kept lands

A set of changes can be reviewed change by change before any of it lands. The
set can be the edits an agent made on its branch or files a process proposes to
write.

For each change the person can keep it, refuse it, refuse only some of its
lines, rewrite it, or comment on it and on specific lines of it.

The person is warned when a file has changed since the change was proposed, or
holds unsaved edits of their own. Nothing is applied over a file that changed.

Before sending, the person is told how many changes they kept, refused, commented
on and never opened. A review sent with no comments lands exactly as decided:
kept changes land, refused ones do not, and refused edits an agent already made
are rolled back. A review sent with any comment applies nothing and returns the
whole set with its comments. A process can answer those comments with a revised
set to review again.

## Reading every change is what makes agents usable on real code

Code an agent changed that nobody read is the failure that makes people stop
trusting agents with real repositories. Deciding per change and per line keeps
the good edits of a piece of work instead of throwing it all away for one bad
part.

## Success shows as nothing applied unopened and more reviews that keep part of the work

| Metric | Read from | Success |
| --- | --- | --- |
| Changes applied that the person never opened | The record of each review, what was applied and what the person opened | Falls |
| Reviews that keep some changes and refuse others rather than all or nothing | The record of the decision on every change in each review | Rises |
