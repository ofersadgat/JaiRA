---
id: ux/patterns/secret-goes-in-never-comes-back
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/bring-your-own-models-and-agents]
siblings: [ux/patterns/checked-status-with-the-fix, ux/patterns/inherited-unless-set-here, ux/patterns/schema-driven-form]
---

# Secret goes in, never comes back

A secret is entered once, into a masked field, with a choice of where it is kept: the machine's encrypted keychain, a file for this project that is not meant to be committed, or a file shared by every project on the machine. Only the secret's name is written into settings, which may be committed. Afterwards the product shows the name and where the secret was found, which is the first place it looks that holds it, or that it was found nowhere. The value is never shown again, and replacing or clearing it means entering a new value. An agent that signs itself in asks for no key and names the command that signs it in.

## Use it whenever the product must keep a credential for later use

**Use when.** A provider or agent needs a key the product will look up each time it is used.

**Do not use when.** The value is not sensitive: it is an ordinary setting, as in [inherited-unless-set-here](inherited-unless-set-here.md). The agent manages its own sign-in.

## The person hands the value over once and afterwards sees only that it is there

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Chooses to add or replace a key | Asks for a name when none is known, the value masked, and where to keep it, offering the keychain first where the machine has one | Where it will be kept |
| 2 | Stores it | Checks the name, sends the value to the chosen place, writes only the name into the layer being edited, clears the entry and checks again | That it was handed over |
| 3 | Returns later | Shows the key's name and where it was found, or that it was found nowhere | That it is present, never what it is |

## Every state says whether the key is found and where, never what it is

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | A provider with no key names none and offers to add one | Add a key |
| empty | Storing an empty value clears the key from the chosen place | Enter a value to add it again |
| loading | Cannot occur as its own state: the entry closes as soon as the key is sent, and the status changes when the next check reports | Wait for the check |
| partial | A key named in settings but found nowhere says so | Store the value |
| error | An invalid name is refused beside the entry. A failure to store is reported apart from the entry after it has closed, so the value must be typed again | Enter the key again |
| denied | The keychain is not offered where the machine has none, and the project's file is not offered with no project open. An agent that signs itself in names the command to run instead | Keep it elsewhere, or sign the agent in |
| success | The key's name and where it was found. A key in the keychain is found by the app only, and work run from a terminal does not find it | Replace the key |

## Storing cannot be undone, only replaced, and cancelling keeps nothing

A stored key is changed only by replacing it or by storing an empty value, and the earlier value is gone. Cancelling or leaving the entry discards what was typed and stores nothing.

## The entry works by keyboard, but its fields are not named for a screen reader

**Keyboard only.** The entry uses ordinary fields and buttons reached by Tab.

**Screen reader.** The masked field and the choice of place have no names, so they are announced without saying what they hold.

**Small window.** The entry is not rearranged for a narrow window.

**Slow machine.** The entry closes before the store answers. Whether the key is found shows only when the check after storing reports.
