/** An island (decision 0015): one of the renderer's DOM components, hosted where DOM is not. */
export interface IslandProps {
  component: "markdown" | "diff" | "markdownEditor";
  props: Record<string, unknown>;
  /** A fixed height, for an editor, which scrolls inside as on the desktop. Absent: sized to its content. */
  height?: number;
  /** A callback the component fired (`change`, `modified`). */
  onEvent?: (name: string, value: unknown) => void;
  /** Every frame the island sent (ready, drawn, height, log…), for a host that measures it (native only). */
  onReport?: (message: { kind: string; [key: string]: unknown }) => void;
}
