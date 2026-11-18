/**
 * What Settings → Connections' provider rows are drawn from — the props `ProviderRows`
 * (`packages/universal/src/components/settings/connections/ProviderRows.tsx`) takes. A type only.
 */
import type {
  AgentInstallMethod,
  ConfigLayer,
  ConfigView,
  ExecutorInfo,
  ProbeResult,
  EmbeddedWeightsReport,
  LocalServerProbe,
  SecretCapabilities,
  SecretTarget,
} from "@jaira/shared/browser";
import type { ExecutorPatch, ExecutorTarget } from "./executorConfig";
import type { InstallLog } from "./installLog";
import type { ModelPatch } from "./modelsConfig";

export interface ProvidersPaneProps {
  config: ConfigView | null;
  executors: ExecutorInfo[];
  /**
   * What the checks observed, kept as TWO maps rather than one.
   *
   * A route and an executor are different namespaces: nothing stops someone registering a generic
   * CLI called `local`, and a single merged map would then report one provider's health for the
   * other. Each row looks its result up in the map for its own family.
   */
  routeProbes: Record<string, ProbeResult>;
  executorProbes: Record<string, ProbeResult>;
  secrets: SecretCapabilities;
  busy: boolean;
  layer: ConfigLayer;
  /** False when this layer has no document to write — see the Settings shell, which hides the layer. */
  editable: boolean;
  onSaveRoute: (fields: ModelPatch, layer: ConfigLayer) => void;
  onSaveExecutor: (executor: ExecutorTarget, fields: ExecutorPatch, layer: ConfigLayer) => void;
  onAdd: (spec: { name: string; command: string }, layer: ConfigLayer) => void;
  onRemove: (name: string, layer: ConfigLayer) => void;
  onSaveCredential: (request: {
    executor: ExecutorTarget & { credential?: string | undefined };
    name: string;
    value: string;
    target: SecretTarget;
    layer: ConfigLayer;
  }) => void;
  /** Agents whose sign-in is waiting on the browser. */
  signingIn: ReadonlySet<string>;
  onSignIn: (name: string) => void;
  onCancelSignIn: (name: string) => void;
  onSignOut: (name: string) => void;
  /** Agents whose install or update is running. */
  installing: ReadonlySet<string>;
  /** What each agent's install or update pressed here printed, by agent — until its row's Hide. */
  installLogs: Readonly<Record<string, InstallLog>>;
  /** Install an agent the way named, or — none named — update it the way it was installed. */
  onInstall: (name: string, method?: AgentInstallMethod) => void;
  onCancelInstall: (name: string) => void;
  /** Put an install's output away. */
  onHideInstallLog: (name: string) => void;
  /** Run an agent from this path: installed where this app's PATH does not reach. */
  onUseCommand: (name: string, path: string) => void;
  /**
   * Run every check again — an agent row's Check again, while it is signed out or not working. Absent ⇒
   * no row offers it (the section's Re-check still does).
   */
  onRecheck?: (() => void) | undefined;
  /** The checks are running again: Check again reads `checking…`. */
  rechecking?: boolean | undefined;
  /** What answered on the usual local ports, when the page last asked. Absent ⇒ not asked yet. */
  localServers?: LocalServerProbe[] | undefined;
  /**
   * Ask the usual ports again now, and re-check the local route — a server started after the page
   * opened is otherwise only found by the page-wide Re-check (the person, 2026-09-25).
   */
  onScanLocal?: (() => void) | undefined;
  /** A scan is in flight. */
  scanningLocal?: boolean | undefined;
  /** Whether each embedded model's weights file is there, and whether the loader is. Absent ⇒ not checked yet. */
  weights?: EmbeddedWeightsReport | undefined;
}
