import type { JSX } from "react";
import { View } from "@tamagui/core";
import { checkedAgo, providerGroups, useLocalModels } from "@jaira/ui/connectionsModel";
import { installLogsOf } from "@jaira/ui/installLog";
import { useMcpData } from "@jaira/ui/mcpData";
import type { ProvidersPaneProps } from "@jaira/ui/providersPaneTypes";
import { useShell } from "../../app/shell";
import { Txt } from "../../primitives";
import { Button } from "./Button";
import { AgentRows } from "./connections/AgentRows";
import { ApiRows, ProviderRows } from "./connections/ProviderRows";
import { ForgeRows } from "./connections/ForgeRows";
import { GitRows } from "./connections/GitRows";
import { McpServerRows } from "./connections/McpServerRows";
import { NeedsAttention, useSettingsShell } from "./NeedsAttention";
import { SettingsSection } from "./SettingsPage";

/**
 * Settings → Connections: what JaiRA can reach, and as whom — the agents, the model APIs, the local
 * models, the MCP servers, git and the forges, each a card of rows closed to a line (`connections/Closed.tsx`)
 * — the agents', the MCP servers', git's and the forges' with a shelf under them of what is not set up
 * yet (`connections/Shelf.tsx`). Its rows are built from the store; what
 * is asked of main (the local ports, the weights, the MCP servers) is `connectionsModel.ts`'s and
 * `mcpData.ts`'s. How the re-check line looks:
 *
 *   the re-check line    in a section's heading, in its font (450 on a 1.3 line): row, centred, gap 8,
 *                        app 11/12.5; when the checks ran (--dim) and Re-check, a ghost button in the
 *                        same font (its tracking `normal`)
 */
export function ConnectionsPage(): JSX.Element {
  const { state, actions } = useShell();
  const { forgeOAuth } = useSettingsShell();
  const mcp = useMcpData(true, state.settingsConfig);
  const local = useLocalModels(true, state.availability.checkedAt, state.settingsConfig);
  const layer = state.configLayer;
  // Settings' path reads its own layers, which exist once they are read.
  const editable = state.settingsConfig !== null;
  const groups = providerGroups(state.executors);
  const rows: ProvidersPaneProps = {
    config: state.settingsConfig,
    executors: state.executors,
    routeProbes: state.modelProbes,
    executorProbes: state.probes,
    secrets: state.secrets,
    busy: state.busy,
    layer,
    editable,
    onSaveRoute: actions.saveModels,
    onSaveExecutor: actions.setExecutorConfig,
    onAdd: actions.addExecutor,
    onRemove: actions.removeExecutor,
    onSaveCredential: actions.saveCredential,
    signingIn: new Set(state.signingIn),
    onSignIn: (name) => void actions.signIn(name),
    onCancelSignIn: (name) => void actions.cancelSignIn(name),
    onSignOut: (name) => void actions.signOut(name),
    installing: new Set(state.installing),
    installLogs: installLogsOf(state.installLogs, "agent"),
    onInstall: (name, method) => void actions.installAgent(name, method),
    onCancelInstall: (name) => void actions.cancelInstall(name),
    onHideInstallLog: (name) => actions.hideInstallLog({ kind: "agent", name }),
    onUseCommand: (name, path) => void actions.useAgentCommand(name, path),
    onRecheck: () => void actions.recheckAvailability(),
    rechecking: state.rechecking,
    localServers: local.localServers,
    // The ports now, and the local route's own check — which is what turns its row from "not
    // reachable" to ready, and refreshes the catalog's local models.
    onScanLocal: () => {
      local.scan();
      void actions.recheckAvailability();
    },
    scanningLocal: local.scanning || state.rechecking,
    weights: local.weights,
  };
  return (
    <>
      <NeedsAttention page="connections" />
      <SettingsSection
        id="agents"
        title="Agents"
        info="They answer by RUNNING — reading files, executing commands — on their own subscription or key. A model id's prefix names one: claude-cli/sonnet."
        action={<RecheckLine checkedAt={state.availability.checkedAt} rechecking={state.rechecking} busy={state.busy} onRecheck={actions.recheckAvailability} />}
        // The card is AgentRows' own, with the shelf of agents not installed under it.
        plain
      >
        <AgentRows {...rows} specs={groups.agents} />
      </SettingsSection>
      <SettingsSection
        id="model-apis"
        title="Model APIs"
        info="They return a completion for a key. A model id's prefix names one — anthropic/claude-sonnet-5 goes to the first of these."
        // The card is ApiRows' own, with the shelf of APIs that have no key under it.
        plain
      >
        <ApiRows {...rows} specs={groups.apis} />
      </SettingsSection>
      <SettingsSection
        id="local-models"
        title="Local models"
        info="What runs on this machine: an OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM, Jan), found by asking the usual ports for a model list, and GGUF weights loaded into JaiRA itself."
      >
        <ProviderRows {...rows} specs={groups.local} />
      </SettingsSection>
      <SettingsSection
        id="mcp-servers"
        title="MCP servers"
        info="Servers whose tools an agent can call: a command JaiRA starts, or a URL it calls. Every agent run is handed the ones that are on, and a permission set says what each of their tools may do (Settings → Tools)."
        action={<RecheckLine checkedAt={mcp.report?.checkedAt ?? 0} rechecking={mcp.rechecking} busy={state.busy} onRecheck={mcp.recheck} />}
        // The card is McpServerRows' own, with the shelf of servers other tools run under it.
        plain
      >
        <McpServerRows config={state.settingsConfig} layer={layer} busy={state.busy} editable={editable} secrets={state.secrets} mcp={mcp} onSave={actions.saveConfig} />
      </SettingsSection>
      <SettingsSection
        id="git"
        title="Git"
        info="The git JaiRA runs for worktrees, diffs and pushes, where agents run. GitHub's and GitLab's own CLIs are for agents that call a forge from a shell: JaiRA itself reaches a forge through the connections under Forges."
        // The card is GitRows' own, with the shelf of forge CLIs not installed under it.
        plain
      >
        <GitRows
          checks={state.availability.gitClis}
          installing={new Set(state.installingGitClis)}
          logs={installLogsOf(state.installLogs, "gitCli")}
          busy={state.busy}
          onInstall={(name, method) => void actions.installGitCli(name, method)}
          onCancel={(name) => void actions.cancelGitCliInstall(name)}
          onHideLog={(name) => actions.hideInstallLog({ kind: "gitCli", name })}
          onRecheck={() => void actions.recheckAvailability()}
          rechecking={state.rechecking}
        />
      </SettingsSection>
      <SettingsSection
        id="forges"
        title="Forges"
        info="Where a review can also be opened as a merge request. A project's git remote picks the connection by host."
        // The card is ForgeRows' own, with the shelf of connections not signed in to under it.
        plain
      >
        <ForgeRows
          config={state.settingsConfig}
          layer={layer}
          busy={state.busy}
          editable={editable}
          checks={state.availability.forges ?? []}
          secrets={state.secrets}
          onSave={actions.saveConfig}
          onSaveToken={actions.saveForgeToken}
          oauth={forgeOAuth}
          onOpenTools={() => actions.setSection("tools")}
        />
      </SettingsSection>
    </>
  );
}

/** The re-check line's font and its button's: the section heading's (450, line 1.3) at 11/12.5. */
const RECHECK = { voice: "app", scale: 11 / 12.5, weight: 450, lineHeight: 1.3 } as const;

/** When the checks last ran, and Re-check — at the head of the section they are about. */
function RecheckLine({ checkedAt, rechecking, busy, onRecheck }: { checkedAt: number; rechecking: boolean; busy: boolean; onRecheck: () => void }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" gap={8} flexShrink={0}>
      {/* The heading's -0.005em, kept as its length: at 1.1× that is -0.00625 of this 11/12.5. */}
      <Txt spec={{ ...RECHECK, color: "dim", ls: (-0.005 * 1.1) / (11 / 12.5) }}>{checkedAgo(checkedAt)}</Txt>
      <Button kind="ghost" onPress={onRecheck} disabled={busy || rechecking} font={RECHECK}>
        {rechecking ? "checking…" : "Re-check"}
      </Button>
    </View>
  );
}
