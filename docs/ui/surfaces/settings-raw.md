---
id: ui/surfaces/settings-raw
type: ui-surface
status: shipped
updated: 2026-09-23
kind: screen
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/draft-belongs-to-the-file, ux/patterns/one-document-several-readings, ux/patterns/absence-is-stated]
serves: [product/share-processes-across-projects, product/find-out-why-the-app-misbehaves]
components: [ui/components/settings-header, ui/components/editor-chrome, ui/components/data-tree]
mockups: []
siblings: [ui/surfaces/settings-view, ui/surfaces/files-view]
---

# Settings raw document

The `settings.json` page of the [Settings view](settings-view.md): the layer's whole settings file as text, and the merged configuration under it on request. It is the last entry of the `Project & shared` group, drawn in the sidebar as the file it opens — a `{ }` glyph and the name in the data face — and it holds whatever the other pages have no row for, so nothing a layer states is out of reach.

## The file path reads first, then the text, then the effective configuration

- **Head.** `settings.json`, the lead `Everything this layer's settings hold, as stored.` followed by the layer sentence, and the [layer switch](../components/settings-header.md) at the head's top-right.
- **The document.** One section, with an `ⓘ`, over one card: the layer's file path in `--dim`; on the shared layer, a notice that this is the shared root; a text box of the JSON with the [editor-chrome](../components/editor-chrome.md) `Save` and `Revert` under it; then a ghost `Show effective`.
- **Effective configuration.** Under `Hide effective`, the heading `Effective configuration`, `shared config with this project's laid over it`, and the merged value as a [data-tree](../components/data-tree.md).

## The page shows the file, unsaved typing, a parse error, or the merged result

| State | Surface shows |
| --- | --- |
| success | The file as stored, `Save` and `Revert` inactive. |
| unsaved | Typing not yet saved: `unsaved changes`, and `Save` and `Revert` active. |
| parse error | `not valid JSON: {message}` under the box after `Save`; nothing is written. |
| effective | `Hide effective`, the heading and the merged configuration as a tree. |
| no file yet | The shared root before anybody has saved to it: the box is empty, and saving creates the file. |
| error | The settings cannot be read: `Configuration is unavailable — the app could not read it.` in place of the card. |
| empty | Cannot occur as its own look: an empty layer is `{}`. |

| Where | String |
| --- | --- |
| Section | `The document`, behind `ⓘ` `Everything this layer's settings.json holds, as it is stored. The Settings pages write into it; what they do not know about survives their saves.` |
| Shared-root notice | `This is the shared root. Every project on this machine reads it unless it sets the same field itself.` |
| Editor | `Save` · `Revert` · `unsaved changes` · `not valid JSON: {message}` |
| Effective | `Show effective` · `Hide effective` · `Effective configuration` · `shared config with this project's laid over it` |
| Unreadable | `Configuration is unavailable — the app could not read it.` |

## A person arrives from the sidebar, and the text waits for Save

- `settings.json` in the sidebar shows this page, with or without a project open; with none open, it is the shared root's file.
- `Save` parses the text and writes the layer; `Revert` puts back what is on disk. Every other page writes into this same file, and a field this page added that no page knows about survives their saves.
- Unsaved text stays with the file: leaving and returning shows it again, and the Files view opens the same draft on the same file.
- Whether the effective configuration is shown is remembered across visits and launches.

## The page keeps its width cap, and the path keeps the file name in view

- **Resize.** The section stops at 740px; the text box scrolls inside itself.
- **Theme.** The card, notice, text box and tree are tokens in both themes.
- **Focus.** Nothing takes focus on entry. The order is the text box, `Save`, `Revert`, then `Show effective`.
- **Long content.** The file path ellipsises from its start so the file name stays in view.
