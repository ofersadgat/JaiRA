import { useMemo, useState, type JSX, type ReactNode } from "react";
import { PixelRatio, Platform, type LayoutChangeEvent } from "react-native";
import { View } from "@tamagui/core";
import {
  BUILTIN_FUNCTIONS,
  COMPONENT_NAMES,
  DEFAULT_SMART_PROMPT,
  SMART_FUNCTION,
  TOOL_CATEGORIES,
  functionAllowed,
  parseFunctionRule,
  toolsInCategory,
  type ConfigLayer,
  type ConfigView,
  type PermissionSetsView,
} from "@jaira/shared/browser";
import { configWriter, presetNamesOf, type Writer } from "@jaira/ui/configWriter";
import {
  DEFAULTS_BLOCK,
  WORKFLOW_FUNCTION_WHAT,
  cellOf,
  columnsOf,
  commandSubjectsOf,
  defaultsSchemaOf,
  defaultsSummary,
  isSubRow,
  modeClass,
  rulesWords,
  runnerSubjectsOf,
  showsDefaultPrompt,
  usersOf,
  valueAt,
  withPresetSuggestions,
  type SetColumn,
} from "@jaira/ui/functionsModel";
import { permissionSetLayersOf } from "@jaira/ui/permissionSetsHost";
import { Press, Txt, edge, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { Icon } from "../panel/Icon";
import { Disclosure } from "../form/Field";
import { FormInput } from "../form/inputs";
import { SchemaForm } from "../form/SchemaForm";
import { Hint } from "./bits";
import { Button } from "./Button";
import { SelectInput } from "./fields";
import { SettingsSection } from "./SettingsPage";

/**
 * `functionsPane.tsx`'s `FunctionsSections`, universal (decision 0015): every function a run can call —
 * the table of what each permission set gives a function an agent calls, and the list of the functions a
 * workflow calls with whether a run may reach them. What each row, column and cell says is
 * `functionsModel.ts`'s. The table is an HTML table on the desktop (auto layout, 100% wide): here its
 * columns are measured first, each as wide as its widest cell, and the room left over shared out in
 * proportion, as Chromium's auto table layout does.
 *
 *   .fx-table            app 11.5/12.5; every cell padding 4 7, a --line under it, centred, one line
 *   thead th             --panel-2, --dim, 500 at 10.5/12.5, to the bottom; a bucket's name data 600 --text
 *   .fx-bucket-start     a --line on its left
 *   .fx-group th         --panel-2, --dim, 600 at 9.5/12.5, 0.1em, upper, left, 7 above
 *   .fx-fn-button        500, --text; a command's 16 in; `.fx-what` --dim at 400, 8 after
 *   .fx-defaults         left, --dim, 10.5/12.5
 *   .fx-cell             at least 44, padding 0 7, round, 10.5/12.5 on 1.6, --text on --panel-3; allow --ok
 *                        on --tint-ok, deny --bad on --tint-bad, a function --accent on --tint-accent, none
 *                        --rule on nothing; here, ringed 1.5 --warn inside
 *   .fx-row.open         --tint-accent
 *   .fx-list-head        grid: minmax(110px, auto) 1fr auto auto 14, centred, gap 12, padding 9 16
 *   .fx-avail            10.5/12.5, padding 0 7, round, line 1.6; yes --ok on --tint-ok, no --bad on --tint-bad
 */
export function FunctionsSections({
  data,
  layer,
  config,
  busy,
  onSave,
  agents,
  rules,
  onRules,
  onOpenSet,
}: {
  data: PermissionSetsView | null;
  layer: ConfigLayer;
  config: ConfigView | null;
  busy: boolean;
  onSave: (layer: ConfigLayer, doc: unknown, written?: readonly string[]) => void;
  agents: string[];
  rules: string[] | undefined;
  onRules: (next: string[] | undefined) => void;
  onOpenSet: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const columns = useMemo(() => columnsOf(data, data === null ? "base" : permissionSetLayersOf(layer, data.layers).reads), [data, layer]);
  const commands = useMemo(() => commandSubjectsOf(columns), [columns]);
  const runners = useMemo(() => runnerSubjectsOf(columns), [columns]);
  const toggle = (name: string): void => setOpen((current) => (current === name ? null : name));
  const writer = config !== null ? configWriter(config, layer, busy, onSave) : null;
  const detail = (name: string): JSX.Element => <FunctionDetail name={name} columns={columns} writer={writer} onOpenSet={onOpenSet} />;
  const workflowFunctions = [SMART_FUNCTION, ...COMPONENT_NAMES, ...agents];

  const rows: TableRow[] = [];
  for (const category of TOOL_CATEGORIES) {
    const tools = toolsInCategory(category.id).map((spec) => spec.name);
    const names = [...tools, ...(category.id === "execution" ? [...commands, ...runners, "script"] : [])];
    if (names.length === 0) continue;
    rows.push({ kind: "group", label: category.label });
    for (const name of names) rows.push({ kind: "fn", name, sub: isSubRow(name), defaults: defaultsSummary(name, writer) });
  }
  rows.push({ kind: "group", label: "Everything not listed" }, { kind: "fn", name: "other", sub: false, defaults: "—", what: "an agent's own tools with no equal here, and MCP" });

  return (
    <>
      <SettingsSection
        id="functions"
        title="Functions an agent calls"
        info="Each row is a tool an agent may call, and each column a permission set this layer can see; the cell is the mode that set gives it. A dash is a set that does not offer the tool — a call to it falls to that set's other line. An outlined cell is in a set this layer states. A row opens the function; a cell opens that set above."
        wide
      >
        {data === null ? <Hint card>Reading the permission sets…</Hint> : <FunctionsTable columns={columns} rows={rows} open={open} onToggle={toggle} onOpenSet={onOpenSet} detail={detail} />}
      </SettingsSection>
      <SettingsSection
        id="workflow-functions"
        title="Functions a workflow calls"
        info="Gates, the permission judge, and an agent reached as a function. A workflow state calls these, not an agent, so no permission set lists them; what decides whether a run may call one is the default executor's rules, below."
      >
        <View flexDirection="column" gap={2}>
          {workflowFunctions.map((name, i) => {
            const isAgent = agents.includes(name) && !(COMPONENT_NAMES as readonly string[]).includes(name);
            return (
              <WorkflowFunction
                key={name}
                first={i === 0}
                name={name}
                what={isAgent ? "agent — delegate a state to that runtime" : (WORKFLOW_FUNCTION_WHAT[name] ?? "")}
                defaults={defaultsSummary(name, writer)}
                available={functionAllowed(rules, name)}
                open={open === name}
                onToggle={() => toggle(name)}
                detail={detail}
              />
            );
          })}
        </View>
        <FxRules>
          <Disclosure summary="Which of them a run may reach" desc={rulesWords(rules)}>
            <Hint>Walked in order, last match winning. Start with a baseline — everything or nothing — then add or subtract; the available column above is what they come to.</Hint>
            <RuleList
              rules={rules ?? []}
              known={[...BUILTIN_FUNCTIONS, ...agents.map((name) => ({ name, what: "agent — delegate this state to that runtime" }))]}
              disabled={busy}
              onChange={(next) => onRules(next.length > 0 ? next : undefined)}
            />
          </Disclosure>
        </FxRules>
      </SettingsSection>
    </>
  );
}

/** `.fx-rules`: padding 4 16 12, a --line above — the card's own rule between its children, the same border. */
function FxRules({ children }: { children: ReactNode }): JSX.Element {
  return (
    <View paddingTop={4} paddingHorizontal={16} paddingBottom={12}>
      {children}
    </View>
  );
}

type TableRow = { kind: "group"; label: string } | { kind: "fn"; name: string; sub: boolean; defaults: string; what?: string };

const CELL = { voice: "app", scale: 11.5 / 12.5 } as const;
/** A sub-row (`tr.sub`) takes the global `.sub` rule's size, 11/12.5, for what inherits it. */
const SUB = { voice: "app", scale: 11 / 12.5 } as const;

/**
 * The line box of a cell holding one inline-block (`.fx-cell`, 10.5/12.5 on 1.6) on the row's strut
 * (its size, on 1.5), as Chromium lays it out — in DEVICE pixels: each font's ascent and descent
 * rounded to whole ones (DM Sans: 0.992 and 0.31 em), the line height floored to a 64th, the half
 * leading above floored to a whole one, and the two baselines aligned. It returns the line's height and
 * the block's top in it, in CSS pixels, or nothing where the sizes are CSS (the desktop's own page).
 * Measured: a row's 17.25 and a sub-row's 17.1667, the pill at the line's top in both.
 */
function cellLine(t: ReturnType<typeof useTokens>, strutScale: number, dpr: number): { line: number; top: number } | undefined {
  const strut = t.scaled("size-app", strutScale);
  const box = t.scaled("size-app", 10.5 / 12.5);
  if (typeof strut !== "number" || typeof box !== "number") return undefined;
  const metrics = (css: number, lineHeight: number): { up: number; down: number } => {
    const size = css * dpr;
    const [ascent, descent] = [Math.round(size * 0.992), Math.round(size * 0.31)];
    const line = Math.floor(css * lineHeight * dpr * 64) / 64;
    const up = ascent + Math.floor((line - ascent - descent) / 2);
    return { up, down: line - up };
  };
  const [s, b] = [metrics(strut, 1.5), metrics(box, 1.6)];
  const up = Math.max(s.up, b.up);
  return { line: (up + Math.max(s.down, b.down)) / dpr, top: (up - b.up) / dpr };
}

/** One cell's contents, as the table and its measuring pass both draw it. */
function HeadCell({ column, first }: { column: SetColumn; first: boolean }): JSX.Element {
  return (
    <View alignItems="center">
      {/* The bucket is a block on the th's 1.5 line. */}
      {first ? (
        <Txt spec={{ voice: "data", scale: (10.5 / 12.5) * (12.5 / 12), weight: 600, lineHeight: 1.5 }}>
          {column.bucket}
        </Txt>
      ) : null}
      <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 500, color: "dim" }} numberOfLines={1}>
        {column.name}
      </Txt>
    </View>
  );
}

function Cell({ column, name, onOpenSet }: { column: SetColumn; name: string; onOpenSet: (id: string) => void }): JSX.Element {
  const t = useTokens();
  const { mode, text, title } = cellOf(column, name);
  const kind = modeClass(mode);
  const ground = kind === "allow" ? t.v("tint-ok") : kind === "deny" ? t.v("tint-bad") : kind === "fn" ? t.v("tint-accent") : kind === "none" ? "transparent" : t.v("panel-3");
  const ink = kind === "allow" ? "ok" : kind === "deny" ? "bad" : kind === "fn" ? "accent" : kind === "none" ? "rule" : "text";
  return (
    <Press
      onPress={() => onOpenSet(column.id)}
      title={title}
      minWidth={44}
      alignSelf="center"
      alignItems="center"
      justifyContent="center"
      paddingHorizontal={7}
      borderRadius={999}
      backgroundColor={ground as never}
      {...(column.here && mode !== undefined ? ({ boxShadow: `inset 0 0 0 1.5px ${String(t.v("warn"))}` } as object) : {})}
    >
      <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.6, color: ink }} numberOfLines={1} textAlign="center">
        {text}
      </Txt>
    </Press>
  );
}

function FnName({ name, sub, what, onToggle, open }: { name: string; sub: boolean; what?: string | undefined; onToggle: () => void; open: boolean }): JSX.Element {
  return (
    <Press onPress={onToggle} {...({ "aria-expanded": open } as object)} flexDirection="row" alignItems="baseline" gap={8} alignSelf="flex-start" {...(sub ? { paddingLeft: 16 } : {})}>
      {({ hovered }) => (
        <>
          <Txt spec={{ ...(sub ? SUB : CELL), weight: 500, color: hovered ? "accent" : "text" }} numberOfLines={1}>
            {name}
          </Txt>
          {what !== undefined ? (
            <Txt spec={{ ...(sub ? SUB : CELL), color: "dim" }} numberOfLines={1}>
              {what}
            </Txt>
          ) : null}
        </>
      )}
    </Press>
  );
}

/**
 * Half of a collapsed border (`border-collapse: collapse`): a cell's 1px rule is drawn centred on the
 * line between it and its neighbour, half in each, so each cell's box reaches half-way into the rules
 * on its sides and the table's last rule stands half outside it.
 */
const HALF = 1 / 3;

/** A collapsed rule: centred on its cell's bottom (or left) edge, over whatever the next row paints. */
function CollapsedRule({ side }: { side: "bottom" | "left" }): JSX.Element {
  const t = useTokens();
  return side === "bottom" ? (
    <View position="absolute" left={0} right={0} bottom={-HALF} height={0} zIndex={1} pointerEvents="none" {...(edge(t, { top: 1 }) as object)} />
  ) : (
    <View position="absolute" top={0} bottom={0} left={-HALF} width={0} zIndex={1} pointerEvents="none" {...(edge(t, { left: 1 }) as object)} />
  );
}

/**
 * The table: measured once (each column as wide as its widest cell, every cell drawn where nothing
 * sees it), then laid out row by row at those widths, the room left over shared in proportion. Its
 * rules are collapsed borders (`CollapsedRule`, `HALF`), as `.fx-table`'s are.
 */
function FunctionsTable({ columns, rows, open, onToggle, onOpenSet, detail }: { columns: SetColumn[]; rows: TableRow[]; open: string | null; onToggle: (name: string) => void; onOpenSet: (id: string) => void; detail: (name: string) => JSX.Element }): JSX.Element {
  const t = useTokens();
  const count = 2 + columns.length;
  const [natural, setNatural] = useState<ReadonlyArray<number | undefined>>([]);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const starts = columns.map((column, i) => i === 0 || columns[i - 1]!.bucket !== column.bucket);
  const fns = rows.filter((row): row is Extract<TableRow, { kind: "fn" }> => row.kind === "fn");
  const measured = natural.length === count && natural.every((w) => w !== undefined) && width !== undefined;
  const widths = measured ? shareOut(natural as number[], width) : undefined;
  /** Whether column `i` starts a permission set's bucket (`.fx-bucket-start`, a rule on its left). */
  const startsAt = (i: number): boolean => i >= 2 && starts[i - 2] === true;
  /** A cell's padding (`th, td`: 4 7), and the halves of the rules on its sides. */
  const padOf = (i: number, head = false): object => ({
    paddingTop: 4 + (head ? 0 : HALF),
    paddingBottom: 4 + HALF,
    paddingLeft: 7 + (startsAt(i) ? HALF : 0),
    paddingRight: 7 + (startsAt(i + 1) ? HALF : 0),
  });
  // The device's pixels. In a browser (the `/rn` page) the ones Chromium lays the page out in — the
  // studio's 1.5, a 1px border drawn ⅔ wide — which `devicePixelRatio` there does not report (it reads 2).
  const dpr = Platform.OS === "web" ? 1.5 : PixelRatio.get();
  const rowLine = cellLine(t, 11.5 / 12.5, dpr);
  const subLine = cellLine(t, 11 / 12.5, dpr);
  /** A cell's own rules: the one under it, and a bucket's on its left. */
  const rules = (i: number): JSX.Element => (
    <>
      <CollapsedRule side="bottom" />
      {startsAt(i) ? <CollapsedRule side="left" /> : null}
    </>
  );
  const probe = (i: number, cells: ReactNode[]): JSX.Element => (
    <View
      key={i}
      position="absolute"
      opacity={0}
      pointerEvents="none"
      alignItems="flex-start"
      onLayout={(e: LayoutChangeEvent) => {
        const w = e.nativeEvent.layout.width;
        setNatural((prev) => {
          if (prev[i] === w) return prev;
          const next = [...prev];
          next.length = count;
          next[i] = w;
          return next;
        });
      }}
    >
      {cells.map((cell, k) => (
        <View key={k} {...padOf(i)}>
          {cell}
        </View>
      ))}
    </View>
  );
  return (
    // The last row's rule is half outside the table: the table's box holds it.
    <View overflow="hidden" paddingBottom={HALF} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      {/* The measuring pass: each column's cells in a column of their own, as wide as the widest. */}
      <View height={0} overflow="hidden">
        {probe(0, [<Txt key="h" spec={{ voice: "app", scale: 10.5 / 12.5, weight: 500 }}>Function</Txt>, ...fns.map((row) => <FnName key={row.name} name={row.name} sub={row.sub} what={row.what} open={false} onToggle={() => undefined} />)])}
        {probe(1, [<Txt key="h" spec={{ voice: "app", scale: 10.5 / 12.5, weight: 500 }}>Defaults</Txt>, ...fns.map((row) => <Txt key={row.name} spec={{ voice: "app", scale: 10.5 / 12.5 }}>{row.defaults}</Txt>)])}
        {columns.map((column, c) => probe(2 + c, [<HeadCell key="h" column={column} first={starts[c]!} />, ...fns.map((row) => <Cell key={row.name} column={column} name={row.name} onOpenSet={() => undefined} />)]))}
      </View>
      {widths === undefined ? null : (
        <View flexDirection="column">
          <View flexDirection="row" alignItems="stretch">
            {/* `th.fx-fn` is left-aligned; the Defaults head keeps the table's centre (only its cells are left). */}
            {["Function", "Defaults"].map((word, i) => (
              <View key={word} width={widths[i]} {...padOf(i, true)} position="relative" backgroundColor={t.v("panel-2") as never} justifyContent="flex-end" alignItems={i === 0 ? "flex-start" : "center"}>
                <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 500, color: "dim" }}>{word}</Txt>
                {rules(i)}
              </View>
            ))}
            {columns.map((column, c) => (
              <View key={column.id} width={widths[2 + c]} {...padOf(2 + c, true)} position="relative" backgroundColor={t.v("panel-2") as never} justifyContent="flex-end">
                <HeadCell column={column} first={starts[c]!} />
                {rules(2 + c)}
              </View>
            ))}
          </View>
          {rows.map((row, r) =>
            row.kind === "group" ? (
              <View key={`g${r}`} position="relative" paddingTop={7 + HALF} paddingBottom={4 + HALF} paddingHorizontal={7} backgroundColor={t.v("panel-2") as never}>
                <Txt spec={{ voice: "app", scale: 9.5 / 12.5, weight: 600, ls: 0.1, upper: true, color: "dim" }}>{row.label}</Txt>
                <CollapsedRule side="bottom" />
              </View>
            ) : (
              <View key={row.name}>
                <View flexDirection="row" alignItems="stretch" backgroundColor={open === row.name ? (t.v("tint-accent") as never) : "transparent"}>
                  <View width={widths[0]} {...padOf(0)} position="relative" justifyContent="center">
                    <FnName name={row.name} sub={row.sub} what={row.what} open={open === row.name} onToggle={() => onToggle(row.name)} />
                    {rules(0)}
                  </View>
                  <View width={widths[1]} {...padOf(1)} position="relative" justifyContent="center">
                    <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: "dim" }} numberOfLines={1}>
                      {row.defaults}
                    </Txt>
                    {rules(1)}
                  </View>
                  {columns.map((column, c) => {
                    const line = row.sub ? subLine : rowLine;
                    return (
                      <View key={column.id} width={widths[2 + c]} {...padOf(2 + c)} position="relative" justifyContent="center">
                        <View {...(line !== undefined ? { height: line.line, paddingTop: line.top } : {})} alignItems="center">
                          <Cell column={column} name={row.name} onOpenSet={onOpenSet} />
                        </View>
                        {rules(2 + c)}
                      </View>
                    );
                  })}
                </View>
                {open === row.name ? (
                  <View position="relative" paddingTop={HALF} paddingBottom={HALF}>
                    {detail(row.name)}
                    <CollapsedRule side="bottom" />
                  </View>
                ) : null}
              </View>
            ),
          )}
        </View>
      )}
    </View>
  );
}

/** Chromium's auto table layout, for cells that never wrap: each column its widest, the rest in proportion. */
function shareOut(natural: readonly number[], width: number): number[] {
  const total = natural.reduce((a, b) => a + b, 0);
  if (total >= width || total === 0) return [...natural];
  return natural.map((w) => w + ((width - total) * w) / total);
}

/** A function, opened: its defaults as rows of the schema form, and every permission set that uses it. */
function FunctionDetail({ name, columns, writer, onOpenSet }: { name: string; columns: SetColumn[]; writer: Writer | null; onOpenSet: (id: string) => void }): JSX.Element {
  const t = useTokens();
  const declared = defaultsSchemaOf(name);
  const schema = name === SMART_FUNCTION && declared !== undefined && writer !== null ? withPresetSuggestions(declared, presetNamesOf(writer.effective)) : declared;
  const users = usersOf(name, columns);
  const title = (words: string): JSX.Element => <Txt spec={{ voice: "app", scale: 11.5 / 12.5, weight: 600 }}>{words}</Txt>;
  return (
    <View flexDirection="column" gap={8} paddingTop={10} paddingHorizontal={14} paddingBottom={14} maxWidth={740}>
      {schema !== undefined && writer !== null ? (
        <View>
          {title("Defaults")}
          <SchemaForm
            schema={schema}
            value={valueAt(writer.effective, `${DEFAULTS_BLOCK}.${name}`)}
            onChange={(next) => writer.set(`${DEFAULTS_BLOCK}.${name}`, next)}
            ctx={{ path: `${DEFAULTS_BLOCK}.${name}`, disabled: writer.locked, isSet: writer.stated, setAt: writer.set }}
          />
          {name === SMART_FUNCTION && showsDefaultPrompt(writer) ? (
            <View>
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>The prompt it uses now — the one JaiRA ships. The call being judged is appended as JSON.</Txt>
              <Txt
                spec={{ voice: "data", scale: 11 / 12, lineHeight: 1.55 }}
                marginTop={4}
                paddingVertical={10}
                paddingHorizontal={12}
                borderRadius={8}
                maxHeight={240}
                overflow="hidden"
                backgroundColor={t.v("panel-2") as never}
                {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
              >
                {DEFAULT_SMART_PROMPT}
              </Txt>
            </View>
          ) : null}
        </View>
      ) : (
        <Hint>{`No defaults — ${name === "other" ? "a set's other line is all there is to it" : "it takes nothing a layer could set"}.`}</Hint>
      )}
      {title("Used by")}
      {users.length === 0 ? (
        <Hint>{`No permission set this layer can see ${name === SMART_FUNCTION ? "hands a call to it" : "offers it"}.`}</Hint>
      ) : (
        <View flexDirection="column" gap={2}>
          {users.map((user) => (
            <View key={user.id} flexDirection="row" gap={10} alignItems="baseline">
              <Press onPress={() => onOpenSet(user.id)}>
                {({ hovered }) => (
                  <Txt spec={{ voice: "data", scale: 11 / 12, color: "accent" }} textDecorationLine={hovered ? "underline" : "none"}>
                    {user.id}
                  </Txt>
                )}
              </Press>
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{user.says}</Txt>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/** One function a workflow calls: its name, what it does, its defaults, whether a run may reach it. */
function WorkflowFunction({
  first,
  name,
  what,
  defaults,
  available,
  open,
  onToggle,
  detail,
}: {
  first: boolean;
  name: string;
  what: string;
  defaults: string;
  available: boolean;
  open: boolean;
  onToggle: () => void;
  detail: (name: string) => JSX.Element;
}): JSX.Element {
  const t = useTokens();
  return (
    <View {...(first ? {} : (edge(t, { top: 1 }) as object))}>
      <Press
        onPress={onToggle}
        {...({ "aria-expanded": open } as object)}
        flexDirection="row"
        alignItems="center"
        gap={12}
        paddingVertical={9}
        paddingHorizontal={16}
        box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
      >
        <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 500 }} minWidth={110} flexShrink={0}>
          {name}
        </Txt>
        <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} numberOfLines={1} flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0}>
          {what}
        </Txt>
        <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: "dim" }} flexShrink={0}>
          {defaults}
        </Txt>
        <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.6, color: available ? "ok" : "bad" }} flexShrink={0} paddingHorizontal={7} borderRadius={999} backgroundColor={t.v(available ? "tint-ok" : "tint-bad") as never}>
          {available ? "available" : "not reachable"}
        </Txt>
        <View width={14} height={14} flexShrink={0} transform={[{ rotate: open ? "0deg" : "-90deg" }]}>
          <Icon name="chevron" size={14} color={String(t.v("dim"))} />
        </View>
      </Press>
      {open ? <View {...(edge(t, { top: 1 }) as object)}>{detail(name)}</View> : null}
    </View>
  );
}

/**
 * `executorTreePane.tsx`'s `RuleList`: an ordered list of `everything` / `nothing` / `+name` / `-name`,
 * last match winning — and a row to add one.
 */
export function RuleList({ rules, known, disabled, onChange }: { rules: string[]; known: Array<{ name: string; what: string }>; disabled: boolean; onChange: (next: string[]) => void }): JSX.Element {
  const t = useTokens();
  const [sign, setSign] = useState<"+" | "-">("-");
  const [name, setName] = useState("");
  const replace = (index: number, rule: string): void => onChange(rules.map((r, i) => (i === index ? rule : r)));
  const move = (index: number, by: number): void => {
    const next = [...rules];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  const SIGNS: ReadonlyArray<readonly [string, string]> = [
    ["allow", "+"],
    ["deny", "-"],
  ];
  return (
    <View flexDirection="column" gap={8} width="100%">
      {rules.length === 0 ? <Hint>No rules — everything the workflow registers.</Hint> : null}
      <View flexDirection="column" gap={5}>
        {rules.map((rule, index) => {
          const parsed = parseFunctionRule(rule);
          const base = parsed?.kind === "everything" || parsed?.kind === "nothing";
          const kind = parsed?.kind ?? "bad";
          const ground = kind === "everything" || kind === "allow" ? t.v("tint-ok") : kind === "nothing" || kind === "deny" ? t.v("tint-bad") : kind === "bad" ? t.v("tint-warn") : t.v("panel");
          return (
            <View
              key={`${index}:${rule}`}
              flexDirection="row"
              alignItems="center"
              gap={6}
              flexWrap="wrap"
              paddingVertical={5}
              paddingHorizontal={8}
              borderRadius={lengthToken(t, "control-radius", 7)}
              backgroundColor={ground as never}
              {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
            >
              <View width={18} height={18} borderRadius={999} alignItems="center" justifyContent="center" flexShrink={0} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
                <Txt spec={{ voice: "app", scale: 10 / 12.5, color: "dim" }}>{String(index + 1)}</Txt>
              </View>
              {base ? (
                <Txt spec={{ voice: "data", scale: 1, weight: 600 }} flexGrow={1}>
                  {parsed?.kind === "everything" ? "everything" : "nothing"}
                </Txt>
              ) : (
                <>
                  <View width={86}>
                    <SelectInput fill value={parsed?.kind === "deny" ? "-" : "+"} options={SIGNS} disabled={disabled} onChange={(v) => replace(index, `${v}${parsed?.pattern ?? ""}`)} />
                  </View>
                  <View flexGrow={1} flexShrink={1} flexBasis={140} minWidth={110}>
                    <FormInput value={parsed?.pattern ?? ""} mono placeholder="name or pattern" disabled={disabled} onChange={(v) => replace(index, `${parsed?.kind === "deny" ? "-" : "+"}${v}`)} />
                  </View>
                </>
              )}
              <Button kind="ghost" disabled={disabled || index === 0} onPress={() => move(index, -1)} title="earlier">
                ↑
              </Button>
              <Button kind="ghost" disabled={disabled || index === rules.length - 1} onPress={() => move(index, 1)} title="later">
                ↓
              </Button>
              <Button kind="danger" disabled={disabled} onPress={() => onChange(rules.filter((_, i) => i !== index))}>
                Remove
              </Button>
            </View>
          );
        })}
      </View>
      <View flexDirection="row" alignItems="center" gap={6} flexWrap="wrap" paddingTop={4}>
        <Button kind="ghost" disabled={disabled} onPress={() => onChange([...rules, "everything"])}>
          + everything
        </Button>
        <Button kind="ghost" disabled={disabled} onPress={() => onChange([...rules, "nothing"])}>
          + nothing
        </Button>
        <SelectInput value={sign} options={SIGNS} disabled={disabled} onChange={(v) => setSign(v as "+" | "-")} />
        <SelectInput
          value=""
          options={[["— pick a function", ""], ...known.map((k): [string, string] => [`${k.name} — ${k.what}`, k.name])]}
          disabled={disabled}
          onChange={(v) => {
            if (v !== "") onChange([...rules, `${sign}${v}`]);
          }}
        />
        <View flexGrow={0} flexShrink={1} flexBasis={200}>
          <FormInput value={name} mono placeholder="…or type a name / pattern" disabled={disabled} onChange={setName} />
        </View>
        <Button
          disabled={disabled || name.trim().length === 0}
          onPress={() => {
            onChange([...rules, `${sign}${name.trim()}`]);
            setName("");
          }}
        >
          Add
        </Button>
      </View>
    </View>
  );
}
