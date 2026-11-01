import { useEffect, useState, type JSX } from "react";
import { View } from "@tamagui/core";
import type { PublishedArtifact } from "@jaira/shared/browser";
import { invoke } from "@jaira/ui/store";
import type { PublishedRef } from "@jaira/ui/transcriptRows";
import type { ArtifactSurface } from "@jaira/ui/transcriptViewTypes";
import { Press, Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { PublishedView, surfaceOf } from "./PublishedView";

/**
 * A task's published artifacts (decision 0020 §3), one row per artifact at its latest version — the
 * same list wherever it is placed: the side panel's Produced tab, and inline in the conversation under
 * a call that listed them. Choosing a row opens the artifact under the list.
 *
 *   a row     row, centred, gap 8, padding 6 10, radius 6: the glyph, the title, and its kind, version
 *             and when (--dim, 11.5); chosen, on --panel-2
 */
export function PublishedList({
  taskId,
  project,
  signal,
  artifacts,
  empty = null,
}: {
  taskId: string;
  project?: string | undefined;
  signal?: unknown;
  artifacts?: ArtifactSurface | undefined;
  /** What stands where the list would when the task has published nothing. */
  empty?: JSX.Element | null;
}): JSX.Element | null {
  const t = useTokens();
  const [list, setList] = useState<PublishedArtifact[] | undefined>(undefined);
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void invoke("artifact:published", { taskId, ...(project !== undefined ? { project } : {}) })
      .then((rows) => live && setList(rows))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [taskId, project, signal]);
  if (list === undefined) return null;
  if (list.length === 0) return empty;
  const open = list.find((row) => row.id === chosen);
  return (
    <View minWidth={0}>
      {[...list].reverse().map((row) => (
        <Press
          key={row.id}
          onPress={() => setChosen(row.id === chosen ? null : row.id)}
          title={`open ${row.title ?? row.entry}`}
          flexDirection="row"
          alignItems="center"
          gap={8}
          paddingVertical={6}
          paddingHorizontal={10}
          borderRadius={6}
          box={({ hovered }) => ({ backgroundColor: row.id === chosen || hovered ? t.v("panel-2") : "transparent" })}
        >
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "accent" }}>{row.kind === "canvas" ? "◫" : row.kind === "markdown" ? "¶" : "▥"}</Txt>
          <Txt spec={{ voice: "app", scale: 12.5 / 12.5 }} numberOfLines={1} flexShrink={1}>
            {row.title ?? row.entry}
          </Txt>
          <View flex={1} />
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }} numberOfLines={1} flexShrink={0}>
            {row.kind === "canvas" ? "canvas" : row.kind === "markdown" ? "document" : "page"} · v{row.version}
            {row.author === "person" ? " · your edit" : ""}
          </Txt>
        </Press>
      ))}
      {open !== undefined ? (
        <View paddingTop={6} minWidth={0}>
          <PublishedView key={`${open.id}@${open.version}`} published={refOf(open)} artifacts={artifacts ?? surfaceOf(taskId, project)} />
        </View>
      ) : null}
    </View>
  );
}

const refOf = (row: PublishedArtifact): PublishedRef => ({
  taskId: row.taskId,
  id: row.id,
  url: row.url,
  version: row.version,
  kind: row.kind,
  ...(row.type !== undefined ? { type: row.type } : {}),
  ...(row.title !== undefined ? { title: row.title } : {}),
  ...(row.icon !== undefined ? { icon: row.icon } : {}),
  entry: row.entry,
});
