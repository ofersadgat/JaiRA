import { useRef, useState, type JSX, type ReactNode } from "react";
import { Platform, TextInput, View as RNView, useWindowDimensions } from "react-native";
import { View, isWeb } from "@tamagui/core";
import {
  REASONING_EFFORTS,
  contextFill,
  declOfPermissionSet,
  formatTokens,
  isSpent,
  parsePermissionSet,
  permissionSetGlyph,
  permissionSetHint,
  permissionSetLabel,
  toneOfContext,
  type ChatPlanView,
  type ChatSettings,
  type ContextReading,
  type PermissionSet,
  type ReasoningEffort,
  type SavePermissionSetRequest,
  type WritableLayer,
} from "@jaira/shared/browser";
import { fileFromText, mentionAt, permissionsHintOf, withFiles, withMention, type ComposerFile } from "@jaira/ui/composerCards";
import { useKeptDraft } from "@jaira/ui/composerDrafts";
import { canSendOf, chipValuesOf, composerFactsOf, routeOf, sendTitleOf } from "@jaira/ui/composerModel";
import type { Parked } from "@jaira/ui/composerPermissionSet";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { accountFor, useLimits, useNow, useUsageFigures } from "@jaira/ui/limitsStore";
import { levelsFooter, useModelParameters } from "@jaira/ui/modelParameters";
import { modeMeta } from "@jaira/ui/permissionSetWords";
import { figureOf } from "@jaira/ui/usageFigure";
import { NO_STACK, PLAIN_SCROLLER, Press, Txt, font } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { MenuLayer } from "../MenuLayer";
import { Float } from "../floats/Float";
import { Icon, type IconName } from "../panel/Icon";
import { Svg } from "../panel/Svg";
import { INK, Ring } from "../usage/Ring";
import { BucketPicker, CardHint, ChipCard, KeepPermissionSet, Opt, Opts, RouteCascade, ThinkingBody } from "./ComposerCards";
import { ToolsBody } from "./ComposerTools";
import { Pulse } from "./Paper";
import { AccountCard, ContextCard, SpentLine } from "./UsageCards";
import { FigureFace } from "../usage/Figures";
import { BrandIcon } from "../settings/bits";

/**
 * The composer: the box a message is typed into, what it will run as, and the button that sends it.
 * What the chips say and whether Enter sends are `composerModel.ts`'s; what the cards compute is
 * `composerCards.ts`' and every edit of the map `composerPermissionSet.ts`'s; the account's figure is
 * `usageFigure.ts`'s. Typing is a native `TextInput`; Enter sends on a keyboard (Shift+Enter breaks
 * the line), the button everywhere. Each chip opens its card (`ComposerCards.tsx`,
 * `ComposerTools.tsx`), the figure the account's and the ring the context's (`UsageCards.tsx`); `@`
 * completes a project path over the box; the clip attaches files (web — a phone has no picker here
 * yet).
 *
 *   the composer      padding 10 16 14, --bg
 *   its frame         900 at most, centred, padding 1, radius 22, --line (focused: --accent 55% into
 *                     --line; a file over it: --accent) — a ring rather than a border
 *   its shell         column, radius 21, --panel (off: --panel-2)
 *   the files         row, wrapping, gap 6, padding 9 12 0; a file a pill: padding 2 4 2 7, 1px --line,
 *                     --panel-2, at most 260, app 11.5/12.5; the clip 12 --dim; × --dim (hovered --text)
 *   the text          app 13.5/12.5, line 1.55, padding 13 15 6, --text, at least 54 tall, at most
 *                     40% of the window, growing with what is typed; the placeholder --tok-hint
 *   the `@` list      over the box, its width, 4 apart: column, at most 240, padding 4, 1px --line,
 *                     radius 10, --panel, 0 8 24 rgb(0 0 0 / 18%); a path padding 4 8, radius 6, app
 *                     12/12.5 (hovered --panel-2)
 *   the foot          row, centred, gap 5, padding 5 7 7 8
 *   a chip            pill, padding 3 9, 1px transparent, gap 5, at most 210, app 11.5/12.5, --dim;
 *                     hovered --fill-ghost-hover and --text; open --fill-ghost-selected, a --line edge,
 *                     --text; overridden --accent; the icon 13, --tok-hint (overridden --accent)
 *   the figure        the account's figure: data 500 11/12, line 1, padding 2 5, radius 6, 2 in on
 *                     the left; its tone's colour (--dim for the accent tone)
 *   the meter         the context ring: 26 tall, padding 0 5, radius 13, gap 6; the ring 16
 *   the live note     row, gap 6, app 11/12.5, --accent (waiting: --dim)
 *   the clip          26 round, the paperclip 15, --dim; hovered --panel-2 and --text
 *   send              30 round, --accent, the arrow 16 in --panel; disabled --panel-2, --tok-hint, at
 *                     half opacity; stop --bad, a 10 square (radius 2) of --panel
 */
export function Composer({
  plan,
  busy,
  joinable,
  overrides,
  onOverrides,
  onSend,
  onStop,
  disabled,
  placeholder,
  value,
  onValue,
  draftKey,
  usage,
  mentions,
  readMention,
  onSavePermissionSet,
  saveLayers,
}: {
  plan: ChatPlanView | null;
  busy?: boolean;
  joinable?: boolean;
  overrides: ChatSettings;
  onOverrides: (next: ChatSettings) => void;
  onSend: (message: string) => void;
  onStop?: (() => void) | undefined;
  disabled?: string;
  placeholder?: string;
  value?: string;
  onValue?: (next: string) => void;
  draftKey?: string | undefined;
  usage?: { context: ContextReading | null | undefined; onCompact?: ((focus?: string) => void) | undefined; cost?: number | undefined } | undefined;
  /** Project paths matching a query — what `@` completes against. Absent ⇒ `@` is an ordinary character. */
  mentions?: ((query: string) => Promise<string[]>) | undefined;
  /** One mentioned file's text, for inlining. Absent ⇒ a mention stays a path. */
  readMention?: ((path: string) => Promise<string>) | undefined;
  /** Keep the map on the cards as a new permission set — the Permissions card's `+`. Absent ⇒ `+` stays dim. */
  onSavePermissionSet?: ((request: Omit<SavePermissionSetRequest, "project">) => Promise<unknown>) | undefined;
  /** Where `+` may write. */
  saveLayers?: readonly WritableLayer[] | undefined;
}): JSX.Element {
  const t = useTokens();
  const win = useWindowDimensions();
  const [own, setOwn] = useKeptDraft(value === undefined ? draftKey : undefined);
  const draft = value ?? own;
  const setDraft = (next: string): void => (onValue !== undefined ? onValue(next) : setOwn(next));
  const [focused, setFocused] = useState(false);
  const [height, setHeight] = useState(54);
  /** What is going with the message: dropped files, and mentioned ones — part of the draft. */
  const [files, setFiles] = useState<ComposerFile[]>([]);
  /** The `@` completion: what is being typed after it, where it started, and what matched. */
  const [mention, setMention] = useState<{ at: number; query: string; paths: string[] } | null>(null);
  const [caret, setCaret] = useState(0);
  /** Which bucket the Permissions rows are, once the person has picked one. Else the plan's. */
  const [picked, setPicked] = useState<string | undefined>(undefined);
  /** What an unticked tool would run under if ticked again. Never sent. */
  const [parked, setParked] = useState<Parked>({});
  const facts = composerFactsOf(plan, picked);
  const { settings, origin, offered, map, tools, buckets, bucket, rows, matched, effective, route, current, cliRoute, permissionsOrigin, toolsOrigin } = facts;
  const thinking = useModelParameters(effective.model);
  const chips = chipValuesOf(plan, facts, thinking);
  const limits = useLimits();
  const now = useNow();
  const account = accountFor(limits, route);
  const spent = account !== undefined && isSpent(account.reading, now);
  const canSend = canSendOf(disabled, busy, joinable);
  const off = disabled !== undefined;
  /** The card open, and the box it was opened from. */
  const [card, setCard] = useState<{ which: "Model" | "Thinking" | "Permissions" | "Tools" | "account" | "context"; at: FloatRect } | null>(null);
  // The `@` list stands over the box it completes into, at the box's width.
  const box = useRef<TextInput | null>(null);
  const [boxAt, setBoxAt] = useState<FloatRect | null>(null);

  const send = (): void => {
    const message = withFiles(draft.trim(), files);
    if (message === "" || !canSend) return;
    onSend(message);
    setDraft("");
    setFiles([]);
    setMention(null);
  };

  /** Watch the box for an `@`, and offer paths under the caret (`mentionAt`). */
  const track = (text: string, at: number): void => {
    if (mentions === undefined) return;
    const found = mentionAt(text, at);
    if (found === null) {
      setMention(null);
      return;
    }
    box.current?.measureInWindow((x, y, w, h) => setBoxAt({ left: x, top: y, right: x + w, bottom: y + h }));
    setMention({ at: found.at, query: found.query, paths: [] });
    void mentions(found.query).then((paths) => setMention((was) => (was !== null && was.at === found.at && was.query === found.query ? { ...was, paths } : was)));
  };
  /** Put a path in the box where the `@` was, and attach the file it names. */
  const pick = (path: string): void => {
    if (mention === null) return;
    setDraft(withMention(draft, mention, path));
    setMention(null);
    if (readMention === undefined) return;
    void readMention(path).then(
      (text) => setFiles((was) => (was.some((f) => f.name === path) ? was : [...was, { name: path, text }])),
      (e: unknown) => setFiles((was) => [...was, { name: path, note: e instanceof Error ? e.message : "could not be read" }]),
    );
  };
  /** Take files in (web: the File API reads them in the page). */
  const take = (list: FileList | null): void => {
    if (list === null) return;
    void Promise.all([...list].map(async (file) => fileFromText(file.name, file.size, file.type, file.size > 200_000 ? undefined : await file.text()))).then((taken) => setFiles((was) => [...was, ...taken]));
  };
  /** From the picker. */
  const attach = (): void => {
    if (!isWeb || typeof document === "undefined") return;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => take(input.files);
    input.click();
  };
  /** Dropped on the composer: the frame is --accent while a file is over it. */
  const [dropping, setDropping] = useState(false);
  // The WHOLE composer is the drop target: a file aimed at the box and dropped on the page behind it
  // is one Electron answers by navigating the window to it. `dragover` must be prevented or the drop
  // never fires.
  const drop = isWeb
    ? {
        onDragOver: (e: DragEvent) => {
          if (off) return;
          e.preventDefault();
          setDropping(true);
        },
        onDragLeave: () => setDropping(false),
        onDrop: (e: DragEvent) => {
          if (off) return;
          e.preventDefault();
          setDropping(false);
          take(e.dataTransfer?.files ?? null);
        },
      }
    : {};

  const set = (patch: ChatSettings): void => onOverrides({ ...overrides, ...patch });
  const clear = (key: keyof ChatSettings): void => {
    const next = { ...overrides };
    delete next[key];
    onOverrides(next);
  };
  /** Send the WHOLE map: a permission set is one statement. */
  const write = (next: PermissionSet, nextParked: Parked = parked): void => {
    setParked(nextParked);
    set({ permissionSet: declOfPermissionSet(next) });
  };
  /** Both cards reset together, because they are one setting. */
  const resetPermissionSet = (): void => {
    const next = { ...overrides };
    delete next.permissionSet;
    setParked({});
    setPicked(undefined);
    onOverrides(next);
  };
  const close = (): void => setCard(null);
  const opener = (which: NonNullable<typeof card>["which"]) => (at: FloatRect) => setCard((was) => (was?.which === which ? null : { which, at }));

  return (
    <View paddingTop={10} paddingHorizontal={16} paddingBottom={14} backgroundColor={t.v("bg") as never} {...(drop as object)}>
      <View
        width="100%"
        maxWidth={900}
        alignSelf="center"
        padding={1}
        borderRadius={22}
        backgroundColor={(dropping ? t.v("accent") : focused ? t.mix(t.v("accent"), 55, t.v("line")) : t.v("line")) as never}
      >
        {/* Positioned: painted after the conversation above it, with what else is. */}
        <View position="relative" flexDirection="column" borderRadius={21} backgroundColor={t.v(off ? "panel-2" : "panel") as never}>
          {!off ? <SpentLine route={route} /> : null}
          {files.length > 0 ? (
            <View flexDirection="row" flexWrap="wrap" gap={6} paddingTop={9} paddingHorizontal={12}>
              {files.map((file, i) => (
                <View key={`${file.name}:${i}`} flexDirection="row" alignItems="center" gap={5} maxWidth={260} paddingTop={2} paddingRight={4} paddingBottom={2} paddingLeft={7} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={999} backgroundColor={t.v("panel-2") as never} {...({ title: file.note ?? `${(file.text ?? "").length} characters` } as object)}>
                  <Icon name="clip" size={12} color={String(t.v("dim"))} />
                  <Txt spec={{ voice: "app", scale: 11.5 / 12.5 }} ellip minWidth={0} flexShrink={1}>
                    {file.name}
                  </Txt>
                  {file.note !== undefined ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{file.note}</Txt> : null}
                  <Press onPress={() => setFiles(files.filter((_, at) => at !== i))} label={`Remove ${file.name}`} paddingHorizontal={4} flexShrink={0}>
                    {({ hovered }) => <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: hovered ? "text" : "dim" }}>×</Txt>}
                  </Press>
                </View>
              ))}
            </View>
          ) : null}
          <TextInput
            ref={box}
            multiline
            value={draft}
            editable={!off}
            placeholder={disabled ?? placeholder ?? "Ask for more changes…"}
            placeholderTextColor={String(t.v("tok-hint"))}
            onChangeText={(next) => {
              setDraft(next);
              track(next, caret + (next.length - draft.length));
            }}
            onSelectionChange={(e) => {
              const at = e.nativeEvent.selection.end;
              setCaret(at);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onContentSizeChange={(e) => setHeight(e.nativeEvent.contentSize.height)}
            // Enter sends and Shift+Enter breaks the line, as every chat client does — on a keyboard. A
            // phone's return key is a newline, and the button sends. While the `@` list is open, Enter
            // takes its first path and Escape closes it.
            onKeyPress={(e) => {
              const key = e.nativeEvent as unknown as { key: string; shiftKey?: boolean };
              if (Platform.OS !== "web") return;
              if (mention !== null && mention.paths.length > 0) {
                if (key.key === "Escape") {
                  (e as unknown as { preventDefault: () => void }).preventDefault();
                  setMention(null);
                  return;
                }
                if (key.key === "Enter" && key.shiftKey !== true) {
                  (e as unknown as { preventDefault: () => void }).preventDefault();
                  pick(mention.paths[0]!);
                  return;
                }
              }
              if (key.key === "Enter" && key.shiftKey !== true) {
                (e as unknown as { preventDefault: () => void }).preventDefault();
                send();
              }
            }}
            {...(Platform.OS === "web" ? {} : { textAlignVertical: "top" as const })}
            style={{
              ...(font(t, { voice: "app", scale: 13.5 / 12.5, color: "text", lineHeight: 1.55 }) as object),
              paddingTop: 13,
              paddingHorizontal: 15,
              paddingBottom: 6,
              minHeight: 54,
              maxHeight: win.height * 0.4,
              // As tall as what is typed (`field-sizing: content`). On web the property itself: a textarea's
              // `scrollHeight` is never less than its own height, so a height fed back from it only grows.
              ...(isWeb ? {} : { height: Math.max(54, Math.min(height, win.height * 0.4)) }),
              backgroundColor: "transparent",
              borderWidth: 0,
              ...(isWeb ? { outlineStyle: "none", resize: "none", fieldSizing: "content" } : {}),
            } as never}
          />
          <View flexDirection="row" alignItems="center" gap={5} paddingTop={5} paddingRight={7} paddingBottom={7} paddingLeft={8} minWidth={0}>
            <Chip t={t} lead={<BrandIcon name={routeOf(effective.model ?? "")} size={13} ink={origin.model === "override" ? "accent" : "tok-hint"} />} label="Model" value={chips.model} own={origin.model === "override"} open={card?.which === "Model"} onOpen={opener("Model")} />
            <Allowance t={t} route={route} model={effective.model} cost={usage?.cost} open={card?.which === "account"} onOpen={opener("account")} />
            <Chip t={t} icon="think" label="Thinking" value={chips.thinking} own={origin.reasoning === "override"} open={card?.which === "Thinking"} onOpen={opener("Thinking")} />
            <Chip t={t} icon="shield" label="Permissions" value={chips.permissions} own={permissionsOrigin === "override"} open={card?.which === "Permissions"} onOpen={opener("Permissions")} />
            <Chip t={t} icon="tool" label="Tools" value={chips.tools} own={toolsOrigin === "override"} open={card?.which === "Tools"} onOpen={opener("Tools")} />
            {plan !== null && plan.unresolved.length > 0 ? (
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }} ellip minWidth={0} paddingLeft={4}>
                {plan.unresolved.map((u) => u.field).join(", ")} {plan.unresolved.length === 1 ? "is" : "are"} an expression here
              </Txt>
            ) : null}
            <View flex={1} minWidth={0} />
            {plan?.live === "steerable" || plan?.live === "busy" ? (
              <View flexDirection="row" alignItems="center" gap={6} flexShrink={0}>
                <Pulse color={plan.live === "busy" ? "dim" : "accent"} />
                <Txt spec={{ voice: "app", scale: 11 / 12.5, color: plan.live === "busy" ? "dim" : "accent" }} numberOfLines={1}>
                  {plan.live === "steerable" ? "joins this turn" : "waits for this turn"}
                </Txt>
              </View>
            ) : null}
            {usage !== undefined ? <ContextMeter t={t} context={usage.context} route={route} open={card?.which === "context"} onOpen={opener("context")} /> : null}
            <Press
              onPress={attach}
              disabled={off}
              title="Attach files"
              label="Attach files"
              width={26}
              height={26}
              flexShrink={0}
              alignItems="center"
              justifyContent="center"
              borderRadius={999}
              box={({ hovered }) => ({ backgroundColor: hovered ? t.v("panel-2") : "transparent" })}
            >
              {({ hovered }) => <Icon name="clip" size={15} color={String(t.v(hovered ? "text" : "dim"))} />}
            </Press>
            {busy === true && onStop !== undefined ? (
              <Press onPress={onStop} label="Stop" title="Stop this turn" width={30} height={30} flexShrink={0} alignItems="center" justifyContent="center" borderRadius={999} backgroundColor={t.v("bad") as never}>
                <View width={10} height={10} borderRadius={2} backgroundColor={t.v("panel") as never} />
              </Press>
            ) : null}
            {busy === true && onStop !== undefined && !canSend ? null : (
              <SendButton t={t} spent={spent} title={sendTitleOf(spent, busy)} disabled={(draft.trim() === "" && files.length === 0) || !canSend} onPress={send} />
            )}
          </View>
        </View>
      </View>
      {mention !== null && mention.paths.length > 0 && boxAt !== null ? (
        <MenuLayer onClose={() => setMention(null)}>
          <Float anchor={boxAt} side="above" align="start" offset={4} width={boxAt.right - boxAt.left} maxHeight={240} padding={4} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={10} backgroundColor={t.v("panel") as never} {...({ boxShadow: "0px 8px 24px rgba(0, 0, 0, 0.18)", overflowY: "auto" } as object)}>
            {mention.paths.slice(0, 8).map((path) => (
              <Press key={path} onPress={() => pick(path)} paddingVertical={4} paddingHorizontal={8} borderRadius={6} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("panel-2") : "transparent" })}>
                <Txt spec={{ voice: "app", scale: 12 / 12.5 }} ellip>
                  {path}
                </Txt>
              </Press>
            ))}
          </Float>
        </MenuLayer>
      ) : null}
      {card?.which === "Model" ? (
        <ChipCard anchor={card.at} label="Model" origin={origin.model} from={plan?.from} onReset={() => clear("model")} onClose={close}>
          <RouteCascade routes={plan?.available.routes ?? []} models={plan?.available.models ?? []} current={current} onPick={(model) => set({ model })} />
        </ChipCard>
      ) : null}
      {card?.which === "Thinking" ? (
        <ChipCard anchor={card.at} label="Thinking" origin={origin.reasoning} from={plan?.from} onReset={() => clear("reasoning")} onClose={close}>
          <ThinkingBody
            takes={thinking?.reasoning !== false}
            levels={thinking?.levels ?? REASONING_EFFORTS.map((level) => ({ level, description: undefined }))}
            effort={settings.reasoning?.effort}
            defaultLevel={thinking?.defaultLevel}
            footer={levelsFooter(thinking)}
            onPick={(level) => set({ reasoning: { effort: level as ReasoningEffort } })}
          />
        </ChipCard>
      ) : null}
      {card?.which === "Permissions" ? (
        <ChipCard
          anchor={card.at}
          label="Permissions"
          origin={permissionsOrigin}
          from={plan?.from}
          onReset={resetPermissionSet}
          onClose={close}
          lead={<BucketPicker buckets={buckets} bucket={bucket} onPick={setPicked} />}
          trail={
            <KeepPermissionSet
              bucket={bucket}
              ready={onSavePermissionSet !== undefined && matched === undefined && Object.keys(map.entries).length > 0}
              layers={saveLayers ?? ["project", "base"]}
              onKeep={async (name, layer) => {
                await onSavePermissionSet?.({ bucket, name, layer, permissionSet: declOfPermissionSet(map) });
                onOverrides({ ...overrides });
              }}
            />
          }
        >
          <Opts>
            {rows.map((choice) => {
              const permissionSet = parsePermissionSet(choice.decl).permissionSet;
              return <Opt key={choice.id} on={matched?.id === choice.id} icon={modeMeta(permissionSetGlyph(choice)).icon as IconName} name={permissionSetLabel(choice)} hint={permissionSetHint(choice)} onPick={() => write(permissionSet, {})} />;
            })}
          </Opts>
          <CardHint>{permissionsHintOf(rows.length, matched !== undefined, tools.length, bucket)}</CardHint>
        </ChipCard>
      ) : null}
      {card?.which === "Tools" ? (
        <ChipCard anchor={card.at} label="Tools" origin={toolsOrigin} from={plan?.from} onReset={resetPermissionSet} onClose={close}>
          <ToolsBody offered={offered} map={map} parked={parked} cliRoute={cliRoute} write={write} setParked={setParked} />
        </ChipCard>
      ) : null}
      {card?.which === "account" && account !== undefined ? <AccountCard anchor={card.at} account={account} cost={usage?.cost} others={limits.accounts.filter((a) => a.key !== account.key)} onClose={close} /> : null}
      {card?.which === "context" && usage !== undefined ? <ContextCard anchor={card.at} context={usage.context} route={route} busy={busy} onCompact={usage.onCompact} onClose={close} /> : null}
    </View>
  );
}

/** Measure a chip's box in the window and hand it to what opens from it. */
function useOpener(onOpen: (at: FloatRect) => void): [React.MutableRefObject<RNView | null>, () => void] {
  const ref = useRef<RNView | null>(null);
  return [ref, () => ref.current?.measureInWindow((x, y, w, h) => onOpen({ left: x, top: y, right: x + w, bottom: y + h }))];
}

/** A chip: one question, its icon and its answer; open, its card's ground and edge. */
function Chip({ t, icon, lead, label, value, own, open, onOpen }: { t: Tokens; icon?: IconName; lead?: ReactNode; label: string; value: string; own: boolean; open: boolean; onOpen: (at: FloatRect) => void }): JSX.Element {
  const [ref, press] = useOpener(onOpen);
  return (
    // The wrap gives way (`minWidth: 0`); on web the chip in it does not: squeezed, the chips keep their
    // words and run over one another, which is what the reference pictures hold (`pair.mts`). A phone,
    // which is always narrow, cuts each chip's words instead.
    <RNView ref={ref} collapsable={false} style={{ minWidth: 0, flexShrink: 1, maxWidth: 210, ...NO_STACK, ...(Platform.OS === "web" ? { alignItems: "flex-start" } : {}) } as never}>
    <Press
      onPress={press}
      title={`${label}: ${value}`}
      label={label}
      {...({ "aria-expanded": open } as object)}
      minWidth={0}
      flexShrink={Platform.OS === "web" ? 0 : 1}
      maxWidth={210}
      flexDirection="row"
      alignItems="center"
      gap={5}
      paddingVertical={3}
      paddingHorizontal={9}
      borderRadius={999}
      borderWidth={1}
      borderStyle="solid"
      box={({ hovered }) => ({ backgroundColor: open ? t.v("fill-ghost-selected") : hovered ? t.v("fill-ghost-hover") : "transparent", borderColor: open ? t.v("line") : "transparent" })}
    >
      {({ hovered }) => (
        <>
          {lead ?? (icon !== undefined ? <Icon name={icon} size={13} color={String(t.v(own ? "accent" : "tok-hint"))} /> : null)}
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: own ? "accent" : hovered || open ? "text" : "dim" }} ellip minWidth={0} flexShrink={1}>
            {value}
          </Txt>
        </>
      )}
    </Press>
    </RNView>
  );
}

/** The account's figure after the model chip — as a number, a ring, or both. */
function Allowance({ t, route, model, cost, open, onOpen }: { t: Tokens; route: string | undefined; model: string | undefined; cost: number | undefined; open: boolean; onOpen: (at: FloatRect) => void }): JSX.Element | null {
  const [ref, press] = useOpener(onOpen);
  const limits = useLimits();
  const mode = useUsageFigures();
  const now = useNow();
  const account = accountFor(limits, route);
  if (account === undefined || mode === "off") return null;
  const figure = figureOf(account, { model, cost, now });
  // The accent tone's number is --dim here, not `INK`'s --text — but money's is --text again.
  const ink = figure.tone === "accent" ? (figure.money ? "text" : "dim") : INK[figure.tone];
  const face = { voice: "data" as const, scale: 11 / 12, weight: 500, color: ink, tabular: true, lineHeight: 1 };
  // The wrap is one line of the body's type tall (13/12.5 at 1.5: 19.5), the button 2.67 below its top —
  // where an inline button sits on that line's baseline (measured) — and it is the WRAP the row centres.
  const line = Number(t.scaled("size-app", (13 / 12.5) * 1.5));
  return (
    <View flexShrink={0} position="relative" marginLeft={-2} {...(Number.isFinite(line) ? { height: line } : {})}>
    <RNView ref={ref} collapsable={false} style={{ marginTop: 2.67, ...PLAIN_SCROLLER } as never}>
    <Press
      onPress={press}
      title={figure.title}
      flexShrink={0}
      
      flexDirection="row"
      alignItems="center"
      gap={5}
      paddingVertical={2}
      paddingHorizontal={5}
      borderRadius={6}
      box={({ hovered }) => ({ backgroundColor: hovered || open ? t.v("fill-ghost-hover") : "transparent" })}
    >
      <FigureFace t={t} figure={figure} mode={mode} text={<Txt spec={face}>{figure.text}</Txt>} />
    </Press>
    </RNView>
    </View>
  );
}

/** `ContextMeter`: how full the conversation is — the ring, and its number from 80%. */
function ContextMeter({ t, context, route, open, onOpen }: { t: Tokens; context: ContextReading | null | undefined; route: string | undefined; open: boolean; onOpen: (at: FloatRect) => void }): JSX.Element {
  const [ref, press] = useOpener(onOpen);
  const fill = context ? contextFill(context, route) : null;
  const tone = context ? toneOfContext(fill) : "none";
  const text = context === null || context === undefined ? null : fill === null ? formatTokens(context.used, true) : fill >= 80 ? `${Math.round(fill)}%` : null;
  const title =
    context === null || context === undefined
      ? "No reading yet — it fills after the first reply"
      : fill === null
        ? `This conversation holds ${formatTokens(context.used)} tokens`
        : `This conversation: ${Math.round(fill)}% of the context (${formatTokens(context.used)} of ${formatTokens(context.window ?? 0)} tokens)`;
  // The wrap is 26.5 tall, the 26px button at its top — an inline button on its line's baseline, with
  // half a pixel of the line's descent under it — and it is the wrap the row centres.
  return (
    <View flexShrink={0} position="relative" height={26.5}>
    <RNView ref={ref} collapsable={false} style={PLAIN_SCROLLER as never}>
    <Press
      onPress={press}
      title={title}
      flexShrink={0}
      height={26}
      flexDirection="row"
      alignItems="center"
      gap={6}
      paddingHorizontal={5}
      borderRadius={13}
      box={({ hovered }) => ({ backgroundColor: open ? t.v("fill-ghost-selected") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      <Ring t={t} pct={fill} tone={tone} size={16} />
      {text !== null ? <Txt spec={{ voice: "data", scale: 10.5 / 12, weight: 500, color: INK[tone], tabular: true, lineHeight: 1 }}>{text}</Txt> : null}
    </Press>
    </RNView>
    </View>
  );
}

/** Send: the arrow (a clock while the account has nothing left). */
function SendButton({ t, spent, title, disabled, onPress }: { t: Tokens; spent: boolean; title: string; disabled: boolean; onPress: () => void }): JSX.Element {
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      label="Send"
      title={title}
      width={30}
      height={30}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      borderRadius={999}
      opacity={disabled ? 0.5 : 1}
      backgroundColor={t.v(disabled ? "panel-2" : "accent") as never}
    >
      <Icon name={spent ? "clock" : "send"} size={16} color={String(t.v(disabled ? "tok-hint" : "panel"))} />
    </Press>
  );
}
