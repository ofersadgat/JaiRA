import { useState, type JSX, type ReactNode } from "react";
import { Linking, View as RNView, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { View } from "@tamagui/core";
import type { EnvironmentView, RunTarget } from "@jaira/shared/browser";
import { AUTO_FACE, barFactsOf, gitAtDrop, gitDropOf, listRowsOf, type EnvironmentStage, type GitDrop, type GitFacts, type ListRow, type ListScope, type Meter } from "@jaira/ui/environmentModel";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { NO_STACK, Press, Txt, edge } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { MachineIcon, WorkRing } from "../MachineIcon";
import { MenuLayer } from "../MenuLayer";
import { Float } from "../floats/Float";
import { Icon } from "../panel/Icon";
import { BrandIcon } from "../settings/bits";
import { BranchMenu } from "./BranchMenu";
import { ChangesMenu } from "./ChangesMenu";
import { useAnchorRect } from "./ComposerCards";
import { Spinner } from "./Spinner";
import { SyncMenu } from "./SyncMenu";

/**
 * The environment bar: the session's shell environment, in a tray tucked under the composer (decision
 * 0013 §5, ruled 2026-10-02). On the left the machine's icon and `machine / workspace`; on the right
 * the checkout — its branch, what is unpushed (`↑2`), the lines changed since the last commit
 * (`+128 −34`), and its merge request (`!17 open`). The right is empty until a workspace is decided.
 * The machine and the workspace are each a button (the person, 2026-11-20: "the machine is separate
 * from the workspace, so they should be individual buttons"): the machine opens the machines, the
 * workspace that machine's workspaces (`EnvironmentList`). Before a conversation starts, and while it
 * waits, a choice is where it will run; once it runs, a choice MOVES it there (decision 0013 ruling 7).
 * The branch opens the workspace's branches (`BranchMenu`), `↑n ↓m` the commits to push and to pull
 * (`SyncMenu`), and `+a −d` the uncommitted changes (`ChangesMenu`) — the person, 2026-11-25: "the
 * section for commits ahead/behind should be able to be interacted with as should the section for
 * additions/removals". What it says is `environmentModel.ts`'s.
 * How it looks:
 *
 *   the tray           the composer's width, its top 22 under the composer's frame; row, centred, gap
 *                      10; padding 28 16 6; 1px --line but the top; radius 0 0 20 20; --accent 3% into
 *                      --panel; app 11.5/12.5, --dim
 *   the machine        row, gap 7: its icon 16, its name --text, a chevron 12 while the list can open;
 *                      hovered, the name underlined
 *   the slash          / at .45
 *   the workspace      row, gap 6: a folder (a clock while it waits, the spinner while one is chosen)
 *                      13, its name --text (--dim for what is not a workspace yet)
 *   the checkout       pushed right, on the bar's one line: where it has no room, the request goes first,
 *                      then +a −d, then ↑n, and the branch's name is cut last (`gitDropOf`, measured off
 *                      screen); row, gap 9: the branch (its glyph 13, its name --text), ↑n and
 *                      +a −d tabular (+ --ok, − --bad), a 1 × 13 --rule, the forge's mark 12 with the
 *                      request's number --text and its state in its tone
 */
export function EnvironmentBar({
  view,
  stage,
  onChoose,
  automatic = true,
  asking,
}: {
  view: EnvironmentView | undefined;
  stage: EnvironmentStage;
  /** Absent: the bar says and does not open. */
  onChoose?: ((target: RunTarget | undefined) => void) | undefined;
  /** Whether the lists offer Automatic: not once the conversation runs somewhere. */
  automatic?: boolean;
  /** The conversation the bar is under, by task id: the branch menu does not count it among those at work. */
  asking?: string | undefined;
}): JSX.Element | null {
  const t = useTokens();
  const [ref, measure] = useAnchorRect();
  const [wsRef, measureWs] = useAnchorRect();
  const [open, setOpen] = useState<{ at: FloatRect; scope: ListScope } | null>(null);
  // The checkout's menus: its branches, its commits to push and pull, its uncommitted changes.
  const [gitMenu, setGitMenu] = useState<{ kind: "branch" | "sync" | "changes"; at: FloatRect } | null>(null);
  const gitMenuAt = (kind: "branch" | "sync" | "changes") => (at: FloatRect) => setGitMenu((was) => (was?.kind === kind ? null : { kind, at }));
  // One line at every width: the bar's width, the left's as written out, and the checkout's with each
  // number of its facts dropped (`gitDropOf`) — the last two measured off screen, in the ruler below.
  const [width, setWidth] = useState(0);
  const [ruler, setRuler] = useState<Readonly<Record<string, number>>>({});
  const measured = (key: string) => (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setRuler((was) => (was[key] !== undefined && Math.abs(was[key] - w) < 0.5 ? was : { ...was, [key]: w }));
  };
  const bar = barFactsOf(view, stage);
  if (bar === undefined || view === undefined) return null;
  // The bar's padding (16 + 16) and the gap before the checkout.
  const drop: GitDrop = width === 0 || ruler["left"] === undefined ? 0 : gitDropOf(width - 32 - ruler["left"] - 10, [0, 1, 2].map((d) => ruler[`git:${d}`] ?? Infinity));
  const wash = String(t.mix(t.v("accent"), 3, t.v("panel")));
  const opens = bar.open && onChoose !== undefined;
  // Running, the choice is where it runs: ticked in the lists.
  const target = stage.kind === "choosing" ? stage.target : stage.kind === "running" ? { project: stage.project } : stage.queued.target;
  const toggle = (scope: ListScope) => (at: FloatRect) => setOpen((was) => (was === null ? { at, scope: { ...scope, automatic } } : null));
  const machine = (hovered: boolean): ReactNode => (
    <>
      <MachineIcon face={bar.face} size={16} ground={wash} />
      <Txt spec={{ ...FACE, color: "text" }} numberOfLines={1} {...(hovered ? { textDecorationLine: "underline" } : {})}>
        {bar.machine}
      </Txt>
      {opens ? <Icon name="chevron" size={12} color={String(t.v("dim"))} /> : null}
    </>
  );
  return (
    <View testID="environment-bar" flexDirection="row" alignItems="center" gap={10} minWidth={0} paddingTop={28} paddingHorizontal={16} paddingBottom={6} borderBottomLeftRadius={20} borderBottomRightRadius={20} backgroundColor={wash as never} {...(edge(t, { right: 1, bottom: 1, left: 1 }) as object)} {...({ title: bar.title } as object)} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      {/* The ruler: the left as written out, and the checkout with none, one and two of its facts
          dropped, laid out in a box of no size that clips. */}
      <View position="absolute" left={0} top={0} width={0} height={0} overflow="hidden" pointerEvents="none" {...({ "aria-hidden": true, importantForAccessibility: "no-hide-descendants" } as object)}>
        <View flexDirection="row" alignItems="flex-start" width={4000}>
          <View flexDirection="row" alignItems="center" gap={10} onLayout={measured("left")}>
            <View flexDirection="row" alignItems="center" gap={7}>
              {machine(false)}
            </View>
            {bar.workspace !== undefined ? (
              <>
                <Txt spec={FACE}>/</Txt>
                <View flexDirection="row" alignItems="center" gap={6}>
                  <Icon name={bar.workspace.icon === "spinner" ? "folder" : bar.workspace.icon} size={13} color={String(t.v("dim"))} />
                  <Txt spec={FACE} numberOfLines={1}>
                    {bar.workspace.text}
                  </Txt>
                </View>
              </>
            ) : null}
          </View>
          {bar.git !== undefined
            ? ([0, 1, 2] as const).map((d) => (
                <View key={d} onLayout={measured(`git:${d}`)}>
                  <GitLine t={t} git={gitAtDrop(bar.git!, d)} link={false} />
                </View>
              ))
            : null}
        </View>
      </View>
      <RNView ref={ref} collapsable={false} style={{ flexShrink: 0, ...NO_STACK } as never}>
        {opens ? (
          <Press onPress={() => measure(toggle({ only: "machines" }))} label={stage.kind === "running" ? "Move this conversation to another machine" : "The machine this conversation runs on"} {...({ "aria-expanded": open?.scope.only === "machines", "aria-haspopup": "listbox" } as object)} flexDirection="row" alignItems="center" gap={7}>
            {({ hovered }) => machine(hovered)}
          </Press>
        ) : (
          <View flexDirection="row" alignItems="center" gap={7}>
            {machine(false)}
          </View>
        )}
      </RNView>
      {bar.workspace !== undefined ? (
        <>
          <Txt spec={FACE} opacity={0.45} flexShrink={0}>
            /
          </Txt>
          <RNView ref={wsRef} collapsable={false} style={{ minWidth: 0, flexShrink: 1, ...NO_STACK } as never}>
            {opens ? (
              <Press
                onPress={() => measureWs(toggle({ only: "workspaces", ...(bar.machineId !== undefined ? { machine: bar.machineId } : {}) }))}
                label={stage.kind === "running" ? "Move this conversation to another workspace" : "The workspace this conversation runs in"}
                {...({ "aria-expanded": open?.scope.only === "workspaces", "aria-haspopup": "listbox" } as object)}
                flexDirection="row"
                alignItems="center"
                gap={6}
                minWidth={0}
              >
                {({ hovered }) => (
                  <>
                    <Icon name={bar.workspace!.icon === "spinner" ? "folder" : bar.workspace!.icon} size={13} color={String(t.v("dim"))} />
                    <Txt spec={{ ...FACE, color: bar.workspace!.dim === true ? "dim" : "text" }} ellip minWidth={0} flexShrink={1} {...(hovered ? { textDecorationLine: "underline" } : {})}>
                      {bar.workspace!.text}
                    </Txt>
                    <Icon name="chevron" size={12} color={String(t.v("dim"))} />
                  </>
                )}
              </Press>
            ) : (
              <View flexDirection="row" alignItems="center" gap={6} minWidth={0} flexShrink={1}>
                {bar.workspace.icon === "spinner" ? <Spinner size={12} color={String(t.v("dim"))} /> : <Icon name={bar.workspace.icon} size={13} color={String(t.v("dim"))} />}
                <Txt spec={{ ...FACE, color: bar.workspace.dim === true ? "dim" : "text" }} ellip minWidth={0} flexShrink={1}>
                  {bar.workspace.text}
                </Txt>
              </View>
            )}
          </RNView>
        </>
      ) : null}
      {/* The checkout at the right end, with as many of its facts as the line has room for. */}
      {bar.git !== undefined ? (
        <View marginLeft="auto" minWidth={0} flexShrink={1}>
          <GitLine
            t={t}
            git={gitAtDrop(bar.git, drop)}
            {...(bar.checkout !== undefined ? { onBranch: gitMenuAt("branch"), onSync: gitMenuAt("sync"), onChanges: gitMenuAt("changes") } : {})}
          />
        </View>
      ) : null}
      {gitMenu !== null && bar.checkout !== undefined ? (
        gitMenu.kind === "branch" ? (
          <BranchMenu anchor={gitMenu.at} project={bar.checkout} workspace={bar.workspace?.text ?? "the workspace"} asking={asking} onClose={() => setGitMenu(null)} />
        ) : gitMenu.kind === "sync" ? (
          <SyncMenu anchor={gitMenu.at} project={bar.checkout} onClose={() => setGitMenu(null)} />
        ) : (
          <ChangesMenu anchor={gitMenu.at} project={bar.checkout} onClose={() => setGitMenu(null)} />
        )
      ) : null}
      {open !== null && onChoose !== undefined ? (
        <EnvironmentList
          anchor={open.at}
          view={view}
          target={target}
          scope={open.scope}
          onChoose={(next) => {
            setOpen(null);
            onChoose(next);
          }}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </View>
  );
}

const FACE = { voice: "app" as const, scale: 11.5 / 12.5, color: "dim" };
const SMALL = { voice: "app" as const, scale: 11 / 12.5, color: "dim" };

/**
 * A checkout's facts on one line, as the bar and the list both write them. `dim`: of a workspace that
 * cannot be chosen — its branch is not lit.
 */
export function GitLine({
  t,
  git,
  dim = false,
  face = FACE,
  link = true,
  onBranch,
  onSync,
  onChanges,
}: {
  t: Tokens;
  git: GitFacts;
  dim?: boolean;
  face?: typeof FACE;
  /** The request opens in the browser (not inside a row that is itself pressed). */
  link?: boolean;
  /** The branch is a button: it opens the branch menu, under it. */
  onBranch?: ((at: FloatRect) => void) | undefined;
  /** `↑n ↓m` is a button: it opens the sync menu, under it. */
  onSync?: ((at: FloatRect) => void) | undefined;
  /** `+a −d` is a button: it opens the changes menu, under it. */
  onChanges?: ((at: FloatRect) => void) | undefined;
}): JSX.Element {
  const num = { ...face, tabular: true };
  const [branchRef, measureBranch] = useAnchorRect();
  const [syncRef, measureSync] = useAnchorRect();
  const [changesRef, measureChanges] = useAnchorRect();
  const request = (hovered: boolean): ReactNode =>
    git.request === undefined ? null : (
      <>
        <BrandIcon name={git.request.provider} size={12} />
        <Txt spec={{ ...face, color: "text" }} {...(hovered ? { textDecorationLine: "underline" } : {})}>
          {git.request.label}
        </Txt>
        <Txt spec={{ ...face, color: git.request.tone }}>{git.request.state}</Txt>
      </>
    );
  return (
    // Squeezed, the branch's name is what is cut.
    <View flexDirection="row" alignItems="center" gap={9} flexShrink={1} minWidth={0}>
      {git.branch !== undefined && onBranch !== undefined ? (
        <RNView ref={branchRef} collapsable={false} style={{ minWidth: 0, flexShrink: 1, ...NO_STACK } as never}>
          <Press onPress={() => measureBranch(onBranch)} label={`Branch: ${git.branch}. Switch branch`} title="Switch branch" {...({ "aria-haspopup": "listbox" } as object)} flexDirection="row" alignItems="center" gap={6} minWidth={0}>
            {({ hovered }) => (
              <>
                <Icon name="git" size={13} color={String(t.v("dim"))} />
                <Txt spec={{ ...face, color: dim ? "dim" : "text" }} ellip minWidth={0} flexShrink={1} {...(hovered ? { textDecorationLine: "underline" } : {})}>
                  {git.branch}
                </Txt>
                <Icon name="chevron" size={12} color={String(t.v("dim"))} />
              </>
            )}
          </Press>
        </RNView>
      ) : git.branch !== undefined ? (
        <View flexDirection="row" alignItems="center" gap={6} flexShrink={1} minWidth={0}>
          <Icon name="git" size={13} color={String(t.v("dim"))} />
          <Txt spec={{ ...face, color: dim ? "dim" : "text" }} ellip minWidth={0} flexShrink={1}>
            {git.branch}
          </Txt>
        </View>
      ) : null}
      {git.ahead !== undefined && onSync !== undefined ? (
        <RNView ref={syncRef} collapsable={false} style={{ flexShrink: 0, ...NO_STACK } as never}>
          <Press onPress={() => measureSync(onSync)} label={`${git.ahead}: commits to push and to pull. Push or pull`} title="Commits to push and to pull" {...({ "aria-haspopup": "dialog" } as object)}>
            {({ hovered }) => (
              <Txt spec={num} numberOfLines={1} {...(hovered ? { textDecorationLine: "underline" } : {})}>
                {git.ahead}
              </Txt>
            )}
          </Press>
        </RNView>
      ) : git.ahead !== undefined ? (
        <Txt spec={num} numberOfLines={1} flexShrink={0} {...({ title: "commits to push (↑) and to pull (↓)" } as object)}>
          {git.ahead}
        </Txt>
      ) : null}
      {git.added !== undefined && git.removed !== undefined && onChanges !== undefined ? (
        <RNView ref={changesRef} collapsable={false} style={{ flexShrink: 0, ...NO_STACK } as never}>
          <Press onPress={() => measureChanges(onChanges)} label={`${git.added} ${git.removed}: lines changed since the last commit. See, commit or stash them`} title="Uncommitted changes" {...({ "aria-haspopup": "dialog" } as object)} flexDirection="row" alignItems="center" gap={4}>
            {({ hovered }) => (
              <>
                <Txt spec={{ ...num, color: "ok" }} {...(hovered ? { textDecorationLine: "underline" } : {})}>
                  {git.added}
                </Txt>
                <Txt spec={{ ...num, color: "bad" }} {...(hovered ? { textDecorationLine: "underline" } : {})}>
                  {git.removed}
                </Txt>
              </>
            )}
          </Press>
        </RNView>
      ) : git.added !== undefined && git.removed !== undefined ? (
        <View flexDirection="row" alignItems="center" gap={4} {...({ title: "lines changed since the last commit" } as object)}>
          <Txt spec={{ ...num, color: "ok" }}>{git.added}</Txt>
          <Txt spec={{ ...num, color: "bad" }}>{git.removed}</Txt>
        </View>
      ) : null}
      {git.request !== undefined ? (
        <>
          <View width={1} height={13} flexShrink={0} backgroundColor={t.v("rule") as never} />
          {link ? (
            <Press onPress={() => void Linking.openURL(git.request!.url)} title={`Open ${git.request.label} in the browser`} flexDirection="row" alignItems="center" gap={5}>
              {({ hovered }) => request(hovered)}
            </Press>
          ) : (
            <View flexDirection="row" alignItems="center" gap={5}>
              {request(false)}
            </View>
          )}
        </>
      ) : null}
    </View>
  );
}

/**
 * Where a conversation can run: Automatic, then each machine — choosing one takes its first workspace
 * with room — and under it each of its workspaces, which is that one and no other. A machine that
 * cannot be reached is listed, dimmed, and cannot be chosen. Choosing something with no room is still
 * the choice: the conversation waits for it. The rows are `environmentModel.ts`'s `listRowsOf`. How it
 * looks:
 *
 *   the list           against the bar's machine, its start edges lined up, 10 apart; 690 wide (the
 *                      window less 32 at most); padding 6; 1px --line, radius 12, --panel, --lift
 *   Automatic          row, gap 12, padding 7 9, radius 8: the dashed screen 18, "Automatic" app 600,
 *                      what it means under it app 11/12.5 --dim; a ✓ at the end when it is the choice
 *   a machine's block  6 above, a --line over it, 6 under that
 *   its line           row, gap 11, padding 6 9, radius 8: its icon 18, its name app 600 (--dim when
 *                      it cannot be reached), what it is app 11/12.5 --dim; pushed right its meters, or
 *                      why it cannot be chosen (--warn connecting, --bad not)
 *   a meter            row, gap 6, app 11/12.5 --dim: its label, a 44 × 5 track (--panel-2, radius 3)
 *                      filled --accent (--warn from 90%), its figure tabular in 26
 *   a workspace's line row, gap 9, padding 4 9, radius 7, app 11/12.5: 26 for the work ring (18, when
 *                      tasks are at work or wait there), a folder 13 and its name --text; pushed right
 *                      its checkout as the bar writes it; at .55 when its machine cannot be reached
 *   the choice         --accent 10% into --panel, and a ✓ in --accent at its end (12 wide, kept on
 *                      every row so the columns line up); hovered --fill-ghost-hover
 */
export function EnvironmentList({
  anchor,
  view,
  target,
  scope,
  onChoose,
  onClose,
}: {
  anchor: FloatRect;
  view: EnvironmentView;
  target: RunTarget | undefined;
  /** Which rows: the machines, the workspaces (of one machine), or all (`listRowsOf`). */
  scope?: ListScope | undefined;
  onChoose: (target: RunTarget | undefined) => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTokens();
  const win = useWindowDimensions();
  return (
    <MenuLayer onClose={onClose}>
      <Float
        anchor={anchor}
        side="below"
        align="start"
        offset={10}
        width={Math.min(690, win.width - 32)}
        padding={6}
        borderWidth={1}
        borderStyle="solid"
        borderColor={t.v("line") as never}
        borderRadius={12}
        backgroundColor={t.v("panel") as never}
        {...({ boxShadow: String(t.v("lift")), role: "listbox" } as object)}
      >
        <EnvironmentRows view={view} target={target} scope={scope} onChoose={onChoose} />
      </Float>
    </MenuLayer>
  );
}

/** The list's rows, in their blocks: Automatic, then a block for each machine. */
export function EnvironmentRows({ view, target, scope, onChoose }: { view: EnvironmentView; target: RunTarget | undefined; scope?: ListScope | undefined; onChoose: (target: RunTarget | undefined) => void }): JSX.Element {
  const t = useTokens();
  const blocks: ListRow[][] = [];
  for (const row of listRowsOf(view, target, scope)) {
    // One machine's workspaces have no machine line to hang under: they are one block.
    if (row.kind === "workspace" && blocks.length > 0) blocks.at(-1)!.push(row);
    else blocks.push([row]);
  }
  return (
    <>
      {blocks.map((block, i) => (
        <View key={i} minWidth={0} {...(i > 0 ? { marginTop: 6, paddingTop: 6, ...(edge(t, { top: 1 }) as object) } : {})}>
          {block.map((row) => (
            <Row key={row.kind === "workspace" ? `w:${row.workspace.project}` : row.kind === "machine" ? `m:${row.machine.id}` : "auto"} t={t} row={row} onChoose={onChoose} />
          ))}
        </View>
      ))}
    </>
  );
}

function Tick({ on }: { on: boolean }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "accent" }} width={12} flexShrink={0} textAlign="center">
      {on ? "✓" : ""}
    </Txt>
  );
}

function MeterBar({ t, meter }: { t: Tokens; meter: Meter }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" gap={6} flexShrink={0}>
      <Txt spec={SMALL}>{meter.label}</Txt>
      <View width={44} height={5} borderRadius={3} overflow="hidden" backgroundColor={t.v("panel-2") as never}>
        <View width={`${meter.pct}%`} height="100%" backgroundColor={t.v(meter.high ? "warn" : "accent") as never} />
      </View>
      <Txt spec={{ ...SMALL, tabular: true, color: meter.high ? "warn" : "dim" }} minWidth={26}>
        {meter.text}
      </Txt>
    </View>
  );
}

function Row({ t, row, onChoose }: { t: Tokens; row: ListRow; onChoose: (target: RunTarget | undefined) => void }): JSX.Element {
  const chosen = String(t.mix(t.v("accent"), 10, t.v("panel")));
  const ground = ({ hovered }: { hovered: boolean }): Record<string, unknown> => ({ backgroundColor: row.on ? chosen : hovered ? t.v("fill-ghost-hover") : "transparent" });
  const said = { role: "option", "aria-selected": row.on } as object;
  if (row.kind === "auto") {
    return (
      <Press onPress={() => onChoose(undefined)} {...said} flexDirection="row" alignItems="center" gap={12} paddingVertical={7} paddingHorizontal={9} borderRadius={8} box={ground}>
        <MachineIcon face={AUTO_FACE} size={18} ground={row.on ? chosen : "panel"} />
        <View flex={1} minWidth={0}>
          <Txt spec={{ voice: "app", scale: 1, weight: 600 }}>Automatic</Txt>
          <Txt spec={SMALL}>the first workspace with room, in this project&apos;s order</Txt>
        </View>
        <Tick on={row.on} />
      </Press>
    );
  }
  if (row.kind === "machine") {
    return (
      <Press onPress={() => onChoose(row.target)} disabled={!row.usable} {...said} flexDirection="row" alignItems="center" gap={11} paddingVertical={6} paddingHorizontal={9} borderRadius={8} box={row.usable ? ground : () => ({})}>
        <MachineIcon face={row.face} size={18} ground={row.on ? chosen : "panel"} {...(row.usable ? {} : { color: String(t.v("dim")) })} />
        <Txt spec={{ voice: "app", scale: 1, weight: 600, color: row.usable ? "text" : "dim" }} numberOfLines={1} flexShrink={0}>
          {row.name}
        </Txt>
        <Txt spec={SMALL} ellip minWidth={0} flexShrink={1}>
          {row.on && row.holds !== true ? "any workspace · the first with room" : row.what}
        </Txt>
        <View flex={1} minWidth={0} />
        {row.note !== undefined ? <Txt spec={{ ...SMALL, color: row.note.tone }}>{row.note.text}</Txt> : row.meters.map((meter) => <MeterBar key={meter.label} t={t} meter={meter} />)}
        <Tick on={row.on} />
      </Press>
    );
  }
  return (
    <Press onPress={() => onChoose(row.target)} disabled={!row.usable} {...said} title={row.workspace.why !== undefined ? `No room now: ${row.workspace.why}. A conversation sent here waits for it.` : row.workspace.dir} flexDirection="row" alignItems="center" gap={9} paddingVertical={4} paddingHorizontal={9} borderRadius={7} opacity={row.usable ? 1 : 0.55} box={row.usable ? ground : () => ({})}>
      <View width={26} flexShrink={0} flexDirection="row" justifyContent="flex-end">
        {row.work > 0 ? <WorkRing count={row.work} title={row.workTitle} /> : null}
      </View>
      <View flexDirection="row" alignItems="center" gap={7} minWidth={0} flexShrink={1}>
        <Icon name="folder" size={13} color={String(t.v("dim"))} />
        <Txt spec={{ ...SMALL, color: row.usable ? "text" : "dim" }} ellip minWidth={0} flexShrink={1}>
          {row.workspace.label}
        </Txt>
      </View>
      <View flex={1} minWidth={0} />
      {row.git !== undefined ? <GitLine t={t} git={row.git} dim={!row.usable} face={SMALL} link={false} /> : null}
      <Tick on={row.on} />
    </Press>
  );
}
