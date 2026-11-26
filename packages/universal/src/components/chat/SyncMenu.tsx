import { useEffect, useState, type JSX } from "react";
import { ScrollView, useWindowDimensions } from "react-native";
import { View } from "@tamagui/core";
import type { WorkspaceCommit, WorkspaceSync, WorkspaceSyncAction } from "@jaira/shared/browser";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { invoke } from "@jaira/ui/store";
import { Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { MenuLayer } from "../MenuLayer";
import { Float } from "../floats/Float";
import { Button } from "../settings/Button";
import { ago } from "./BranchMenu";
import { Spinner } from "./Spinner";

/**
 * The sync menu the bar's `↑n ↓m` opens (the person, 2026-11-25: "the section for commits ahead/behind
 * should be able to be interacted with"): the commits a push would send and those a pull would bring,
 * and the one that does it. It reads what the checkout knows at once, then asks the remote (a fetch)
 * and reads again — the ↓ is only as new as the last fetch. A branch that has diverged is pulled by
 * rebasing its own commits on top or by a merge, the person's choice; git's refusal is said in its
 * words. How it looks:
 *
 *   the menu           under the counts, its end edges lined up, 8 apart; 380 wide (the window less 32 at
 *                      most); padding 6; 1px --line, radius 12, --panel, --lift
 *   the head           row, gap 8, padding 6 9: `branch → upstream` app 11.5/12.5 --dim; pushed right,
 *                      while the remote is asked, the spinner 11 and `fetching`
 *   a section          a caption, data 9.5/12 uppercase --dim, padding 8 9 4: `To push · n`, `To pull · n`
 *   a commit           row, gap 8, padding 4 9: its short hash data 11/12 --dim, its subject app 12/12.5,
 *                      when --dim 11/12.5 pushed right
 *   the foot           a --line over it, 6 above; what stands (app 11.5/12.5 --dim, --bad for a refusal),
 *                      then the buttons on one row, pushed right
 */
export function SyncMenu({ anchor, project, onClose }: { anchor: FloatRect; project: string; onClose: () => void }): JSX.Element {
  const t = useTokens();
  const win = useWindowDimensions();
  const [sync, setSync] = useState<WorkspaceSync | { error: string } | undefined>(undefined);
  const [fetching, setFetching] = useState(true);
  const [working, setWorking] = useState<WorkspaceSyncAction | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const said = (e: unknown): { error: string } => ({ error: e instanceof Error ? e.message : String(e) });
    // What the checkout knows now, then what the remote says.
    invoke("workspace:sync", { project }).then(
      (now) => live && setSync((was) => (was === undefined ? now : was)),
      (e: unknown) => live && setSync((was) => (was === undefined ? said(e) : was)),
    );
    invoke("workspace:sync", { project, fetch: true })
      .then(
        (now) => live && setSync(now),
        (e: unknown) => live && setSync(said(e)),
      )
      .finally(() => live && setFetching(false));
    return () => {
      live = false;
    };
  }, [project]);

  const run = (action: WorkspaceSyncAction): void => {
    setWorking(action);
    setFailed(undefined);
    invoke("workspace:syncRun", { project, action }).then(
      () => onClose(),
      (e: unknown) => {
        setWorking(undefined);
        setFailed(e instanceof Error ? e.message : String(e));
      },
    );
  };

  const caption = (text: string): JSX.Element => (
    <Txt spec={{ voice: "data", scale: 9.5 / 12, color: "dim", tracking: 0.09 }} paddingTop={8} paddingHorizontal={9} paddingBottom={4} {...({ textTransform: "uppercase" } as object)}>
      {text}
    </Txt>
  );
  const commit = (c: WorkspaceCommit): JSX.Element => (
    <View key={c.hash} flexDirection="row" alignItems="center" gap={8} paddingVertical={4} paddingHorizontal={9} {...({ title: [c.subject, c.author].filter((x) => x !== undefined).join(" — ") } as object)}>
      <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }} flexShrink={0}>
        {c.short}
      </Txt>
      <Txt spec={{ voice: "app", scale: 12 / 12.5 }} ellip flexShrink={1} minWidth={0} flexGrow={1}>
        {c.subject}
      </Txt>
      {c.at !== undefined ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} flexShrink={0}>
          {ago(c.at)}
        </Txt>
      ) : null}
    </View>
  );
  const more = (shown: number, count: number): JSX.Element | null =>
    count > shown ? (
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} paddingVertical={4} paddingHorizontal={9}>
        {`and ${count - shown} more`}
      </Txt>
    ) : null;
  const words = (text: string, tone: "dim" | "bad" = "dim"): JSX.Element => (
    <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: tone, lineHeight: 1.4 }} {...({ style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } } as object)}>
      {text}
    </Txt>
  );

  const body = (s: WorkspaceSync): JSX.Element => {
    const up = s.upstream ?? "its upstream";
    const diverged = s.aheadCount > 0 && s.behindCount > 0;
    const busy = working !== undefined || fetching;
    return (
      <>
        <View flexDirection="row" alignItems="center" gap={8} paddingVertical={6} paddingHorizontal={9}>
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }} ellip flexShrink={1} minWidth={0}>
            {s.upstream !== undefined ? `${s.branch ?? "HEAD"} → ${s.upstream}` : (s.branch ?? "a detached HEAD")}
          </Txt>
          {fetching ? (
            <View flexDirection="row" alignItems="center" gap={5} marginLeft="auto" flexShrink={0}>
              <Spinner size={11} color={String(t.v("dim"))} />
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>fetching</Txt>
            </View>
          ) : null}
        </View>
        <ScrollView style={{ maxHeight: Math.max(160, win.height - anchor.bottom - 180) } as never}>
          {s.aheadCount > 0 ? caption(`To push · ${s.aheadCount}`) : null}
          {s.ahead.map(commit)}
          {more(s.ahead.length, s.aheadCount)}
          {s.behindCount > 0 ? caption(`To pull · ${s.behindCount}`) : null}
          {s.behind.map(commit)}
          {more(s.behind.length, s.behindCount)}
        </ScrollView>
        <View {...(edge(t, { top: 1 }) as object)} marginTop={6} paddingTop={8} paddingHorizontal={9} paddingBottom={4} gap={8}>
          {s.upstream === undefined
            ? words(s.branch !== undefined ? `${s.branch} has no upstream: it has not been pushed anywhere to compare with.` : "A detached HEAD has no upstream to compare with.")
            : s.aheadCount === 0 && s.behindCount === 0
              ? words(fetching ? `Up to date with ${up}, as of the last fetch.` : `Up to date with ${up}.`)
              : diverged
                ? words(`${s.branch ?? "This branch"} and ${up} have each gone their own way: pull before pushing — your ${s.aheadCount === 1 ? "commit" : `${s.aheadCount} commits`} on top of theirs, or joined by a merge.`)
                : null}
          {s.fetchFailed !== undefined ? words(`Could not fetch: ${s.fetchFailed}`, "bad") : null}
          {failed !== undefined ? words(failed, "bad") : null}
          {s.upstream !== undefined && (s.aheadCount > 0 || s.behindCount > 0) ? (
            <View flexDirection="row" flexWrap="wrap" justifyContent="flex-end" gap={6}>
              {diverged ? (
                <>
                  <Button onPress={() => run("pull-merge")} disabled={busy} title={`git pull --no-rebase: a merge commit joins ${up} into ${s.branch ?? "this branch"}`}>
                    {working === "pull-merge" ? "Merging…" : "Pull with a merge"}
                  </Button>
                  <Button kind="primary" onPress={() => run("pull-rebase")} disabled={busy} title={`git pull --rebase --autostash: your commits are replayed on top of ${up}`}>
                    {working === "pull-rebase" ? "Rebasing…" : "Pull, mine on top"}
                  </Button>
                </>
              ) : s.behindCount > 0 ? (
                <Button kind="primary" onPress={() => run("pull-ff")} disabled={busy} title="git pull --ff-only">
                  {working === "pull-ff" ? "Pulling…" : `Pull ${s.behindCount === 1 ? "1 commit" : `${s.behindCount} commits`}`}
                </Button>
              ) : (
                <Button kind="primary" onPress={() => run("push")} disabled={working !== undefined} title={`git push to ${up}`}>
                  {working === "push" ? "Pushing…" : `Push ${s.aheadCount === 1 ? "1 commit" : `${s.aheadCount} commits`}`}
                </Button>
              )}
            </View>
          ) : null}
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
        width={Math.min(380, win.width - 32)}
        padding={6}
        borderWidth={1}
        borderStyle="solid"
        borderColor={t.v("line") as never}
        borderRadius={12}
        backgroundColor={t.v("panel") as never}
        {...({ boxShadow: String(t.v("lift")), role: "dialog", "aria-label": "Push and pull" } as object)}
      >
        {sync === undefined ? (
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }} padding={9}>
            Reading the branch…
          </Txt>
        ) : "error" in sync ? (
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "bad", lineHeight: 1.4 }} padding={9}>
            {sync.error}
          </Txt>
        ) : (
          body(sync)
        )}
      </Float>
    </MenuLayer>
  );
}
