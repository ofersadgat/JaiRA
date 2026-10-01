/**
 * What Settings → Connections' forge rows are drawn from — the props the universal `ForgeRows`
 * (`packages/universal/src/components/settings/connections/ForgeRows.tsx`) takes. A type only.
 */
import type { ConfigLayer, ConfigView, ForgeCheck, SecretCapabilities, SecretTarget } from "@jaira/shared/browser";

export interface IntegrationsPaneProps {
  config: ConfigView | null;
  layer: ConfigLayer;
  busy: boolean;
  /** False when this layer has no document to write — see the Settings shell, which hides the layer. */
  editable: boolean;
  /** What the last check found, by connection name. Absent ⇒ not checked yet. */
  checks: ForgeCheck[];
  secrets: SecretCapabilities;
  /** Write the whole layer document. The caller validates it in main before it lands. */
  onSave: (layer: ConfigLayer, doc: unknown) => void;
  /**
   * Store a token's value, and name it in the layer being edited when nothing names it yet.
   *
   * The value crosses to main in this call and is never read back; an empty one clears the secret.
   */
  onSaveToken: (request: {
    connection: string;
    /** The name config already holds, when it holds one. */
    named?: string;
    name: string;
    value: string;
    target: SecretTarget;
    layer: ConfigLayer;
  }) => void;
  /**
   * Signing in with the forge itself (OAuth device flow), beside pasting a token. Absent ⇒ tokens only.
   * `pending` holds the code the person types at the forge while a sign-in waits on the browser.
   */
  oauth?: {
    signingIn: ReadonlySet<string>;
    pending: ReadonlyMap<string, string>;
    errors: ReadonlyMap<string, string>;
    viaOAuth: ReadonlySet<string>;
    onSignIn: (connection: string) => void;
    onCancel: (connection: string) => void;
    onDisconnect: (connection: string) => void;
  };
  /** Go to Settings → Tools, where the Git tools a connection serves are governed. Absent ⇒ the name is plain text. */
  onOpenTools?: (() => void) | undefined;
}
