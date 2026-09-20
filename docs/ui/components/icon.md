---
id: ui/components/icon
type: ui-component
status: shipped
updated: 2026-09-13
realizes: []
serves: []
surfaces: [ui/surfaces/chat-view, ui/surfaces/conversation-list, ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal, ui/surfaces/module-approval-dialog, ui/surfaces/settings-providers]
reuses: []
implemented_by: [packages/app/src/renderer/icons.tsx, packages/app/src/renderer/brands.ts]
verified_by: []
mockups: [ui/assets/icon/line.html, ui/assets/icon/turning.html, ui/assets/icon/vendor.html]
siblings: [ui/components/status-pill, ui/components/composer-setting-chip, ui/components/work-row]
---

# Icon

A small line drawing one text-height tall, stroked in the colour of the words beside it with rounded ends and no fill; or a faint ring with a turning arc; or a company's logo in its own colour, or a rounded square carrying the company's initial.

## An icon illustrates a word and never replaces it

**Use when.** A row, a chip, a menu entry or a heading names a kind of thing, and a silhouette lets the eye scan a column of them before reading: what a tool call did, a composer setting, a permission posture, a gate's component, a change's action, a value's type family, a model's vendor. Use the turning ring where something is being produced right now and the place that says so has room for one glyph only.

**Do not use when.** The mark is a status: running, waiting, failed, stopped and done are the literal glyphs of a [status-pill](status-pill.md). The icon would stand alone as the only label: every icon sits beside its word, and the two exceptions are the copy and rewind buttons under a message, which name themselves by tooltip. The mark is a structural glyph such as a sidebar row's `▦` or a twisty's `▸`: those are text characters, not icons.

## The glyph reads as the word's silhouette and takes the word's colour

- **Line glyph.** Drawn on a 24-unit square at 1.7 units of stroke, rounded caps and joins, no fill. Its size defaults to 1em, so it is exactly as tall as the text it sits in until the host sizes it: 13px in a composer chip or a menu row, 12px in the model cascade, 14px in option rows, 11px as a fork mark in a conversation row.
- **Colour.** Always the host's text colour. A host colours the glyph by colouring its span: `--tok-hint` in a composer chip, `--accent` on a chosen one, `--bad` on a failed call, `--panel` on a menu row under the pointer.
- **The set.** What an agent did: a command prompt, an eye for reading, a page with a pen for writing, a globe, a magnifier, a small robot for a helper agent, a wrench for any other tool, a sparkle for thinking, and a circled `i` and a circled `!` for plain and alarming events. The composer: an upward arrow to send, a paperclip, a cube for the model, a shield for permissions, a shut lock, an open lock, a star, a pencil and a ruled page for the five permission postures. Arrangement: a chevron, two fold marks, two panes abreast and a tabbed pane. Gates and state kinds: a forking path, two offset sheets, a sheet with fields, a tick, a speech bubble for a note, a summation sign for a computed value, a clock for a wait, and a cross. Changes: a file with a plus, a minus or two lines. Message verbs: two sheets to copy and a hooked arrow to rewind. Type families: the markdown mark, ruled lines, angle brackets, braces, a grid, a plus over a minus, and a framed horizon.
- **Filled marks.** The Anthropic and OpenAI logos also exist as glyphs filled with the host's colour instead of stroked.
- **Turning ring.** A full circle at a quarter of the colour's strength with a quarter arc over it at full strength, stroked at 2.6 units, turning once every 900ms. In a conversation row it stands where the time would be, in `--accent`, 12px square.
- **Vendor mark.** The company's real logo filled with its brand colour. A company with no logo but a known colour gets a rounded square in that colour with a white initial. Any other company gets a rounded square in the host colour at 18% strength with the initial in the host colour.

## Every icon draws something, so its states are the three kinds of glyph

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: every glyph in the set draws, and a vendor with no logo still gets its initial. | |
| loading | The turning ring, beside or in place of a word that says what is being produced. Under a reduced-motion preference the ring stands still. | [turning.html](../assets/icon/turning.html) |
| partial | Cannot occur: a glyph is drawn whole. | |
| error | Cannot occur as a look of its own: a failed call keeps the glyph of what it was, and its row colours it `--bad`. | |
| line | A stroked glyph in the host's colour beside its word, shown for the whole set with one chip in the chosen `--accent`. | [line.html](../assets/icon/line.html) |
| vendor | Real logos in brand colours for Anthropic, OpenAI, Google, Meta, Mistral, DeepSeek and Qwen; tinted initials for OpenRouter, Amazon, xAI, Cohere, Microsoft, NVIDIA, Perplexity and IBM; a faint neutral initial for any other vendor. | [vendor.html](../assets/icon/vendor.html) |

## An icon takes no input of its own

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over the control that holds it | Nothing of its own | The glyph follows the control's colour change |

Every glyph is hidden from screen readers; the word beside it, or the button's own name, is what is announced.

## The only copy is a vendor's initial

| Where | String |
| --- | --- |
| Vendor badge | `{first letter of the company}`, uppercased |
| Company from a route or catalog name | `claude-cli`, `claude-code` and `anthropic` are Anthropic; `codex-cli` and `openai` are OpenAI; `meta-llama` is Meta; `mistralai` is Mistral; `x-ai` is xAI; any other name is itself with a capital first letter |

## A host must size the ring and the vendor mark, and two logos vanish on the dark ground

- Resize: a line glyph scales with the text size of its host. The turning ring and the vendor mark carry no size of their own and fill whatever box holds them, so every host sets their width and height.
- Theme: line glyphs and the ring follow their host's colour tokens in both themes. Vendor logos keep their brand colours, so the near-black Anthropic and OpenAI logos all but disappear on the dark `--panel`.
- Focus order: an icon never takes focus.
- Long or missing content: a vendor badge shows one letter however long the name.

## The vendor badge's initial ignores the app's type settings

- The initial is drawn in the system sans at a fixed size rather than in `--font-app` at a register's size.
