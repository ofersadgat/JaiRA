import type { JairaAppearanceConfig } from "@jaira/shared/browser";

/** An island (decision 0015): one of the renderer's DOM components, hosted where DOM is not. */
export interface IslandProps {
  component: "markdown" | "diff" | "markdownEditor" | "code" | "schemaText" | "artifact";
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
  /**
   * What the host can ask of the island once it is drawn (the diff's `revertSelectedLines`), handed over
   * when it can take commands and withdrawn (`null`) when it goes. A command's answer comes back as an
   * event. On web the component's own imperative actions; on a phone a message over the bridge.
   */
  handle?: (handle: IslandHandle | null) => void;
  /** Every frame the island sent (ready, drawn, height, log…), for a host that measures it (native only). */
  onReport?: (message: { kind: string; [key: string]: unknown }) => void;
}

/** See {@link IslandProps.handle}. */
export interface IslandHandle {
  command(name: string, value?: unknown): void;
}
