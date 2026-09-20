---
id: ux/patterns/inherited-unless-set-here
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/share-processes-across-projects, product/bring-your-own-models-and-agents, product/chat-with-agents, product/agents-act-only-where-allowed]
siblings: [ux/patterns/schema-driven-form, ux/patterns/secret-goes-in-never-comes-back, ux/patterns/checked-status-with-the-fix, ux/patterns/preview-beside-the-setting]
---

# Inherited unless set here

A decision can be made at a wide scope and a narrow one, and the narrower decision wins: every project on the machine, then one project, then one message to an agent. A group of file kinds and one kind in it layer the same way. At the layer being edited, each setting shows the value in effect and whether it is set here or inherited, and from where. Setting a value writes it to that layer only, and releasing it returns to what the wider layer or the built-in default says. The combined result of every layer can be read on its own. A process file or prompt kept for every project can be copied into one project to override it there, and a project's own copy can be copied out to share it.

## Use it when the same decision is legitimately made at more than one level

**Use when.** A decision applies widely but a project or a message may need to differ: providers and agents, which model does which work, where agents may act, and the processes and prompts every project shares.

**Do not use when.** The decision is made in one place only and has nothing to inherit. The value is a secret: only its presence is shown, as in [secret-goes-in-never-comes-back](secret-goes-in-never-comes-back.md).

## The person reads what applies and why, then overrides or releases it at one layer

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Chooses the layer to edit | Shows each setting's value in effect, marked as set here or inherited | What applies and where it comes from |
| 2 | Sets a value | Writes it to that layer only | This layer now overrides the wider one |
| 3 | Releases it by switching it off, emptying it or resetting it | Removes it from that layer | It follows the wider layer again, and which value that is |
| 4 | Reads the combined result | Shows every layer merged, with defaults filled in | What will actually apply |

## Every state says which layer decides and how to change that

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | A layer with nothing written reads as empty, and every value shows as inherited from the wider layer or the default | Set a value here |
| empty | A layer that sets nothing of its own says the wider layers and built-in defaults decide everything | Set a value here |
| loading | A value the app works out from what is available says it is not resolved until the check reports | Wait, or set a value by hand |
| partial | A group whose members are set differently shows no single value and says they disagree | Set one value for the whole group |
| error | Settings that cannot be read say so and show nothing to edit | Fix the settings file |
| denied | With no project open there is no project layer to choose, and the settings say only the shared layer can be edited | Edit the shared layer, or open a project |
| success | Each value says whether it is set here, inherited, worked out from what is available, or pinned. A choice for one message says it is the person's own or where it is inherited from | Release a value, or read the combined result |

## Releasing a value is the only undo, and unsaved typing is lost on switching layer

Releasing a value undoes setting it. No history of earlier values is kept.

Settings changed through a form are written as they change. Some settings, such as a provider's fields, are saved explicitly, and typing not saved there is discarded without warning when the person switches layer or leaves.

A shared piece copied into a project is a separate copy that hides the shared one in that project. Later changes to the shared piece do not reach that project while the copy exists.

## Layers switch by keyboard, but the set-here mark is not tied to its field

**Keyboard only.** Layers are chosen with ordinary buttons reached by Tab. Switching an optional value on or off uses a real switch.

**Screen reader.** The layer buttons do not announce which layer is chosen. The mark saying a value is set here is text beside the field and is not announced with it.

**Small window.** Fields stack into one column.

**Slow machine.** A value worked out from what is available shows as not resolved until the check reports, as in [checked-status-with-the-fix](checked-status-with-the-fix.md).
