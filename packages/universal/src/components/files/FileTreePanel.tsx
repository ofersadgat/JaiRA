import { useRef, useState, type JSX } from "react";
import { ScrollView, TextInput, View as RNView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { FileNode, FileRoot, FileTree, WorkflowLayer } from "@jaira/shared/browser";
import { isWritableLayer } from "@jaira/shared/browser";
import {
  KIND_GLYPH,
  anchorIn,
  newItems,
  rootEmptyText,
  rootNeedsName,
  treeMatches,
  treeRowOf,
  type FileSelection,
  type TreeDraft,
} from "@jaira/ui/filesModel";
import { Press, Txt, edge, font, scrollbarProps, useHover } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { ContextMenu, type MenuAt } from "../Menu";
import { Chip } from "./Chip";

/**
 * `files.tsx`'s `FileTreePanel`, universal (decision 0015): the Files drawer under the sidebar's Files
 * row — every root's tree, folded as the person left it, the `+` on a folder and on a named root, the
 * row a new name is typed into, and the find field. What each row says is `treeRowOf`, what a `+`
 * offers is `newItems`, where a draft is drawn is `anchorIn` (`filesModel.ts`, the desktop's own).
 * The rules, from `styles.css` (`cascade.mts .file-browser --scene files`):
 *
 *   .file-browser     column, flex 1, gap 8, padding 2 0 4
 *   .scroll           flex 1, scrolls
 *   .file-tree        12.5/12.5 app, 10 below
 *   .tree-root        row, centred, gap 5, padding 8 6 4, --dim, app 10.5/12.5, uppercase, 0.08em; its
 *                     name data-secondary (the letter spacing and case inherited), taking the slack but
 *                     on Built in (`.is-readonly`), whose chip keeps no case or spacing
 *   .tree-item        row, centred, gap 5, padding 3 6, radius 5; hovered --fill-ghost-hover; selected
 *                     --fill-ghost-selected and 600 (inherited by all of it); inert --dim; shadowed at
 *                     .55 and the name struck through
 *   .tree-guide       13 wide, the row's height (-3 above and below), -5 right (the gap), a 1px rule on
 *                     its left: --rule on the last, --line on the ones before it
 *   .glyph            13 wide, centred, app 10/12.5, --dim
 *   .name             data 11.5/12, the slack, one line cut with "…"; --bad with an error, --warn with a
 *                     warning, at .6 and italic unchecked
 *   .lint-dot         app 8/12.5, line 1; --bad or --warn.   .dirty-dot  the same in --accent
 *   .tree-add         16 square, radius 4, app 12/12.5, line 1, --dim; hidden (opacity 0) until the row
 *                     is hovered; hovered --text on --fill-ghost-selected
 *   .root-empty       --dim, padding 2 6 6 19, app 11/12.5, line 1.45
 *   .tree-draft       no hover ground; .draft-lead --dim data 11.5/12; .draft-name the same face in
 *                     --text, a --accent rule under it
 *   input.tree-find   --bg, 1px --line (--rule hovered), radius --control-radius, padding 5 9
 *
 * Not copied: the right-click menus (rename, duplicate, delete, override, copy path) and their
 * confirmations — `FileTreePanel` builds them in the component, beside `AskDialog`.
 */
export interface FileTreePanelProps {
  tree: FileTree | null;
  selected: FileSelection | null;
  dirty?: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  onToggleExpanded: (key: string) => void;
  onSelect: (node: FileNode) => void;
  onCreate: (stateId: string, layer: WorkflowLayer, project?: string) => void;
  onCreateFile: (layer: WorkflowLayer, path: string, kind: "file" | "directory", text?: string, project?: string) => void;
  find?: boolean;
  draft: TreeDraft | null;
  onDraft: (draft: TreeDraft | null) => void;
  onUnfold: (keys: readonly string[]) => void;
  project?: string | null;
}

const NONE: ReadonlySet<string> = new Set();

export function FileTreePanel({
  tree,
  selected,
  dirty = NONE,
  expanded,
  onToggleExpanded,
  onSelect,
  onCreate,
  onCreateFile,
  find = false,
  draft,
  onDraft,
  onUnfold,
  project = null,
}: FileTreePanelProps): JSX.Element {
  const t = useTokens();
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<MenuAt | null>(null);

  /** Start typing a name, having first made the place it lands visible (`FileTreePanel.startDraft`). */
  const startDraft = (next: TreeDraft): void => {
    const missing = next.reveal.filter((key) => !expanded.has(key));
    if (missing.length > 0) onUnfold(missing);
    onDraft(next);
  };
  /** What the typed name becomes (`FileTreePanel.commitDraft`). */
  const commitDraft = (name: string): void => {
    if (draft === null) return;
    onDraft(null);
    if (draft.target.kind === "state") {
      const id = `${draft.target.prefix}${name.replace(/\.(json|jsonc|ya?ml)$/i, "")}`;
      onCreate(id, draft.layer, draft.project);
      return;
    }
    onCreateFile(draft.layer, draft.dir === "" ? name : `${draft.dir}/${name}`, draft.target.kind, undefined, draft.project);
  };
  const draftIn = (root: FileRoot, key: string | null): JSX.Element | null => {
    if (draft === null || draft.rootDir !== root.dir) return null;
    const at = anchorIn(root, draft);
    return at.under === key ? <DraftRow key="draft" draft={draft} depth={at.depth} missing={at.missing} onCommit={commitDraft} onCancel={() => onDraft(null)} /> : null;
  };
  const openNew = (root: FileRoot, dir: string, x: number, y: number): void => setMenu({ x, y, items: newItems(root, dir, startDraft) });

  return (
    <View flexDirection="column" flex={1} minHeight={0} gap={8} paddingTop={2} paddingBottom={4}>
      {find ? (
        <FindField
          value={filter}
          onChange={(v) => {
            setFilter(v);
            if (draft !== null) onDraft(null);
          }}
        />
      ) : null}
      <ScrollView {...(scrollbarProps(t) as object)} style={{ flex: 1, minHeight: 0 } as never} contentContainerStyle={{ flexDirection: "column" }}>
        {tree === null ? (
          <Txt spec={{ voice: "app", scale: 1, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 1) as number}>
            Open a project to browse its files.
          </Txt>
        ) : (
          tree.roots.map((root) => {
            const writable = isWritableLayer(root.layer);
            const named = !writable || rootNeedsName(root, project);
            return (
              <View key={root.dir} flexDirection="column" marginBottom={10}>
                {named ? <RootRow root={root} writable={writable} onNew={(x, y) => openNew(root, "", x, y)} /> : null}
                {draftIn(root, null)}
                {(filter.length > 0 ? treeMatches(root.nodes, filter) : root.nodes).map((node) => (
                  <TreeNode
                    key={`${node.project ?? node.layer}:${node.path}`}
                    node={node}
                    depth={0}
                    selected={selected}
                    dirty={dirty}
                    expanded={expanded}
                    onToggle={onToggleExpanded}
                    onSelect={onSelect}
                    onNew={(folder, x, y) => openNew(root, folder.path, x, y)}
                    draftUnder={(key) => draftIn(root, key)}
                  />
                ))}
                {root.nodes.length === 0 ? (
                  <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim", lineHeight: 1.45 }} paddingTop={2} paddingRight={6} paddingBottom={6} paddingLeft={19}>
                    {rootEmptyText(root, writable)}
                  </Txt>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </View>
  );
}

/** `li.tree-root`: a root the drawer is not standing in — its name, and its `+` (or Built in's chip). */
function RootRow({ root, writable, onNew }: { root: FileRoot; writable: boolean; onNew: (x: number, y: number) => void }): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  // The root's own letter spacing (0.08em of its 10.5/12.5), which its name inherits at a smaller size.
  const spacing = t.replayed ? Number(t.scaled("size-app", 10.5 / 12.5)) * 0.08 : "calc(var(--size-app) * 10.5 / 12.5 * 0.08)";
  return (
    <View {...(hover as object)} {...((isWeb ? { title: root.dir } : {}) as object)} flexDirection="row" alignItems="center" gap={5} paddingTop={8} paddingHorizontal={6} paddingBottom={4}>
      <Txt register="data-secondary" spec={{ upper: true }} letterSpacing={spacing as never} ellip {...(writable ? { flexGrow: 1, flexShrink: 1, flexBasis: 0 } : { flexShrink: 0 })} minWidth={0}>
        {root.label}
      </Txt>
      {writable ? (
        <AddButton label={root.label} shown={hovered} onNew={onNew} />
      ) : (
        <Chip title="What ships with JaiRA. It is never changed in place: editing a file here copies it into Shared (~/.jaira), and the copy is what is used.">edits copy to Shared</Chip>
      )}
    </View>
  );
}

/** `button.tree-add`: a folder's (or a root's) `+`, hidden until its row is hovered. */
function AddButton({ label, shown, onNew }: { label: string; shown: boolean; onNew: (x: number, y: number) => void }): JSX.Element {
  const t = useTokens();
  const at = useRef<RNView>(null);
  return (
    <RNView ref={at} collapsable={false} style={{ flexShrink: 0 }}>
      <Press
        onPress={() => at.current?.measureInWindow((x, y, _w, h) => onNew(x, y + h))}
        title={`new file, folder or workflow in ${label}`}
        label={`New in ${label}`}
        width={16}
        height={16}
        alignItems="center"
        justifyContent="center"
        borderRadius={4}
        opacity={shown ? 1 : 0}
        box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-selected") : "transparent", ...(hovered ? { opacity: 1 } : {}) })}
      >
        {({ hovered }) => (
          <Txt spec={{ voice: "app", scale: 12 / 12.5, color: hovered ? "text" : "dim", lineHeight: 1 }} textAlign="center">
            +
          </Txt>
        )}
      </Press>
    </RNView>
  );
}

/** The rules down the left of a row, one per level: the last in --rule, the ones before it in --line. */
function Guides({ depth, t }: { depth: number; t: Tokens }): JSX.Element {
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <View key={i} width={13} flexShrink={0} alignSelf="stretch" marginTop={-3} marginBottom={-3} marginRight={-5} {...(edge(t, { left: 1 }, i === depth - 1 ? "rule" : "line") as object)} />
      ))}
    </>
  );
}

function TreeNode({
  node,
  depth,
  selected,
  dirty,
  expanded,
  onToggle,
  onSelect,
  onNew,
  draftUnder,
}: {
  node: FileNode;
  depth: number;
  selected: FileSelection | null;
  dirty: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onSelect: (node: FileNode) => void;
  onNew: (node: FileNode, x: number, y: number) => void;
  draftUnder: (key: string) => JSX.Element | null;
}): JSX.Element {
  const t = useTokens();
  const row = treeRowOf(node, selected, dirty, expanded);
  const lint = node.lint;
  const weight = row.isSelected ? 600 : 400;
  const nameInk = row.tone === " has-error" ? "bad" : row.tone === " has-warning" ? "warn" : row.inert ? "dim" : "text";
  const dotInk = row.tone === " has-error" ? "bad" : "warn";
  return (
    <>
      <Press
        onPress={() => (row.isDir ? onToggle(row.key) : onSelect(node))}
        title={row.title}
        label={node.name}
        flexDirection="row"
        alignItems="center"
        gap={5}
        paddingVertical={3}
        paddingHorizontal={6}
        borderRadius={5}
        {...(node.shadowed === true ? { opacity: 0.55 } : {})}
        {...(isWeb && row.inert ? { cursor: "default" } : {})}
        box={({ hovered }) => ({ backgroundColor: row.isSelected ? t.v("fill-ghost-selected") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
      >
        {({ hovered }) => (
          <>
            <Guides depth={depth} t={t} />
            <Txt spec={{ voice: "app", scale: 10 / 12.5, color: "dim", weight }} width={13} flexShrink={0} textAlign="center">
              {row.glyph}
            </Txt>
            <Txt
              spec={{ voice: "data", scale: 11.5 / 12, color: nameInk, weight, ...(row.tone === " unchecked" ? { italic: true } : {}) }}
              ellip
              flexGrow={1}
              flexShrink={1}
              flexBasis={0}
              minWidth={0}
              {...(row.tone === " unchecked" ? { opacity: 0.6 } : {})}
              {...(node.shadowed === true ? { textDecorationLine: "line-through" } : {})}
            >
              {node.name}
            </Txt>
            {row.unsaved ? (
              <Txt spec={{ voice: "app", scale: 8 / 12.5, color: "accent", weight, lineHeight: 1 }} flexShrink={0} {...((isWeb ? { title: row.isDir ? "unsaved edits below here" : "unsaved edits" } : {}) as object)}>
                ●
              </Txt>
            ) : null}
            {row.tone === " has-error" || row.tone === " has-warning" ? (
              <Txt spec={{ voice: "app", scale: 8 / 12.5, color: dotInk, weight, lineHeight: 1 }} flexShrink={0}>
                ●
              </Txt>
            ) : null}
            {node.error !== undefined ? <Chip tone="bad" spec={{ weight }}>!</Chip> : null}
            {node.error === undefined && lint !== undefined && lint.errors > 0 ? <Chip tone="bad" spec={{ weight }}>{lint.errors}</Chip> : null}
            {node.error === undefined && lint !== undefined && lint.errors === 0 && lint.warnings > 0 ? <Chip tone="warn" spec={{ weight }}>{lint.warnings}</Chip> : null}
            {node.shadowed === true ? <Chip spec={{ weight }}>{node.layer === "system" ? "overridden" : "shadowed"}</Chip> : null}
            {node.overridesBuiltIn === true ? (
              <Chip spec={{ weight }} title="Overrides built in: JaiRA ships a state with this id, and this file runs instead of it">
                override
              </Chip>
            ) : null}
            {row.isDir && isWritableLayer(node.layer) ? <AddButton label={node.name} shown={hovered} onNew={(x, y) => onNew(node, x, y)} /> : null}
          </>
        )}
      </Press>
      {draftUnder(row.key)}
      {row.open
        ? (node.children ?? []).map((child) => (
            <TreeNode
              key={`${child.layer}:${child.path}`}
              node={child}
              depth={depth + 1}
              selected={selected}
              dirty={dirty}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
              onNew={onNew}
              draftUnder={draftUnder}
            />
          ))
        : null}
    </>
  );
}

/** `li.tree-draft`: the row a new name is typed into, where what it names will be (`DraftRow`). */
function DraftRow({ draft, depth, missing, onCommit, onCancel }: { draft: TreeDraft; depth: number; missing: string; onCommit: (name: string) => void; onCancel: () => void }): JSX.Element {
  const t = useTokens();
  const [name, setName] = useState("");
  // Enter commits and unmounts, and the unmount blurs: without this the field would commit twice.
  const done = useRef(false);
  const finish = (commit: boolean): void => {
    if (done.current) return;
    done.current = true;
    const clean = name.trim().replace(/^\/+|\/+$/g, "");
    if (commit && clean.length > 0) onCommit(clean);
    else onCancel();
  };
  const kind = draft.target.kind;
  const face = { voice: "data", scale: 11.5 / 12 } as const;
  return (
    <View flexDirection="row" alignItems="center" gap={5} paddingVertical={3} paddingHorizontal={6} borderRadius={5}>
      <Guides depth={depth} t={t} />
      <Txt spec={{ voice: "app", scale: 10 / 12.5, color: "dim" }} width={13} flexShrink={0} textAlign="center">
        {kind === "directory" ? "▸" : kind === "state" ? (KIND_GLYPH.workflow ?? "·") : "·"}
      </Txt>
      {missing.length > 0 ? (
        <Txt spec={{ ...face, color: "dim" }} flexShrink={0}>
          {missing}
        </Txt>
      ) : null}
      <TextInput
        autoFocus
        spellCheck={false}
        value={name}
        placeholder={kind === "directory" ? "folder name" : kind === "state" ? "state id" : "file name"}
        accessibilityLabel={kind === "state" ? "new state id" : `new ${kind} name`}
        onChangeText={setName}
        onBlur={() => finish(true)}
        onSubmitEditing={() => finish(true)}
        onKeyPress={(e) => {
          if (e.nativeEvent.key === "Escape") finish(false);
        }}
        style={{
          ...(font(t, { ...face, color: "text" }) as object),
          flex: 1,
          minWidth: 0,
          padding: 0,
          backgroundColor: "transparent",
          ...(edge(t, { bottom: 1 }, "accent") as object),
          ...(isWeb ? { outlineStyle: "none" } : {}),
        } as never}
      />
    </View>
  );
}

/** `input.tree-find`: the Files row's find verb, a filter over every root's files. */
function FindField({ value, onChange }: { value: string; onChange: (value: string) => void }): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  return (
    <View {...(hover as object)} flexShrink={0}>
      <TextInput
        autoFocus
        value={value}
        placeholder="Filter…"
        onChangeText={onChange}
        onKeyPress={(e) => {
          if (e.nativeEvent.key === "Escape") onChange("");
        }}
        style={{
          ...(font(t, { voice: "app", scale: 1, color: "text" }) as object),
          width: "100%",
          paddingVertical: 5,
          paddingHorizontal: 9,
          backgroundColor: t.v("bg"),
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: t.v(hovered ? "rule" : "line"),
          borderRadius: t.v("control-radius"),
        } as never}
      />
    </View>
  );
}
