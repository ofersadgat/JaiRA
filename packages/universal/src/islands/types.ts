import type { JairaAppearanceConfig } from "@jaira/shared/browser";

/** An island (decision 0015): one of `@jaira/ui`'s DOM components, inline on web and in a WebView on a phone. */
export interface IslandProps {
  component: "markdown" | "diff" | "markdownEditor" | "code" | "schemaText" | "artifact";
  props: Record<string, unknown>;
  /** A fixed height, for an editor, which scrolls inside. Absent: sized to its content. */
  height?: number;
  /**
   * The classes the component is to stand under, outermost first (`["markdown", "md-block"]` for a
   * fenced block's reading): its rules in the island's stylesheet — `.markdown pre`, `.markdown code` —
   * name those ancestors, and the tree round an island has none of them. On web each is a box that
   * generates no box (`display: contents`), so the rules match and the layout is the island's own. A
   * phone's island page does not take them yet.
   */
  under?: readonly string[];
  /**
   * The person's appearance block (`lookOf(config)`), for an editor island: its fonts and size, the
   * editors' own palette, each editor's look and the palette per type — what the store puts on a web
   * page's root (`applyAppearance`), which a phone's island page is sent instead.
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
