---
id: engineering/decisions/0027-open-anywhere-and-project-setup
type: decision
status: built
updated: 2026-11-18
decides_for: [engineering/decisions/0013-machines, engineering/decisions/0026-settings-follow-the-person, engineering/units/forge-integrations, engineering/units/tool-policy, engineering/units/project-config]
---

# 0027. Open a project from a forge or any machine onto any machine, and set it up from `.jaira/setup.json`

The person, 2026-11-17: "if you have gitlab/github, when you press new/open, you can checkout a git
project as well". Over the design that followed (the canvas *Open from GitHub or GitLab*), it grew into:
choosing a project, deciding where it goes, how it gets there, and a file that says how a project's
environment is set up.

## Context

- **Open** opened a folder on this machine (the OS dialog) or on a paired machine (the folder browser,
  [0013](0013-machines.md) §8). Nothing cloned, nothing copied between machines, nothing listed a
  forge's repositories.
- **A project is known by its git remote** (0013 §4): clones of one repository are its workspaces. A
  second workspace on another machine was made by hand, outside JaiRA.
- **Nothing said how a checkout is made ready** — tools, dependencies, the files git ignores. Dev
  Containers, version files, lockfiles and CI files each say part of it.

## Decisions

### 1. Open is four steps that keep their answers

`+ Open → Open project…` opens a dialog whose steps run across its top, each keeping its answer: **the
project** (a folder on any machine, or a repository on a signed-in forge, at a branch), **where it goes**
(a machine — each with its status for this project on the right: ready, installs …, password, can't,
offline — and a folder: the machine's projects folder and the project's name, numbered `name-1`,
`name-2`… when taken, or any folder the person opens), **how it gets there** (what is copied, what Bring
takes, the setup's steps with where each came from), and **go** (the progress, phase by phase and step
by step, with what it prints). A finished step can be pressed to go back to it.

- **From a forge**: a clean clone at the branch, with the forge connection's credentials handed to git
  in its environment (`pushCredentials`), never written into a URL or a config.
- **From a folder on a machine**: copied **as it is** — everything git does not ignore: the branch, its
  commits pushed or not, the changes staged and not, new files. Nothing git ignores travels with the copy
  (dependencies, build output, `.env` files); Bring takes the ignored files the setup names. Where the
  folder has a remote, the history comes from the remote and only the commits it lacks travel between the
  machines, as a git bundle.
- **To the machine it is on**: it opens there; nothing is copied.

### 2. Add a workspace is Open with the project chosen

The project crumb's machine menu lists every machine; the row under the pointer shows **Add** — a
machine that has a workspace already takes a second one, named `name-1`. Add opens a card where the
menu stood: four lines — Project (the forge and the project / branch, or the machine and folder copied),
Where (the machine and the folder, numbered when taken), Bring and Then — and `Add <machine>`. Project
and Where open the dialog at that step with everything filled in; Bring and Then open under their line;
More… opens it at How it gets there. Once pressed, the card follows the job in place (Details opens the
dialog at Go). **Add a workspace…** at the bottom opens the dialog at Where it goes. The project's remote is cloned, or — with no remote — one of its
workspaces is copied, this machine's first. A project of one workspace has the same menu on its name.

### 3. Each machine has a projects folder

A machine-local setting (Settings → Machines, the machine's own section, read from and written to that
machine; `machine.json` `projectsFolder`). Unset, it is the folder most of the machine's workspaces
already sit in, else `Code` in its home folder (`guessProjectsFolder`).

### 4. The setup file: `.jaira/setup.json` (or `.yaml`), and `.local` for one machine

```json
{
  "version": 1,
  "default": [
    { "target": "node" },
    { "install": "vips" },
    { "run": "brew bundle", "on": ["mac"] },
    { "bring": ".env*.local" },
    { "run": "pnpm install", "again": ["pnpm-lock.yaml"] }
  ],
  "node": [{ "install": "node", "version": ".nvmrc" }, { "install": "pnpm", "version": "package.json" }],
  "environment": [{ "first": [{ "use": "compose", "file": "compose.dev.yml", "when": "open" }, { "install": "postgres", "version": "16" }] }]
}
```

- `version` is the format; every other key is a **target**. `default` is what a new workspace runs.
- A step does one thing: `install` (a tool or a package, at an optional version or a file holding one),
  `target` (run another target), `use` (hand over to another tool — `devcontainer`, `github`, `gitlab`,
  `docker`, `compose`, `nvm`, `fnm`, `pyenv`, `rbenv`, `rustup`, `mise`, `asdf`, `uv`, `poetry`, `venv`,
  `conda`, `bundler`, `nix`, `devbox`, `shell`, `make`, `just`, `npm` — with its settings in fields:
  `file`, `job`, `from`, `through`, `skip`, `part`, `in`, `rule`, `recipe`, `script`…), `run`, `bring`,
  `first` (the first alternative this machine can do).
- Any step: `on` (machine tags — the OS tag `mac`/`linux`/`windows`, and `wsl`, its own: `["linux",
  "wsl"]` means either — an architecture, the person's tags, or machine names), `when: "open"`, `again`,
  `check`, `optional`. A whole target may be `{ "on": [...], "steps": [...] }`.
- **JSON first, YAML accepted** (both present is an error). `.jaira/setup.local.json` (or `.yaml`) sits
  beside it uncommitted: a target it names replaces the committed one; a new name adds one.
- **A CI file is reused a part at a time**: a job's steps `from`/`through`/`skip`, or a composite action;
  a GitLab job's `before_script` (hidden `.setup` jobs, `extends`, `!reference`). Setup actions become
  installs, `run:` lines become runs in their working directory, the code's own checkout and caches are
  dropped, another repository's checkout is cloned beside the workspace, and a step needing a CI secret
  is said as one that cannot run.
- **A Dev Container runs on the machine by default** (`in: "machine"`): features become installs,
  lifecycle commands become runs (start commands each open). With `in: "container"` the workspace runs
  inside it instead, as `use: "docker"` runs it inside an image (§9).
- **No file**: the setup the checkout states — version files, lockfiles, a Dev Container, the `.env`
  files its `.gitignore` names — is used and shown as found (`inferSetup`).

### 5. `install` goes through the tool installer agents already use

The agent installer's general half becomes the tool installer (`@jaira/runtime` install module): a
catalog of tools and packages, found where they are, installed through whatever installed them there
before (Homebrew, npm, WinGet, a version manager the machine already uses), with versions read and
matched, apt/dnf where a password is needed (the command is said, to run on that machine). The agents
and git use the same code.

### 6. The person's press is the approval; a workflow may ask for a target

Go / Add, with the plan in front of the person, approves the setup on that machine; its hash is kept
per workspace (`<base>/system/setup-approvals.json`). A workflow's root state may name a target with
`setup`; absent, the file's `environment` target is used. It runs in the task's folder before a fresh
start — a step whose `check` passes is skipped — and is recorded as a `setup` start step. A setup that
changed since its approval waits. A failing target refuses the start, leaving the task startable.

### 7. Agents and `.jaira/`

Not a rule in the code: the permission sets JaiRA ships refuse writing under `.jaira/` by default, a line
like any other a set may change ([tool-policy](../units/tool-policy.md)).

### 8. Settings are addressed by a path

The layer switch became a breadcrumb beside the Settings label: `Settings › [project] › [machine] › [Just
you] › +`, any part left out meaning all of them, `+` a picker of what can be added. Least to most
specific: a project, then a machine, then you — `Settings › Just you` outranks `Settings › atlas ›
build-01`. A machine in the path reads and writes that machine's settings.

### 9. A workspace may run in its container, on a Mac or Linux

The person, 2026-11-17: Dev Containers run on the machine by default, with an option to run in the
container. `use: "docker"` (an `image`, or a Dockerfile as `file`) and `use: "devcontainer"` with `in:
"container"` bring the workspace's container up; the setup's steps after it run inside.

- **The same path.** The workspace is mounted at its own absolute path inside (`-v <dir>:<dir> -w
  <dir>`; a Dev Container's `workspaceMount` and `workspaceFolder` laid over), and so is the folder its
  task worktrees go in (`.jaira-worktrees/<name>` beside it). A file is where it was, so the machine's
  git, the file tools, JaiRA's own reads and every path a task records stay right.
- **What runs where.** The commands JaiRA runs for the workspace — its shell tool, a state's
  `run_command`, the setup's steps (`run` lines, and `install` through the tool installer as it works
  inside a Linux machine) — run inside, through `docker exec -i [-u <user>] -w <cwd> [-e NAME …]
  <container> sh -lc …`, and are judged as POSIX. Each runs in a process group of its own there (under
  `setsid`), its id in `/tmp/.jaira-exec-<token>.pid`: Docker keeps a process running when its `docker
  exec` ends, so Stop and a timeout run a second `docker exec` that sends the group TERM, and KILL two
  seconds later. Git, the file and search tools, the agents (their
  CLIs, sign-ins, installs and MCP servers) and a person's terminal stay on the machine. An agent CLI's
  own built-in shell runs where the agent runs — on the machine — unless JaiRA's shell is served to it
  in its place.
- **Said for that workspace on that machine.** `execEnvironment: { "container": "<name>", "user":
  "<remoteUser>", "from": "devcontainer" | "docker" }` in the workspace's `.jaira/settings.local.json`
  (the project-on-machine layer), written as the container comes up — through `writeConfig` while the
  workspace is open, so its session reads it at once. Its other workspaces, and other machines, are
  untouched.
- **Made.** `use: "docker"`: the image, or the Dockerfile built (`docker build -t jaira-<hash>`, its
  folder the context); then `docker run -d --name jaira-<first 8 of the folder's sha-256> --init -v … -w
  <dir> <image> sleep infinity`. A container of that name is used again: started when stopped, made
  again only when it was made from another image. A Dev Container goes through the Dev Containers CLI
  when the machine has it (`devcontainer up --workspace-folder <dir> --config <file> --override-config
  <tmp>`, the container read from its JSON answer, its name kept); the CLI runs the features and
  lifecycle commands, and JaiRA none of them again. `{ "install": "devcontainer" }` installs it (npm
  `@devcontainers/cli`, or Homebrew). Without the CLI, a devcontainer.json that names only an `image`
  is made as `use: "docker"` makes one — its `initializeCommand` on the machine first, its features (as
  installs) and lifecycle commands inside after; one that builds a Dockerfile needs the CLI; one made
  from a compose file is refused in its container, since the compose file, not JaiRA, says where the
  workspace is mounted.
- **Kept up.** Each time the workspace opens, its container is started when it is stopped
  (`ensureContainer`; one that is gone is said — making it again is the setup's, which the person
  approved), and the setup's open steps bring it up again with its start commands.
- **Where it cannot.** A Windows host, or from inside WSL: refused with why, in the plan (`cannot`)
  and when it runs. Without Docker the plan says `cannot`, unless an earlier step installs it.

## Built

- `@jaira/shared`: `setup.ts` (reading, `.local`, planning), `setupDelegates.ts` (what a `use` step comes
  to), `setupInfer.ts` (the found setup), `workspaces.ts` (the wire types), `guessProjectsFolder` /
  `workspaceFolderName`, `ForgeRepository`, `StartStep` kind `setup`, the state schema's `requires` and
  `setup`.
- `@jaira/runtime`: `workspaceMake.ts` (clone, pack, unpack, collect and write ignored files),
  `setupRun.ts` (what a setup would take, and running it), the forge providers' `repositories()` and
  `fileText()`.
- `@jaira/service`: `workspaces.ts` (`WorkspaceMaker`: `forge:repositories`, `forge:branches`,
  `workspace:inspect`, `workspace:plan`, `workspace:create`, `workspace:cancel`; pushes
  `workspace:progress` and `workspace:finished`; peer channels `workspace:pack`, `workspace:packChunk`,
  `workspace:ignored`, `workspace:files`, `workspace:inspect`), the task hook in `startRun`, and a window's
  `project:open`/`project:init` naming another machine routed there (they opened the path here before).
- The engine runs a workspace's setup past its making: `when: "open"` steps each time it opens, and
  `again` steps when its checkout's HEAD moves (looked at every 20 seconds, so a pull by anyone counts),
  for the files that changed between the two — `WorkspaceMaker.runPhase`, `Service.workspaceOpened` and
  `checkHeads`. Only a setup approved on that machine runs; one that is not is logged under `setup`.
- A workspace's container (§9): `@jaira/runtime` `container.ts` (`dockerUp`, `devcontainerUp`,
  `ensureContainer`, `containerPort`), the third `ExecEnv` (`paths.ts`: `isContainerEnv`,
  `machineEnvOf`, `onMachine`, `containerRefusal`; `exec.ts`: `containerInvocation`), the setup's
  container port (`setupRun.ts`: `SetupContainerPort`, `runContainerStep`, `needsOf`), the installer
  inside a container (`inGuest`), `devcontainer` in the tool catalog; `@jaira/shared`
  `devcontainerShapeOf` and `devcontainerOverrideOf`, and `execEnvironment`'s `{ container }`;
  `@jaira/service` `WorkspaceMaker.environmentFor` and the engine's `recordWorkspaceEnv` and
  `keepContainerUp`; Settings' Where commands run row (`containerLine`).
- The window: `OpenProject.tsx` (the dialog), `AddWorkspace.tsx` (Add's card), `openProjectModel.ts`
  (`addLines`), the store's `opening` and `workspaceJobs`, menu rows with an action under the pointer.

## Not yet

- A Dev Container made from a compose file, in its container; a person's terminal inside a workspace's
  container; `on` tags for the steps after a container step (they are still planned for the machine).
- `jaira run` from a terminal does not start a stopped container first. An image without `setsid`
  (rare: util-linux and BusyBox both have it) has its command stopped, not what the command started.

