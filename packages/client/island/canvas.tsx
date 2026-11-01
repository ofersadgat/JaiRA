import { CanvasBoard } from "@jaira/ui/canvasBoard";
import { readCanvasIndex } from "@jaira/ui/canvasIndex";
import { mountIsland } from "./host";

/**
 * The canvas island (decision 0020 §5): a design canvas's board, every artboard running in a frame of its
 * own from the grant at the engine's HTTP route (`base`). No Edit: the editor is a computer's.
 */
mountIsland({
  drawn: "#island iframe",
  draw: (p) => (
    <CanvasBoard
      index={readCanvasIndex(typeof p["index"] === "string" ? p["index"] : undefined)}
      base={String(p["base"] ?? "")}
      {...(p["style"] !== undefined ? { style: p["style"] as never } : {})}
    />
  ),
});
