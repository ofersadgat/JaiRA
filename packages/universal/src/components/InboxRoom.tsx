import type { JSX } from "react";
import { ScrollView } from "react-native";
import { View } from "@tamagui/core";
import type { ProjectSummary } from "@jaira/shared/browser";
import { SHARED_SESSION } from "@jaira/shared/browser";
import type { InboxItem } from "@jaira/ui/inboxModel";
import { projectName } from "@jaira/ui/projects";
import { PLAIN_SCROLLER, Press, Txt, edge, scrollbarProps } from "../primitives";
import { useTokens } from "../tokens";
import { ProjectChip } from "./InboxStrip";

/**
 * The Inbox room (decision 0015, amended 2026-10-04): everything awaiting the person, across projects —
 * the desktop's inbox strip (`InboxStrip.tsx`) with nothing left out, as the room a phone's sidebar opens
 * from its INBOX row. What is listed and in what order is `inboxModel.ts`'s. A card is pressed to open
 * its task, where the question stands at the foot of its panel. How it looks:
 *
 *   the room           scrolls, --bg, padding 12, gap 10
 *   a card             column, gap 6, padding 12 14, --panel, 1px --line, radius 10; pressed --panel-2
 *   its head           row, gap 8: the project's chip (`ProjectChip`), what it asks (app-label, --warn),
 *                      pushed apart
 *   its text           data-text, at most four lines; the detail under it app-secondary, two
 *   the empty words    "Nothing is waiting for you.", --dim, centred, 40 above
 */
export function InboxRoom({
  items,
  projects,
  hues,
  onOpen,
}: {
  items: readonly InboxItem[];
  projects: readonly ProjectSummary[];
  hues: Readonly<Record<string, string>>;
  onOpen: (item: InboxItem) => void;
}): JSX.Element {
  const t = useTokens();
  const chipOf = (project: string): { label: string; hue: string } => {
    const found = project === SHARED_SESSION ? projects.find((p) => p.kind === "shared") : projects.find((p) => p.project === project);
    if (project === SHARED_SESSION) return { label: found?.label ?? "Shared", hue: (found !== undefined ? hues[found.project] : undefined) ?? "var(--p0)" };
    return { label: found?.label ?? projectName(project), hue: hues[project] ?? "var(--p0)" };
  };
  return (
    <ScrollView {...(scrollbarProps(t) as object)} style={{ flex: 1, backgroundColor: t.v("bg") as string, ...PLAIN_SCROLLER } as never} contentContainerStyle={{ padding: 12, gap: 10, ...PLAIN_SCROLLER } as never} testID="inbox-room">
      {items.length === 0 ? (
        <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} textAlign="center" marginTop={40}>
          Nothing is waiting for you.
        </Txt>
      ) : null}
      {items.map((item) => (
        <Press
          key={item.key}
          onPress={() => onOpen(item)}
          label={`${item.heading}: ${item.text}`}
          disabled={item.taskId === undefined}
          flexDirection="column"
          gap={6}
          paddingVertical={12}
          paddingHorizontal={14}
          borderRadius={10}
          box={({ pressed }) => ({ backgroundColor: t.v(pressed ? "panel-2" : "panel"), ...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object) })}
        >
          <View flexDirection="row" alignItems="center" gap={8} minWidth={0}>
            <ProjectChip {...chipOf(item.project)} />
            <View flex={1} minWidth={0} />
            <Txt register="app-label" spec={{ color: "warn" }} flexShrink={1} ellip>
              {item.heading}
            </Txt>
          </View>
          <Txt register="data-text" numberOfLines={4}>
            {item.text}
          </Txt>
          {item.detail !== undefined ? (
            <Txt register="app-secondary" numberOfLines={2}>
              {item.detail}
            </Txt>
          ) : null}
        </Press>
      ))}
    </ScrollView>
  );
}
