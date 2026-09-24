---
id: engineering/units/mcp-servers
type: engineering-unit
status: shipped
updated: 2026-09-23
implements: [product/bring-your-own-models-and-agents, product/agents-act-only-where-allowed, product/risky-actions-wait-for-approval, ui/surfaces/settings-connections, ui/surfaces/settings-tools, ui/components/permissionSet-card, ui/components/command-approval, ux/patterns/checked-status-with-the-fix, ux/patterns/secret-goes-in-never-comes-back]
layer: core
owns_contracts: []
requires: [engineering/units/tool-policy, engineering/units/agent-executors, engineering/units/project-config]
implemented_by: [packages/shared/src/mcp.ts, packages/shared/src/permissionSets.ts, packages/shared/src/config.ts, packages/runtime/src/mcpServers.ts, packages/runtime/src/agentTools.ts, packages/runtime/src/policy.ts, packages/runtime/src/approval.ts, packages/runtime/src/modelRoutes.ts, packages/runtime/src/agents.ts, packages/runtime/src/agentHanded.ts, packages/app/src/main/service.ts, packages/app/src/renderer/mcpData.ts, packages/app/src/renderer/mcpServersRows.tsx, packages/app/src/renderer/mcpBucket.tsx, packages/app/src/renderer/mcpBucketModel.ts, packages/app/src/renderer/connectionsPane.tsx, packages/app/src/renderer/permissionSetCard.tsx, packages/app/src/renderer/approvalModel.ts]
verified_by: [packages/shared/test/mcp.test.ts, packages/runtime/test/mcpServers.test.ts, packages/app/test/mcpBucket.test.ts, packages/shared/test/permissionSets.test.ts]
siblings: [engineering/units/tool-policy, engineering/units/agent-executors, engineering/units/model-routing]
---

# MCP servers

## The unit configures other people's MCP servers, hands them to the agents that run, and judges each of their tools by a permission set line

A server is a command JaiRA starts (stdio) or a URL it calls (streamable HTTP, SSE for an older
server), named in the `mcp.servers` block of `settings.json`. Every agent run is handed the servers
that are on; a permission set says what each of their tools may do, by the name every agent already
calls it — `mcp__<server>__<tool>` — with the server's own line, `mcp__<server>`, standing for every
tool of it no line names.

- `mcp.ts` in shared: the block, the subjects and the wire shapes. `parseMcp` is strict — a field the
  block has no place for, a server that is both a command and a URL, a name its tools' subject could
  not carry (`[A-Za-z0-9_-]`, never `__`, never `_` at an end), and `dai`, the bridge every agent run
  already has, are refused naming the field. A value in `env` or `headers` is a string or
  `{ "credential": "<name>" }`, which names a secret the way a provider's `credential` does and is
  checked the same way (a name with whitespace in it is refused as a secret in the file). The layers
  merge the block by server name through `mergeConfigDocuments`, so a project turns a shared server off
  with `{ "enabled": false }`. `parseMcpSubject` splits a subject at the first `__` after the server;
  `mcpModeOf(permissionSet, subject)` answers for one tool — its own line, then its server's, then a
  written `other` — the order a shell part answers in (`git commit`, `git`, the shell's line).
  `mcpFirstMode(annotations, answering)` is where a newly named tool starts: `readOnlyHint` allows,
  `destructiveHint` denies, anything else keeps what it answered to. `mcpServerOfForeign` and
  `mcpNameOfForeign` turn another tool's entry into ours, dropping its `type` and every field of its
  own, and reading `${NAME}` as the secret `NAME`.
- `permissionSets.ts` in shared: `mcp` is a subject kind and a `PermissionSetEntry.kind`. An MCP line is
  never offered — nothing JaiRA registers is served under it — and lowers into `permissions.tools` at
  its gate mode (a function as `ask`, its reference in `permissions.functions`), where the upstream gate
  reads a tool's line by the name the agent uses; `permissionSetOfEnvironment` reads a
  `permissions.tools` key that is an MCP subject back as an MCP entry. A map with MCP lines writes
  `permissions.source` as one with command subjects does. An MCP line is neither a shell subject nor a
  door for a withheld shell (`shellSubjects`, `shellWithheld` count commands and `script` alone).
- `mcpServers.ts` in runtime, four jobs:
  - **Detection** (`detectMcpServers`) reads `~/.claude.json` (its `mcpServers`, and
    `projects[<this project>].mcpServers`, matched whatever the slashes and case), the project's
    `.mcp.json`, Claude Desktop's `claude_desktop_config.json` (`%APPDATA%\Claude\`,
    `~/Library/Application Support/Claude/`, `~/.config/Claude/`), Cursor's `~/.cursor/mcp.json` and
    `<project>/.cursor/mcp.json`, and VS Code's `<project>/.vscode/mcp.json` (`servers`), leniently —
    comments and trailing commas are read — and asks Figma Dev Mode's `http://127.0.0.1:3845/mcp` for
    its tools within 1.5 s. Every path is injectable (`home`, `appData`, `platform`, `projectDir`), and
    nothing a source lists is started.
  - **The tools probe** (`probeMcpServers`) starts each configured server that is on — the MCP SDK's
    `Client` over `StdioClientTransport` (a WSL project's through `wsl.exe`, its variables carried by
    `WSLENV`), or `StreamableHTTPClientTransport` falling back to `SSEClientTransport` — lists every
    page of its tools with their `readOnlyHint`, `destructiveHint` and title, and closes it, all
    servers side by side under a 10 s deadline each. A server that is off, or names a secret nothing
    stores, is `not started` with the reason; one that did not answer is `failed` with the reason and a
    fix where one is known. Each secret it names is reported with where the chain found it, never the
    value. The SDK's client half is loaded on first use by specifiers that are not string literals, as
    upstream loads its server half: inlined into the CLI's ESM bundle, `ajv-formats`' `require("ajv")`
    killed the CLI at import.
  - **Resolution** (`resolveMcpServers`) is the servers a process is handed: the ones on, each secret
    looked up through the chain a provider's key is (`SecretResolver`). A server one of whose secrets is
    not stored is left out and named.
  - **Handing them over.** Every agent executor takes them as upstream's `mcpServers` (declarative-ai
    `AgentQueryOptions.mcpServers`), read off each call: `mcpServersOfCall` is the executor option, and
    `handedMcpServers(servers, view)` is one call's servers — every one that is on, less a server every
    line of which refuses (its own line or, with none, a written `other` is `deny`, and no tool of it
    is named anything else), which is not handed over and not started. Nothing else a permission set
    says is written into what is handed over, because every call is judged where it is made:
    - **Claude** finds them in the ONE `--mcp-config` document the bridge's `dai` is declared in (the
      SDK transport, in its `mcpServers` beside the in-process `dai`), calls them itself, and asks its
      permission callback about each call as about any tool.
    - **Codex**'s bridge PROXIES them. Before codex starts, the bridge connects to each server (the MCP
      SDK's client, stdio or streamable HTTP falling back to SSE) and lists its tools; codex is pointed
      at `<bridge url>/<server>` under the server's own name (`mcp_servers.<server>`, required, each tool
      `approval_mode = "approve"` on codex's side), so it still calls `mcp__<server>__<tool>`; and every
      call crosses the bridge, where it is put to the gate with that name and the call's input and
      forwarded to the real server only on an allow — its result, or its error, handed back unchanged.
      A server that cannot start or list fails the run naming it; the connections close with the run.
      The bridge starts the servers in JaiRA's own process, so a WSL project's stdio server is handed
      over as the distro runs it (`mcpServersIn`: `wsl.exe -d <distro> -- <command>`, its variables
      carried by `WSLENV`), as the probe starts it.
    - A codex agent reached as a FUNCTION is handed them the same way: upstream's function entry takes
      the same option and passes it to the executor it builds per call (`registerAgentRuntimes`).
- `agentTools.ts` in runtime: `PermissionSetView` gains `lineOf` and `lines`; `permissionSetViewOf(ctx)`
  is the one call's view, published or read back. For claude, `withAgentPermissionSet` puts every MCP
  tool line that denies, and every refused server, on the deny list (claude's rule `mcp__figma` covers
  every tool of it), and `translatedGate` asks the gate about an MCP tool with no line of its own by its
  SERVER's name, `mcp__figma` — the name its mode was written against, as a native is asked about by its
  standard tool's — leaving the tool it really is against the call's input (`noteMcpCall`). Codex's
  services (`switchedServices`) carry the same translation, since its bridge puts every proxied call to
  that gate: the same call answers to the same line on either agent.
- `policy.ts` in runtime: `decideMcpCall(tool, permissionSet, source, grants)` judges one MCP call as a
  decision of ONE part — kind `mcp`, its line the tool's name, its widths the tool and its server — so
  everything a shell part gets, it gets: allowed and refused without a person, a function asked first,
  an answer remembered for this run at the tool or the whole server (`CommandGrants`), and "add to the
  permission set" writing the tool's line by default. The narrowing reaches it for any MCP tool, by
  `mcpCallOf(input)` or the name it was asked about, under the state's lowered block or the permission
  set the policy was compiled for, and keeps the decision against the input where the approver finds it
  (`commandDecisionOf`). With no line and no written `other` it says nothing and the gate answers.
- `approval.ts`: a parked MCP call names the tool, not the server it was asked about by, and carries its
  one part; `command` is the tool's name, so the approval draws it as a line.
- `service.ts`: `mcp:detect` (`detectMcpServers` for the focused project) and `mcp:tools`, which is
  cached in main by the servers' block, the project and the execution environment — probed again when
  any of those changed or `recheck` is asked, two reads while one runs sharing it. `promptWiring` and the
  function registration hand `resolveMcpServers(config.mcp, …)` to `agentPromptRoutes` and
  `registerAgentRuntimes`; the CLI's prompt routes get the same.
- The renderer: `mcpData.ts` asks both channels while Connections or Tools is open, again on a
  configuration change, and on Re-check; a stored secret goes to `secret:set` and re-checks.
  `mcpServersRows.tsx` is Connections → MCP servers (data-part `mcp-servers`, after Local models): a
  row per server — `ready — HTTP · <url> · answered with N tools`, `ready — stdio · <command> · N
  tools`, `failed — <reason>` with its `cfg-fix`, `not started — …` — a key box per secret it names, the
  enabled switch and the chevron onto its fields through the schema form (`env` and `headers` values are
  a value or a stored secret); then "Add a server", the schema form for a name and a command or an
  address, and across its width the detection panel in the local servers' markup (`conn-probe`), each
  source's Add writing what it lists that is not configured yet into the page's layer, whichever that
  is. `mcpBucket.tsx` and `mcpBucketModel.ts` are a permission set's MCP section: one group per
  configured server (and per server the map names that nothing configures), a fold with the server's
  name, `N tools · M named here; any other <server> tool <mode>` (folded: `N tools · M named
  (<tool> <mode>); the rest <mode>`), a count and the group's own button — the server's line, or `other`
  until the first change writes one; open, a line per named tool with the tool's description and what
  the server says of it, and "name another <server> tool: K more, from <first> to <last>" listing the
  tools the probe found. The approval's answer menu reads the server's width as "every `<server>` tool".

## Gaps it leaves, and where they are closed

- **Codex asks now** (declarative-ai `task/mcp-server-proxy`, 2026-09-23). It used to be handed each
  server as its own `-c mcp_servers.<name>={command=…}`, called it itself, and could be asked about
  nothing — so an allowed tool was approved in codex's config and an `ask`, a function or a `deny` took
  the tool away. Measured with `codex-cli 0.147.0` through the proxy: an allowed call reached the real
  server and its answer reached the model; a refused one came back `PermissionDenied` and the server's
  tool never ran; a call held at the gate for 12 s waited and then ran.
- **Claude has no `cwd` for a stdio server**; the probe and codex's proxy honour it, claude's document
  leaves it out.
- **A proxied call's progress notifications and `_meta`** are not relayed: codex hears the result when
  the real server answers, bounded by the bridge's per-call timeout (a day, as codex's own).
- **An API model's tool loop** (a provider route, not an agent) is handed no MCP server.
- **The composer's Tools card** keeps a message's MCP lines and does not draw them; they are edited in
  Settings → Tools.

## Tests

`mcp.test.ts` (shared): the block parsed and refused, layered by name, subjects split, the line order,
the first mode from annotations, lowering and reading back, foreign entries converted.
`mcpServers.test.ts` (runtime): detection from fixture files in a temp directory with every path
injected; resolution with a missing secret; the probe with a lister standing in for a server (ready,
failed, not started, a deadline); one call's servers with and without a permission set, read per call, and a
WSL project's as codex's bridge starts them; and MEASURED through the real chain with `handedToClaude`
and `handedToCodex` (`mcpServers`, `mcpProbes`): each tool answering to its line, its server's,
`other` — on codex at the bridge that proxies it, by a route and as a function, `ask` and a function
included — a server's line widening past a stricter `other`, a refused server not handed over; `decideMcpCall` with remembered widths; the
narrowing and the approval hub naming the tool. `mcpBucket.test.ts` (app): the bucket's model and its
static markup, and Connections' rows.
