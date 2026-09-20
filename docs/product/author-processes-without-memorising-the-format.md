---
id: product/author-processes-without-memorising-the-format
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can build and change processes with help that knows what every part of a process means and offers only the names that exist, or write them by hand, so that authoring does not depend on remembering how a process is written or what things are called."
importance: 0.6
audience: developer
metrics:
  - "Mistakes in a process that refer to something that does not exist: falls"
  - "Processes changed by someone other than the person who wrote them: rises"
requires: [product/repeatable-agent-processes]
related: [product/catch-process-mistakes-before-running, product/see-how-a-process-flows, product/share-processes-across-projects]
verified_by: []
---

# Building a process does not depend on remembering how it is written or what things are called

> As a developer, I can build and change processes with help that knows what every part of a process means and offers only the names that exist, or write them by hand, so that authoring does not depend on remembering how a process is written or what things are called.

## Without this, changing a process means recalling exact names and rules from memory

The person is a developer changing a process they did not write, or have not
touched in weeks. A process refers to its steps, values, prompts and code by
name, and has rules about what belongs where. A misremembered name refers to
nothing and is found only when the process is checked or run. So only the
original author changes a process with confidence, and even they keep the rules
open beside them.

## Help knows what each part of a process means and offers only what exists

Wherever a process refers to a value, a step, a prompt or a piece of code, the
person chooses from what actually exists at that point, so no name has to be
remembered.

The parts of a step are changed with help that knows what each means: what the
step needs and hands on, what it does, which steps it contains, where the work
goes next and its limits. Adding a step inside another sets out the inputs it
needs, ready to be connected. A reference to a prompt or passage shows what it
says without leaving the step.

A structured document whose shape is known is written with help that knows what
belongs in it and can add what is missing. Prompts are written as the formatted
documents they are, with the code in them treated as code.

A person who prefers to write a process by hand still can, and the guided way and
the hand-written text are always the same process.

Renaming or deleting something other steps depend on first says which steps
depend on it. Unsaved changes stay with what they change while the person looks
at something else.

## Picking from what exists removes a whole kind of silent mistake and opens a process to more people

Choosing from what exists removes the name that refers to nothing, which is easy
to write and hard to see. A process that can be changed without knowing its rules
by heart can be improved by whoever uses it, not only by whoever wrote it.

## Success shows as fewer references to nothing and more people changing processes

| Metric | Read from | Success |
| --- | --- | --- |
| Mistakes in a process that refer to something that does not exist | The record of mistakes reported after each change to a process | Falls |
| Processes changed by someone other than the person who wrote them | The repository's history of changes to each process | Rises |
