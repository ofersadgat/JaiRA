import { useState, type JSX } from "react";
import { ScrollView } from "react-native";
import { View } from "@tamagui/core";
import type { ExecutorInfo, FileTree, StateSlots, ValidateSchemaResult, WorkflowLayer, WorkflowSource } from "@jaira/shared/browser";
import { useStateSource } from "@jaira/ui/configPanelModel";
import type { UiSurface } from "@jaira/ui/fileTypes";
import { PLAIN_SCROLLER, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { Button } from "../settings/Button";
import { Empty } from "./controls";
import { WorkflowEditor } from "./WorkflowEditor";

/**
 * One state's configuration in the side panel — its own copy of the file (`useStateSource`,
 * `configPanelModel.ts`), the workflow editor on Form and JSON only, and the way out to the file's own
 * editor. How it looks:
 *
 *   the panel           column, the rest, gap 8, padding 10 12 12, scrolling sideways
 *   each child          at least 460 wide (the column is narrower: it scrolls)
 *   the way out         a row, its button (a ghost) at the end
 */
export function StatePanel({
  stateId,
  read,
  save,
  tree,
  executors,
  busy,
  validateSchema,
  loadStateSlots,
  wrapJson,
  onWrapJson,
  ui,
  readFile,
  onOpenState,
}: {
  stateId: string;
  read: (stateId: string) => Promise<WorkflowSource | null>;
  save: (source: WorkflowSource, text: string) => void;
  tree: FileTree | null;
  executors: ExecutorInfo[];
  busy: boolean;
  validateSchema?: ((schemaId: string, text: string) => Promise<ValidateSchemaResult | null>) | undefined;
  loadStateSlots?: ((stateIds: string[]) => Promise<Record<string, StateSlots> | null>) | undefined;
  wrapJson?: boolean | undefined;
  onWrapJson?: ((wrap: boolean) => void) | undefined;
  ui?: UiSurface | undefined;
  readFile?: ((layer: WorkflowLayer, path: string) => Promise<string | null>) | undefined;
  onOpenState?: ((stateId: string) => void) | undefined;
}): JSX.Element {
  const t = useTokens();
  const source = useStateSource(stateId, read);
  // The panel's width, for its content's: every child at least 460 wide, the padding either side of it.
  const [room, setRoom] = useState(0);
  if (source === null) return <Empty>Reading {stateId}…</Empty>;
  if (source === "missing") return <Empty>Nothing under either root defines {stateId}.</Empty>;
  return (
    <ScrollView
      horizontal
      style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0, ...PLAIN_SCROLLER } as never}
      onLayout={(e) => setRoom(e.nativeEvent.layout.width)}
      contentContainerStyle={{ flexDirection: "column", gap: 8, paddingTop: 10, paddingHorizontal: 12, paddingBottom: 12, width: Math.max(room, 460 + 24), height: "100%", ...PLAIN_SCROLLER } as never}
      {...(scrollbarProps(t) as object)}
    >
      {onOpenState !== undefined ? (
        <View flexDirection="row" justifyContent="flex-end" flexShrink={0} minWidth={460}>
          <Button kind="ghost" title={`open ${source.file}`} onPress={() => onOpenState(stateId)}>
            Open in the editor
          </Button>
        </View>
      ) : null}
      <View flexGrow={1} flexShrink={1} flexBasis={0} minHeight={0} minWidth={460} flexDirection="column">
        <WorkflowEditor
          source={source}
          tree={tree}
          executors={executors}
          busy={busy}
          tabs={["form", "json"]}
          {...(validateSchema !== undefined ? { validateSchema } : {})}
          {...(loadStateSlots !== undefined ? { loadStateSlots } : {})}
          {...(wrapJson !== undefined ? { wrapJson } : {})}
          onWrapJson={onWrapJson}
          ui={ui}
          {...(readFile !== undefined ? { readFile } : {})}
          onSave={(_stateId, _layer, text) => save(source, text)}
        />
      </View>
    </ScrollView>
  );
}
