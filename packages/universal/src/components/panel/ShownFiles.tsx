import { useEffect, useState, type JSX } from "react";
import type { LayoutChangeEvent } from "react-native";
import { View } from "@tamagui/core";
import { mediaKindOf } from "@jaira/shared/browser";
import { invoke } from "@jaira/ui/store";
import { shownMimeOf, type PublishedRef, type ShownFiles } from "@jaira/ui/transcriptRows";
import type { ArtifactSurface } from "@jaira/ui/transcriptViewTypes";
import { useValuePanel } from "@jaira/ui/valuePanel";
import { Press, Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { Picture } from "../Picture";
import { PublishedView } from "./PublishedView";

/**
 * What one `show_artifact` call showed the person (2026-11-13), under its call:
 *
 *   the caption     the call's line over all of it, app 13.5, --text, padding 2 2 6
 *   a gallery       several pictures in one call: tiles in rows of three (two under 640 wide, one under
 *                   380), gap 10; a tile is the picture in a --panel-2 frame 170 tall, radius 6, 1px
 *                   --line, its name and version under it (data 11.5, --dim), then its caption; pressing
 *                   it opens that picture on its own in the side panel, with its versions
 *   otherwise       one card per file (`PublishedView`), stacked, gap 10, each under its own caption
 *   refused         one line per file that could not be shown, after the rest: ✕ and why, --bad
 *
 * A call that showed nothing failed, and its line already says why: it never reaches here.
 */
export function ShownFilesView({ shown, artifacts }: { shown: ShownFiles; artifacts?: ArtifactSurface | undefined }): JSX.Element {
  const gallery = shown.items.length > 1 && shown.items.every(isPicture);
  return (
    <View gap={6} minWidth={0}>
      {shown.caption !== undefined ? (
        <Txt spec={{ voice: "app", scale: 13.5 / 12.5 }} paddingTop={2} paddingHorizontal={2}>
          {shown.caption}
        </Txt>
      ) : null}
      {gallery ? (
        <Gallery items={shown.items} artifacts={artifacts} />
      ) : (
        <View gap={10} minWidth={0}>
          {shown.items.map((item) => (
            <View key={item.url} gap={2} minWidth={0}>
              {item.caption !== undefined ? (
                <Txt spec={{ voice: "app", scale: 13 / 12.5 }} paddingHorizontal={2}>
                  {item.caption}
                </Txt>
              ) : null}
              {/* Keyed by version: the card holds the version it shows, read once from what it is handed. */}
              <PublishedView key={`${item.id}@${String(item.version)}`} published={item} artifacts={artifacts} follows={item.version} />
            </View>
          ))}
        </View>
      )}
      {shown.refused.map((refused, i) => (
        <View key={`${refused.source}-${i}`} flexDirection="row" gap={6} alignItems="baseline" paddingHorizontal={2} minWidth={0}>
          <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "bad", weight: 700 }} flexShrink={0}>
            ✕
          </Txt>
          <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }} flexShrink={1}>
            {refused.why}
          </Txt>
        </View>
      ))}
    </View>
  );
}

/** A shown file whose type is a picture, read off its source's name — the gallery's test, before any file is read. */
const isPicture = (item: PublishedRef): boolean => item.kind === "file" && mediaKindOf(shownMimeOf(item.entry, undefined)) === "image";

function Gallery({ items, artifacts }: { items: PublishedRef[]; artifacts?: ArtifactSurface | undefined }): JSX.Element {
  const [width, setWidth] = useState(0);
  const columns = width >= 640 ? 3 : width >= 380 ? 2 : 1;
  const gap = 10;
  const tile = width === 0 ? 0 : Math.floor((width - gap * (columns - 1)) / columns);
  return (
    <View flexDirection="row" flexWrap="wrap" gap={gap} minWidth={0} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      {tile > 0 ? items.map((item) => <Tile key={item.url} item={item} width={tile} artifacts={artifacts} />) : null}
    </View>
  );
}

function Tile({ item, width, artifacts }: { item: PublishedRef; width: number; artifacts?: ArtifactSurface | undefined }): JSX.Element {
  const t = useTokens();
  const panel = useValuePanel();
  const [src, setSrc] = useState<string | null>(null);
  const project = artifacts?.project !== undefined ? { project: artifacts.project } : {};
  const taskId = artifacts?.taskId ?? item.taskId;
  useEffect(() => {
    let live = true;
    void invoke("artifact:files", { taskId, artifact: item.id, version: item.version, ...project })
      .then((read) => live && setSrc(read.files[item.entry] ?? null))
      .catch(() => live && setSrc(null));
    return () => {
      live = false;
    };
    // `project` is derived from `artifacts`, which the surface keeps stable per task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, item.id, item.version, item.entry]);
  const name = item.title ?? item.entry;
  return (
    <View width={width} gap={5} minWidth={0}>
      <Press
        onPress={() => panel?.open({ title: name, published: { ref: item, ...project } })}
        title={`Open ${name} on its own, in the side panel`}
        height={170}
        borderRadius={6}
        borderWidth={1}
        borderStyle="solid"
        borderColor={t.v("line") as never}
        backgroundColor={t.v("panel-2") as never}
        overflow="hidden"
        justifyContent="center"
      >
        {/* Stretched, not centred: the picture measures the width it is given, and a centred box gives it none. */}
        {src !== null ? <Picture src={src} alt={name} maxHeight={168} box={{ alignSelf: "center" }} /> : null}
      </Press>
      <Txt spec={{ voice: "data", scale: 11.5 / 12.5, color: "dim" }} numberOfLines={1}>
        {name} · v{item.version}
      </Txt>
      {item.caption !== undefined ? (
        <Txt spec={{ voice: "app", scale: 12.5 / 12.5 }} numberOfLines={3}>
          {item.caption}
        </Txt>
      ) : null}
    </View>
  );
}
