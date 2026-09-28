import { useEffect, useState, type JSX } from "react";
import { ScrollView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { FolderListing } from "@jaira/shared/browser";
import type { BrowseMachine } from "@jaira/ui/folderBrowser";
import { invoke } from "@jaira/ui/store";
import { Press, Txt, edge, lengthToken, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { Chip } from "../files/Chip";
import { Button } from "../settings/Button";
import { Segmented } from "../settings/controls";
import { ModalBox } from "./Modal";

/**
 * `folderBrowser.tsx`'s `FolderBrowser`, universal (decision 0015): choosing a folder on a paired machine,
 * read by that machine's engine (`files:browse`) — the machine switcher, the roots and where it is, the
 * folders (a click goes in), and Open (or Make a project) naming the folder and the machine. The rules,
 * from `styles.css` (two sets of `.folder-list` and `.folder-row` rules; the later wins where both say):
 *
 *   .folder-browser        the dialog, 560 wide (or 90% of the window), a column, gap 10
 *   .folder-browser-title  the heading, no margin: app 17/12.5 700, line 1.35
 *   .folder-crumbs         row, wrapping, centred, gap 4: each root a `ghost` button, then where it is
 *                          (`code.folder-at`: data 11/12, --dim, 6 in, one line)
 *   .folder-list           at most 320 tall, scrolling; 1px --line, radius --control-radius; padding
 *                          8 10, gap 1 (the earlier rule's)
 *   .folder-row            row, centred, gap 8, padding 6 10, --panel, a --line under all but the last;
 *                          app 13/12.5; hovered --panel-2; a project on --tint-accent; its glyph --dim, 12
 *   .cfg-hint              app 11/12.5, line 1.4, --dim; an error in --bad
 *   .folder-foot           row, centred, gap 8: the rest, Cancel (`ghost`), Open (`primary`)
 */
export function FolderBrowser({
  machines,
  initial,
  mode,
  onClose,
  onChosen,
  staged = false,
}: {
  machines: readonly BrowseMachine[];
  initial: string;
  mode: "open" | "init";
  onClose: () => void;
  onChosen: (machine: BrowseMachine, dir: string) => void;
  staged?: boolean;
}): JSX.Element {
  const t = useTokens();
  const [machineId, setMachineId] = useState(initial);
  const [listing, setListing] = useState<FolderListing | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const machine = machines.find((m) => m.id === machineId) ?? machines[0]!;
  const go = (dir?: string): void => {
    setError(undefined);
    invoke("files:browse", { machine: machine.id, ...(dir !== undefined ? { dir } : {}) }).then(setListing, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    setListing(undefined);
    go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId]);
  const chosen = listing?.dir;
  const title = mode === "init" ? "New project" : "Open a project";
  const hint = { voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "dim" } as const;
  const rows: JSX.Element[] = [];
  if (listing?.parent !== undefined) rows.push(<FolderRow key=".." glyph="↑" name=".." onPress={() => go(listing.parent)} />);
  for (const entry of listing?.entries ?? []) {
    rows.push(<FolderRow key={entry.path} glyph="▸" name={entry.name} project={entry.project} {...(entry.project ? { chip: "JaiRA project" } : entry.git ? { chip: "git" } : {})} onPress={() => go(entry.path)} />);
  }
  return (
    <ModalBox staged={staged} onDismiss={onClose} label={title}>
      <View width={isWeb ? ("min(560px, 90vw)" as never) : "100%"} maxWidth="100%" flexDirection="column" gap={10}>
        <Txt spec={{ voice: "app", scale: 17 / 12.5, weight: 700, lineHeight: 1.35 }}>{title}</Txt>
        {machines.length > 1 ? <Segmented label="Machine" value={machine.id} options={machines.map((m) => [m.label, m.id] as const)} onChange={setMachineId} /> : null}
        <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={4} minWidth={0}>
          {listing?.roots.map((root) => (
            <Button key={root} kind="ghost" onPress={() => go(root)}>
              {root}
            </Button>
          ))}
          {listing !== undefined ? (
            <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }} ellip marginLeft={6} minWidth={0} flexShrink={1}>
              {listing.dir}
            </Txt>
          ) : null}
        </View>
        <ScrollView
          {...(scrollbarProps(t) as object)}
          style={{ maxHeight: 320, borderRadius: lengthToken(t, "control-radius", 7) as number, ...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object) } as never}
          contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 10, gap: 1 } as never}
        >
          {rows.map((row, i) => (
            <View key={row.key ?? i} {...(i < rows.length - 1 ? (edge(t, { bottom: 1 }) as object) : {})}>
              {row}
            </View>
          ))}
          {listing === undefined && error === undefined ? (
            <Txt spec={hint} padding={10}>
              Reading {machine.label}…
            </Txt>
          ) : null}
          {listing?.entries.length === 0 ? (
            <Txt spec={hint} padding={10}>
              No folders here.
            </Txt>
          ) : null}
        </ScrollView>
        <Txt spec={{ ...hint, ...(error !== undefined ? { color: "bad" } : {}) }}>
          {error !== undefined ? error : `Folders on ${machine.label}, read by its engine.${mode === "open" ? " A folder that is not a project yet can be set up there." : ""}`}
        </Txt>
        <View flexDirection="row" alignItems="center" gap={8}>
          <View flexGrow={1} />
          <Button kind="ghost" onPress={onClose}>
            Cancel
          </Button>
          <Button kind="primary" disabled={chosen === undefined} onPress={() => chosen !== undefined && onChosen(machine, chosen)}>
            {`${mode === "init" ? "Make a project" : "Open"} ${chosen !== undefined ? `${chosen.split(/[\\/]/).filter(Boolean).pop() ?? chosen} on ${machine.label}` : ""}`}
          </Button>
        </View>
      </View>
    </ModalBox>
  );
}

function FolderRow({ glyph, name, chip, project = false, onPress }: { glyph: string; name: string; chip?: string; project?: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      flexDirection="row"
      alignItems="center"
      gap={8}
      paddingVertical={6}
      paddingHorizontal={10}
      box={({ hovered }) => ({ backgroundColor: hovered ? t.v("panel-2") : project ? t.v("tint-accent") : t.v("panel") })}
    >
      <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} width={12} flexShrink={0}>
        {glyph}
      </Txt>
      <Txt spec={{ voice: "app", scale: 13 / 12.5 }} ellip flexGrow={1} flexShrink={1} minWidth={0}>
        {name}
      </Txt>
      {chip !== undefined ? <Chip>{chip}</Chip> : null}
    </Press>
  );
}
