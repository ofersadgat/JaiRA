import { useState, type JSX, type ReactNode } from "react";
import { Linking, View as RNView, useWindowDimensions } from "react-native";
import { View } from "@tamagui/core";
import type { EnvironmentView, RunTarget } from "@jaira/shared/browser";
import { AUTO_FACE, barFactsOf, listRowsOf, type EnvironmentStage, type GitFacts, type ListRow, type Meter } from "@jaira/ui/environmentModel";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { NO_STACK, Press, Txt, edge } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { MachineIcon, WorkRing } from "../MachineIcon";
import { MenuLayer } from "../MenuLayer";
import { Float } from "../floats/Float";
import { Icon } from "../panel/Icon";
import { BrandIcon } from "../settings/bits";
import { useAnchorRect } from "./ComposerCards";
import { Spinner } from "./Spinner";

/**
 * The environment bar: the session's shell environment, in a tray tucked under the composer (decision
 * 0013 §5, ruled 2026-10-02). On the left the machine's icon and `machine / workspace`; on the right
 * the checkout — its branch, what is unpushed (`↑2`), the lines changed since the last commit
 * (`+128 −34`), and its merge request (`!17 open`). The right is empty until a workspace is decided.
 * Before a conversation starts, and while it waits, the left opens the list of where it can run
 * (`EnvironmentList`); once it runs the bar only says. What it says is `environmentModel.ts`'s. How it
 * looks:
 *
 *   the tray           the composer's width, its top 22 under the composer's frame; row, centred, gap
 *                      10; padding 28 16 6; 1px --line but the top; radius 0 0 20 20; --accent 3% into
 *                      --panel; app 11.5/12.5, --dim
 *   the machine        row, gap 7: its icon 16, its name --text, a chevron 12 while the list can open;
 *                      hovered, the name underlined
 *   the slash          / at .45
 *   the workspace      row, gap 6: a folder (a clock while it waits, the spinner while one is chosen)
 *                      13, its name --text (--dim for what is not a workspace yet)
 *   the checkout       pushed right; row, gap 9: the branch (its glyph 13, its name --text), ↑n and
 *                      +a −d tabular (+ --ok, − --bad), a 1 × 13 --rule, the forge's mark 12 with the
 *                      request's number --text and its state in its tone
 */
export function EnvironmentBar({ view, stage, onChoose }: { view: EnvironmentView | undefined; stage: EnvironmentStage; /** Absent: the bar says and does not open. */ onChoose?: ((target: RunTarget | undefined) => void) | undefined }): JSX.Element | null {
  const t = useTokens();
  const [ref, measure] = useAnchorRect();
  const [open, setOpen] = useState<FloatRect | null>(null);
  const bar = barFactsOf(view, stage);
  if (bar === undefined || view === undefined) return null;
  const wash = String(t.mix(t.v("accent"), 3, t.v("panel")));
  const opens = bar.open && onChoose !== undefined;
  const target = stage.kind === "choosing" ? stage.target : stage.kind === "running" ? undefined : stage.queued.target;
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
    <View testID="environment-bar" flexDirection="row" alignItems="center" gap={10} minWidth={0} paddingTop={28} paddingHorizontal={16} paddingBottom={6} borderBottomLeftRadius={20} borderBottomRightRadius={20} backgroundColor={wash as never} {...(edge(t, { right: 1, bottom: 1, left: 1 }) as object)} {...({ title: bar.title } as object)}>
      <RNView ref={ref} collapsable={false} style={{ flexShrink: 0, ...NO_STACK } as never}>
        {opens ? (
          <Press onPress={() => measure((at) => setOpen((was) => (was === null ? at : null)))} label="Where this conversation runs" {...({ "aria-expanded": open !== null } as object)} flexDirection="row" alignItems="center" gap={7}>
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
          <View flexDirection="row" alignItems="center" gap={6} minWidth={0} flexShrink={1}>
            {bar.workspace.icon === "spinner" ? <Spinner size={12} color={String(t.v("dim"))} /> : <Icon name={bar.workspace.icon} size={13} color={String(t.v("dim"))} />}
            <Txt spec={{ ...FACE, color: bar.workspace.dim === true ? "dim" : "text" }} ellip minWidth={0} flexShrink={1}>
              {bar.workspace.text}
            </Txt>
          </View>
        </>
      ) : null}
      <View flex={1} minWidth={0} />
      {bar.git !== undefined ? <GitLine t={t} git={bar.git} /> : null}
      {open !== null && onChoose !== undefined ? (
        <EnvironmentList
          anchor={open}
          view={view}
          target={target}
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
export function GitLine({ t, git, dim = false, face = FACE, link = true }: { t: Tokens; git: GitFacts; dim?: boolean; face?: typeof FACE; /** The request opens in the browser (not inside a row that is itself pressed). */ link?: boolean }): JSX.Element {
  const num = { ...face, tabular: true };
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
    <View flexDirection="row" alignItems="center" gap={9} flexShrink={0}>
      {git.branch !== undefined ? (
        <View flexDirection="row" alignItems="center" gap={6}>
          <Icon name="git" size={13} color={String(t.v("dim"))} />
          <Txt spec={{ ...face, color: dim ? "dim" : "text" }} numberOfLines={1}>
            {git.branch}
          </Txt>
        </View>
      ) : null}
      {git.ahead !== undefined ? (
        <Txt spec={num} numberOfLines={1} {...({ title: "commits not pushed" } as object)}>
          {git.ahead}
        </Txt>
      ) : null}
      {git.added !== undefined && git.removed !== undefined ? (
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
export function EnvironmentList({ anchor, view, target, onChoose, onClose }: { anchor: FloatRect; view: EnvironmentView; target: RunTarget | undefined; onChoose: (target: RunTarget | undefined) => void; onClose: () => void }): JSX.Element {
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
        <EnvironmentRows view={view} target={target} onChoose={onChoose} />
      </Float>
    </MenuLayer>
  );
}

/** The list's rows, in their blocks: Automatic, then a block for each machine. */
export function EnvironmentRows({ view, target, onChoose }: { view: EnvironmentView; target: RunTarget | undefined; onChoose: (target: RunTarget | undefined) => void }): JSX.Element {
  const t = useTokens();
  const blocks: ListRow[][] = [];
  for (const row of listRowsOf(view, target)) {
    if (row.kind === "workspace") blocks.at(-1)?.push(row);
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
          {row.on ? "any workspace · the first with room" : row.what}
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
