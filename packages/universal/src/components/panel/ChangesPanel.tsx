import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import { Linking, ScrollView } from "react-native";
import { Text, View } from "@tamagui/core";
import { changeCountOf, ownChangesOf, type ChangeAuthor, type ChangeItem, type FileChange, type MergeRequestView, type TaskChangeLog } from "@jaira/shared/browser";
import { GROUPS, LETTER, STATE_WORDS, STEP_WORDS, baseOf, fromOf, groupFactsOf, hasAuthored, treeOf, type GroupId } from "@jaira/ui/changesModel";
import { clockOf } from "@jaira/ui/runActivityModel";
import { invoke } from "@jaira/ui/store";
import { Press, Txt, font, scrollbarProps, type FontSpec } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { Button } from "../settings/Button";
import { Switch } from "../settings/controls";
import { Icon, type IconName } from "./Icon";

/**
 * `changesPanel.tsx`'s `ChangesPanel`, universal (decision 0015): what a task changed, as the tool menu
 * groups tools — a card per group that folds from its head. The groups, their heads' words, the file
 * tree and who made each change are `changesModel.ts`'s, shared with the DOM. The rules:
 *
 *   .chg            column, flex 1 0 auto, gap 8, bled over the panel's padding (−12 −12 −18) and padded
 *                   10 12 18 on --bg; app 12.5/12.5; icons 14
 *   .chg-bar        row, centred, gap 8, padding 0 2, --dim at 11.5/12.5; the switch pushed right
 *   .chg-empty      p.empty at padding 8 2
 *   .chg-card       1px --text 7%, radius 10, --panel, 0 1 2 --text 5%
 *   .chg-head       row, centred, gap 8, padding 9 10 (5 under while open), radius 10 (10 10 0 0 open);
 *                   hover --text 3%. The fold 12 --tok-hint (−90° folded), the icon --dim, the name 600,
 *                   the sum --dim 11/12.5 ellipsed, the count data 500 10.5/12 / 1.7 on --text 7%
 *   .chg-body       padding 0 2 6
 *   .chg-folder     row, centred, gap 6, at least 24 tall, padding 2 8 2 (8 + 14 a level), radius 6;
 *                   data 11/12 / 1.4 --dim; hover --text 5%
 *   .chg-file       the same, 26 + 14 a level in, data 11.5/12 / 1.4: created --ok, deleted --bad and
 *                   struck, renamed --p1, modified icon and letter --warn; +N --ok, −N --bad; the letter
 *                   12 wide, data 700 10.5/12
 *   .chg-hunks      margin 2 6 6, padding 4 0, 1px --line, radius 6, --bg, data 10.5/12 / 1.5, scrolls
 *                   sideways, at most 320; a line padding 0 8 — added --ok 13%, removed --bad 12%,
 *                   headers --tok-hint
 *   .chg-item       16 | 1fr | auto, gap 8, top-aligned, padding 5 8: the icon (--dim, 2 down), what was
 *                   said (and its detail under it, --dim 11/12.5), when (data 10.5/12 / 1.6 --tok-hint)
 *   .chg-by         a pill: padding 0 6, --text 6%, app 500 10.5/12.5 / 1.65, --dim
 *   .chg code       data at 0.92em
 *
 * The git card (merge requests and the ladder of steps) is drawn from the same rules, less exactly: no
 * scene in the parity world has one yet. A command's parts are one run (`ShellLine`'s colouring is not
 * carried).
 */
export function ChangesPanel({ taskId, project, signal, onReview, onOpenTask }: { taskId: string; project?: string | undefined; signal: unknown; onReview?: (() => void) | undefined; onOpenTask?: ((taskId: string) => void) | undefined }): JSX.Element {
  const t = useTokens();
  const [log, setLog] = useState<TaskChangeLog | "error" | undefined>(undefined);
  const [others, setOthers] = useState(true);
  const [folded, setFolded] = useState<ReadonlySet<GroupId>>(new Set());
  useEffect(() => {
    let live = true;
    void invoke("task:changes", { taskId, ...(project !== undefined ? { project } : {}) })
      .then((next) => live && setLog(next))
      .catch(() => live && setLog("error"));
    return () => {
      live = false;
    };
  }, [taskId, project, signal]);
  const shown = useMemo(() => (log === undefined || log === "error" ? undefined : others ? log : ownChangesOf(log)), [log, others]);
  const empty = (words: string, extra: Record<string, unknown> = {}): JSX.Element => (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 13 / 12.5) as number} {...extra}>
      {words}
    </Txt>
  );
  if (log === undefined) return empty("Reading what this task changed…");
  if (log === "error") return empty("What this task changed could not be read.");
  const authored = hasAuthored(log);
  const count = changeCountOf(shown!);
  const fold = (id: GroupId): void => setFolded((was) => (was.has(id) ? new Set([...was].filter((one) => one !== id)) : new Set([...was, id])));
  const ctx: Ctx = { onOpenTask, currentTask: taskId, t };
  return (
    <View flexGrow={1} flexShrink={0} flexDirection="column" gap={8} marginTop={-12} marginHorizontal={-12} marginBottom={-18} paddingTop={10} paddingHorizontal={12} paddingBottom={18} backgroundColor={t.v("bg") as never}>
      <View flexDirection="row" alignItems="center" gap={8} paddingHorizontal={2}>
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>{count === 1 ? "1 change" : `${count} changes`}</Txt>
        {authored ? (
          <View flexDirection="row" alignItems="center" gap={8} marginLeft="auto">
            <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>Subagents &amp; subtasks</Txt>
            <Switch on={others} label="Include what subagents and subtasks changed" onChange={setOthers} />
          </View>
        ) : null}
      </View>
      {onReview !== undefined && shown!.files.length > 0 ? (
        <View flexDirection="row">
          <Button onPress={onReview}>Review these changes</Button>
        </View>
      ) : null}
      {count === 0 ? (
        <Txt spec={{ voice: "app", scale: 1, color: "dim" }} paddingVertical={8} paddingHorizontal={2} marginVertical={t.scaled("size-app", 1) as number}>
          Nothing here has changed anything yet.
        </Txt>
      ) : null}
      {GROUPS.map((group) => {
        const facts = groupFactsOf(group.id, shown!);
        if (facts === null) return null;
        const open = !folded.has(group.id);
        return (
          <View key={group.id} minWidth={0} borderWidth={1} borderStyle="solid" borderColor={t.mix(t.v("text"), 7, "transparent") as never} borderRadius={10} backgroundColor={t.v("panel") as never} {...({ boxShadow: `0px 1px 2px ${t.mix(t.v("text"), 5, "transparent")}` } as object)}>
            <Press
              onPress={() => fold(group.id)}
              {...({ "aria-expanded": open } as object)}
              flexDirection="row"
              alignItems="center"
              justifyContent="flex-start"
              gap={8}
              width="100%"
              paddingTop={9}
              paddingHorizontal={10}
              paddingBottom={open ? 5 : 9}
              {...(open ? { borderTopLeftRadius: 10, borderTopRightRadius: 10 } : { borderRadius: 10 })}
              box={({ hovered }) => (hovered ? { backgroundColor: t.mix(t.v("text"), 3, "transparent") } : {})}
            >
              <View transform={open ? [] : [{ rotate: "-90deg" }]}>
                <Icon name="chevron" size={12} color={String(t.v("tok-hint"))} />
              </View>
              <Icon name={group.icon} size={14} color={String(t.v("dim"))} />
              <Txt spec={{ voice: "app", scale: 1, weight: 600 }} flexShrink={0} numberOfLines={1}>
                {group.name}
              </Txt>
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} ellip flex={1} minWidth={0}>
                {facts.summary.kind === "files" ? (
                  <>
                    {facts.summary.added > 0 ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "ok" }}>+{facts.summary.added}</Txt> : null}{" "}
                    {facts.summary.removed > 0 ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }}>−{facts.summary.removed}</Txt> : null}
                  </>
                ) : facts.summary.kind === "branch" ? (
                  <Code t={t} base={11 / 12.5}>
                    {facts.summary.branch}
                  </Code>
                ) : (
                  facts.summary.text
                )}
              </Txt>
              <View flexShrink={0} minWidth={20} paddingHorizontal={6} borderRadius={999} backgroundColor={t.mix(t.v("text"), 7, "transparent") as never}>
                <Txt spec={{ voice: "data", scale: 10.5 / 12, weight: 500, color: "dim", lineHeight: 1.7 }} textAlign="center">
                  {facts.count}
                </Txt>
              </View>
            </Press>
            {open ? (
              <View paddingTop={0} paddingHorizontal={2} paddingBottom={6} minWidth={0}>
                {group.id === "files" ? <FileTree files={shown!.files} ctx={ctx} /> : group.id === "git" ? <GitBody git={shown!.git} ctx={ctx} /> : shown![group.id].map((item) => <ItemRow key={item.call} item={item} icon={group.icon} ctx={ctx} />)}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

interface Ctx {
  onOpenTask?: ((taskId: string) => void) | undefined;
  currentTask: string;
  t: Tokens;
}

/** `.chg code`: the data face at 0.92 of the words around it (`base`, a factor of --size-app). */
function Code({ children, t, base = 1 }: { children: ReactNode; t: Tokens; base?: number }): JSX.Element {
  // Nested in the words it sits among, so it takes their colour and line; only the face and size are its own.
  return (
    <Text fontFamily={font(t, { voice: "data", scale: 1 })["fontFamily"] as never} fontSize={t.scaled("size-app", base * 0.92) as never}>
      {children}
    </Text>
  );
}

/** `By`: who made a change — a subagent, or a task this one started (a link to it). */
function By({ by, ctx }: { by: ChangeAuthor | undefined; ctx: Ctx }): JSX.Element | null {
  if (by === undefined) return null;
  const t = ctx.t;
  const pill = (words: string, title: string, onPress?: () => void): JSX.Element => {
    const inside = (
      <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 500, color: "dim", lineHeight: 1.65 }} numberOfLines={1}>
        {words}
      </Txt>
    );
    const box = { flexShrink: 0, flexDirection: "row", alignItems: "center", paddingHorizontal: 6, borderRadius: 999, backgroundColor: t.mix(t.v("text"), 6, "transparent") } as const;
    return onPress !== undefined ? (
      <Press onPress={onPress} title={title} {...box}>
        {inside}
      </Press>
    ) : (
      <View {...box} {...({ title } as object)}>
        {inside}
      </View>
    );
  };
  if (by.kind === "subagent") return pill(`⑂ ${by.name}`, "Made by a subagent this conversation spawned");
  return ctx.onOpenTask !== undefined ? pill(`↳ ${by.name}`, "Made by a task this one started — open it", () => ctx.onOpenTask!(by.taskId)) : pill(`↳ ${by.name}`, "");
}

/** `Out`: a page outside the app, opened in the browser. */
function Out({ url, children, title, t }: { url: string; children: ReactNode; title?: string; t: Tokens }): JSX.Element {
  return (
    <Press onPress={() => void Linking.openURL(url)} title={title ?? url} flexDirection="row" alignItems="center" gap={3} minWidth={0}>
      {({ hovered }) => (
        <>
          <Txt spec={{ voice: "app", scale: 1, color: "accent" }} numberOfLines={1} {...(hovered ? { textDecorationLine: "underline" } : {})}>
            {children}
          </Txt>
          <Icon name="external" size={11} color={String(t.v("accent"))} />
        </>
      )}
    </Press>
  );
}

const FILE_INK: Record<FileChange["action"], { icon: string; name: string; letter: string }> = {
  create: { icon: "ok", name: "ok", letter: "ok" },
  delete: { icon: "bad", name: "bad", letter: "bad" },
  rename: { icon: "p1", name: "p1", letter: "p1" },
  modify: { icon: "warn", name: "text", letter: "warn" },
};

/** `FileTree`: the files as folders, each folding; a file's hunks a press away. */
function FileTree({ files, ctx }: { files: readonly FileChange[]; ctx: Ctx }): JSX.Element {
  const t = ctx.t;
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => treeOf(files), [files]);
  const toggle = (set: ReadonlySet<string>, key: string): Set<string> => (set.has(key) ? new Set([...set].filter((one) => one !== key)) : new Set([...set, key]));
  let hiddenUnder: string | undefined;
  const hover = (hovered: boolean, can = true): Record<string, unknown> => (hovered && can ? { backgroundColor: t.mix(t.v("text"), 5, "transparent") } : {});
  const box = { flexDirection: "row", alignItems: "center", justifyContent: "flex-start", gap: 6, width: "100%", minWidth: 0, minHeight: 24, paddingTop: 2, paddingBottom: 2, paddingRight: 8, borderRadius: 6 } as const;
  return (
    <View flexDirection="column" minWidth={0}>
      {rows.map((row) => {
        const key = row.kind === "folder" ? row.key : row.file.path;
        if (hiddenUnder !== undefined && key.startsWith(hiddenUnder)) return null;
        hiddenUnder = undefined;
        if (row.kind === "folder") {
          const shut = closed.has(row.key);
          if (shut) hiddenUnder = row.key;
          return (
            <Press key={row.key} onPress={() => setClosed((was) => toggle(was, row.key))} {...({ "aria-expanded": !shut } as object)} {...box} paddingLeft={8 + row.depth * 14} box={({ hovered }) => hover(hovered)}>
              <View transform={shut ? [{ rotate: "-90deg" }] : []}>
                <Icon name="chevron" size={12} color={String(t.v("tok-hint"))} />
              </View>
              <Icon name="folder" size={13} color={String(t.v("dim"))} />
              <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim", lineHeight: 1.4 }} ellip minWidth={0} flexShrink={1}>
                {row.name}
              </Txt>
            </Press>
          );
        }
        const file = row.file;
        const open = opened.has(file.path);
        const canOpen = file.hunks.length > 0;
        const from = fromOf(file);
        const ink = FILE_INK[file.action];
        const words: FontSpec = { voice: "data", scale: 11.5 / 12, lineHeight: 1.4 };
        return (
          <View key={file.path} flexDirection="column" minWidth={0}>
            <Press onPress={() => setOpened((was) => toggle(was, file.path))} disabled={!canOpen} title={file.path} {...box} paddingLeft={26 + row.depth * 14} box={({ hovered }) => hover(hovered, canOpen)}>
              <Icon name={file.action === "create" ? "fileAdd" : file.action === "delete" ? "fileDel" : "fileEdit"} size={13} color={String(t.v(ink.icon))} />
              <View flex={1} minWidth={0} flexDirection="column">
                <Txt spec={{ ...words, color: ink.name }} ellip {...(file.action === "delete" ? { textDecorationLine: "line-through" } : {})}>
                  {baseOf(file.path)}
                </Txt>
                {from !== undefined ? (
                  <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: "dim", lineHeight: 1.35 }} ellip>
                    from{" "}
                    <Txt spec={{ voice: "data", scale: 10.5 / 12.5 * 12.5 / 12, color: "bad", lineHeight: 1.35 }} textDecorationLine="line-through">
                      {from}
                    </Txt>
                  </Txt>
                ) : null}
              </View>
              <By by={file.by} ctx={ctx} />
              <View flexShrink={0} flexDirection="row" gap={6}>
                {file.added !== undefined ? (
                  <>
                    {file.added > 0 ? <Txt spec={{ voice: "data", scale: 11 / 12, color: "ok", lineHeight: 1.4 }}>+{file.added}</Txt> : null}
                    {(file.removed ?? 0) > 0 ? <Txt spec={{ voice: "data", scale: 11 / 12, color: "bad", lineHeight: 1.4 }}>−{file.removed}</Txt> : null}
                  </>
                ) : file.command !== undefined ? (
                  <Txt spec={{ voice: "app", scale: 11 / 12 * 12 / 12.5, color: "tok-hint", lineHeight: 1.4 }} numberOfLines={1}>
                    by <Code t={t} base={11 / 12.5}>{file.command}</Code>
                  </Txt>
                ) : null}
              </View>
              <Txt spec={{ voice: "data", scale: 10.5 / 12, weight: 700, color: ink.letter, lineHeight: 1 }} width={12} textAlign="center" flexShrink={0}>
                {LETTER[file.action]}
              </Txt>
            </Press>
            {open ? <Hunks file={file} t={t} /> : null}
          </View>
        );
      })}
    </View>
  );
}

/** `.chg-hunks`: a file's hunks, a line each, coloured by what happened to it. */
function Hunks({ file, t }: { file: FileChange; t: Tokens }): JSX.Element {
  const line: FontSpec = { voice: "data", scale: 10.5 / 12 };
  return (
    <ScrollView horizontal {...(scrollbarProps(t) as object)} style={{ marginTop: 2, marginHorizontal: 6, marginBottom: 6, maxHeight: 320, borderWidth: 1, borderStyle: "solid", borderColor: String(t.v("line")), borderRadius: 6, backgroundColor: String(t.v("bg")) }} contentContainerStyle={{ paddingVertical: 4, flexDirection: "column", minWidth: "100%" }}>
      {file.hunks.map((hunk, h) => (
        <View key={h} flexDirection="column">
          {hunk.header !== "" ? (
            <Txt spec={{ ...line, color: "tok-hint" }} paddingHorizontal={8} {...({ whiteSpace: "pre" } as object)}>
              {hunk.header}
            </Txt>
          ) : null}
          {hunk.lines.slice(0, 400).map((text, i) => (
            <Txt
              key={i}
              spec={line}
              paddingHorizontal={8}
              {...({ whiteSpace: "pre" } as object)}
              {...(text.startsWith("+") ? { backgroundColor: t.mix(t.v("ok"), 13, "transparent") } : text.startsWith("-") ? { backgroundColor: t.mix(t.v("bad"), 12, "transparent") } : {})}
            >
              {text.length > 0 ? text : " "}
            </Txt>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

/** `Banner`: a merge request — its number and title (a link), its branches, its state, who opened it. */
function Banner({ request, ctx }: { request: MergeRequestView; ctx: Ctx }): JSX.Element {
  const t = ctx.t;
  const pill = request.state === "merged" ? { ground: t.mix(t.v("ok"), 14, "transparent"), ink: "ok" } : request.state === "closed" ? { ground: t.mix(t.v("text"), 8, "transparent"), ink: "dim" } : { ground: t.mix(t.v("accent"), 14, "transparent"), ink: "accent" };
  const title = (
    <>
      <Txt spec={{ voice: "app", scale: 1, weight: 600, color: "accent" }}>!{request.number}</Txt> {request.title ?? ""}
    </>
  );
  return (
    <View flexDirection="column" gap={4} marginHorizontal={6} marginBottom={6} paddingVertical={8} paddingHorizontal={10} borderRadius={8} minWidth={0} backgroundColor={t.mix(t.v("accent"), 7, t.v("panel")) as never}>
      <View flexDirection="row" alignItems="flex-start" gap={8} minWidth={0}>
        <Icon name="git" size={14} color={String(t.v("dim"))} box={{ marginTop: 2 }} />
        {request.url !== undefined ? (
          <Press onPress={() => void Linking.openURL(request.url!)} title={`Open merge request !${request.number} in the browser`} flexShrink={1} minWidth={0}>
            <Txt spec={{ voice: "app", scale: 1, weight: 600 }}>{title}</Txt>
          </Press>
        ) : (
          <Txt spec={{ voice: "app", scale: 1, weight: 600 }} flexShrink={1} minWidth={0}>
            {title}
          </Txt>
        )}
      </View>
      <View flexDirection="row" flexWrap="wrap" alignItems="center" rowGap={4} columnGap={8} paddingLeft={22}>
        {request.branch !== undefined ? (
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>
            <Code t={t} base={11.5 / 12.5}>{request.branch}</Code>
            {request.target !== undefined ? (
              <>
                {" → "}
                <Code t={t} base={11.5 / 12.5}>{request.target}</Code>
              </>
            ) : null}
          </Txt>
        ) : null}
        <View paddingHorizontal={8} borderRadius={999} backgroundColor={pill.ground as never}>
          <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 500, color: pill.ink, lineHeight: 1.8 }}>{STATE_WORDS[request.state]}</Txt>
        </View>
        <By by={request.by} ctx={ctx} />
      </View>
    </View>
  );
}

/** `GitBody`: the merge requests, then the steps as a ladder, then what is not committed. */
function GitBody({ git, ctx }: { git: TaskChangeLog["git"]; ctx: Ctx }): JSX.Element {
  const t = ctx.t;
  const steps = [...git.steps.map((step) => ({ step, todo: false as const })), ...(git.uncommitted.length > 0 ? [{ step: undefined, todo: true as const }] : [])];
  return (
    <>
      {git.requests.map((request) => (
        <Banner key={request.number} request={request} ctx={ctx} />
      ))}
      <View flexDirection="column">
        {steps.map(({ step, todo }, i) => {
          const last = i === steps.length - 1;
          const said =
            step === undefined ? (
              <Txt spec={{ voice: "app", scale: 1, color: "warn" }} numberOfLines={1}>
                {git.uncommitted.length === 1 ? "1 file changed since the last commit" : `${git.uncommitted.length} files changed since the last commit`}
              </Txt>
            ) : (
              <View flexDirection="row" alignItems="baseline" gap={4} minWidth={0} overflow="hidden">
                <Txt spec={{ voice: "app", scale: 1 }} flexShrink={0}>
                  {STEP_WORDS[step.kind]}
                </Txt>
                {step.kind === "other" && step.command !== undefined ? (
                  <Txt spec={{ voice: "app", scale: 1 }} numberOfLines={1} flexShrink={1}>
                    <Code t={t}>{step.command}</Code>
                  </Txt>
                ) : step.subject !== undefined ? (
                  step.url !== undefined ? (
                    <Out url={step.url} t={t}>
                      <Code t={t}>{step.subject}</Code>
                    </Out>
                  ) : (
                    <Txt spec={{ voice: "app", scale: 1 }} numberOfLines={1} flexShrink={1}>
                      <Code t={t}>{step.subject}</Code>
                    </Txt>
                  )
                ) : null}
              </View>
            );
          const sub =
            step === undefined ? (
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} numberOfLines={1}>
                {git.uncommitted.slice(0, 3).map((path, j) => (
                  <Txt key={path} spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>
                    {j > 0 ? ", " : ""}
                    <Code t={t} base={11 / 12.5}>{baseOf(path)}</Code>
                  </Txt>
                ))}
                {git.uncommitted.length > 3 ? ` and ${git.uncommitted.length - 3} more` : ""} · not committed
              </Txt>
            ) : step.detail !== undefined || step.by !== undefined ? (
              <View flexDirection="row" alignItems="center" gap={6} minWidth={0}>
                {step.detail !== undefined ? (
                  <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} ellip minWidth={0} flexShrink={1}>
                    {step.detail}
                  </Txt>
                ) : null}
                <By by={step.by} ctx={ctx} />
              </View>
            ) : null;
          return (
            <View key={step === undefined ? "todo" : `${step.call}:${step.kind}:${step.command ?? ""}`} position="relative" flexDirection="row" alignItems="flex-start" gap={8} paddingVertical={5} paddingHorizontal={8} borderRadius={6}>
              {!last ? <View position="absolute" left={14} top={20} bottom={-6} width={2} backgroundColor={t.v("line") as never} /> : null}
              <View width={16} flexShrink={0}>
                {todo ? (
                  <View width={10} height={10} marginTop={4} marginLeft={2} borderRadius={5} borderWidth={2} borderStyle="dashed" borderColor={t.v("warn") as never} backgroundColor={t.v("panel") as never} zIndex={1} />
                ) : (
                  <View width={10} height={10} marginTop={4} marginLeft={2} borderRadius={5} backgroundColor={t.v("ok") as never} zIndex={1} />
                )}
              </View>
              <View flex={1} minWidth={0} flexDirection="column">
                {said}
                {sub}
              </View>
              {step !== undefined ? (
                <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "tok-hint", lineHeight: 1.6 }} flexShrink={0} numberOfLines={1}>
                  {clockOf(step.at)}
                </Txt>
              ) : null}
            </View>
          );
        })}
      </View>
    </>
  );
}

/** `ItemRow`: one change that is not a file — what was said about it, its detail, who, and when. */
function ItemRow({ item, icon, ctx }: { item: ChangeItem; icon: IconName; ctx: Ctx }): JSX.Element {
  const t = ctx.t;
  const task = item.open?.taskId;
  const subject =
    item.subject === undefined ? null : item.url !== undefined ? (
      <Out url={item.url} t={t}>
        <Code t={t}>{item.subject}</Code>
      </Out>
    ) : (
      <Txt spec={{ voice: "app", scale: 1 }} numberOfLines={1} flexShrink={1}>
        <Code t={t}>{item.subject}</Code>
      </Txt>
    );
  const hasSub = item.command !== undefined || item.detail !== undefined || item.by !== undefined || (task !== undefined && task !== ctx.currentTask);
  return (
    <View flexDirection="row" alignItems="flex-start" gap={8} paddingVertical={5} paddingHorizontal={8} borderRadius={6}>
      <View width={16} flexShrink={0} paddingTop={2}>
        <Icon name={icon} size={14} color={String(t.v("dim"))} />
      </View>
      <View flex={1} minWidth={0} flexDirection="column">
        <View flexDirection="row" alignItems="baseline" gap={4} minWidth={0} overflow="hidden">
          <Txt spec={{ voice: "app", scale: 1 }} flexShrink={0}>
            {item.said}
          </Txt>
          {subject}
          {item.url !== undefined && item.subject === undefined ? (
            <Out url={item.url} t={t}>
              open
            </Out>
          ) : null}
        </View>
        {hasSub ? (
          <View flexDirection="row" alignItems="center" gap={6} minWidth={0}>
            {item.command !== undefined ? (
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} ellip minWidth={0} flexShrink={1}>
                <Code t={t} base={11 / 12.5}>{item.command}</Code>
              </Txt>
            ) : null}
            {item.detail !== undefined ? (
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} ellip minWidth={0} flexShrink={1}>
                {item.detail}
              </Txt>
            ) : null}
            {task !== undefined && task !== ctx.currentTask && ctx.onOpenTask !== undefined ? (
              <Press onPress={() => ctx.onOpenTask!(task)}>
                <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "accent" }}>open the task</Txt>
              </Press>
            ) : null}
            <By by={item.by} ctx={ctx} />
          </View>
        ) : null}
      </View>
      <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "tok-hint", lineHeight: 1.6 }} flexShrink={0} numberOfLines={1}>
        {clockOf(item.at)}
      </Txt>
    </View>
  );
}
