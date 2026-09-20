---
id: product/share-processes-across-projects
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can keep processes, prompts and settings once for every project on my machine and override any single piece of them in one project, so that improving a process improves it everywhere while a project can still differ where it must."
importance: 0.65
audience: developer
metrics:
  - "Projects running a process kept once for the machine: rises"
  - "Copies of the same process kept separately in several projects: falls"
requires: [product/repeatable-agent-processes]
related: [product/all-projects-in-one-place, product/bring-your-own-models-and-agents, product/catch-process-mistakes-before-running]
verified_by: []
---

# A process kept once serves every project, and a project changes only the part it needs

> As a developer, I can keep processes, prompts and settings once for every project on my machine and override any single piece of them in one project, so that improving a process improves it everywhere while a project can still differ where it must.

## Without this, every repository keeps its own copy and a fix lands in only one

The person is a developer with several repositories who uses the same processes,
prompts and settings in all of them. Kept per project, the copies drift. A fix
made in one never reaches the others, and the same process soon does different
things in different places. One copy with no way to differ forces every project
to accept what fits only some of them.

## You keep a process once for the machine and replace only the piece a project needs

Processes, prompts, reusable passages and settings can be kept once for every
project on the machine. Any project can run a shared process without containing
it.

A project can replace a single step or a single prompt of a shared process with
its own. Everything it did not replace still comes from the shared process, so
later improvements to the rest still reach it. A shared piece can be copied into
a project to become that project's own, and a project's piece can be copied out
to be shared.

Settings combine the same way. Shared settings apply everywhere, a project's own
settings apply wherever it sets something, and the person can see the combined
result that work in the project will use.

Changing a shared piece tells the person that the change reaches every project
that has not replaced it.

Shared processes can be written, checked and run with no project open, and the
record of that work is kept with the shared processes rather than in whichever
project happens to be open.

## One shared process with local exceptions stays one process

Improving a process is worth more when the improvement reaches every repository
at once. Letting a project differ in one step keeps it on the shared process
instead of pushing it to copy the whole thing.

## Success shows as more projects on one shared process and fewer duplicate copies

| Metric | Read from | Success |
| --- | --- | --- |
| Projects running a process kept once for the machine | The record of which process each piece of work ran and where that process was kept | Rises |
| Copies of the same process kept separately in several projects | The processes of each project compared with each other and with the shared ones | Falls |
