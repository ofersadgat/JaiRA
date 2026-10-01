/**
 * What Settings → Connections' provider rows are drawn from — the props the universal `ProviderRows`
 * (`packages/universal/src/components/settings/connections/ProviderRows.tsx`) takes. A type only.
 */
import type {
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
