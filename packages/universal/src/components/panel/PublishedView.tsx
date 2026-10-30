import { useEffect, useState, type JSX } from "react";
import type { GestureResponderEvent } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import { publishedMime, type PublishedVersion } from "@jaira/shared/browser";
import { invoke } from "@jaira/ui/store";
import type { PublishedRef } from "@jaira/ui/transcriptRows";
import type { ArtifactSurface } from "@jaira/ui/transcriptViewTypes";
import { ContextMenu, type MenuAt } from "../Menu";
import { Markdown } from "../Markdown";
import { Press, Txt } from "../../primitives";
import { Island } from "../../islands";
import { useTokens } from "../../tokens";
import { ValueView } from "./ValueView";

/**
 * A published artifact in the conversation (decision 0020 §3–§4): the page Claude made, a Markdown
 * document, or a design canvas — at the version this call published, any other a press away.
 *
 *   the title bar    row, centred, gap 8, padding 6 2 4: the glyph, the title (600), and the version
 *                    and when, --dim; above the value view's head row, never instead of it
 *   the head row     the value view's own: Artifact (this view, first), its other views, and the
 *                    version picker as a segment of the same toggle, in its type
 *   Artifact         a page RUNNING in its frame (the grant is the whole artifact at this version, an
 *                    origin of its own); a document drawn as the conversation draws Markdown; a canvas
 *                    as a board of its artboards, each running (web: the `canvas` island)
 *   Rendered/Source  the entry file's (a canvas's: its first artboard's) as any value's
 *
 * What the call returned names the artifact and its version, never its files: those are read here.
 */
export function PublishedView({ published, artifacts }: { published: PublishedRef; artifacts?: ArtifactSurface | undefined }): JSX.Element {
  const t = useTokens();
  const [version, setVersion] = useState(published.version);
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [versions, setVersions] = useState<PublishedVersion[] | null>(null);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const project = artifacts?.project !== undefined ? { project: artifacts.project } : {};
  const taskId = artifacts?.taskId ?? published.taskId;

  useEffect(() => {
    let live = true;
    setFiles(null);
    setFrame(null);
    void invoke("artifact:files", { taskId, artifact: published.id, version, ...project })
      .then(async (read) => {
        if (!live) return;
        setFiles(read.files);
        // The grant the Artifact view runs in: the whole artifact at this version (a phone's WebView
        // cannot load it yet, and draws what it can without one).
        if (published.kind === "markdown" || !isWeb) return;
        const opens = published.kind === "canvas" ? "project/canvas.json" : published.entry;
        if (read.files[opens] === undefined) return;
        const granted = await invoke("artifact:serve", { taskId, artifact: published.id, version, path: opens, ...project });
        if (live) setFrame(granted.url);
      })
      .catch((e: unknown) => live && setFailed(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
    // `project` is derived from `artifacts`, which the surface keeps stable per task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, published.id, published.kind, published.entry, version]);

  const index = files?.["project/canvas.json"];
  /** What Rendered and Source show: the entry file, or a canvas's first artboard. */
  const shownPath =
    published.kind !== "canvas"
      ? published.entry
      : (() => {
          try {
            const parsed = JSON.parse(index ?? "{}") as { order?: string[]; boards?: Record<string, unknown> };
            const first = parsed.order?.[0] ?? Object.keys(parsed.boards ?? {})[0];
            return first !== undefined ? `project/${first}` : "project/canvas.json";
          } catch {
            return "project/canvas.json";
          }
        })();
  const shownText = files?.[shownPath];

  const openVersions = (e: GestureResponderEvent): void => {
    const el = (e as unknown as { currentTarget?: { getBoundingClientRect?: () => DOMRect } }).currentTarget;
    const rect = isWeb && typeof el?.getBoundingClientRect === "function" ? el.getBoundingClientRect() : undefined;
    const at = rect !== undefined ? { x: rect.left, y: rect.bottom + 3 } : { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY + 12 };
    const show = (list: PublishedVersion[]): void =>
      setMenu({
        ...at,
        title: "Version",
        items: [...list].reverse().map((v) => ({
          label: `v${v.version}${v.version === published.version ? " · this call" : ""}`,
          note: `${v.author === "person" ? "your edit" : "Claude"} · ${when(v.createdAt)}`,
          checked: v.version === version,
          onSelect: () => setVersion(v.version),
        })),
      });
    if (versions !== null) show(versions);
    else void invoke("artifact:versions", { taskId, artifact: published.id, ...project }).then((list) => {
      setVersions(list);
      show(list);
    });
  };

  const glyph = published.kind === "canvas" ? "◫" : published.kind === "markdown" ? "¶" : "▥";
  const titleBar = (
    <View flexDirection="row" alignItems="center" gap={8} paddingTop={6} paddingHorizontal={2} paddingBottom={4} minWidth={0}>
      <View width={16} height={16} borderRadius={4} backgroundColor={t.v("panel-3") as never} alignItems="center" justifyContent="center" flexShrink={0}>
        <Text color={t.v("accent") as never} fontSize={10}>
          {glyph}
        </Text>
      </View>
      <Txt spec={{ voice: "app", scale: 12.5 / 12.5, weight: 600 }} numberOfLines={1} flexShrink={1}>
        {published.title ?? published.entry}
      </Txt>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} numberOfLines={1} flexShrink={0}>
        {published.kind === "canvas" ? "canvas" : published.kind === "markdown" ? "document" : "page"} · v{version}
      </Txt>
    </View>
  );

  const segment = (
    <Press onPress={openVersions} title="Which version" {...({ "aria-haspopup": "menu" } as object)} paddingVertical={1} paddingHorizontal={7} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}>
      {({ hovered }) => (
        <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: hovered ? "text" : "tok-hint" }} numberOfLines={1}>
          v{version} ▾
        </Txt>
      )}
    </Press>
  );

  const lead = ((): JSX.Element => {
    if (failed !== null) return <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }}>Could not open this artifact: {failed}</Txt>;
    if (files === null) return <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "tok-hint" }}>Opening…</Txt>;
    if (published.kind === "markdown") return <Markdown text={files[published.entry] ?? ""} scale={12.5 / 12.5} />;
    if (published.kind === "canvas") {
      if (!isWeb || frame === null) {
        return <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }}>{isWeb ? "Opening the canvas…" : "This design canvas opens in JaiRA on a computer."}</Txt>;
      }
      return <Island component="canvas" props={{ index: index ?? "{}", base: new URL(frame).origin + "/", style: { height: 440 } }} />;
    }
    return (
      <Island
        component="artifact"
        props={{ text: shownText ?? "", ...(frame !== null ? { url: frame, published: true } : {}), style: { width: "100%", height: 420, border: `1px solid ${String(t.v("line"))}`, borderRadius: 6, background: "#fff", boxSizing: "border-box" } }}
        {...(artifacts?.onPrompt !== undefined ? { onEvent: (name: string, text: unknown) => void (name === "prompt" && typeof text === "string" && artifacts.onPrompt!(text)) } : {})}
      />
    );
  })();

  return (
    <View minWidth={0}>
      <ValueView
        value={{ path: shownPath, mediaType: publishedMime(shownPath), content: shownText ?? "" }}
        hint={{ mime: publishedMime(shownPath) }}
        titleBar={titleBar}
        lead={{ label: "Artifact", hint: "The artifact as Claude published it", body: lead }}
        segment={segment}
      />
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </View>
  );
}

/** A version's time: today's as a time, an older one's as a date. */
function when(at: number): string {
  const d = new Date(at);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
