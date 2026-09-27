import { Markdown } from "@jaira/ui/markdown";
import { mountIsland } from "./host";

/** The markdown island: `markdown.tsx`'s view, sized to its content. */
mountIsland({
  drawn: "#island > *",
  draw: (p) => <Markdown text={String(p["text"] ?? "")} />,
});
