import { useEffect, useState, type JSX } from "react";
import { ScrollView, useWindowDimensions } from "react-native";
import { View } from "@tamagui/core";
import type { WorkspaceChanges } from "@jaira/shared/browser";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { invoke } from "@jaira/ui/store";
import { Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { MenuLayer } from "../MenuLayer";
import { Float } from "../floats/Float";
import { ChangedFiles } from "../panel/ChangesPanel";
import { Button } from "../settings/Button";
import { TextField } from "../settings/fields";

/**
 * The changes menu the bar's `+a −d` opens (the person, 2026-11-25: "the section for additions/removals
 * [should be able to be interacted with]"): every file changed, new or removed since the last commit,
 * drawn as a task's Changes panel draws files — folders that fold, a file's lines a press away — and
 * under them a commit of all of it, or all of it put on the stash. The bar's count leaves out files git
 * does not track yet; the menu lists them. How it looks:
 *
 *   the menu           under the counts, its end edges lined up, 8 apart; 560 wide (the window less 32 at
 *                      most); padding 6; 1px --line, radius 12, --panel, --lift
 *   the head           a caption, data 9.5/12 uppercase --dim, padding 8 9 4: `Uncommitted · n files`
 *   the files          `ChangedFiles`, scrolling past the room under the bar
 *   the foot           a --line over it, 6 above, padding 8 9 4, gap 8: the message field, then on one
 *                      row pushed right `Stash` and `Commit all`; a refusal over them, --bad
 */
export function ChangesMenu({ anchor, project, onClose }: { anchor: FloatRect; project: string; onClose: () => void }): JSX.Element {
  const t = useTokens();
  const win = useWindowDimensions();
  const [changes, setChanges] = useState<WorkspaceChanges | { error: string } | undefined>(undefined);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState<"commit" | "stash" | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    invoke("workspace:changes", { project }).then(
      (now) => live && setChanges(now),
      (e: unknown) => live && setChanges({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [project]);

  const run = (what: "commit" | "stash"): void => {
    if (what === "commit" && message.trim() === "") return;
    setWorking(what);
    setFailed(undefined);
    (what === "commit" ? invoke("workspace:commit", { project, message }) : invoke("workspace:stash", { project })).then(
      () => onClose(),
      (e: unknown) => {
        setWorking(undefined);
        setFailed(e instanceof Error ? e.message : String(e));
      },
    );
  };

  const body = (c: WorkspaceChanges): JSX.Element => {
    if (c.count === 0)
      return (
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }} padding={9}>
          Nothing uncommitted.
        </Txt>
      );
    return (
      <>
        <Txt spec={{ voice: "data", scale: 9.5 / 12, color: "dim", tracking: 0.09 }} paddingTop={8} paddingHorizontal={9} paddingBottom={4} {...({ textTransform: "uppercase" } as object)}>
          {`Uncommitted · ${c.count === 1 ? "1 file" : `${c.count} files`}`}
        </Txt>
        <ScrollView style={{ maxHeight: Math.max(180, win.height - anchor.bottom - 220) } as never}>
          <ChangedFiles files={c.files} />
          {c.count > c.files.length ? (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} paddingVertical={4} paddingHorizontal={9}>
              {`and ${c.count - c.files.length} more`}
            </Txt>
          ) : null}
        </ScrollView>
        <View {...(edge(t, { top: 1 }) as object)} marginTop={6} paddingTop={8} paddingHorizontal={9} paddingBottom={4} gap={8}>
          {c.unborn === true ? (
            <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim", lineHeight: 1.4 }}>No commit yet: these are every file there is.</Txt>
          ) : null}
          <TextField value={message} onChange={setMessage} placeholder="Commit message" label="Commit message" width="100%" disabled={working !== undefined} onSubmit={() => run("commit")} autoFocus />
          {failed !== undefined ? (
            <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "bad", lineHeight: 1.4 }} {...({ style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } } as object)}>
              {failed}
            </Txt>
          ) : null}
          <View flexDirection="row" flexWrap="wrap" justifyContent="flex-end" gap={6}>
            {c.unborn !== true ? (
              <Button onPress={() => run("stash")} disabled={working !== undefined} title="git stash push --include-untracked: put all of it aside, to bring back later">
                {working === "stash" ? "Stashing…" : "Stash"}
              </Button>
            ) : null}
            <Button kind="primary" onPress={() => run("commit")} disabled={working !== undefined || message.trim() === ""} title="git add --all, then git commit">
              {working === "commit" ? "Committing…" : "Commit all"}
            </Button>
          </View>
        </View>
      </>
    );
  };

  return (
    <MenuLayer onClose={onClose}>
      <Float
        anchor={anchor}
        side="below"
        align="end"
        offset={8}
        width={Math.min(560, win.width - 32)}
        padding={6}
        borderWidth={1}
        borderStyle="solid"
        borderColor={t.v("line") as never}
        borderRadius={12}
        backgroundColor={t.v("panel") as never}
        {...({ boxShadow: String(t.v("lift")), role: "dialog", "aria-label": "Uncommitted changes" } as object)}
      >
        {changes === undefined ? (
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }} padding={9}>
            Reading the changes…
          </Txt>
        ) : "error" in changes ? (
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "bad", lineHeight: 1.4 }} padding={9}>
            {changes.error}
          </Txt>
        ) : (
          body(changes)
        )}
      </Float>
    </MenuLayer>
  );
}
