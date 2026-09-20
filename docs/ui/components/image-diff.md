---
id: ui/components/image-diff
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/per-change-review, ux/patterns/absence-is-stated]
serves: [product/review-changes-before-they-land, product/read-what-work-produced]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal]
reuses: []
implemented_by: [packages/app/src/renderer/imageDiff.tsx]
verified_by: []
mockups: [ui/assets/image-diff/empty.html, ui/assets/image-diff/one-version.html, ui/assets/image-diff/overlay.html, ui/assets/image-diff/side-by-side.html]
siblings: [ui/components/diff-editor, ui/components/changeset-review, ui/components/value-view]
---

# Image diff

Two versions of a picture: stacked on a grey checkerboard with a `before`–`after` fade slider, or in two captioned columns, switched by a small joined `Overlay | Side by side` toggle at the right; a single captioned picture when the change added or removed the file.

## The image diff is how a review compares a changed picture

**Use when.** A change under review is an image file and the change carries the picture itself, such as a produced artifact. It takes the place of the [diff-editor](diff-editor.md) in the chosen change of a [changeset-review](changeset-review.md).

**Do not use when.** The file is text: use [diff-editor](diff-editor.md). The change comes from an agent's working copy, which carries no picture bytes: the review states the change cannot be shown instead. One picture is shown with nothing to compare: the [value-view](value-view.md) preview draws it.

## The pictures read first, and the controls sit quietly above them

- **Bar.** Right-aligned above the pictures, 4px over them: the joined toggle, a 1px `--line` outline with 6px corners, words in the app face at 10.5/12.5 in `--tok-hint`, the chosen word in `--text` at 600 on `--fill-ghost-selected`. In overlay the slider follows it: `before` and `after` in `.app-secondary` either side of a 140px range.
- **Overlay.** One box sized by the before picture, on a checkerboard of 16px `--panel-2` squares, so a change in transparency reads as one. The after picture sits exactly over it at the slider's opacity.
- **Side by side.** Two equal columns 10px apart, each picture over its caption in `--dim`, 4px between.
- **Pictures.** Never wider than their column, with a 1px `--line` border and 4px corners.

## The layout is chosen, and only a missing version changes the shape

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Neither version is available: `Neither version of this image is available to show.` in `--dim`, with no bar. | [empty.html](../assets/image-diff/empty.html) |
| loading | Cannot occur as a look of its own: the pictures arrive with the change and draw as the window decodes them. | |
| error | Cannot occur as a look of its own: a version the change carries no picture for counts as absent, which is the one-version or empty state. | |
| one version | The change created or deleted the file: one picture captioned `added` or `removed`, with no bar and no slider. | [one-version.html](../assets/image-diff/one-version.html) |
| overlay | The first look for each review: both pictures stacked, the after one at half opacity until the slider moves. | [overlay.html](../assets/image-diff/overlay.html) |
| side by side | Two captioned columns, `before` left and `after` right; the slider is gone. | [side-by-side.html](../assets/image-diff/side-by-side.html) |

## Dragging the slider shows where the pictures differ

| On | Does | Feedback |
| --- | --- | --- |
| `Overlay` | Stacks the pictures | The word takes the chosen look; the slider appears |
| `Side by side` | Sets them in two columns | The word takes the chosen look; the slider goes |
| Drag the slider | Sets the after picture's opacity from 0 to 1 in hundredths | Anything that moved shimmers while anything identical holds still |

The layout holds while the reviewer moves between files of the same review. The slider starts halfway each time the comparison is drawn.

## The copy names the two versions and what each layout shows

| Where | String |
| --- | --- |
| Toggle group label | `How to compare the images` |
| Overlay | `Overlay` · tooltip `Stacked, with the new one fading in — shows WHERE they differ` |
| Side by side | `Side by side` · tooltip `Two columns — shows what each version is` |
| Slider ends | `before` · `after` |
| Slider label | `Fade between the two versions` |
| Captions | `before` · `after` · `added` · `removed` |
| Picture descriptions | `before` · `after` · `the new image` · `the removed image` |
| Empty | `Neither version of this image is available to show.` |

## The pictures shrink to the pane and keep their pixels in both themes

- Width is the review's detail pane. Pictures never exceed their column, so side by side halves them in a narrow pane; the overlay box is sized by the before picture, and an after picture of another size is stretched to that box.
- Theme: the checkerboard and the frame are tokens; the pictures are drawn as they are.
- Focus: the two toggle words are buttons in the tab order and say which is pressed; the slider moves with the arrow keys.
- Missing content: without a before, the change is drawn as `added`; without an after, as `removed`; without either, the empty sentence.
