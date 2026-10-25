---
id: engineering/decisions/0020-artifacts-and-the-design-canvas
type: decision
status: proposed
updated: 2026-10-24
decides_for: [engineering/units/host-tools, engineering/units/tool-policy]
---

# 0020. Artifacts and the design canvas, as Claude Code makes them

Mockup (approved 2026-10-24, "looks good"): `0020-canvas-mockup.html`. The instructions it relies on are
committed in `packages/shared/builtin/artifact-types/design/` (7ea524c4). The person's words are quoted
where they settle something; nothing below reopens them.

## Context

2026-10-20 to 10-24, task `t-yehfkd91ob`. Asked to test visualizations, then about mockups and "a figma
like design canvas", the person settled the goal:

- "claude should produce the same output that the desktop app renders into its ui and we should be able
  to take that output and render it the same way."
- "It shouldnt use any of the desktop client code, but should create its own renderer that mirrors as
  close as possible claudes renderer."
- "It shouldnt need any special login … we should be using our own [tool] (that has the same/similar
  contract)."
- On leaving the canvas out: "that is the main purpose of this feature request."
- "we should aim to be file compatible. we should also pass claude the exact same instructions."
- "Use the same instructions and commit it."

### Claude Code's artifacts (code.claude.com/docs/en/artifacts, read 2026-10-23)

A page artifact is one `.html`, `.htm` or `.md` file the model writes and publishes with its `Artifact`
tool. claude.ai serves it in a sandboxed `*.claudeusercontent.com` frame under a CSP allowing Google Fonts,
scripts from cdnjs, unpkg, `cdn.tailwindcss.com`, `code.jquery.com` and jsDelivr `/npm/`, images as data
URIs, `fetch` only to its own origin, no page-started downloads; each publish is a version. Publishing
needs a claude.ai login and is off under `-p` and the Agent SDK, which is why JaiRA's agents never see it.

### What `/design` is (read from the person's own run, 2026-10-24)

A tagandrestart session ran `/design` in Claude desktop. What it showed:

- `/design` is an **Artifact type** on claude.ai, "Design" (`…/artifact/QKN21svewxgyPb6SYRqWnd`, release
  `1792800572-07fb`, contract `0.2.47`; the service named `0.2.90` as the newest). The type carries the
  EDITOR (its `app.js`, `dc-runtime.js`, `fast-edit-worker.js`, fonts, page) and the INSTRUCTIONS
  (`SKILL.md` and `reference/*.md`), served to the model as tool results.
- The model's calls: `Artifact {action: "quickstart", intent: "design"}`; then
  `{action: "publish", type_url, title, auto_open}` with no files, whose answer carries the
  instructions; then publishes of its files, `{action: "publish", url, root, file_path, files}`.
- **What it writes**, under `project/`:
  - `canvas.json`, `"v": 3`: `title`, `launch`, `pages`, `boards` (per artboard file: the frame `x`,
    `y`, `w`, `h` and `title`, `page`, `expand`, `print`, `paper`, `is_interactive`, `guides`,
    `radius`, `frameless`), `order`, `notes` (titles, stickies, and the person's shapes: `rect`, `oval`,
    `pen`, `line`, `arrow`, `image`), `designSystems`, `createdOnFiles`.
  - one `<Name>.dc.html` per artboard: a "Design Component" — `<script src="./support.js">`, an `<x-dc>`
    template with `<helmet>`, `{{holes}}`, `<sc-for>`, `<sc-if>`, `<dc-import>`, links between
    artboards; a `<script type="text/x-dc" data-dc-script data-props='…'>` holding
    `class Component extends DCLogic { renderVals() }` (React class state and lifecycle); `data-props`
    declaring the Tweaks controls; uploaded assets at `/_blob/<id>`.
- A publish over a person's edit is refused and names the file to re-read: that is how hand edits reach
  the model.

## Decision

### 1. One tool, Claude Code's call shape

`show_artifact` keeps its name (the person, 2026-10-24) and takes the `Artifact` tool's inputs, because the
instructions are passed verbatim and name them:

| Input | Meaning |
| --- | --- |
| `action` | `publish` (absent), `read`, `list`, `quickstart` |
| `file_path` | the file published (a page: `.html`, `.htm`, `.md`; a canvas: one of its files, absolute) |
| `root`, `files` | a canvas: the folder holding `project/`, and the other files by their `project/…` paths (`null` removes one) |
| `url` | the artifact to update — JaiRA's own address for it, `artifact://<task>/<id>` |
| `type_url`, `title`, `auto_open` | create an artifact of a type (§2); `title` also names a page with no `<title>` |
| `intent` | `quickstart`: `"design"` |
| `asset` | `true`: upload one image or font, answered with its `/_blob/<id>` address |
| `path` | `read`: one file of the artifact |
| `capabilities` | a page's declared capabilities; JaiRA honours `downloads` (§6) |
| `force` | publish over a newer version |

- The bytes are copied into JaiRA's artifact store at each call, never read from disk afterwards. Every
  publish is a version.
- Every permission set lets an agent write and read under the task's own artifact folder, in every mode —
  "producing a new file under the task's artifact directory is a cache write and does not count". The
  canvas's `root` lives there.
- Refused as Claude Code refuses: a file that does not decode or holds U+FFFD, a page over 16 MiB, a
  canvas over 512 files or 256 MB, a path outside `project/` or with `..`.

### 2. The Design type ships with JaiRA

JaiRA has one built-in artifact type, `design`, and answers as Claude Code's tool does:

- `/design <brief>` in a JaiRA conversation sends `command.md` with the brief.
- `quickstart` answers `quickstart-result.md`; the create call answers `created-result.md` (which carries
  `SKILL.md` and `reference/format.md`); a publish answers `updated-result.md`. The placeholders
  (`{{canvas_url}}`, `{{version}}`, `{{version_id}}`, `{{file_path}}`) are filled with JaiRA's values; the
  text is otherwise as served.
- `type_url` is accepted as the type's claude.ai address, which is what the instructions name.
- A `read` of a type file the run never captured (`craft.md`, `diagrams.md`, `print.md`, …) answers that
  it is not available. Each is added, verbatim, when a `/design` run that reads it is captured.
- A canvas's support file is `support.js`, served by JaiRA (§4).

### 3. The view row, and the Artifact view

As the mockup draws it:

- The view toggle is always shown, and gains **Artifact**: a page running under §4's frame, or a canvas
  drawn by §5's editor. `Rendered` stays today's inert drawing; `Source` the bytes (a canvas: its files).
- The **version** picker is a segment in the same box, in the toggle's own type.
- An artifact's **title bar** — glyph, title (a page's `<title>`, a canvas's `title`), detail, `Open` —
  sits ABOVE that row and never replaces it.
- The **artifact list** (one row per artifact, its latest version, its kind) is one render function: inline
  in the conversation and as the side panel's Artifacts tab.
- Markdown stays as it is today (the person, 2026-10-24).

### 4. The page frame

A page artifact, and each artboard, runs in JaiRA's own frame, mirroring what a Claude Code artifact page is
written for. Nothing is uploaded and no Claude service is used.

- Served from the `jaira-artifact:` scheme with its own origin per grant, never `srcdoc`.
- CSP: scripts inline and from the five CDNs; styles inline and Google Fonts; fonts Google Fonts and data;
  images data and blob (a canvas also its `/_blob/` assets); `connect-src` own origin and Google Fonts;
  no frames, forms or base.
- `sandbox="allow-scripts allow-popups"`, with `allow-same-origin` once a per-artifact origin is shown to
  give storage without reaching the app; `allow="clipboard-write"`; no downloads.
- The phone draws the same page from the engine's HTTP route, by the same token.

### 5. The canvas editor

JaiRA's own editor over `canvas.json` and the `.dc.html` files — "a person should be able to do all the same
things they can in the claude design canvas":

- **The `.dc.html` runtime**, JaiRA's own (`support.js`): the `<x-dc>` template, holes, `sc-for`, `sc-if`,
  `dc-import`, `helmet`, `DCLogic` on React, `data-props`, links between artboards for Play.
- **The board**: pan and zoom, frames at `boards`' positions in `order`, name strips with `title`, the
  interactive mark and ▶ on `is_interactive`, pages, guides, notes.
- **Tools**: pointer (select, move, resize elements and artboards), hand, text, artboard (a new frame, or
  wrap in a stack or grid), note, pen, rectangle, oval, arrow, line.
- **Panels**: Properties (layout, size, fill, border, radius, type — written to the element's inline
  `style`), Tweaks (the artboard's `data-props`), Layers.
- **Play** runs the artboards; **Export** gives PNG or PDF per artboard.
- **Saving**: an element edit rewrites its `.dc.html`; notes and shapes are `notes` entries in
  `canvas.json`. Each save is a version marked as the person's; the model's next publish over a file the
  person changed is refused, naming the file to re-read, as claude.ai refuses it.

### 6. Capabilities

`downloads`: a page cannot start a download; one that declared it posts `{type: "download", name, mime,
data}` and JaiRA asks where to save. Connectors, comments, `db`, `room` and design-system libraries are
not part of this decision.

## Consequences

- The format is Anthropic's and moving (0.2.47 → 0.2.90 already). JaiRA pins 0.2.47 and moves only with a
  newly captured run: instructions, then runtime and editor to match.
- `show_artifact`'s old inputs (`path` + `content`, `mediaType`, `interactive`) go; the `smart` size rule
  reads the published files' size. Recorded calls keep what they were written with; nothing under
  `~/.jaira` names the old inputs (checked at the build, no back-compat readers).
- The artifact store gains versions and multi-file artifacts (a canvas is one artifact of many files).
- Pages reach Google Fonts and five CDNs from the person's machine when drawn.

## Build order

1. Store: versions and multi-file artifacts (migration).
2. `show_artifact`'s new contract and the `design` type's answers (§1–2); `/design`.
3. The page frame (§4) and the view row (§3).
4. The `.dc.html` runtime, then the read-only board (the Artifact view).
5. The editor's tools, panels, saving and conflicts; Play; Export.
6. Downloads.
