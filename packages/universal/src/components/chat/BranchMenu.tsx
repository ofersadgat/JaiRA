import { useEffect, useMemo, useState, type JSX } from "react";
import { ScrollView, useWindowDimensions } from "react-native";
import { View } from "@tamagui/core";
import type { WorkspaceBranch, WorkspaceBranches, WorkspaceSwitchResult } from "@jaira/shared/browser";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { invoke } from "@jaira/ui/store";
import { Press, Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { MenuLayer } from "../MenuLayer";
import { Float } from "../floats/Float";
import { Icon } from "../panel/Icon";
import { Button } from "../settings/Button";
import { TextField } from "../settings/fields";

/** What the switch is to: a branch of the checkout's, a remote's, or a new one. */
interface Pick {
  branch: string;
  create: boolean;
  /** The branch the checkout ends up on, for the words: `origin/x` makes `x`. */
  lands: string;
}

/**
 * The branch menu the bar's branch opens (the person, 2026-11-20: "the branch label … should also
 * allow you to click on it to switch branches of that workspace"): the workspace's own branches, the
 * remotes' none of its own tracks, and a field that finds one or names a new one. A switch with
 * uncommitted changes asks what becomes of them first — brought along (git refuses, naming the files,
 * where it cannot) or stashed (the person: "if dirty, ask the user what to do") — and one with other
 * conversations at work in the workspace says so before it changes the files under them. How it looks:
 *
 *   the menu           under the branch, its end edges lined up, 8 apart; 360 wide (the window less 32
 *                      at most); padding 6; 1px --line, radius 12, --panel, --lift
 *   the field          the top row: `Find or name a branch`
 *   a section          a caption, data 9.5/12 uppercase --dim, padding 8 9 4: `On this checkout`,
 *                      `From the remote`
 *   a branch           row, gap 8, padding 5 9, radius 7: the branch glyph 13, its name app 12/12.5 (600
 *                      for the one it is on), when its last commit was and its subject --dim, a ✓ on the
 *                      one it is on; hovered --fill-ghost-hover
 *   `New branch`       a row like a branch, `+` for the glyph: `New branch ‘{name}’ from here`
 *   the question       in place of the list: what stands in the way, in app 12/12.5, the files in data
 *                      11/12 --dim, then its buttons on one row, pushed right
 */
export function BranchMenu({ anchor, project, workspace, asking, onClose }: { anchor: FloatRect; project: string; /** The workspace's folder name, for the words. */ workspace: string; asking?: string | undefined; onClose: () => void }): JSX.Element {
  const t = useTokens();
  const win = useWindowDimensions();
  const [list, setList] = useState<WorkspaceBranches | { error: string } | undefined>(undefined);
  const [find, setFind] = useState("");
  const [asked, setAsked] = useState<{ pick: Pick; dirty: string[]; dirtyCount: number; busy: WorkspaceBranches["busy"] } | undefined>(undefined);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  useEffect(() => {
    invoke("workspace:branches", { project, ...(asking !== undefined ? { asking } : {}) }).then(setList, (e: unknown) => setList({ error: e instanceof Error ? e.message : String(e) }));
  }, [project, asking]);

  const go = (pick: Pick, dirty?: "carry" | "stash"): void => {
    setWorking(true);
    setFailed(undefined);
    invoke("workspace:switchBranch", { project, branch: pick.branch, ...(pick.create ? { create: true } : {}), ...(dirty !== undefined ? { dirty } : {}), ...(asking !== undefined ? { asking } : {}) }).then(
      (result: WorkspaceSwitchResult) => {
        setWorking(false);
        if (result.switched) onClose();
        // Changed since the list was read: asked now.
        else setAsked({ pick, dirty: result.dirty, dirtyCount: result.dirtyCount, busy: asked?.busy ?? [] });
      },
      (e: unknown) => {
        setWorking(false);
        setFailed(e instanceof Error ? e.message : String(e));
      },
    );
  };
  const choose = (pick: Pick): void => {
    if (list === undefined || "error" in list) return;
    if (!pick.create && pick.branch === list.current) return onClose();
    if (list.dirtyCount > 0 || list.busy.length > 0) setAsked({ pick, dirty: list.dirty, dirtyCount: list.dirtyCount, busy: list.busy });
    else go(pick);
  };

  const query = find.trim();
  const shown = useMemo(() => {
    if (list === undefined || "error" in list) return { local: [], remote: [] };
    const has = (b: WorkspaceBranch): boolean => query === "" || b.name.toLowerCase().includes(query.toLowerCase());
    return { local: list.local.filter(has), remote: list.remote.filter(has) };
  }, [list, query]);
  const exists = list !== undefined && !("error" in list) && [...list.local, ...list.remote].some((b) => b.name === query || b.name.endsWith(`/${query}`));
  const canMake = query !== "" && !exists && /^[^\s~^:?*[\\]+$/.test(query) && !query.startsWith("-");

  const caption = (text: string): JSX.Element => (
    <Txt spec={{ voice: "data", scale: 9.5 / 12, color: "dim", tracking: 0.09 }} paddingTop={8} paddingHorizontal={9} paddingBottom={4} {...({ textTransform: "uppercase" } as object)}>
      {text}
    </Txt>
  );
  const row = (b: WorkspaceBranch, remote: boolean): JSX.Element => {
    const on = !remote && list !== undefined && !("error" in list) && list.current === b.name;
    const lands = remote ? b.name.slice(b.name.indexOf("/") + 1) : b.name;
    return (
      <Press
        key={`${remote ? "r" : "l"}:${b.name}`}
        onPress={() => choose({ branch: b.name, create: false, lands })}
        disabled={working}
        {...({ role: "option", "aria-selected": on } as object)}
        title={b.subject ?? b.name}
        flexDirection="row"
        alignItems="center"
        gap={8}
        paddingVertical={5}
        paddingHorizontal={9}
        borderRadius={7}
        box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
      >
        <Icon name="git" size={13} color={String(t.v("dim"))} />
        <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: on ? 600 : 400 }} ellip flexShrink={1} minWidth={0}>
          {b.name}
        </Txt>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} ellip flexShrink={2} minWidth={0} flexGrow={1}>
          {[b.at !== undefined ? ago(b.at) : undefined, b.subject].filter((x) => x !== undefined).join(" · ")}
        </Txt>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "accent" }} width={12} textAlign="center" flexShrink={0}>
          {on ? "✓" : ""}
        </Txt>
      </Press>
    );
  };

  const question = (q: NonNullable<typeof asked>): JSX.Element => {
    const others = q.busy.length;
    return (
      <View gap={10} padding={10}>
        {others > 0 ? (
          <Txt spec={{ voice: "app", scale: 12 / 12.5, lineHeight: 1.4 }}>
            {`${others === 1 ? "Another conversation is" : `${others} other conversations are`} at work in ${workspace}: ${q.busy
              .slice(0, 3)
              .map((b) => `‘${b.title}’`)
              .join(", ")}${others > 3 ? "…" : ""}. Switching to ${q.pick.lands} changes the files under ${others === 1 ? "it" : "them"}.`}
          </Txt>
        ) : null}
        {q.dirtyCount > 0 ? (
          <>
            <Txt spec={{ voice: "app", scale: 12 / 12.5, lineHeight: 1.4 }}>
              {`${q.dirtyCount === 1 ? "1 file is" : `${q.dirtyCount} files are`} not committed in ${workspace}. What becomes of ${q.dirtyCount === 1 ? "it" : "them"} on ${q.pick.lands}?`}
            </Txt>
            <View gap={1}>
              {q.dirty.slice(0, 6).map((path) => (
                <Txt key={path} spec={{ voice: "data", scale: 11 / 12, color: "dim" }} ellip>
                  {path}
                </Txt>
              ))}
              {q.dirtyCount > 6 ? <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }}>{`and ${q.dirtyCount - 6} more`}</Txt> : null}
            </View>
          </>
        ) : null}
        {failed !== undefined ? (
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "bad", lineHeight: 1.4 }} {...({ style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } } as object)}>
            {failed}
          </Txt>
        ) : null}
        <View flexDirection="row" flexWrap="wrap" justifyContent="flex-end" gap={6}>
          <Button kind="ghost" onPress={() => setAsked(undefined)} disabled={working}>
            Cancel
          </Button>
          {q.dirtyCount > 0 ? (
            <>
              <Button onPress={() => go(q.pick, "stash")} disabled={working} title="Put them on git's stash, then switch">
                Stash them, then switch
              </Button>
              <Button kind="primary" onPress={() => go(q.pick, "carry")} disabled={working} title="git brings them along where it can; where it cannot, nothing moves">
                {`Bring them to ${q.pick.lands}`}
              </Button>
            </>
          ) : (
            <Button kind="primary" onPress={() => go(q.pick)} disabled={working}>
              Switch anyway
            </Button>
          )}
        </View>
      </View>
    );
  };

  return (
    <MenuLayer onClose={onClose}>
      <Float
        anchor={anchor}
        side="below"
        align="end"
        offset={8}
        width={Math.min(360, win.width - 32)}
        padding={6}
        borderWidth={1}
        borderStyle="solid"
        borderColor={t.v("line") as never}
        borderRadius={12}
        backgroundColor={t.v("panel") as never}
        {...({ boxShadow: String(t.v("lift")), role: "listbox", "aria-label": `Branches of ${workspace}` } as object)}
      >
        {asked !== undefined ? (
          question(asked)
        ) : (
          <>
            <View padding={4}>
              <TextField value={find} onChange={setFind} placeholder="Find or name a branch" label="Find or name a branch" onSubmit={() => (canMake ? choose({ branch: query, create: true, lands: query }) : shown.local[0] !== undefined ? choose({ branch: shown.local[0].name, create: false, lands: shown.local[0].name }) : undefined)} />
            </View>
            {list === undefined ? (
              <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }} padding={9}>
                Reading the branches…
              </Txt>
            ) : "error" in list ? (
              <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "bad", lineHeight: 1.4 }} padding={9}>
                {list.error}
              </Txt>
            ) : (
              <ScrollView style={{ maxHeight: Math.max(160, win.height - anchor.bottom - 120) } as never}>
                {canMake ? (
                  <Press onPress={() => choose({ branch: query, create: true, lands: query })} disabled={working} flexDirection="row" alignItems="center" gap={8} paddingVertical={5} paddingHorizontal={9} borderRadius={7} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}>
                    <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }} width={13} textAlign="center">
                      +
                    </Txt>
                    <Txt spec={{ voice: "app", scale: 12 / 12.5 }} ellip flexShrink={1} minWidth={0}>{`New branch ‘${query}’ from here`}</Txt>
                  </Press>
                ) : null}
                {shown.local.length > 0 ? caption("On this checkout") : null}
                {shown.local.map((b) => row(b, false))}
                {shown.remote.length > 0 ? caption("From the remote") : null}
                {shown.remote.map((b) => row(b, true))}
                {shown.local.length === 0 && shown.remote.length === 0 && !canMake ? (
                  <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }} padding={9}>
                    No branch by that name.
                  </Txt>
                ) : null}
              </ScrollView>
            )}
            {failed !== undefined ? (
              <View {...(edge(t, { top: 1 }) as object)} marginTop={6} paddingTop={6}>
                <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "bad", lineHeight: 1.4 }} padding={9} {...({ style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } } as object)}>
                  {failed}
                </Txt>
              </View>
            ) : null}
          </>
        )}
      </Float>
    </MenuLayer>
  );
}

/** How long ago, in one short word: `now`, `5m`, `3h`, `2d`, `4w`, `1y`. */
function ago(at: number): string {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  if (s < 365 * 86_400) return `${Math.floor(s / (7 * 86_400))}w`;
  return `${Math.floor(s / (365 * 86_400))}y`;
}
