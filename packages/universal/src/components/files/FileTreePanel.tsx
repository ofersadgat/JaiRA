import { copyText } from "../../clipboard";
import { useRef, useState, type JSX } from "react";
import { ScrollView, TextInput, View as RNView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { FileMutationResult, FileNode, FileRoot, FileTree, MoveWorkflowRequest, WorkflowLayer, WorkflowMutationResult } from "@jaira/shared/browser";
import { isWritableLayer } from "@jaira/shared/browser";
import {
  KIND_GLYPH,
  anchorIn,
  newItems,
  rootEmptyText,
  rootNeedsName,
  treeMatches,
  treeMenus,
  treeRowOf,
  type FileSelection,
  type TreeDraft,
} from "@jaira/ui/filesModel";
import { PLAIN_SCROLLER, ENTER_KEEPS_FOCUS, Press, Txt, edge, font, scrollbarProps, useHover } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import type { AskSpec } from "@jaira/ui/menuTypes";
import { ContextMenu, type MenuAt } from "../Menu";
import { AskDialog } from "./AskDialog";
import { Chip } from "./Chip";

/**
 * The Files drawer under the sidebar's Files row — every root's tree, folded as the person left it,
 * the `+` on a folder and on a named root, the row a new name is typed into, and the find field. What
 * each row says is `treeRowOf`, what a `+` offers is `newItems`, where a draft is drawn is `anchorIn`
 * (`filesModel.ts`). How it looks:
 *
 *   the drawer        column, flex 1, gap 8, padding 2 0 4
 *   its scroller      flex 1, scrolls
 *   a root's tree     12.5/12.5 app, 10 below
 *   a root's row      row, centred, gap 5, padding 8 6 4, --dim, app 10.5/12.5, uppercase, 0.08em; its
 *                     name data-secondary (in the row's letter spacing and case), taking the slack but
 *                     on Built in, whose chip keeps no case or spacing
 *   a row             row, centred, gap 5, padding 3 6, radius 5; hovered --fill-ghost-hover; selected
 *                     --fill-ghost-selected and 600 (all of it); inert --dim; shadowed at .55 and the
 *                     name struck through
 *   a guide           13 wide, the row's height (-3 above and below), -5 right (the gap), a 1px rule on
 *                     its left: --rule on the last, --line on the ones before it
 *   the glyph         13 wide, centred, app 10/12.5, --dim
 *   the name          data 11.5/12, the slack, one line cut with "…"; --bad with an error, --warn with a
 *                     warning, at .6 and italic unchecked
 *   the lint dot      app 8/12.5, line 1; --bad or --warn.   The unsaved dot  the same in --accent
 *   the `+`           16 square, radius 4, app 12/12.5, line 1, --dim; hidden (opacity 0) until the row
 *                     is hovered; hovered --text on --fill-ghost-selected
 *   an empty root     --dim, padding 2 6 6 19, app 11/12.5, line 1.45
 *   the draft row     no hover ground; what is missing above it --dim data 11.5/12; the name the same
 *                     face in --text, a --accent rule under it
 *   the find field    --bg, 1px --line (--rule hovered), radius --control-radius, padding 5 9
 *
 * A row's and a root's own menu (open, new, rename, duplicate, delete, override, copy path) is
 * `treeMenus` — a right-click on web, a long press on a phone — with the second ask a refused one
 * makes, in {@link AskDialog}.
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
  hasProject: boolean;
  onOpen: (stateId: string, layer: WorkflowLayer) => void;
  onMove: (request: MoveWorkflowRequest) => Promise<WorkflowMutationResult | null>;
  onDelete: (stateId: string, layer: WorkflowLayer, force?: boolean) => Promise<WorkflowMutationResult | null>;
  onRenameFile: (layer: WorkflowLayer, path: string, to: string, force?: boolean) => Promise<FileMutationResult | null>;
  onDeleteFile: (layer: WorkflowLayer, path: string, force?: boolean) => Promise<FileMutationResult | null>;
  onReveal: (file: string) => void;
  find?: boolean;
  draft: TreeDraft | null;
  onDraft: (draft: TreeDraft | null) => void;
  onUnfold: (keys: readonly string[]) => void;
  project?: string | null;
  /**
   * Where the tree's menus are drawn, when the host draws them: outside the sidebar — so a menu takes
   * the window's tokens, not the sidebar's (which redefines --panel, --text …). Drawn here if absent.
   * The ASK is drawn here always, and wears the sidebar's variables.
   */
  floats?: { menu: (menu: MenuAt | null) => void };
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
  hasProject,
  onOpen,
  onMove,
  onDelete,
  onRenameFile,
  onDeleteFile,
  onReveal,
  find = false,
  draft,
  onDraft,
  onUnfold,
  project = null,
  floats,
}: FileTreePanelProps): JSX.Element {
  const t = useTokens();
  const [filter, setFilter] = useState("");
  const [ownMenu, setOwnMenu] = useState<MenuAt | null>(null);
  const [ownAsk, setOwnAsk] = useState<AskSpec | null>(null);
  const setMenu = floats?.menu ?? setOwnMenu;
  const setAsk = setOwnAsk;

  /** Start typing a name, having first made the place it lands visible. */
  const startDraft = (next: TreeDraft): void => {
    const missing = next.reveal.filter((key) => !expanded.has(key));
    if (missing.length > 0) onUnfold(missing);
    onDraft(next);
  };
  /** What the typed name becomes. */
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
  const { itemsFor, rootItems } = treeMenus({ hasProject, onOpen, onMove, onDelete, onRenameFile, onDeleteFile, onReveal, copy: copyText, setAsk, startDraft });

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
      <ScrollView {...(scrollbarProps(t) as object)} // No layer of its own on web: react-native-web's `translateZ(0)` makes one, over a transparent
        // ground, and Chromium then draws the names in greyscale rather than the page's LCD antialiasing —
        // and no stacking context (`PLAIN_SCROLLER`): the scroller is painted where it stands in the page.
        style={{ flex: 1, minHeight: 0, ...PLAIN_SCROLLER } as never} contentContainerStyle={{ flexDirection: "column", ...PLAIN_SCROLLER } as never}>
        {tree === null ? (
          <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 13 / 12.5) as number}>
            Open a project to browse its files.
          </Txt>
        ) : (
          tree.roots.map((root) => {
            const writable = isWritableLayer(root.layer);
            const named = !writable || rootNeedsName(root, project);
            return (
              <View key={root.dir} flexDirection="column" marginBottom={10}>
                {named ? <RootRow root={root} writable={writable} onNew={(x, y) => openNew(root, "", x, y)} onMenu={(x, y) => setMenu({ x, y, items: rootItems(root, writable) })} /> : null}
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
                    // Right-click selects too, so the menu always acts on the row that is highlighted.
                    onMenu={(node, x, y) => {
                      if (node.kind !== "directory") onSelect(node);
                      setMenu({ x, y, items: itemsFor(node, root) });
                    }}
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
      {ownMenu !== null ? <ContextMenu anchor={ownMenu} onClose={() => setOwnMenu(null)} /> : null}
      {ownAsk !== null ? <AskDialog spec={ownAsk} onCancel={() => setOwnAsk(null)} /> : null}
    </View>
  );
}

/** A root the drawer is not standing in — its name, and its `+` (or Built in's chip). */
function RootRow({ root, writable, onNew, onMenu }: { root: FileRoot; writable: boolean; onNew: (x: number, y: number) => void; onMenu: (x: number, y: number) => void }): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  // The root row's letter spacing (0.08em of its 10.5/12.5), which its name keeps at its own smaller size.
  const spacing = t.replayed ? Number(t.scaled("size-app", 10.5 / 12.5)) * 0.08 : "calc(var(--size-app) * 10.5 / 12.5 * 0.08)";
  return (
    <View {...(hover as object)} {...(rightClick(onMenu) as object)} {...((isWeb ? { title: root.dir } : {}) as object)} flexDirection="row" alignItems="center" gap={5} paddingTop={8} paddingHorizontal={6} paddingBottom={4}>
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

/** A folder's (or a root's) `+`, hidden until its row is hovered. */
function AddButton({ label, shown, onNew }: { label: string; shown: boolean; onNew: (x: number, y: number) => void }): JSX.Element {
  const t = useTokens();
  const at = useRef<RNView>(null);
  return (
    <RNView ref={at} collapsable={false} style={{ flexShrink: 0, ...PLAIN_SCROLLER } as never}>
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
  onMenu,
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
  onMenu: (node: FileNode, x: number, y: number) => void;
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
        onLongPress={(e: { nativeEvent: { pageX: number; pageY: number } }) => onMenu(node, e.nativeEvent.pageX, e.nativeEvent.pageY)}
        {...(rightClick((x, y) => onMenu(node, x, y)) as object)}
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
              onMenu={onMenu}
              draftUnder={draftUnder}
            />
          ))
        : null}
    </>
  );
}

/** The row a new name is typed into, where what it names will be. */
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
      <TextInput {...(ENTER_KEEPS_FOCUS as object)}
        autoFocus
        spellCheck={false}
        value={name}
        placeholder={kind === "directory" ? "folder name" : kind === "state" ? "state id" : "file name"}
        placeholderTextColor="#757575"
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

/** The Files row's find verb: a filter over every root's files. */
function FindField({ value, onChange }: { value: string; onChange: (value: string) => void }): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  const [focused, setFocused] = useState(false);
  return (
    <View {...(hover as object)} flexShrink={0}>
      <TextInput {...(ENTER_KEEPS_FOCUS as object)}
        autoFocus
        value={value}
        placeholder="Filter…"
        // Chromium's own placeholder ink (`::placeholder`: #757575).
        placeholderTextColor="#757575"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChangeText={onChange}
        onKeyPress={(e) => {
          if (e.nativeEvent.key === "Escape") onChange("");
        }}
        style={{
          ...(font(t, { voice: "app", scale: 13 / 12.5, color: "text" }) as object),
          width: "100%",
          paddingVertical: 5,
          paddingHorizontal: 9,
          backgroundColor: t.v("bg"),
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: t.v(hovered ? "rule" : "line"),
          borderRadius: t.v("control-radius"),
          // Focused: a 2px --focus-ring outline, 1 outside the box (web; a phone draws none).
          ...(isWeb ? (focused ? { outlineWidth: 2, outlineStyle: "solid", outlineColor: t.v("focus-ring"), outlineOffset: 1 } : { outlineStyle: "none" }) : {}),
        } as never}
      />
    </View>
  );
}



/**
 * The gesture for a row's menu on web: a right-click, at the pointer. A phone has none; a row takes a
 * long press instead (a root row's menu is web only).
 */
function rightClick(onMenu: (x: number, y: number) => void): Record<string, unknown> {
  if (!isWeb) return {};
  return {
    onContextMenu: (e: { preventDefault: () => void; stopPropagation: () => void; clientX: number; clientY: number }) => {
      e.preventDefault();
      e.stopPropagation();
      onMenu(e.clientX, e.clientY);
    },
  };
}
