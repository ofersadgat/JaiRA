import { useMemo, useRef, useState, type JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import type { FolderListing, MachinesView } from "@jaira/shared/browser";
import type { BrowseMachine } from "@jaira/ui/folderBrowserTypes";
import { folderChip, machinePlacesOf, workspaceDirsOn, type MachinePlace } from "@jaira/ui/openProjectModel";
import type { ProjectGroup } from "@jaira/ui/workspaceGroups";
import { Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { Button } from "../settings/Button";
import { Column, ColumnBrowser, FolderDetail, MachinePlaces, PlaceRow, lastOf } from "./FolderColumns";
import { ModalBox } from "./Modal";

/**
 * Choosing a folder on a machine, read by that machine's engine (`files:browse`): the machines down the
 * left with their places (the folder new workspaces go in, the folders holding workspaces, recent ones,
 * home, the roots), the folders in columns (`ColumnBrowser`: the folder above, the folder browsed, and
 * the folder chosen), and the foot's button naming the folder and the machine — as the Open dialog's
 * Project step has them (docs/ui/assets/add-workspace, proposals 3 and 6; 2026-11-21). How it looks:
 *
 *   the dialog             min(1000px, 94vw) wide, 600 tall, a column
 *   its title              padding 14 20, a --line under: app 15/12.5 700
 *   the body               row: the column (232, --bg) and the pane (padding 14 18, gap 10)
 *   the foot               row, padding 12 20, a --line above: Cancel (`ghost`), the primary
 *
 * Without the machines' view (`view`), one column of the machines given, by name.
 */
export function FolderBrowser({
  machines,
  initial,
  mode,
  onClose,
  onChosen,
  staged = false,
  startDir,
  view,
  groups = [],
  recent,
}: {
  machines: readonly BrowseMachine[];
  initial: string;
  /** `folder`: any folder, for a setting (a machine's projects folder) rather than a project. */
  mode: "open" | "init" | "folder";
  onClose: () => void;
  onChosen: (machine: BrowseMachine, dir: string) => void;
  staged?: boolean;
  /** Where the listing opens, on the first machine shown; its home when absent or unreadable. */
  startDir?: string | undefined;
  /** The machines as Settings → Machines has them: their icons, and the folders their new workspaces go in. */
  view?: MachinesView | undefined;
  /** The person's projects: the folders that hold their workspaces are places, and a folder says which it is. */
  groups?: readonly ProjectGroup[];
  /** The folders lately chosen, by machine. */
  recent?: Readonly<Record<string, readonly string[]>> | undefined;
}): JSX.Element {
  const t = useTokens();
  const selfId = view?.self.id;
  // The machines it can browse: the ones given, and this machine when the view says it.
  const browsable = useMemo(() => {
    const out = [...machines];
    if (view !== undefined && mode !== "folder" && !out.some((m) => m.id === view.self.id)) out.unshift({ id: view.self.id, label: view.self.label });
    return out;
  }, [machines, view, mode]);
  const [machineId, setMachineId] = useState(initial);
  const machine = browsable.find((m) => m.id === machineId) ?? browsable[0]!;
  const [listing, setListing] = useState<FolderListing | undefined>(undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [jump, setJump] = useState<{ dir: string; n: number } | undefined>(undefined);
  const [rootsBy, setRootsBy] = useState<Record<string, string[]>>({});
  const firstMachine = useRef(machine.id);
  const placesOf = (id: string): MachinePlace[] => {
    const at = id === selfId ? view?.self : view?.machines.find((m) => m.id === id);
    return machinePlacesOf({
      projectsFolder: at?.projectsFolder,
      workspaces: workspaceDirsOn(groups, id, selfId),
      ...(recent?.[id] !== undefined ? { recent: recent[id] } : {}),
      ...(rootsBy[id] !== undefined ? { roots: rootsBy[id] } : {}),
    });
  };
  const same = (a: string | undefined, b: string): boolean => a !== undefined && a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");
  // What the foot acts on: the folder chosen in the folder browsed, else the folder browsed.
  const picked = listing?.entries.find((e) => same(selected, e.path));
  const target = picked?.path ?? listing?.dir;
  const targetName = target !== undefined ? lastOf(target) : "";
  const title = mode === "init" ? "New project" : mode === "folder" ? "Choose a folder" : "Open a project";
  const verb = mode === "init" ? "Make a project of" : mode === "folder" ? "Use" : "Open";
  const shown = view !== undefined ? { ...view, machines: view.machines.filter((m) => browsable.some((b) => b.id === m.id)) } : undefined;
  return (
    <ModalBox staged={staged} onDismiss={onClose} label={title} width={isWeb ? "min(1000px, 94vw)" : "96%"}>
      <View flexDirection="column" height={isWeb ? 600 : undefined} margin={-16} minHeight={0}>
        <View paddingVertical={14} paddingHorizontal={20} {...(edge(t, { bottom: 1 }) as object)}>
          <Txt spec={{ voice: "app", scale: 15 / 12.5, weight: 700 }}>{title}</Txt>
        </View>
        <View flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0}>
          <Column>
            {shown !== undefined ? (
              <MachinePlaces
                machines={shown}
                chosen={machine.id}
                at={listing?.dir}
                placesOf={placesOf}
                onMachine={(id) => {
                  setSelected(undefined);
                  setJump(undefined);
                  setMachineId(id);
                }}
                onPlace={(id, dir) => {
                  if (id !== machine.id) setMachineId(id);
                  setSelected(undefined);
                  setJump((j) => ({ dir, n: (j?.n ?? 0) + 1 }));
                }}
              />
            ) : (
              browsable.map((m) => <PlaceRow key={m.id} label={m.label} chosen={m.id === machine.id} onPress={() => setMachineId(m.id)} />)
            )}
          </Column>
          <View flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} gap={10} paddingVertical={14} paddingHorizontal={18}>
            <ColumnBrowser
              key={machine.id}
              machineId={machine.id}
              self={false}
              label={machine.label}
              start={machine.id === firstMachine.current ? startDir : undefined}
              jump={jump}
              chosen={selected}
              chipOf={(e) => (groups.length > 0 && selfId !== undefined ? folderChip(e, machine.id, groups, selfId) : e.project ? "JaiRA project" : e.git ? "git" : undefined)}
              onChoose={(f) => setSelected(f.path)}
              onListing={(l) => {
                setListing(l);
                setRootsBy((was) => (was[machine.id]?.join("\n") === l.roots.join("\n") ? was : { ...was, [machine.id]: l.roots }));
              }}
              detail={(focus, open, narrow) => (
                <FolderDetail
                  focus={focus}
                  narrow={narrow}
                  pill={focus.project ? { text: "JaiRA project", tone: "accent" } : focus.git ? { text: "git", tone: "dim" } : undefined}
                  lines={
                    <Txt spec={{ voice: "app", scale: 11.5 / 12.5, lineHeight: 1.45, color: "dim" }}>
                      {mode === "folder"
                        ? "New workspaces go in a folder of their own inside it."
                        : focus.project
                          ? "Already a JaiRA project: it opens as it is."
                          : focus.git
                            ? "A git clone: it is set up as a project where it is."
                            : "A folder: it is set up as a project where it is."}
                    </Txt>
                  }
                  actions={
                    open !== undefined ? (
                      <Button kind="ghost" onPress={open}>
                        Open ›
                      </Button>
                    ) : undefined
                  }
                />
              )}
              hint={
                <Txt spec={{ voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "dim" }} padding={4}>
                  {`Folders on ${machine.label}, read by its engine. A press chooses a folder; › or a second press goes in.${mode === "open" ? " A folder that is not a project yet can be set up there." : ""}`}
                </Txt>
              }
            />
          </View>
        </View>
        <View flexDirection="row" alignItems="center" gap={8} paddingVertical={12} paddingHorizontal={20} {...(edge(t, { top: 1 }) as object)}>
          <View flexGrow={1} />
          <Button kind="ghost" onPress={onClose}>
            Cancel
          </Button>
          <Button kind="primary" disabled={target === undefined} onPress={() => target !== undefined && onChosen(machine, target)}>
            {target !== undefined ? `${verb} ${targetName} on ${machine.label}` : verb}
          </Button>
        </View>
      </View>
    </ModalBox>
  );
}
