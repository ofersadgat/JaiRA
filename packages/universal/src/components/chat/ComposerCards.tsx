import { useRef, useState, type JSX, type ReactNode } from "react";
import { View as RNView, useWindowDimensions } from "react-native";
import { View, isWeb } from "@tamagui/core";
import {
  PERMISSION_SET_LAYER_LABELS,
  permissionSetNameProblem,
  type PermissionSetBucket,
  type SettingOrigin,
  type WritableLayer,
} from "@jaira/shared/browser";
import { EFFORT_HINTS, KEEP_WHERE, VENDOR_NAMES, cascadeOf, modalitiesOf, modalityIcon, originWordsOf, repoint, tierOf, type PickModel } from "@jaira/ui/composerCards";
import { ROUTE_BORROWS } from "@jaira/ui/composerModel";
import type { FloatRect } from "@jaira/ui/floatPlace";
import type { Schema } from "@jaira/ui/schemaForm/types";
import { NO_STACK, Press, Txt, edge, scrollbarProps, viewScrollbarProps } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { Svg } from "../panel/Svg";
import { MenuLayer } from "../MenuLayer";
import { Float } from "../floats/Float";
import { SchemaForm } from "../form/SchemaForm";
import { Icon, type IconName } from "../panel/Icon";
import { BrandIcon } from "../settings/bits";
import { ModelWindow, RouteLeft } from "./UsageCards";

/**
 * The composer's cards: what each chip opens — the route → model cascade, the thinking levels, the
 * permission sets of a bucket (with the bucket picker and `+`), and (in `ComposerTools.tsx`) the tools.
 * What they compute is `composerCards.ts`' and `composerModel.ts`'s. How they look:
 *
 *   a card             above the chip, its start edges lined up, 7 apart; at least 250, at most 560 (78% of
 *                      the window), as wide as its content; padding 10 12 11, 1px --line, radius 12,
 *                      --panel, --lift
 *   its head           row, baseline, gap 8, 7 under, at least 20 tall, 132 clear on the right; the title
 *                      app 600 11/12.5 --text; the origin app 10.5/12.5 --tok-hint (yours --accent; unset
 *                      italic); reset pushed right, padding 1 7, round, --panel-2, app 10.5/12.5 --dim
 *   the options        column, gap 1, margin 0 −4; a row: gap 8, padding 5 7, radius 7, --dim (hovered
 *                      --text 7% and --text; in force --accent 13%); its icon 14 --tok-hint (in force
 *                      --accent); name app 500 12/12.5 on 1.25, hint app 10.5/12.5 on 1.3 --tok-hint (in
 *                      force --dim); tag data 600 ×.76 on 1.45 in an --accent 45% pill; ✓ --accent 11/12.5
 *   the hint           at most 320, 7 above, app 10.5/12.5 on 1.5, --tok-hint
 *   the cascade        row, margin 0 −4 8, 1px --line, radius 9, clipped, 208 tall; a column 148 wide,
 *                      padding 3, a --line on the right, scrolls; the last at least 190, --panel-2 45%;
 *                      a row as an option's (on --text 7%, live --accent 13%); icons 12; › and ✓ 11
 *   the filters        over the card's head, top 9 right 12; a filter's button padding 2 7, 1px --line,
 *                      round, --dim; its label 9.5/12.5, upper, 0.06em, --tok-hint (on: --accent, the
 *                      button --accent 16% into --panel, its edge 45%)
 */

/** Where a box is in the window — what a card or a menu is placed against. */
export function useAnchorRect(): [React.MutableRefObject<RNView | null>, (then: (at: FloatRect) => void) => void] {
  const ref = useRef<RNView | null>(null);
  return [ref, (then) => ref.current?.measureInWindow((x, y, w, h) => then({ left: x, top: y, right: x + w, bottom: y + h }))];
}

const NAME = { voice: "app" as const, scale: 12 / 12.5, weight: 500, lineHeight: 1.25 };
const HINT = { voice: "app" as const, scale: 10.5 / 12.5, lineHeight: 1.3, color: "tok-hint" };

/** A chip's card — its head (title, what leads, the origin, what trails, reset) and body. */
export function ChipCard({
  anchor,
  label,
  origin,
  from,
  onReset,
  lead,
  trail,
  onClose,
  width,
  sections = false,
  align = "start",
  offset = 7,
  children,
}: {
  anchor: FloatRect;
  label: string;
  origin?: SettingOrigin | undefined;
  from?: string | undefined;
  onReset?: (() => void) | undefined;
  lead?: ReactNode;
  trail?: ReactNode;
  onClose: () => void;
  /** A card of a fixed width (the context's 380, the account's 370). */
  width?: number | undefined;
  /** A usage card: no padding of its own — its head padded 10 14 4, its body sections of their own. */
  sections?: boolean;
  /** Which edges line up (the context ring's card: its end); how far above (a usage card: 8). */
  align?: "start" | "end";
  offset?: number;
  children: ReactNode;
}): JSX.Element {
  const t = useTokens();
  const win = useWindowDimensions();
  return (
    <MenuLayer onClose={onClose}>
      <Float
        anchor={anchor}
        side="above"
        align={align}
        offset={offset}
        minWidth={sections ? 0 : 250}
        maxWidth={sections ? Math.min(width ?? 380, win.width * 0.86) : Math.min(560, win.width * 0.78)}
        {...(sections ? {} : { paddingTop: 10, paddingHorizontal: 12, paddingBottom: 11 })}
        borderWidth={1}
        borderStyle="solid"
        borderColor={t.v("line") as never}
        borderRadius={12}
        backgroundColor={t.v("panel") as never}
        {...(width !== undefined ? { width } : {})}
        {...({ boxShadow: String(t.v("lift")) } as object)}
      >
        <CardHead label={label} origin={origin} from={from} onReset={onReset} lead={lead} trail={trail} sections={sections} />
        {children}
      </Float>
    </MenuLayer>
  );
}

/** A card's head. */
export function CardHead({ label, origin, from, onReset, lead, trail, sections = false }: { label: string; origin?: SettingOrigin | undefined; from?: string | undefined; onReset?: (() => void) | undefined; lead?: ReactNode; trail?: ReactNode; sections?: boolean }): JSX.Element {
  const t = useTokens();
  const words = origin !== undefined ? originWordsOf(origin, from) : undefined;
  return (
    <View flexDirection="row" alignItems="baseline" gap={8} marginBottom={7} minHeight={20} {...(sections ? { paddingTop: 10, paddingHorizontal: 14, paddingBottom: 4 } : { paddingRight: 132 })}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600, color: "text" }} flexShrink={0}>
        {label}
      </Txt>
      {lead}
      {words !== undefined ? (
        <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: words.tone === "own" ? "accent" : "tok-hint", italic: words.tone === "unset" }} flexShrink={1} minWidth={0}>
          {words.text}
        </Txt>
      ) : null}
      {trail}
      {onReset !== undefined && origin === "override" ? (
        <Press onPress={onReset} marginLeft="auto" flexShrink={0} paddingVertical={1} paddingHorizontal={7} borderRadius={999} backgroundColor={t.v("panel-2") as never}>
          {({ hovered }) => <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: hovered ? "text" : "dim" }}>reset</Txt>}
        </Press>
      ) : null}
    </View>
  );
}

/** A card's hint. */
export function CardHint({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.5, color: "tok-hint" }} marginTop={7} maxWidth={320}>
      {children}
    </Txt>
  );
}

/** The column of options. */
export function Opts({ children }: { children: ReactNode }): JSX.Element {
  return (
    <View flexDirection="column" gap={1} marginHorizontal={-4}>
      {children}
    </View>
  );
}

/** `Opt`: one option — its icon, its name (and tag) over the sentence that explains it, a tick in force. */
export function Opt({ on, icon, name, tag, hint, title, onPick }: { on: boolean; icon?: IconName | undefined; name: string; tag?: string | undefined; hint?: string | undefined; title?: string | undefined; onPick: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPick}
      title={title ?? hint ?? name}
      flexDirection="row"
      alignItems="center"
      gap={8}
      width="100%"
      minWidth={0}
      paddingVertical={5}
      paddingHorizontal={7}
      borderRadius={7}
      box={({ hovered }) => ({ backgroundColor: on ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
    >
      {({ hovered }) => (
        <>
          {icon !== undefined ? <Icon name={icon} size={14} color={String(t.v(on ? "accent" : "tok-hint"))} /> : null}
          <View flexDirection="column" gap={1} minWidth={0} flexShrink={1}>
            <Txt spec={{ ...NAME, color: on || hovered ? "text" : "dim" }} ellip>
              {name}
              {tag !== undefined ? (
                <Txt spec={{ voice: "data", scale: 0.76, weight: 600, lineHeight: 1.45, color: "accent" }} marginLeft={7} paddingHorizontal={6} borderWidth={1} borderStyle="solid" borderColor={t.mix(t.v("accent"), 45, "transparent") as never} borderRadius={999} {...({ display: "inline-block", verticalAlign: 1 } as object)}>
                  {tag}
                </Txt>
              ) : null}
            </Txt>
            {hint !== undefined ? (
              <Txt spec={{ ...HINT, color: on ? "dim" : "tok-hint" }} ellip>
                {hint}
              </Txt>
            ) : null}
          </View>
          {on ? (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "accent" }} marginLeft="auto" flexShrink={0}>
              ✓
            </Txt>
          ) : null}
        </>
      )}
    </Press>
  );
}

/** The Thinking card's body: the levels this model takes, each with what it buys, and where they come from. */
export function ThinkingBody({ levels, effort, defaultLevel, takes, footer, onPick }: { levels: readonly { level: string; description?: string | undefined }[]; effort: string | undefined; defaultLevel: string | undefined; takes: boolean; footer: string; onPick: (level: string) => void }): JSX.Element {
  if (!takes) return <CardHint>this model takes no thinking level</CardHint>;
  return (
    <>
      <Opts>
        {levels.map(({ level, description }) => (
          <Opt key={level} on={effort === level} icon="think" name={level} {...(level === defaultLevel ? { tag: "default" } : {})} hint={description ?? EFFORT_HINTS[level]} onPick={() => onPick(level)} />
        ))}
      </Opts>
      <CardHint>{footer}</CardHint>
    </>
  );
}

/** A row of a cascade column: hovered or picked a --text 7% ground, live --accent 13%. */
function ColRow({ on, live, onPress, onHover, title, children }: { on: boolean; live: boolean; onPress: () => void; onHover?: (() => void) | undefined; title?: string; children: (hovered: boolean) => ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      {...(title !== undefined ? { title } : {})}
      {...(isWeb && onHover !== undefined ? { onMouseEnter: onHover } : {})}
      flexDirection="row"
      alignItems="center"
      gap={8}
      width="100%"
      minWidth={0}
      paddingVertical={5}
      paddingHorizontal={7}
      borderRadius={7}
      box={({ hovered }) => ({ backgroundColor: live ? t.mix(t.v("accent"), 13, "transparent") : on || hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
    >
      {({ hovered }) => children(hovered || on)}
    </Press>
  );
}

/**
 * The › of a row with more under it: pushed to the edge — or, after a route's figure, 4 after it. Its
 * weight is where it stands (the bucket's head is 600, and a bold › is 0.3 wider).
 */
const More = ({ after = false, weight = 400 }: { after?: boolean; weight?: number }): JSX.Element => (
  <Txt spec={{ voice: "app", scale: 11 / 12.5, weight, color: "tok-hint" }} marginLeft={after ? 4 : "auto"} flexShrink={0}>
    ›
  </Txt>
);
const Tick = ({ on }: { on: boolean }): JSX.Element => (
  <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "ok" }} width={10} flexShrink={0}>
    {on ? "✓" : ""}
  </Txt>
);

/** One side's modality filter (`ModalityFilter`): what is ticked, as glyphs, and a list below it. */
function ModalityFilter({ side, options, value, onChange }: { side: "input" | "output"; options: readonly string[]; value: readonly string[]; onChange: (next: string[]) => void }): JSX.Element {
  const t = useTokens();
  const [ref, measure] = useAnchorRect();
  const [at, setAt] = useState<FloatRect | null>(null);
  const on = value.length > 0;
  const toggle = (mode: string): void => onChange(value.includes(mode) ? value.filter((m) => m !== mode) : [...value, mode]);
  return (
    <RNView ref={ref} collapsable={false} style={NO_STACK as never}>
      <Press
        onPress={() => (at !== null ? setAt(null) : measure(setAt))}
        title={value.length === 0 ? `any ${side}` : `${side}: ${value.join(" + ")}`}
        flexDirection="row"
        alignItems="center"
        gap={4}
        paddingVertical={2}
        paddingHorizontal={7}
        borderWidth={1}
        borderStyle="solid"
        borderRadius={999}
        borderColor={(on ? t.mix(t.v("accent"), 45, t.v("line")) : t.v("line")) as never}
        backgroundColor={(on ? t.mix(t.v("accent"), 16, t.v("panel")) : "transparent") as never}
      >
        {({ hovered }) => (
          <>
            <Txt spec={{ voice: "app", scale: 9.5 / 12.5, upper: true, ls: 0.06, color: on ? "accent" : "tok-hint" }}>{side === "input" ? "in" : "out"}</Txt>
            {value.length === 0 ? (
              <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: hovered ? "text" : "dim" }}>any</Txt>
            ) : (
              value.map((mode) => <Icon key={mode} name={modalityIcon(mode)} size={11} color={String(t.v("tok-hint"))} />)
            )}
          </>
        )}
      </Press>
      {at !== null ? (
        <MenuLayer onClose={() => setAt(null)}>
          <Float anchor={at} side="below" align="end" minWidth={128} padding={3} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={9} backgroundColor={t.v("panel") as never} {...({ boxShadow: String(t.v("lift")) } as object)}>
            {options.map((mode) => (
              <Press key={mode} onPress={() => toggle(mode)} flexDirection="row" alignItems="center" gap={6} width="100%" paddingVertical={3} paddingHorizontal={6} borderRadius={6} box={({ hovered }) => ({ backgroundColor: hovered ? t.mix(t.v("accent"), 10, "transparent") : "transparent" })}>
                {({ hovered }) => (
                  <>
                    <Tick on={value.includes(mode)} />
                    <Icon name={modalityIcon(mode)} size={11} color={String(t.v("tok-hint"))} />
                    <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: hovered || value.includes(mode) ? "text" : "dim" }} ellip>
                      {mode}
                    </Txt>
                  </>
                )}
              </Press>
            ))}
          </Float>
        </MenuLayer>
      ) : null}
    </RNView>
  );
}

/**
 * `RouteCascade`: route → (group) → model, drilled into on hover (a press on a phone), taken on a
 * click — with the modality filters over the card's head. Its height is FIXED (208).
 */
export function RouteCascade({ routes, models, current, onPick }: { routes: readonly string[]; models: readonly PickModel[]; current: string; onPick: (model: string) => void }): JSX.Element {
  const t = useTokens();
  const here = tierOf(current);
  const [route, setRoute] = useState<string>(here.route);
  const [group, setGroup] = useState<string | undefined>(here.group);
  const [needs, setNeeds] = useState<{ input: string[]; output: string[] }>({ input: [], output: [] });
  const { columns, groups, shown, borrows, ownDefault, own, borrowed, leaves } = cascadeOf(routes, models, route, group, needs);
  const drill = (r: string): void => {
    setRoute(r);
    setGroup(undefined);
  };
  const col = (last: boolean, children: ReactNode, first = false): JSX.Element => (
    <View
      flexDirection="column"
      minWidth={last ? 190 : 0}
      // No column gives way, the last included; the first column is 204.
      flexShrink={0}
      // The width 148 holds for the last column too, under its `minWidth` 190: it is 190.
      {...(last ? { width: 148, backgroundColor: t.mix(t.v("panel-2"), 45, "transparent") as never } : { width: first ? 204 : 148, ...edge(t, { right: 1 }) })}
      padding={3}
      {...({ overflowY: "auto" } as object)}
      {...(viewScrollbarProps(t) as object)}
    >
      {children}
    </View>
  );
  const leafName = (id: string, lit: boolean): JSX.Element => (
    <Txt spec={{ voice: "data", scale: 11.5 / 12, lineHeight: 1.25, color: lit ? "text" : "dim" }} ellip minWidth={0} flexShrink={1}>
      {tierOf(id).leaf}
    </Txt>
  );
  return (
    <>
      {/* Over the card's own head, hard right: absolute, top 9, right 12. */}
      {/* The 0.58 more: where a button set inline sits on the body's strut (measured). */}
      <View position="absolute" top={9.58} right={12} flexDirection="row" gap={6}>
        {(["input", "output"] as const).map((side) => (
          <ModalityFilter key={side} side={side} options={modalitiesOf(models, side)} value={needs[side]} onChange={(next) => setNeeds({ ...needs, [side]: next })} />
        ))}
      </View>
      <View flexDirection="row" marginHorizontal={-4} marginBottom={8} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={9} overflow="hidden" height={208} maxHeight={210}>
        {col(
          false,
          columns.map((r) => (
            <ColRow
              key={r}
              on={r === route}
              live={r === here.route}
              onHover={() => drill(r)}
              onPress={() => {
                // A phone has no hover to drill with: the first press on another route shows its column,
                // and the next picks there, as a click does after hovering on the desktop.
                if (!isWeb && r !== route) {
                  drill(r);
                  return;
                }
                const there = repoint(r, current, models);
                if (there !== undefined) onPick(there);
                else drill(r);
              }}
            >
              {(lit) => (
                <>
                  <BrandIcon name={r} size={12} ink="tok-hint" />
                  <Txt spec={{ ...NAME, color: lit ? "text" : "dim" }} ellip minWidth={0} flexShrink={1}>
                    {r}
                  </Txt>
                  <RouteLeft route={r} after={(afterFigure) => <More after={afterFigure} />} />
                </>
              )}
            </ColRow>
          )),
          true,
        )}
        {groups.length > 0
          ? col(
              false,
              groups.map((g) => (
                <ColRow key={g} on={g === shown} live={route === here.route && g === here.group} onHover={() => setGroup(g)} onPress={() => setGroup(g)}>
                  {(lit) => (
                    <>
                      <BrandIcon name={g} size={12} ink="tok-hint" />
                      <Txt spec={{ ...NAME, color: lit ? "text" : "dim" }} ellip minWidth={0} flexShrink={1}>
                        {g}
                      </Txt>
                      <More />
                    </>
                  )}
                </ColRow>
              )),
            )
          : null}
        {col(
          true,
          <>
            {ROUTE_BORROWS[route] !== undefined ? (
              <ColRow on={current === route || current === `${route}/default`} live={current === route || current === `${route}/default`} onPress={() => onPick(`${route}/default`)}>
                {(lit) => (
                  <>
                    <Tick on={current === `${route}/default`} />
                    <View flexDirection="column" gap={1} minWidth={0} flexShrink={1}>
                      <Txt spec={{ voice: "data", scale: 11.5 / 12, lineHeight: 1.25, color: lit ? "text" : "dim" }} ellip>
                        default
                      </Txt>
                      <Txt spec={HINT} ellip>
                        {ownDefault?.levels !== undefined ? `the CLI's pick · ${ownDefault.levels}` : "whatever the CLI picks"}
                      </Txt>
                    </View>
                  </>
                )}
              </ColRow>
            ) : null}
            {own.map((m) => (
              <ColRow key={m.id} on={m.id === current} live={m.id === current} onPress={() => onPick(m.id)}>
                {(lit) => (
                  <>
                    <Tick on={m.id === current} />
                    <View flexDirection="column" gap={1} minWidth={0} flexShrink={1}>
                      {leafName(m.id, lit)}
                      {m.levels !== undefined ? (
                        <Txt spec={HINT} ellip>
                          {m.levels}
                        </Txt>
                      ) : null}
                    </View>
                  </>
                )}
              </ColRow>
            ))}
            {own.length > 0 && borrowed.length > 0 ? (
              <View marginTop={6} marginHorizontal={7} marginBottom={2} paddingTop={7} paddingBottom={1} {...(edge(t, { top: 1 }) as object)}>
                {/* An outer text whose lines are the body's (13/12.5 on 1.5), the words a run on their
                    baseline — and it WRAPS in a narrow column ("…any Anthropic" / "model"); held to one
                    line it was cut with an ellipsis and every row under it stood a line high. */}
                <Txt spec={{ voice: "app", scale: 13 / 12.5 }}>
                  <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: "tok-hint" }}>{`also by id — any ${VENDOR_NAMES[borrows ?? ""] ?? borrows} model`}</Txt>
                </Txt>
              </View>
            ) : null}
            {leaves.length === 0 && ROUTE_BORROWS[route] === undefined ? (
              <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.5, color: "tok-hint" }} marginTop={7} maxWidth={320}>
                this route picks its own model
              </Txt>
            ) : (
              borrowed.map((m) => (
                <ColRow key={m.id} on={m.id === current} live={m.id === current} onPress={() => onPick(m.id)}>
                  {(lit) => (
                    <>
                      <Tick on={m.id === current} />
                      {leafName(m.id, lit)}
                      <ModelWindow route={route} model={m.id} />
                    </>
                  )}
                </ColRow>
              ))
            )}
          </>,
        )}
      </View>
    </>
  );
}

/**
 * `BucketPicker`: the Permissions head's bucket — its folder and name, opening the hierarchy of
 * buckets, each with what it holds and the layer that defines it.
 *
 *   the bucket's button         row, centred, gap 4, margin −1 −5, padding 1 5, radius 6, --text 600
 *                               (hovered or open --text 7%); the folder 12
 *   its menu                    under it, from its start, at least 320
 *   a row's layer               6 in, padding 0 5, round, --panel-2, app 500 9.5/12.5 on 1.5
 */
export function BucketPicker({ buckets, bucket, onPick }: { buckets: readonly PermissionSetBucket[]; bucket: string; onPick: (path: string) => void }): JSX.Element {
  const t = useTokens();
  const [ref, measure] = useAnchorRect();
  const [at, setAt] = useState<FloatRect | null>(null);
  return (
    <RNView ref={ref} collapsable={false} style={{ flexShrink: 0, ...NO_STACK } as never}>
      <Press
        onPress={() => (at !== null ? setAt(null) : measure(setAt))}
        title="Which bucket of permission sets these rows are"
        flexDirection="row"
        alignItems="center"
        gap={4}
        marginVertical={-1}
        marginHorizontal={-5}
        paddingVertical={1}
        paddingHorizontal={5}
        borderRadius={6}
        box={({ hovered }) => ({ backgroundColor: hovered || at !== null ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
      >
        <Icon name="folder" size={12} color={String(t.v("tok-hint"))} />
        <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 600, color: "text" }}>{bucket}</Txt>
        <More weight={600} />
      </Press>
      {at !== null ? (
        <SubMenu anchor={at} align="start" minWidth={320} onClose={() => setAt(null)}>
          {buckets.map((row) => (
            <SubRow
              key={row.path}
              on={row.path === bucket}
              paddingLeft={7 + 16 * row.depth}
              onPress={() => {
                onPick(row.path);
                setAt(null);
              }}
            >
              {(lit) => (
                <>
                  <Tick on={row.path === bucket} />
                  <Icon name="folder" size={14} color={String(t.v("tok-hint"))} />
                  <View flexDirection="column" gap={1} minWidth={0} flexShrink={1}>
                    <Txt spec={{ ...NAME, color: lit ? "text" : "dim" }} ellip>
                      {row.name}{" "}
                      <Txt spec={{ voice: "app", scale: 9.5 / 12.5, weight: 500, lineHeight: 1.5, color: "tok-hint" }} marginLeft={6} paddingHorizontal={5} borderRadius={999} backgroundColor={t.v("panel-2") as never}>
                        {PERMISSION_SET_LAYER_LABELS[row.layer]}
                      </Txt>
                    </Txt>
                    <Txt spec={HINT} ellip>
                      {row.hint}
                    </Txt>
                  </View>
                </>
              )}
            </SubRow>
          ))}
        </SubMenu>
      ) : null}
    </RNView>
  );
}

/** A menu under a card's head: column, gap 1, padding 4, 1px --line, radius 9, --panel, a 0 10 28 shadow at 28%. */
export function SubMenu({ anchor, align, minWidth, padding = 4, gap = 1, onClose, children }: { anchor: FloatRect; align: "start" | "end"; minWidth: number; padding?: number; gap?: number; onClose: () => void; children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <MenuLayer onClose={onClose}>
      <Float anchor={anchor} side="below" align={align} flexDirection="column" gap={gap} minWidth={minWidth} padding={padding} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={9} backgroundColor={t.v("panel") as never} {...({ boxShadow: "0px 10px 28px rgba(0, 0, 0, 0.28)" } as object)}>
        {children}
      </Float>
    </MenuLayer>
  );
}

/** A `SubMenu` row: gap 8, padding 5 7, radius 7; hovered --text 7%, in force --accent 13%. */
function SubRow({ on, paddingLeft = 7, onPress, children }: { on: boolean; paddingLeft?: number; onPress: () => void; children: (lit: boolean) => ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      flexDirection="row"
      alignItems="center"
      gap={8}
      width="100%"
      minWidth={0}
      paddingVertical={5}
      paddingRight={7}
      paddingLeft={paddingLeft}
      borderRadius={7}
      box={({ hovered }) => ({ backgroundColor: on ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
    >
      {({ hovered }) => children(on || hovered)}
    </Press>
  );
}

/**
 * `KeepPermissionSet`: `+` — keep the map on the cards as a NEW permission set in this bucket, asked
 * through the schema form (a name, and where it goes).
 *
 *   the `+`             padding 0 7, round, --panel-2, app 11.5/12.5 on 1.5, --dim; ready --accent 13%
 *                       and --accent; not ready at .45
 *   its menu            gap 7, at least 270, padding 9; the foot's buttons padding 4 13, Add --accent
 */
export function KeepPermissionSet({ bucket, ready, layers, onKeep }: { bucket: string; ready: boolean; layers: readonly WritableLayer[]; onKeep: (name: string, layer: WritableLayer) => Promise<void> }): JSX.Element {
  const t = useTokens();
  const [ref, measure] = useAnchorRect();
  const [at, setAt] = useState<FloatRect | null>(null);
  const [draft, setDraft] = useState<{ name?: string; where?: string }>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const where = layers.map((layer) => KEEP_WHERE[layer]);
  const schema: Schema = {
    type: "object",
    properties: { name: { type: "string", title: "name", minLength: 1 }, where: { type: "string", title: "where", enum: where, default: where[0] } },
    required: ["name", "where"],
  };
  const add = (): void => {
    const name = (draft.name ?? "").trim();
    const layer = layers.find((candidate) => KEEP_WHERE[candidate] === (draft.where ?? where[0]));
    const wrong = permissionSetNameProblem(name) ?? (layer === undefined ? "pick where it goes" : undefined);
    if (wrong !== undefined || layer === undefined) {
      setProblem(wrong ?? null);
      return;
    }
    setSaving(true);
    setProblem(null);
    void onKeep(name, layer).then(
      () => {
        setSaving(false);
        setDraft({});
        setAt(null);
      },
      (e: unknown) => {
        setSaving(false);
        setProblem(e instanceof Error ? e.message : String(e));
      },
    );
  };
  return (
    <RNView ref={ref} collapsable={false} style={{ flexShrink: 0, ...NO_STACK } as never}>
      <Press
        onPress={() => (at !== null ? setAt(null) : measure(setAt))}
        disabled={!ready}
        title={ready ? `Keep these tools and modes as a new permission set in ${bucket}` : "These tools and modes are already a permission set here"}
        paddingHorizontal={7}
        borderRadius={999}
        opacity={ready ? 1 : 0.45}
        backgroundColor={(ready ? t.mix(t.v("accent"), 13, "transparent") : t.v("panel-2")) as never}
      >
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: ready ? "accent" : "dim" }}>+</Txt>
      </Press>
      {at !== null && ready ? (
        <SubMenu anchor={at} align="end" minWidth={270} padding={9} gap={7} onClose={() => setAt(null)}>
          <Txt spec={HINT}>
            Keep these tools and modes as a permission set in <Txt spec={{ ...HINT, weight: 700 }}>{bucket}</Txt>
          </Txt>
          <SchemaForm schema={schema} value={{ where: where[0], ...draft }} onChange={(next) => setDraft((next ?? {}) as { name?: string; where?: string })} ctx={{ path: "", hidePaths: true, disabled: saving }} />
          {problem !== null ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }} maxWidth={300}>{problem}</Txt> : null}
          <View flexDirection="row" alignItems="center" justifyContent="flex-end" gap={8}>
            <Press onPress={add} disabled={saving} paddingVertical={4} paddingHorizontal={13} borderRadius={7} backgroundColor={t.v("accent") as never} {...(saving ? { opacity: 0.5 } : {})}>
              <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600, color: "#fff" }}>Add</Txt>
            </Press>
          </View>
        </SubMenu>
      ) : null}
    </RNView>
  );
}


