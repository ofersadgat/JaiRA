/**
 * What the MCP servers' rows are drawn from — the props the universal `McpServerRows`
 * (`packages/universal/src/components/settings/connections/McpServerRows.tsx`) takes. A type only.
 */
import type { ConfigLayer, ConfigView, SecretCapabilities } from "@jaira/shared/browser";
import type { McpData } from "./mcpData";

export interface McpServerRowsProps {
  config: ConfigView | null;
  /** The layer every write goes into — any of them. */
  layer: ConfigLayer;
  busy: boolean;
  /** False when this layer has no document to write. */
  editable: boolean;
  secrets: SecretCapabilities;
  mcp: McpData;
  /** Write the whole layer document; main validates it before it lands. */
  onSave: (layer: ConfigLayer, doc: unknown) => void;
}
