# The Design artifact type's instructions

What Claude Code hands the model when a person runs `/design`, kept word for word so that JaiRA gives
Claude the same instructions and gets the same files back (decision 0020: a canvas is file-compatible
with Claude Design's — `project/canvas.json` v3 and one `project/<Name>.dc.html` per artboard).

Read 2026-10-24 from a `/design` run in Claude Code (Claude desktop), the type "Design"
`https://claude.ai/artifact/QKN21svewxgyPb6SYRqWnd`, release `1792800572-07fb`, contract `0.2.47` (the
service reported `0.2.90` as the newest).

| File | Is |
| --- | --- |
| `command.md` | the prompt `/design <brief>` expands to; `{{brief}}` is the person's words |
| `quickstart-result.md` | the `Artifact` tool's answer to `{action: "quickstart", intent: "design"}`, with no design system on the account |
| `created-result.md` | its answer to the create call (`type_url`, `title`, no files): how the canvas's files are laid out and published, then `SKILL.md` and `reference/format.md` inside their fences |
| `updated-result.md` | its answer to a later publish |
| `SKILL.md` | the type's instructions file, as fenced in `created-result.md` |
| `reference/format.md` | the `.dc.html` authoring format, as fenced in `created-result.md` |

Only these changed, and only to placeholders a JaiRA canvas fills in: `{{canvas_url}}`,
`{{version}}`, `{{version_id}}`, `{{file_path}}`, `{{brief}}`. Everything else is as served, including
the type's own URLs.

**Not here yet.** `SKILL.md` names reference pages the run never read — `craft.md`, `diagrams.md`,
`print.md`, `questions.md`, `view-state.md`, `make-from-this.md`, `design-system-components.md`,
`brand-colors.md`, `brand-typography.md` — and the type's `google-fonts-*.json`. They are served only
when the model reads them (`{action: "read", url, path}`), so each needs a run that does.
