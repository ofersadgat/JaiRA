---
id: product/all-projects-in-one-place
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can have every repository I work in open together, and still open tomorrow, with what is running and what needs me in each visible without going into it, so that switching projects never means losing sight of the others."
importance: 0.65
audience: user
metrics:
  - "Projects with work running at the same time per person: rises"
  - "Projects opened again by hand right after the app starts: falls"
requires: [product/hand-work-to-agents]
related: [product/see-what-changed-since-you-looked, product/everything-waiting-on-you-together, product/share-processes-across-projects, product/keep-track-of-everything]
verified_by: []
---

# Every repository you work in stays open together, and none drops out of sight

> As a developer, I can have every repository I work in open together, and still open tomorrow, with what is running and what needs me in each visible without going into it, so that switching projects never means losing sight of the others.

## Without this, working in one project means losing sight of the others

The person is a developer whose work spans several repositories, with agents
running in more than one of them at a time. When only one project is in view,
the agents running in the others are out of sight, and those are the ones that
end up forgotten.

## Several projects stay open at once and are open again after a restart

Opening a project never closes another. A person can have every repository they
work in open together and see what is running and what needs them in each
without going into it. They can look at the work of all open projects together,
or at one project's work and conversations on their own. Two checkouts of the
same repository are separate projects, told apart by where they live.

The projects open when the app closed are open again when it starts. A project
whose folder was deleted or moved is forgotten. One that is only unreachable for
the moment, such as a project on a drive that is not connected, is kept and tried
again next time.

Opening a folder that has never been set up offers to set it up rather than
reporting an error.

## Developers rarely work in one repository, and a project out of sight is where work gets forgotten

Agents are handed work so that several things move at once, and in practice
those things are spread across repositories. Keeping every project open and
accounted for means switching to one never costs the person their view of the
rest, and a restart never costs them the set of projects they had.

## Success shows as more projects with work going at once and none reopened by hand

| Metric | Read from | Success |
| --- | --- | --- |
| Projects with work running at the same time per person | The record of what was running when, by project | Rises |
| Projects opened again by hand right after the app starts | The record of which projects were open when the app closed and which the person opened after it started | Falls to zero |
