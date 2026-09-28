import type { JSX } from "react";
import { View } from "@tamagui/core";
import type { ConfigLayer, WorkflowLayer } from "@jaira/shared/browser";
import { layerSegmentOf } from "@jaira/ui/layerLabels";
import { Button } from "./Button";

/**
 * `panes.tsx`'s `LayerPicker`, universal (decision 0015): the layer switch, used wherever a write has to
 * name where it lands — at a settings page's top-right corner. Its words and tooltips are
 * `layerSegmentOf`'s, as the DOM's are.
 *
 *   .layer-picker          row, gap 4; each segment a `button` (flex 1, which in a switch sized by its
 *                          content is each one's own width)
 *   button.ghost           a segment not chosen
 *   button.layer-on        the chosen one: --fill-accent, --on-accent at 600, --sheen (as `primary`)
 */
export function LayerPicker<L extends WorkflowLayer | ConfigLayer = ConfigLayer>({
  value,
  onChange,
  disabled,
  layers,
  projectName,
}: {
  value: L;
  onChange: (layer: L) => void;
  disabled?: boolean;
  layers?: readonly L[];
  projectName?: string | undefined;
}): JSX.Element {
  return (
    <View flexDirection="row" gap={4} role="group" aria-label="Configuration layer">
      {(layers ?? (["you", "project", "base"] as L[])).map((layer) => {
        const segment = layerSegmentOf(layer, projectName);
        return (
          <Button key={layer} kind={value === layer ? "primary" : "ghost"} onPress={() => onChange(layer)} disabled={disabled} title={segment.title} flexGrow={1}>
            {segment.label}
          </Button>
        );
      })}
    </View>
  );
}
