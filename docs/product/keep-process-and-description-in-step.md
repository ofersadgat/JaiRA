---
id: product/keep-process-and-description-in-step
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can describe in plain language what my processes should do and be told, requirement by requirement, where the processes and the description disagree, with the edits that would bring either one in line, so that the process I believe I have is the one that runs."
importance: 0.5
audience: developer
metrics:
  - "Descriptions whose processes meet them when checked: rises"
  - "Builds failed by the check that pass again within a day: rises"
requires: [product/repeatable-agent-processes, product/review-changes-before-they-land]
related: [product/catch-process-mistakes-before-running, product/run-headless-and-in-ci]
verified_by: []
---

# Your processes are checked against your own description of what they should do

> As a developer, I can describe in plain language what my processes should do and be told, requirement by requirement, where the processes and the description disagree, with the edits that would bring either one in line, so that the process I believe I have is the one that runs.

## Without this, a process drifts from what its author believes it does and nothing notices

The person is a developer whose processes change over weeks, a step at a time,
sometimes by other people or by agents. Each change can be sound on its own and
still leave the process doing something its author never meant. Checking how a
process is written cannot see that, because nothing is written wrongly. The
process simply no longer does what was intended.

## You say what the processes should do, and each requirement is checked against them

A person keeps a plain-language description with the processes it describes.
They are told whether the description or the processes changed since the two
last agreed, and which of the two probably needs to follow the other.

They can have the description rewritten to match the processes, or have changes
to the processes proposed to match the description. Either way they are told,
for each requirement, whether the processes meet it, and what the processes do
that the description never mentions. The agent doing the comparison only reads.
Nothing is written until the person accepts it, and proposed changes to a
process are reviewed change by change.

The same check runs from a terminal and fails a build when the processes do not
meet their description.

## A check against the author's own words catches the drift that matters

The mistakes that do most harm are not broken processes but working ones that do
the wrong thing. Only the author's intent can reveal those, and writing that
intent down once lets it be checked every time the process changes.

## Success shows as more processes meeting their description and drift fixed quickly

| Metric | Read from | Success |
| --- | --- | --- |
| Descriptions whose processes meet them when checked | The record of each check and its verdict | Rises |
| Builds failed by the check that pass again within a day | The record of builds failed by the check and when the same check next passed | Rises |
