import type { JSX } from "react";
import { ScrollView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { FileTree, WorkflowLayer } from "@jaira/shared/browser";
import { KIND_GLYPH, entriesUnder } from "@jaira/ui/filesModel";
import { PLAIN_SCROLLER, Press, Txt, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { Chip } from "./Chip";

/**
 * A folder, one level, as a file explorer shows one — `..` first, then the folders, then the files
 * (`entriesUnder`'s order). How it looks:
 *
 *   the panel        takes the file panel's column, scrolling
 *   the list         a column, 1px --line ring, radius --control-radius, at most 320 tall, clipped;
 *                    padding 8 10, gap 1
 *   a row            row, centred, gap 8, padding 6 10, a --line under it (none on the last), --panel,
 *                    app 13/12.5; hovered --panel-2
 *   its glyph        14 wide, centred, app 10/12.5, --dim.   A folder's name 600.   `..` --dim
 */
export function DirectoryPanel({
  layer,
  path,
  tree,
  onOpenDir,
  onOpenFile,
  onOpenState,
}: {
  layer: WorkflowLayer;
  path: string;
  tree: FileTree | null;
  onOpenDir: (layer: WorkflowLayer, path: string) => void;
  onOpenFile: (layer: WorkflowLayer, path: string) => void;
  onOpenState: (stateId: string) => void;
}): JSX.Element {
  const t = useTokens();
  const entries = entriesUnder(tree, layer, path);
  const parent = path === "" ? null : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const rows = [
    ...(parent !== null ? [{ key: "..", glyph: "↰", name: "..", dir: false, up: true, go: () => onOpenDir(layer, parent), node: null }] : []),
    ...entries.map((node) => ({
      key: node.path,
      glyph: node.kind === "directory" ? "▸" : (KIND_GLYPH[node.kind] ?? "·"),
      name: node.stateId !== undefined ? (node.stateId.split("/").pop() ?? node.name) : node.name,
      dir: node.kind === "directory",
      up: false,
      go: () => (node.kind === "directory" ? onOpenDir(node.layer, node.path) : node.stateId !== undefined ? onOpenState(node.stateId) : onOpenFile(node.layer, node.path)),
      node,
    })),
  ];
  return (
    <ScrollView {...(scrollbarProps(t) as object)} style={{ flex: 1, minHeight: 0, ...PLAIN_SCROLLER } as never} contentContainerStyle={PLAIN_SCROLLER as never}>
      <View flexDirection="column" paddingVertical={8} paddingHorizontal={10} gap={1} maxHeight={320} overflow="hidden" borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={t.v("control-radius") as never}>
        {rows.map((row, i) => (
          <Press
            key={row.key}
            onPress={row.go}
            title={row.node?.error ?? row.node?.path ?? row.name}
            label={row.name}
            flexDirection="row"
            alignItems="center"
            gap={8}
            paddingVertical={6}
            paddingHorizontal={10}
            borderBottomWidth={i === rows.length - 1 ? 0 : 1}
            borderTopWidth={0}
            borderLeftWidth={0}
            borderRightWidth={0}
            borderStyle="solid"
            borderColor={t.v("line") as never}
            box={({ hovered }) => ({ backgroundColor: t.v(hovered ? "panel-2" : "panel") })}
          >
            <Txt spec={{ voice: "app", scale: 10 / 12.5, color: "dim" }} width={14} flexShrink={0} textAlign="center">
              {row.glyph}
            </Txt>
            <Txt spec={{ voice: "app", scale: 13 / 12.5, color: row.up ? "dim" : "text", weight: row.dir ? 600 : 400 }} ellip flex={1} minWidth={0}>
              {row.name}
            </Txt>
            {row.node?.error !== undefined ? <Chip tone="bad">!</Chip> : null}
            {row.node !== null && row.node.error === undefined && (row.node.lint?.errors ?? 0) > 0 ? <Chip tone="bad">{row.node.lint!.errors}</Chip> : null}
            {row.node !== null && row.node.error === undefined && (row.node.lint?.errors ?? 0) === 0 && (row.node.lint?.warnings ?? 0) > 0 ? <Chip tone="warn">{row.node.lint!.warnings}</Chip> : null}
            {row.node?.shadowed === true ? <Chip>shadowed</Chip> : null}
          </Press>
        ))}
        {entries.length === 0 ? (
          <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8}>
            This folder is empty.
          </Txt>
        ) : null}
      </View>
    </ScrollView>
  );
}
