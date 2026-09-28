import { useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { Pressable, View as RNView, useWindowDimensions } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import type { FileSource, FileTree, WorkflowLayer } from "@jaira/shared/browser";
import { LAYER_LABEL, ROOT_WORD, crumbInputOf, crumbsOf, folderFactsOf, issueCountsOf, runToggleableOf, stateIdsOf, type CrumbInput, type FileSelection } from "@jaira/ui/filesModel";
import type { FileSurfaceContext } from "@jaira/ui/fileTypes";
import { Press, Txt, font, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { CrumbBar } from "../Crumbs";
import { MenuLayer } from "../MenuLayer";
import { Icon } from "../panel/Icon";
import { RunModeToggle } from "../RunModeToggle";
import { Chip } from "./Chip";

/**
 * `files.tsx`'s `FileAddressBar`, universal (decision 0015): the address of whatever the Files room has
 * open, as the top row of the window — the folders, the state levels and the runs walked into
 * (`crumbsOf`, fed by `crumbInputOf`: the desktop's own), then what is true of the file (its label, its
 * issues, "built in"), the board/conversation toggle where there are two readings, and the ⓘ. The
 * drawing is {@link CrumbBar}; a press on the bar's own ground puts the inspector back on the file, as
 * a click does on the desktop's. The rules the bar adds (`cascade.mts .title-bar --scene files-markdown`):
 *
 *   .doc-label       .sub (--dim, app 11/12.5), 6 left, may shrink, one line
 *   .chip(-bad/-warn)  see {@link Chip}
 *   .sp-icon         26 square, radius --control-radius-sm (5), --dim; hovered --text on
 *                    --fill-ghost-hover; `.on` --accent on --tint-accent; its glyph 15
 *   .facts-pop       320 wide, at most 60% of the window, scrolls, padding 12, --panel, 1px --line,
 *                    radius 10, --lift; below the ⓘ (6 between), its right edge on the ⓘ's
 *
 * `null` when nothing is open — an address bar for no address is a row of nothing.
 */
export function FileAddressBar({
  doc,
  dir,
  context,
  onWalkBack,
  onInspect,
  facts,
}: {
  doc: FileSource | null;
  dir?: FileSelection | null;
  context: FileSurfaceContext;
  onWalkBack?: ((index: number) => void) | undefined;
  onInspect: () => void;
  facts?: ReactNode;
}): JSX.Element | null {
  const known = useMemo(() => stateIdsOf(context.tree), [context.tree]);
  const barFor = (at: { layer: WorkflowLayer; path: string; stateId?: string | undefined; isDir?: boolean }): CrumbInput => crumbInputOf(at, context, known, onWalkBack);
  if (doc === null) {
    return dir == null ? null : (
      <DocBar input={barFor({ ...dir, isDir: true })} label={undefined} counts={{ errors: 0, warnings: 0 }} onInspect={onInspect}>
        {facts}
      </DocBar>
    );
  }
  const toggleable = runToggleableOf(doc, context);
  return (
    <DocBar input={barFor(doc)} label={context.state?.label} counts={issueCountsOf(context.state)} onInspect={onInspect}>
      {toggleable && context.onRunMode !== undefined ? <RunModeToggle mode={context.runMode ?? "board"} onMode={context.onRunMode} /> : undefined}
      {doc.layer === "system" && doc.stateId === undefined ? (
        doc.builtIn?.layers.includes("base") === true ? (
          <Chip tone="warn" title="Shared already has its own copy of this file, and that copy is the one in use.">
            built in · Shared has its copy
          </Chip>
        ) : (
          <Chip title="This file ships with JaiRA. The first change you make copies it into ~/.jaira with the change in it, and the copy is what is used.">built in · an edit copies it to Shared</Chip>
        )
      ) : null}
      {facts}
    </DocBar>
  );
}

/** `DocBar`: the crumbs, then the state's name and its issue counts, then the tools. */
function DocBar({
  input,
  label,
  counts,
  onInspect,
  children,
}: {
  input: CrumbInput;
  label: string | undefined;
  counts: { errors: number; warnings: number };
  onInspect: () => void;
  children?: ReactNode;
}): JSX.Element {
  const tools = [children].flat().some((c) => c !== null && c !== undefined && c !== false);
  return (
    <Pressable onPress={onInspect} {...((isWeb ? { title: LAYER_LABEL[input.layer] } : {}) as object)} style={{ flexGrow: 0, flexShrink: 1, minWidth: 0, flexDirection: "row", ...(isWeb ? ({ cursor: "default" } as object) : {}) }}>
      <CrumbBar
        crumbs={crumbsOf(input)}
        trailing={
          <>
            {label ? (
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} ellip flexGrow={0} flexShrink={1} minWidth={0} marginLeft={6} {...((isWeb ? { title: label } : {}) as object)}>
                {label}
              </Txt>
            ) : null}
            {counts.errors > 0 ? <Chip tone="bad">{counts.errors} error</Chip> : null}
            {counts.warnings > 0 ? <Chip tone="warn">{counts.warnings} warning</Chip> : null}
          </>
        }
        {...(tools ? { tools: children } : {})}
      />
    </Pressable>
  );
}

/** `FactsButton`: the ⓘ at the right of the address — a plain file's or a folder's facts, in a float. */
export function FactsButton({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  const win = useWindowDimensions();
  const at = useRef<RNView>(null);
  const [open, setOpen] = useState<{ right: number; top: number } | null>(null);
  return (
    <RNView ref={at} collapsable={false} style={{ flexShrink: 0 }}>
      <Press
        onPress={() => (open !== null ? setOpen(null) : at.current?.measureInWindow((x, y, w, h) => setOpen({ right: win.width - (x + w), top: y + h + 6 })))}
        title="About this"
        label="About this"
        {...({ "aria-expanded": open !== null } as object)}
        width={26}
        height={26}
        alignItems="center"
        justifyContent="center"
        borderRadius={t.v("control-radius-sm") as never}
        box={({ hovered }) => ({ backgroundColor: open !== null ? t.v("tint-accent") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
      >
        {({ hovered }) => <Icon name="info" size={15} color={String(t.v(open !== null ? "accent" : hovered ? "text" : "dim"))} />}
      </Press>
      {open !== null ? (
        <MenuLayer onClose={() => setOpen(null)}>
          <View
            position="absolute"
            right={Math.max(4, open.right)}
            top={open.top}
            width={320}
            maxHeight={win.height * 0.6}
            // `overflow: auto` on web (a scrollbar only when the facts outgrow 60% of the window).
            overflow={(isWeb ? "auto" : "hidden") as never}
            {...(scrollbarProps(t) as object)}
            padding={12}
            backgroundColor={t.v("panel") as never}
            borderWidth={1}
            borderStyle="solid"
            borderColor={t.v("line") as never}
            borderRadius={10}
            {...({ boxShadow: t.v("lift") } as object)}
            role="dialog"
            aria-label="About this"
          >
            {children}
          </View>
        </MenuLayer>
      ) : null}
    </RNView>
  );
}

/**
 * `.inspector` and `dl.kv`: a column, gap 14; each section a column, gap 5. `.insp-crumb` a baseline
 * row, gap 5: the name (`.state-id`, data 13/12, 600, one line) and `.sub`. `.kv` a grid of 72px terms
 * (--dim) and their values, gap 4 10, app 12/12.5; `code` data 11/12. `.file-path` one line, cut at its
 * START (`direction: rtl`), .sub.
 */
function Inspector({ name, what, rows, file }: { name: string; what: string; rows: readonly [string, ReactNode][]; file: string | null }): JSX.Element {
  const kv = { voice: "app", scale: 12 / 12.5 } as const;
  return (
    <View flexDirection="column" gap={14}>
      <View flexDirection="row" alignItems="baseline" gap={5} minWidth={0}>
        <Txt spec={{ voice: "data", scale: 13 / 12, weight: 600 }} ellip flexShrink={1} minWidth={0}>
          {name}
        </Txt>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} flexShrink={0}>
          {what}
        </Txt>
      </View>
      <View flexDirection="column" gap={4}>
        {rows.map(([term, value]) => (
          <View key={term} flexDirection="row" gap={10}>
            <Txt spec={{ ...kv, color: "dim" }} width={72} flexShrink={0}>
              {term}
            </Txt>
            <View flex={1} minWidth={0}>
              {/* A `dd` is a line of text; its `code` runs inline in it, on its baseline. */}
              <Txt spec={kv}>{value}</Txt>
            </View>
          </View>
        ))}
      </View>
      {file !== null ? (
        // Cut at its START (`direction: rtl` on the desktop, which a web copy says the same way; a
        // phone's Text says it as `ellipsizeMode="head"`).
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} numberOfLines={1} {...((isWeb ? { title: file, style: { direction: "rtl" } } : { ellipsizeMode: "head" }) as object)}>
          {file}
        </Txt>
      ) : null}
    </View>
  );
}

/** `code`: the data voice at 11/12, inline in the line it is on. */
function Code({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return <Text {...(font(t, { voice: "data", scale: 11 / 12 }) as object)}>{children}</Text>;
}

/** `FileInspector`: where a plain file is, what it is, how big. */
export function FileInspector({ doc }: { doc: FileSource | null }): JSX.Element {
  if (doc === null) return <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }}>Select a file.</Txt>;
  return (
    <Inspector
      name={doc.path.split("/").pop() ?? doc.path}
      what="· the file"
      rows={[
        ["path", <Code key="p">{doc.path}</Code>],
        ["layer", LAYER_LABEL[doc.layer]],
        ["type", <Code key="t">{doc.mime}</Code>],
        ["size", doc.exists ? `${doc.text.length} characters` : "not created yet"],
      ]}
      file={doc.file}
    />
  );
}

/** `FolderInspector`: what a folder holds (`folderFactsOf`). */
export function FolderInspector({ layer, path, tree }: { layer: WorkflowLayer; path: string; tree: FileTree | null }): JSX.Element {
  const { entries, dirs, states, root } = folderFactsOf(tree, layer, path);
  return (
    <Inspector
      name={path === "" ? ROOT_WORD[layer] : (path.split("/").pop() ?? path)}
      what="· the folder"
      rows={[
        ["path", <Code key="p">{path === "" ? "/" : path}</Code>],
        ["layer", LAYER_LABEL[layer]],
        [
          "holds",
          `${dirs > 0 ? `${dirs} folder${dirs === 1 ? "" : "s"}` : "no folders"}, ${entries.length - dirs} file${entries.length - dirs === 1 ? "" : "s"}${states > 0 ? ` · ${states} states` : ""}`,
        ],
      ]}
      file={root === undefined ? null : `${root.dir}${path === "" ? "" : `/${path}`}`}
    />
  );
}
