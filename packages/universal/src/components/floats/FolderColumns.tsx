import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { FolderEntry, FolderListing, MachinesView } from "@jaira/shared/browser";
import { faceOf } from "@jaira/ui/environmentModel";
import { placeGroupsOf, type MachinePlace } from "@jaira/ui/openProjectModel";
import { invoke } from "@jaira/ui/store";
import { Press, Txt, edge, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { MachineIcon } from "../MachineIcon";
import { Icon, type IconName } from "../panel/Icon";
import { BrandIcon } from "../settings/bits";

/**
 * The folder browsers' parts — the Open dialog's Project and Where it goes, and the folder chooser
 * (`FolderBrowser`) — chosen from eight proposals (docs/ui/assets/add-workspace, 2026-11-21): the
 * column of machines with their places (proposal 6), and the folders in columns (proposal 3).
 */

export const HEAD = { voice: "app", scale: 10.5 / 12.5, weight: 600, ls: 0.02, upper: true, color: "dim" } as const;

/** A folder's own name, as a column heads it: `/srv/work` → `work`; a root is itself. */
export function lastOf(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

export function joinPath(parent: string, name: string): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${sep}${name}`;
}

/** The folder a folder is in, for browsing to it: `/srv/work/atlas` → `/srv/work`, `C:\src\atlas` → `C:\src`. */
export function parentOf(dir: string): string | undefined {
  const cut = dir.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "");
  if (cut === "") return dir.startsWith("/") ? "/" : undefined;
  return /^[A-Za-z]:$/.test(cut) ? `${cut}\\` : cut;
}

/**
 * The folders from the root down to `dir`, to go to: from the machine's home (`~`) when it is under it,
 * else from the root; with more than four, the first, an `…` that goes to the folder before the last
 * two, and the last two. `/srv/work` → `/`, `srv`, `work`; `C:\src` → `C:`, `src`.
 */
export function crumbsOf(dir: string, home: string | undefined): { label: string; path: string }[] {
  const windows = /^[A-Za-z]:/.test(dir);
  const sep = windows ? "\\" : "/";
  const trim = (p: string): string => p.replace(/[\\/]+$/, "");
  const underHome = home !== undefined && (trim(dir) === trim(home) || trim(dir).startsWith(trim(home) + sep));
  const out: { label: string; path: string }[] = [];
  let at: string;
  let rest: string[];
  if (underHome) {
    at = trim(home);
    out.push({ label: "~", path: home });
    rest = trim(dir).slice(at.length).split(/[\\/]/).filter(Boolean);
  } else {
    const parts = dir.split(/[\\/]/).filter(Boolean);
    at = windows ? `${parts[0] ?? ""}${sep}` : "/";
    out.push({ label: windows ? (parts[0] ?? dir) : "/", path: at });
    rest = windows ? parts.slice(1) : parts;
  }
  for (const p of rest) {
    at = joinPath(at, p);
    out.push({ label: p, path: at });
  }
  if (out.length <= 4) return out;
  const skipped = out[out.length - 3]!;
  return [out[0]!, { label: "…", path: skipped.path }, ...out.slice(-2)];
}

// --- the column of machines and their places -------------------------------------------------------------

/** The column down the dialog's left: 232 wide, padding 10 8, --bg, a --line right, scrolling. */
export function Column({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <ScrollView
      {...(scrollbarProps(t) as object)}
      style={{ width: 232, flexGrow: 0, flexShrink: 0, backgroundColor: t.v("bg"), ...(edge(t, { right: 1 }) as object) } as never}
      contentContainerStyle={{ paddingVertical: 10, paddingHorizontal: 8, gap: 1 } as never}
    >
      {children}
    </ScrollView>
  );
}

/**
 * A row of the column: padding 5 8 (a place 5 8 5 30), radius 6, gap 8; its glyph (15; a place's 14,
 * --dim), its name (app 1; a machine 600 once chosen, a place 600 when browsed), its note at its right
 * (app 10.5, in its tone); the chosen --tint-accent, hovered --fill-ghost-hover.
 */
export function PlaceRow({
  label,
  chosen,
  onPress,
  right,
  glyph,
  dim = false,
  indent = false,
  strong,
}: {
  label: string;
  chosen: boolean;
  onPress: () => void;
  right?: { text: string; tone: string } | undefined;
  glyph?: ReactNode;
  dim?: boolean;
  indent?: boolean;
  strong?: boolean;
}): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      label={label}
      flexDirection="row"
      alignItems="center"
      gap={8}
      paddingVertical={5}
      paddingRight={8}
      paddingLeft={indent ? 30 : 8}
      borderRadius={6}
      opacity={dim ? 0.6 : 1}
      box={({ hovered }) => ({ backgroundColor: chosen ? t.v("tint-accent") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      {glyph}
      <Txt spec={{ voice: "app", scale: 1, weight: (strong ?? chosen) ? 600 : 400, color: dim ? "dim" : "text" }} ellip flexGrow={1} flexShrink={1} minWidth={0}>
        {label}
      </Txt>
      {right !== undefined ? (
        <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: right.tone }} flexShrink={0}>
          {right.text}
        </Txt>
      ) : null}
    </Press>
  );
}

const PLACE_GLYPH: Record<MachinePlace["kind"], IconName> = { projects: "star", workspaces: "folder", recent: "clock", home: "home", root: "drive" };

/**
 * The machines, grouped as `placeGroupsOf` has them, each with its icon (`MachineIcon`: what it is,
 * what it runs, whether it is reached) and its status at its right; under the machine chosen, its
 * places (`machinePlacesOf`) — a press browses there.
 */
export function MachinePlaces({
  machines,
  chosen,
  at,
  placesOf,
  statusOf,
  onMachine,
  onPlace,
  exclude,
  titleOf,
}: {
  machines: MachinesView | undefined;
  chosen: string | undefined;
  /** The folder browsed on the machine chosen: its place, when it is one, is marked. */
  at?: string | undefined;
  placesOf: (machine: string) => readonly MachinePlace[];
  statusOf?: (machine: string, online: boolean) => { text: string; tone: string } | undefined;
  onMachine: (machine: string) => void;
  onPlace: (machine: string, dir: string) => void;
  /** A machine listed elsewhere in the column (Where it is). */
  exclude?: string | undefined;
  titleOf?: (title: string) => string;
}): JSX.Element {
  const t = useTokens();
  const same = (a: string | undefined, b: string): boolean => a !== undefined && a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");
  return (
    <>
      {placeGroupsOf(machines).map((group) => {
        const rows = group.machines.filter((m) => m.id !== exclude);
        if (rows.length === 0) return null;
        return (
          <View key={group.title} flexDirection="column" gap={1}>
            <Txt spec={HEAD} paddingTop={8} paddingHorizontal={8} paddingBottom={3}>
              {titleOf?.(group.title) ?? group.title}
            </Txt>
            {rows.map((m) => {
              const view = m.self ? machines?.self : machines?.machines.find((p) => p.id === m.id);
              const state = m.self ? "online" : (machines?.machines.find((p) => p.id === m.id)?.state ?? "offline");
              const right = statusOf?.(m.id, m.online) ?? (m.online ? undefined : { text: "offline", tone: "dim" });
              return (
                <View key={m.id} flexDirection="column" gap={1}>
                  <PlaceRow
                    label={m.label}
                    chosen={chosen === m.id && (at === undefined || !placesOf(m.id).some((p) => same(at, p.dir)))}
                    strong={chosen === m.id}
                    dim={!m.online}
                    right={right}
                    glyph={view !== undefined ? <MachineIcon face={faceOf({ form: view.form, os: view.os, state })} size={15} ground={chosen === m.id ? "tint-accent" : "bg"} /> : undefined}
                    onPress={() => (m.online ? onMachine(m.id) : undefined)}
                  />
                  {chosen === m.id && m.online
                    ? placesOf(m.id).map((p) => (
                        <PlaceRow
                          key={`${p.kind}:${p.dir}`}
                          label={p.label}
                          indent
                          chosen={same(at, p.dir)}
                          right={p.note !== undefined ? { text: p.note, tone: "dim" } : undefined}
                          glyph={<Icon name={PLACE_GLYPH[p.kind]} size={14} color={String(t.v(p.kind === "projects" ? "accent" : "dim"))} />}
                          onPress={() => onPlace(m.id, p.dir)}
                        />
                      ))
                    : null}
                </View>
              );
            })}
          </View>
        );
      })}
    </>
  );
}

/** A forge's mark: GitHub's or GitLab's, else git's. */
export function ForgeGlyph({ host, size = 15 }: { host: string; size?: number }): JSX.Element {
  const t = useTokens();
  if (/(^|\.)github\./.test(host)) return <BrandIcon name="github" size={size} />;
  if (/(^|\.)gitlab\./.test(host)) return <BrandIcon name="gitlab" size={size} />;
  return <Icon name="git" size={size} color={String(t.v("dim"))} />;
}

// --- the folders in columns ------------------------------------------------------------------------------

/**
 * The path to a folder: each folder from `~` (else the root; past four, the middle folded to `…`) a
 * button (padding 3 6, radius 6, --dim; hovered --panel-2), a `›` in --rule between; the last --text 600
 * on --panel-2. `tail` follows it (the new folder's name, Where it goes).
 */
export function Crumbs({ dir, home, onGo, tail }: { dir: string; home: string | undefined; onGo: (dir: string) => void; tail?: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" alignItems="center" gap={2} minWidth={0} overflow="hidden" flexShrink={0}>
      {crumbsOf(dir, home).map((c, i, all) => (
        <View key={c.path} flexDirection="row" alignItems="center" gap={2} flexShrink={i === 0 ? 1 : 0} minWidth={0}>
          {i > 0 ? <Txt spec={{ voice: "app", scale: 1, color: "rule" }}>›</Txt> : null}
          <Press
            onPress={() => onGo(c.path)}
            label={c.path}
            paddingVertical={3}
            paddingHorizontal={6}
            borderRadius={6}
            minWidth={0}
            box={({ hovered }) => ({ backgroundColor: i === all.length - 1 || hovered ? t.v("panel-2") : "transparent" })}
          >
            <Txt spec={{ voice: "app", scale: 1, weight: i === all.length - 1 ? 600 : 400, color: i === all.length - 1 ? "text" : "dim" }} ellip minWidth={0}>
              {c.label}
            </Txt>
          </Press>
        </View>
      ))}
      {tail}
    </View>
  );
}

/** A column of folders: its folder's name (caps, 10.5 600, --dim, padding 8 10 6), then its rows, scrolling. */
export function FolderColumn({ title, grow, children }: { title: string; grow: number; children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View flexBasis={0} flexGrow={grow} flexShrink={1} minWidth={0} minHeight={0} {...(edge(t, { right: 1 }) as object)}>
      <Txt spec={HEAD} paddingTop={8} paddingHorizontal={10} paddingBottom={6} ellip>
        {title}
      </Txt>
      <ScrollView {...(scrollbarProps(t) as object)} style={{ flexGrow: 1, flexShrink: 1 } as never} contentContainerStyle={{ paddingBottom: 6 } as never}>
        {children}
      </ScrollView>
    </View>
  );
}

/**
 * A folder in a column: 27 tall, padding 0 8, gap 8, a 15 folder glyph (--dim), the name (app 1, cut
 * with "…"), what it is in words (app 10.5, --dim), a git or JaiRA project mark (12; JaiRA --accent),
 * a `›`. Chosen or being made: --tint-accent, the glyph --accent; made: a 2px --accent bar at its left,
 * a folder-with-plus glyph, its name --accent 600.
 *
 * With `onOpen`, a press chooses it and `›` — or a second press — goes in; without, a press goes in.
 */
export function FolderCell({
  name,
  git = false,
  project = false,
  chip,
  chosen = false,
  made = false,
  onPress,
  onOpen,
}: {
  name: string;
  git?: boolean;
  project?: boolean;
  chip?: string | undefined;
  chosen?: boolean;
  made?: boolean;
  onPress: () => void;
  onOpen?: () => void;
}): JSX.Element {
  const t = useTokens();
  const lit = chosen || made;
  const last = useRef(0);
  const press = (): void => {
    const now = Date.now();
    if (onOpen !== undefined && chosen && now - last.current < 450) onOpen();
    else onPress();
    last.current = now;
  };
  return (
    <View position="relative" flexDirection="row" alignItems="center" height={27} backgroundColor={(lit ? t.v("tint-accent") : "transparent") as never}>
      {made ? <View position="absolute" left={0} top={0} bottom={0} width={2} backgroundColor={t.v("accent") as never} /> : null}
      <Press
        onPress={press}
        label={made ? `Rename ${name}` : name}
        flexDirection="row"
        alignItems="center"
        gap={8}
        height={27}
        paddingLeft={8}
        paddingRight={onOpen !== undefined ? 2 : 8}
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        box={({ hovered }) => ({ backgroundColor: !lit && hovered ? t.v("fill-ghost-hover") : "transparent" })}
      >
        <Icon name={made ? "folderAdd" : "folder"} size={15} color={String(t.v(lit ? "accent" : "dim"))} />
        <Txt spec={{ voice: "app", scale: 1, weight: made || chosen ? 600 : 400, color: made ? "accent" : "text" }} ellip flexGrow={1} flexShrink={1} minWidth={0}>
          {name}
        </Txt>
        {chip !== undefined ? (
          <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: "dim" }} ellip flexShrink={2} minWidth={0} maxWidth="45%">
            {chip}
          </Txt>
        ) : null}
        {project ? <Icon name="diamond" size={12} color={String(t.v("accent"))} /> : git ? <Icon name="git" size={12} color={String(t.v("dim"))} /> : null}
        {made || onOpen !== undefined ? null : <Txt spec={{ voice: "app", scale: 1, color: "dim" }}>›</Txt>}
      </Press>
      {onOpen !== undefined ? (
        <Press onPress={onOpen} label={`Open ${name}`} title={`Open ${name}`} width={24} height={27} alignItems="center" justifyContent="center" box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}>
          <Txt spec={{ voice: "app", scale: 1, color: "dim" }}>›</Txt>
        </Press>
      ) : null}
    </View>
  );
}

/** What the detail column is about: a folder in the folder browsed, or that folder itself. */
export interface FolderFocus {
  path: string;
  name: string;
  git: boolean;
  project: boolean;
  identity?: string;
  /** It is the folder browsed, not one in it. */
  here: boolean;
}

/**
 * A machine's folders in columns, for choosing a folder that is there (Project, the folder chooser):
 * the path across the top; then, in one bordered box (1px --line, radius 9), the folder above (the
 * folder browsed marked; at a root, the machine's roots), the folder browsed (its folders, the one
 * chosen marked), and what is chosen — `detail`'s, on a --panel-2 wash. A press on a folder chooses it,
 * and `›` or a second press goes in; a press in the left column goes there. Narrower than 560 it is one
 * column, `detail` under it.
 */
export function ColumnBrowser({
  machineId,
  self,
  label,
  start,
  jump,
  chosen,
  chipOf,
  onChoose,
  onListing,
  detail,
  hint,
}: {
  machineId: string;
  self: boolean;
  label: string;
  /** Where it opens; the machine's home when absent. */
  start?: string | undefined;
  /** Browse here now (a place pressed in the column): `n` changes for each press. */
  jump?: { dir: string; n: number } | undefined;
  /** The folder chosen, wherever it is. */
  chosen: string | undefined;
  chipOf?: (entry: FolderEntry) => string | undefined;
  onChoose: (focus: FolderFocus) => void;
  onListing?: (listing: FolderListing) => void;
  /** The third column: what `focus` is, and what can be done with it. `open` goes into it. */
  detail: (focus: FolderFocus, open: (() => void) | undefined, narrow: boolean) => ReactNode;
  hint?: ReactNode;
}): JSX.Element {
  const t = useTokens();
  const [here, setHere] = useState<FolderListing | undefined>(undefined);
  const [up, setUp] = useState<FolderListing | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [narrow, setNarrow] = useState(false);
  const asked = useRef(0);
  const ask = (dir: string | undefined): Promise<FolderListing> => invoke("files:browse", { ...(self ? {} : { machine: machineId }), ...(dir !== undefined ? { dir } : {}) });
  const go = (dir: string | undefined): void => {
    const n = ++asked.current;
    setError(undefined);
    ask(dir).then(
      (l) => {
        if (n !== asked.current) return;
        setHere(l);
        onListing?.(l);
        if (l.parent === undefined) setUp(undefined);
        else
          ask(l.parent).then(
            (p) => n === asked.current && setUp(p),
            () => n === asked.current && setUp(undefined),
          );
      },
      (e: unknown) => {
        if (n !== asked.current) return;
        setError(e instanceof Error ? e.message : String(e));
        // Where it was asked to open can't be read: its home, so there is somewhere to start.
        if (here === undefined && dir !== undefined) go(undefined);
      },
    );
  };
  useEffect(() => {
    setHere(undefined);
    setUp(undefined);
    go(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId]);
  useEffect(() => {
    if (jump !== undefined) go(jump.dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.n]);
  const same = (a: string | undefined, b: string): boolean => a !== undefined && a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");
  const picked = here?.entries.find((e) => same(chosen, e.path));
  const focus: FolderFocus | undefined =
    picked !== undefined
      ? { path: picked.path, name: picked.name, git: picked.git, project: picked.project, ...(picked.identity !== undefined ? { identity: picked.identity } : {}), here: false }
      : here !== undefined
        ? { path: here.dir, name: lastOf(here.dir), git: here.here?.git === true, project: here.here?.project === true, ...(here.here?.identity !== undefined ? { identity: here.here.identity } : {}), here: true }
        : undefined;
  const choose = (e: FolderEntry): void => onChoose({ path: e.path, name: e.name, git: e.git, project: e.project, ...(e.identity !== undefined ? { identity: e.identity } : {}), here: false });
  const middle = (
    <FolderColumn title={here !== undefined ? lastOf(here.dir) : label} grow={1}>
      {(here?.entries ?? []).map((e) => (
        <FolderCell key={e.path} name={e.name} git={e.git} project={e.project} chip={chipOf?.(e)} chosen={same(chosen, e.path)} onPress={() => choose(e)} onOpen={() => go(e.path)} />
      ))}
      {here === undefined && error === undefined ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} padding={10}>
          {`Reading ${label}…`}
        </Txt>
      ) : null}
      {here !== undefined && here.entries.length === 0 ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} padding={10}>
          No folders here.
        </Txt>
      ) : null}
    </FolderColumn>
  );
  const detailBox =
    focus !== undefined ? (
      <View
        flexBasis={narrow ? "auto" : 0}
        flexGrow={narrow ? 0 : 1.05}
        flexShrink={narrow ? 0 : 1}
        minWidth={0}
        gap={10}
        paddingVertical={narrow ? 12 : 18}
        paddingHorizontal={16}
        backgroundColor={t.v("panel-2") as never}
        {...(narrow ? (edge(t, { top: 1 }) as object) : {})}
      >
        {detail(focus, focus.here ? undefined : () => go(focus.path), narrow)}
      </View>
    ) : (
      <View flexBasis={0} flexGrow={narrow ? 0 : 1.05} backgroundColor={t.v("panel-2") as never} />
    );
  return (
    <>
      <Crumbs dir={here?.dir ?? start ?? ""} home={here?.roots[0]} onGo={go} />
      <View
        flexDirection={narrow ? "column" : "row"}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        borderRadius={9}
        overflow="hidden"
        {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
        onLayout={(e: { nativeEvent: { layout: { width: number } } }) => setNarrow(e.nativeEvent.layout.width < 560)}
      >
        {narrow ? null : (
          <FolderColumn title={up !== undefined ? lastOf(up.dir) : label} grow={1}>
            {up !== undefined
              ? // The folder browsed, among the folders beside it — added where the listing leaves it out (a hidden one).
                (here !== undefined && !up.entries.some((e) => e.path === here.dir) ? [...up.entries, { name: lastOf(here.dir), path: here.dir, git: false, project: false }] : up.entries).map((e) => (
                  <FolderCell key={e.path} name={e.name} git={e.git} project={e.project} chosen={e.path === here?.dir} onPress={() => go(e.path)} />
                ))
              : (here?.roots ?? []).map((root) => <FolderCell key={root} name={root} chosen={root === here?.dir} onPress={() => go(root)} />)}
          </FolderColumn>
        )}
        {middle}
        {detailBox}
      </View>
      {error !== undefined ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "bad" }} padding={4}>
          {error}
        </Txt>
      ) : (
        hint ?? null
      )}
    </>
  );
}

/**
 * The detail column's parts: the folder's glyph at 40 (a JaiRA project's diamond and a clone's git mark
 * in --accent, else a folder in --dim), its name (app 15/12.5 700), a pill, lines, its whole path
 * (data, wrapping anywhere), then its buttons at the foot.
 */
export function FolderDetail({
  focus,
  narrow,
  pill,
  lines,
  actions,
}: {
  focus: FolderFocus;
  narrow: boolean;
  pill?: { text: string; tone: "accent" | "dim" | "ok" } | undefined;
  lines?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  const t = useTokens();
  return (
    <>
      {narrow ? null : <Icon name={focus.project ? "diamond" : focus.git ? "git" : "folder"} size={40} color={String(t.v(focus.project || focus.git ? "accent" : "dim"))} />}
      <Txt spec={{ voice: "app", scale: 15 / 12.5, weight: 700 }} ellip minWidth={0}>
        {focus.name}
      </Txt>
      {pill !== undefined ? (
        <View flexDirection="row">
          <View paddingHorizontal={7} borderRadius={99} backgroundColor={t.v(pill.tone === "accent" ? "fill-accent" : pill.tone === "ok" ? "tint-ok" : "fill-ghost-hover") as never}>
            <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 600, color: pill.tone === "accent" ? "on-accent" : pill.tone === "ok" ? "ok" : "dim", lineHeight: 1.55 }}>{pill.text}</Txt>
          </View>
        </View>
      ) : null}
      {lines}
      <Txt spec={{ voice: "data", scale: 11.5 / 12, lineHeight: 1.45 }} minWidth={0} {...((isWeb ? { style: { overflowWrap: "anywhere" } } : {}) as object)}>
        {focus.path}
      </Txt>
      {narrow ? null : <View flexGrow={1} />}
      {actions !== undefined ? (
        <View flexDirection="row" flexWrap="wrap" gap={6}>
          {actions}
        </View>
      ) : null}
    </>
  );
}
