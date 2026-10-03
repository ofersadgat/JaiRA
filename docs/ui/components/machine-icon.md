---
id: ui/components/machine-icon
type: ui-component
status: shipped
updated: 2026-10-02
realizes: [ux/patterns/live-facts-and-unseen-counts]
serves: [product/all-projects-in-one-place, product/parallel-work-without-collisions]
surfaces: [ui/surfaces/chat-view, ui/surfaces/settings-view]
reuses: [ui/components/icon]
implemented_by: [packages/universal/src/components/MachineIcon.tsx, packages/app/src/renderer/machineIcons.ts, packages/app/src/renderer/environmentModel.ts]
verified_by: [packages/app/test/environmentModel.test.ts, packages/client/src/specimens/environmentSpecimens.tsx#machine-icons]
mockups: [ui/assets/machine-icon/default.html]
siblings: [ui/components/icon, ui/components/environment-bar]
---

# Machine icon

A small line drawing of a computer — a screen on a stand, a laptop, a flat box, two stacked units or a phone — with a tiny operating-system mark on its bottom-right corner and a coloured dot on its top-right corner.

## One icon says what a machine is, what it runs and whether it is reachable

**Use when.** A machine is named: in the [environment-bar](environment-bar.md) and its list, in the chip beside a conversation's title, in the rows of a [placement-summary](placement-summary.md), and beside the control in Settings that says what this machine is.

**Do not use when.** The thing named is a project, a workspace or a model: those have a folder, a dot in the project's hue, and a company's mark.

## The shape is the machine, and two marks sit on its corners

- **Shape.** What the machine is, stroked 1.7 on a 24 grid in `--text`: `desktop` a screen on a stand, `laptop` a lid over a base, `mini` a flat box with one light, `server` two stacked units, `phone` a tall rounded slab. The shape is the largest thing in the icon.
- **System.** What it runs, at 0.44 of the icon's size and never under 7px, centred on the shape's bottom-right corner in `--dim`: four squares for Windows, the apple for macOS and iOS, the penguin for Linux, a head with antennae for Android. It has no ground of its own, so the shape shows through it.
- **Dot.** Whether it can be reached, at 0.3 of the icon's size and never under 5px, centred on the shape's top-right corner: `--ok` connected, `--warn` connecting, `--bad` offline or running a version that cannot be used. A ring in the colour of whatever the icon stands on parts the dot from the line under it.
- **Room.** The system's mark runs past the shape's right edge, so half its width is kept clear after the icon.

## The icon has a state for each connection and one for no machine

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Nothing decided: the desktop's screen, dashed, in `--dim`, with no mark and no dot. | [default.html](../assets/machine-icon/default.html) |
| loading | Connecting: the dot in `--warn`. | [default.html](../assets/machine-icon/default.html) |
| partial | In a row of a placement summary the icon carries no dot and takes the row's colour: `--bad` on an ask that was refused. | [queued.html](../assets/chat-view/queued.html) |
| error | Offline or unusable: the dot in `--bad`; in a list the shape is `--dim`. | [default.html](../assets/machine-icon/default.html) |
| success | Connected: the dot in `--ok`. | [default.html](../assets/machine-icon/default.html) |

## The icon is not pressed

The icon is never a control by itself. The bar's machine, the title's chip and a list row are the controls, and the icon is their first element.

## Its words stand beside it

| Where | String |
| --- | --- |
| What a machine is | `{OS} {form}`: `Windows desktop`, `Mac mini`, `Mac laptop`, `Linux server`, `Linux laptop` |
| Settings → Machines | `What it is` · `The shape of this machine's icon, wherever it is named. Guessed once; yours to correct.` · `Desktop` · `Laptop` · `Mini` · `Server` |

A machine's form is guessed once, when the machine is first named: a battery makes it a laptop, a Mac that calls itself a mini is a mini, a Linux machine with no display is a server, anything else a desktop. The person corrects it in Settings → Machines.

## The icon is drawn at four sizes and keeps its marks legible

- Sizes: 13px in a summary's row, 14px in the title's chip, 16px in the bar, 18px in the list, 20px in Settings. The mark and the dot scale with it down to their floors.
- Theme: every colour is a token.
- The work ring that sits beside a workspace is its sibling: an open ring in `--accent`, stroked 2.6, with the number of tasks at work and waiting there inside it in `--text` at weight 700.

## The system marks are filled where every other icon is stroked

The Windows, Apple and Linux marks are filled shapes, because each is recognised by its silhouette; the Android head is stroked like the rest.
