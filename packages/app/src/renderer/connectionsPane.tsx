/**
 * Settings → Connections — what JaiRA can reach, and as whom (the person's reorganisation,
 * 2026-09-23). Where there were two tabs, Providers and Integrations, both answering that one
 * question, there is one page of four sections, in the order a person sets them up:
 *
 *  - **Agents** — the CLIs and SDK agents that answer by running, on a subscription or a key. First,
 *    because a subscription needs no key, and it is what a bare model id reaches first.
 *  - **Model APIs** — the providers that return a completion for a key.
 *  - **Local models** — what runs on this machine: an OpenAI-compatible server, found by asking the
 *    usual ports, and GGUF weights loaded into JaiRA itself, each file checked.
 *  - **MCP servers** — the servers whose tools an agent can call, handed to every agent run; and the
 *    ones other tools on this machine already run, one click from being ours (`mcpServersRows.tsx`).
 *  - **Forges** — where a review can also be opened as a merge request.
 *
 * Every row has one shape: what it is and whether it works on the left; who it connects as on the
 * right, as boxes — a login, an OAuth account, a stored key — with a + box at the end to add one.
 */
import type { JSX } from "react";
import type {
  ConfigLayer,
  ConfigView,
  EmbeddedWeightsReport,
  ExecutorInfo,
  ForgeCheck,
  LocalServerProbe,
  ProbeResult,
  SecretCapabilities,
  SecretTarget,
} from "@jaira/shared/browser";
import { AddAgentRow, ProviderRows, providerGroups, type ProvidersPaneProps } from "./providersPane";
import { ForgeRows, type IntegrationsPaneProps } from "./integrationsPane";
import type { McpData } from "./mcpData";
import { McpServerRows } from "./mcpServersRows";
import { SettingsSection } from "./settingsLayout";

export interface ConnectionsPageProps {
  config: ConfigView | null;
  executors: ExecutorInfo[];
  routeProbes: Record<string, ProbeResult>;
  executorProbes: Record<string, ProbeResult>;
  forgeChecks: ForgeCheck[];
  secrets: SecretCapabilities;
  busy: boolean;
  layer: ConfigLayer;
  editable: boolean;
  /** When the availability checks last ran, and whether a re-check is running now. */
  checkedAt: number;
  rechecking: boolean;
  onRecheck: () => void;
  onSave: (layer: ConfigLayer, doc: unknown) => void;
  onSaveRoute: ProvidersPaneProps["onSaveRoute"];
  onSaveExecutor: ProvidersPaneProps["onSaveExecutor"];
  onAdd: ProvidersPaneProps["onAdd"];
  onRemove: ProvidersPaneProps["onRemove"];
  onSaveCredential: ProvidersPaneProps["onSaveCredential"];
  onSaveToken: (request: { connection: string; named?: string; name: string; value: string; target: SecretTarget; layer: ConfigLayer }) => void;
  signingIn: ReadonlySet<string>;
  onSignIn: (name: string) => void;
  onCancelSignIn: (name: string) => void;
  onSignOut: (name: string) => void;
  localServers?: LocalServerProbe[] | undefined;
  weights?: EmbeddedWeightsReport | undefined;
  oauth?: IntegrationsPaneProps["oauth"];
  /** The MCP servers' state and tools, and what other tools on this machine run. Absent ⇒ the section is not drawn. */
  mcp?: McpData | undefined;
}

export function ConnectionsPage(props: ConnectionsPageProps): JSX.Element {
  const groups = providerGroups(props.executors);
  const rows: ProvidersPaneProps = {
    config: props.config,
    executors: props.executors,
    routeProbes: props.routeProbes,
    executorProbes: props.executorProbes,
    secrets: props.secrets,
    busy: props.busy,
    layer: props.layer,
    editable: props.editable,
    onSaveRoute: props.onSaveRoute,
    onSaveExecutor: props.onSaveExecutor,
    onAdd: props.onAdd,
    onRemove: props.onRemove,
    onSaveCredential: props.onSaveCredential,
    signingIn: props.signingIn,
    onSignIn: props.onSignIn,
    onCancelSignIn: props.onCancelSignIn,
    onSignOut: props.onSignOut,
    localServers: props.localServers,
    weights: props.weights,
  };
  return (
    <div className="cfg-pane">
      <SettingsSection
        id="agents"
        title="Agents"
        info="They answer by RUNNING — reading files, executing commands — on their own subscription or key. A model id's prefix names one: claude-cli/sonnet."
        action={<RecheckLine checkedAt={props.checkedAt} rechecking={props.rechecking} busy={props.busy} onRecheck={props.onRecheck} />}
      >
        <ProviderRows {...rows} specs={groups.agents} />
        <AddAgentRow layer={props.layer} busy={props.busy} editable={props.editable} onAdd={props.onAdd} />
      </SettingsSection>
      <SettingsSection
        id="model-apis"
        title="Model APIs"
        info="They return a completion for a key. A model id's prefix names one — anthropic/claude-sonnet-5 goes to the first of these."
      >
        <ProviderRows {...rows} specs={groups.apis} />
      </SettingsSection>
      <SettingsSection
        id="local-models"
        title="Local models"
        info="What runs on this machine: an OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM, Jan), found by asking the usual ports for a model list, and GGUF weights loaded into JaiRA itself."
      >
        <ProviderRows {...rows} specs={groups.local} />
      </SettingsSection>
      {props.mcp !== undefined ? (
        <SettingsSection
          id="mcp-servers"
          title="MCP servers"
          info="Servers whose tools an agent can call: a command JaiRA starts, or a URL it calls. Every agent run is handed the ones that are on, and a permission set says what each of their tools may do (Settings → Tools)."
          action={<RecheckLine checkedAt={props.mcp.report?.checkedAt ?? 0} rechecking={props.mcp.rechecking} busy={props.busy} onRecheck={props.mcp.recheck} />}
        >
          <McpServerRows config={props.config} layer={props.layer} busy={props.busy} editable={props.editable} secrets={props.secrets} mcp={props.mcp} onSave={props.onSave} />
          {props.mcp.problem !== null ? <p className="sub warn-text">{props.mcp.problem}</p> : null}
        </SettingsSection>
      ) : null}
      <SettingsSection
        id="forges"
        title="Forges"
        info="Where a review can also be opened as a merge request. A project's git remote picks the connection by host."
      >
        <ForgeRows
          config={props.config}
          layer={props.layer}
          busy={props.busy}
          editable={props.editable}
          checks={props.forgeChecks}
          secrets={props.secrets}
          onSave={props.onSave}
          onSaveToken={props.onSaveToken}
          {...(props.oauth !== undefined ? { oauth: props.oauth } : {})}
        />
      </SettingsSection>
    </div>
  );
}

/**
 * When the checks last ran, and Re-check — at the head of the section they are about. Not "Test":
 * nothing here is waiting to be tested. The checks ran at startup and after the last save; this is
 * only for a world that changed since — a server started, a key installed in another window.
 */
function RecheckLine({ checkedAt, rechecking, busy, onRecheck }: { checkedAt: number; rechecking: boolean; busy: boolean; onRecheck: () => void }): JSX.Element {
  return (
    <span className="settings-recheck">
      <span className="sub">{checkedAgo(checkedAt)}</span>
      <button className="ghost" onClick={onRecheck} disabled={busy || rechecking}>
        {rechecking ? "checking…" : "Re-check"}
      </button>
    </span>
  );
}

/** "checked 2 min ago", or the honest absence of one. */
function checkedAgo(at: number): string {
  if (at === 0) return "not checked yet";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "checked just now";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `checked ${minutes} min ago` : `checked ${Math.round(minutes / 60)} h ago`;
}
