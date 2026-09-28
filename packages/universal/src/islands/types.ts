import type { JairaAppearanceConfig } from "@jaira/shared/browser";

/** An island (decision 0015): one of the renderer's DOM components, hosted where DOM is not. */
export interface IslandProps {
  component: "markdown" | "diff" | "markdownEditor" | "code" | "schemaText";
  props: Record<string, unknown>;
  /** A fixed height, for an editor, which scrolls inside as on the desktop. Absent: sized to its content. */
  height?: number;
  /**
   * The person's appearance block (`lookOf(config)`), for an editor island: its fonts and size, the
   * editors' own palette, each editor's look and the palette per type — what the desktop's store puts
   * on its root, which an island page is sent instead. On web the page's root has it already.
   */
  appearance?: JairaAppearanceConfig;
  /** A callback the component fired (`change`, `modified`). */
  onEvent?: (name: string, value: unknown) => void;
  /** Every frame the island sent (ready, drawn, height, log…), for a host that measures it (native only). */
  onReport?: (message: { kind: string; [key: string]: unknown }) => void;
}
