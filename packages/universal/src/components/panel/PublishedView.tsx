import { useEffect, useState, type JSX } from "react";
import type { GestureResponderEvent, LayoutChangeEvent } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import { publishedMime, type PublishedVersion } from "@jaira/shared/browser";
import { invoke } from "@jaira/ui/store";
import type { PublishedRef } from "@jaira/ui/transcriptRows";
import type { ArtifactSurface } from "@jaira/ui/transcriptViewTypes";
import { useValuePanel } from "@jaira/ui/valuePanel";
import { usePhone } from "../../app/phone";
import { artifactInMain } from "../../app/viewState";
import { ContextMenu, type MenuAt } from "../Menu";
import { Markdown } from "../Markdown";
import { Press, Txt, viewScrollbarProps } from "../../primitives";
import { Island } from "../../islands";
import { useTokens } from "../../tokens";
import { SpIcon } from "./SidePanel";
import { ValueView } from "./ValueView";

/**
 * The surface of an artifact drawn away from its conversation: which task and project it reads from. Its
 * frame comes from its own grant, never `serve`, and there is no composer for a page to write into.
 */
export const surfaceOf = (taskId: string, project: string | undefined): ArtifactSurface => ({ serve: () => Promise.reject(new Error("no frame")), taskId, project });

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
 *   the verbs        the title bar's right: open it on its own in the side panel (where a panel can take
 *                    it), and ⇤ into the main view (a phone's sheet is the whole screen, so none there);
 *                    in the main view, ‹ back in their place
 *
 * Where it stands is its caller's. In the conversation and a list it is as tall as its frame; `fill`, it
 * owns the column it is in (`ValueView`'s `pinned`), the frame as tall as the room measured for it and
 * full bleed: the side panel, and the main view, which also gives it `onBack`.
 *
 * What the call returned names the artifact and its version, never its files: those are read here.
 */
export function PublishedView({ published, artifacts, fill = false, onBack }: { published: PublishedRef; artifacts?: ArtifactSurface | undefined; fill?: boolean; onBack?: (() => void) | undefined }): JSX.Element {
  const t = useTokens();
  const panel = useValuePanel();
  const phone = usePhone();
  const [version, setVersion] = useState(published.version);
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [versions, setVersions] = useState<PublishedVersion[] | null>(null);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** Whether the version declared the `downloads` capability: only then may the page offer a file. */
  const [downloads, setDownloads] = useState(false);
  /**
   * The artifact's newest version, once read. A call whose version a later one replaced draws its title
   * bar and no more until asked: a canvas published in six calls is six rows, and six running boards of
   * the same canvas is a conversation nobody can scroll.
   */
  const [newest, setNewest] = useState<number | null>(null);
  // Brought here on purpose, at the version it was showing: drawn whatever came after it.
  const [opened, setOpened] = useState(fill);
  /** The canvas open in its editor, in place (a conversation draws inline). */
  const [editing, setEditing] = useState(false);
  /** Bumped to read the artifact again: after the editor saved, or a refused save asked to reload. */
  const [reread, setReread] = useState(0);
  /** The height `fill` measured for the frame. */
  const [room, setRoom] = useState(0);
  const tall = (height: number): number => (fill ? room : height);
  const project = artifacts?.project !== undefined ? { project: artifacts.project } : {};
  const taskId = artifacts?.taskId ?? published.taskId;

  useEffect(() => {
    let live = true;
    void invoke("artifact:versions", { taskId, artifact: published.id, ...project })
      .then((list) => live && setNewest(list.at(-1)?.version ?? published.version))
      .catch(() => live && setNewest(published.version));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, published.id, published.version, reread]);
  const superseded = newest !== null && newest > published.version && !opened;

  useEffect(() => {
    if (newest === null || superseded) return;
    let live = true;
    setFiles(null);
    setFrame(null);
    void invoke("artifact:files", { taskId, artifact: published.id, version, ...project })
      .then(async (read) => {
        if (!live) return;
        setFiles(read.files);
        setDownloads(read.capabilities !== undefined && "downloads" in read.capabilities);
        // The grant the Artifact view runs in: the whole artifact at this version - on a phone, at the
        // engine's HTTP route (the phone's engine bridge says where).
        if (published.kind === "markdown") return;
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
  }, [taskId, published.id, published.kind, published.entry, version, reread, newest === null, superseded]);

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
  // At the version on screen: where it is opened shows what was being looked at.
  const here: PublishedRef = { ...published, version };
  const verbs =
    onBack !== undefined ? (
      <SpIcon icon="back" label="Back out of this artifact" onPress={onBack} />
    ) : newest === null || superseded ? null : (
      <>
        {panel !== null ? <SpIcon icon="read" label="Open it on its own, in the side panel" onPress={() => panel.open({ title: published.title ?? published.entry, published: { ref: here, ...project } })} /> : null}
        {phone ? null : <SpIcon icon="adopt" label="Show this artifact in the main view" onPress={() => artifactInMain.set({ published: here, artifacts: artifacts ?? surfaceOf(taskId, undefined) })} />}
      </>
    );
  const titleBar = (
    <View flexDirection="row" alignItems="center" gap={8} paddingTop={6} paddingHorizontal={fill ? 10 : 2} paddingBottom={4} minWidth={0}>
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
      {verbs !== null ? (
        <>
          <View flex={1} minWidth={0} />
          {/* The icons' 26 stands out of the row, which keeps its height. */}
          <View flexDirection="row" gap={1} flexShrink={0} marginVertical={-5}>
            {verbs}
          </View>
        </>
      ) : null}
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
      // The version the create call made: the canvas exists, and nothing is on it yet.
      if (index === undefined) return <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }}>The canvas is empty at v{version}: its artboards come in the calls after this one.</Txt>;
      if (frame === null) return <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }}>{"Opening the canvas…"}</Txt>;
      // The grant's root: the address it opened on, less `project/canvas.json`.
      const frames = frame.slice(0, frame.lastIndexOf("project/canvas.json"));
      if (editing) {
        return (
          <Island
            component="canvasEditor"
            props={{
              files,
              base: version,
              frames,
              style: { height: tall(640) },
              // A save is a version marked the person's; the view then follows it.
              onSave: async (changes: Record<string, string | null>, base: number) => {
                const answer = await invoke("artifact:save", { taskId, artifact: published.id, base, changes, ...project });
                if ("version" in answer) setVersions(null);
                return answer;
              },
            }}
            onEvent={(name, value) => {
              if (name === "close") {
                setEditing(false);
                void invoke("artifact:versions", { taskId, artifact: published.id, ...project }).then((list) => setVersion(list.at(-1)?.version ?? version));
              } else if (name === "reload") {
                void invoke("artifact:versions", { taskId, artifact: published.id, ...project }).then((list) => {
                  setVersion(list.at(-1)?.version ?? version);
                  setReread((n) => n + 1);
                });
              } else if (name === "export") {
                const { file, format, size } = value as { file: string; format: "png" | "pdf"; size: { width: number; height: number } };
                void invoke("shell:exportArtboard", { url: `${frames}project/${file}`, width: size.width, height: size.height, format, name: file.replace(/\.dc\.html$/, "") }).catch(() => undefined);
              }
            }}
          />
        );
      }
      // The editor is a computer's: a phone draws the board, every artboard running, and no Edit.
      return <Island component="canvas" props={{ index: index ?? "{}", base: frames, style: { height: tall(440) } }} {...(isWeb ? { onEvent: (name: string) => name === "open" && setEditing(true) } : {})} />;
    }
    const box = fill ? { height: room, border: 0, borderRadius: 0, display: "block" } : { height: 420, border: `1px solid ${String(t.v("line"))}`, borderRadius: 6 };
    return (
      <Island
        component="artifact"
        props={{ text: shownText ?? "", ...(frame !== null ? { url: frame, published: true, downloads } : {}), style: { ...box, width: "100%", background: "#fff", boxSizing: "border-box" } }}
        onEvent={(name: string, value: unknown) => {
          if (name === "prompt" && typeof value === "string") artifacts?.onPrompt?.(value);
          // A file the page offers (its declared `downloads`): saved where the person chooses.
          if (name === "download") {
            const file = value as { name: string; data: string; base64: boolean };
            const data = file.base64 ? file.data : base64OfText(file.data);
            void invoke("shell:saveFile", { name: file.name, data }).catch(() => undefined);
          }
        }}
      />
    );
  })();

  if (newest === null || superseded) {
    return (
      <View flexDirection="row" alignItems="center" gap={8} minWidth={0}>
        <View flexShrink={1} minWidth={0}>
          {titleBar}
        </View>
        {superseded ? (
          <Press onPress={() => setOpened(true)} title={`Show v${String(published.version)}`} paddingVertical={1} paddingHorizontal={8} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={6} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("panel-2") : "transparent" })}>
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>
              v{newest} is newer · Show v{published.version}
            </Txt>
          </Press>
        ) : null}
      </View>
    );
  }

  // Filling a column, a document scrolls in it and anything else is as tall as what was measured here.
  const scrolling = published.kind === "markdown" ? { overflow: "auto", paddingHorizontal: 10, paddingBottom: 10, ...viewScrollbarProps(t) } : {};
  return (
    <View minWidth={0} {...(fill ? { flex: 1, minHeight: 0 } : {})}>
      <ValueView
        value={{ path: shownPath, mediaType: publishedMime(shownPath), content: shownText ?? "" }}
        hint={{ mime: publishedMime(shownPath) }}
        pinned={fill}
        titleBar={titleBar}
        lead={{
          label: "Artifact",
          hint: "The artifact as Claude published it",
          body: fill ? (
            <View flex={1} minHeight={0} {...(scrolling as object)} onLayout={(e: LayoutChangeEvent) => setRoom(e.nativeEvent.layout.height)}>
              {lead}
            </View>
          ) : (
            lead
          ),
        }}
        segment={segment}
      />
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </View>
  );
}

/** Text as UTF-8 in base64, in chunks: spreading a large file into one call overflows the stack. */
function base64OfText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A version's time: today's as a time, an older one's as a date. */
function when(at: number): string {
  const d = new Date(at);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
