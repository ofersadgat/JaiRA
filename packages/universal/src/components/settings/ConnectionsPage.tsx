import type { JSX } from "react";
import { View } from "@tamagui/core";
import { checkedAgo, providerGroups, useLocalModels } from "@jaira/ui/connectionsModel";
import { useMcpData } from "@jaira/ui/mcpData";
import type { ProvidersPaneProps } from "@jaira/ui/providersPane";
import { useShell } from "../../app/shell";
import { Txt } from "../../primitives";
import { Button } from "./Button";
import { AddAgentRow, ProviderRows } from "./connections/ProviderRows";
import { ForgeRows } from "./connections/ForgeRows";
import { McpServerRows } from "./connections/McpServerRows";
import { Problem } from "./connections/Row";
import { NeedsAttention, useSettingsShell } from "./NeedsAttention";
import { SettingsSection } from "./SettingsPage";

/**
 * Settings → Connections (`connectionsPane.tsx`'s `ConnectionsPage`), universal (decision 0015): what
 * JaiRA can reach, and as whom — the agents, the model APIs, the local models, the MCP servers and the
 * forges, each a card of rows. It is built from the store as `App.tsx` builds the DOM's; what is asked
 * of main (the local ports, the weights, the MCP servers) is `connectionsModel.ts`'s and `mcpData.ts`'s,
 * the hooks the desktop calls. The rule it adds:
 *
 *   .settings-recheck    in a section's heading (whose font it inherits: 450 on a 1.3 line): row,
 *                        centred, gap 8, app 11/12.5; when the checks ran (`.sub`, --dim) and Re-check,
 *                        a ghost button in the same font (its tracking `normal`)
 */
export function ConnectionsPage(): JSX.Element {
  const { state, actions } = useShell();
  const { forgeOAuth } = useSettingsShell();
  const mcp = useMcpData(true, state.config);
  const local = useLocalModels(true, state.availability.checkedAt, state.config);
  const layer = state.configLayer;
  const editable = layer !== "project" || state.at !== null;
  const groups = providerGroups(state.executors);
  const rows: ProvidersPaneProps = {
    config: state.config,
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
      >
        <>
          <ProviderRows {...rows} specs={groups.agents} />
          <AddAgentRow layer={layer} busy={state.busy} editable={editable} onAdd={actions.addExecutor} />
        </>
      </SettingsSection>
      <SettingsSection id="model-apis" title="Model APIs" info="They return a completion for a key. A model id's prefix names one — anthropic/claude-sonnet-5 goes to the first of these.">
        <ProviderRows {...rows} specs={groups.apis} />
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
      >
        <McpServerRows config={state.config} layer={layer} busy={state.busy} editable={editable} secrets={state.secrets} mcp={mcp} onSave={actions.saveConfig} />
        {mcp.problem !== null ? (
          <View paddingVertical={13} paddingHorizontal={16}>
            <Problem>{mcp.problem}</Problem>
          </View>
        ) : null}
      </SettingsSection>
      <SettingsSection id="forges" title="Forges" info="Where a review can also be opened as a merge request. A project's git remote picks the connection by host.">
        <ForgeRows
          config={state.config}
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

/** The heading's font, which `.settings-recheck` and its button inherit at 11/12.5 (`.set-section-title`: 450, line 1.3). */
const RECHECK = { voice: "app", scale: 11 / 12.5, weight: 450, lineHeight: 1.3 } as const;

/** When the checks last ran, and Re-check — at the head of the section they are about. */
function RecheckLine({ checkedAt, rechecking, busy, onRecheck }: { checkedAt: number; rechecking: boolean; busy: boolean; onRecheck: () => void }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" gap={8} flexShrink={0}>
      {/* The heading's -0.005em, inherited as its length: at 1.1× that is -0.00625 of this 11/12.5. */}
      <Txt spec={{ ...RECHECK, color: "dim", ls: (-0.005 * 1.1) / (11 / 12.5) }}>{checkedAgo(checkedAt)}</Txt>
      <Button kind="ghost" onPress={onRecheck} disabled={busy || rechecking} font={RECHECK}>
        {rechecking ? "checking…" : "Re-check"}
      </Button>
    </View>
  );
}
