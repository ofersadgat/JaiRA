import type { JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import type { CommandDialect } from "@jaira/shared/browser";
import { installLogHeadOf, installLogPlain, type InstallLog } from "@jaira/ui/installLog";
import { copyText } from "../../../clipboard";
import { Txt } from "../../../primitives";
import { TermLog, plainOf } from "../../terminal/TermLog";
import { IconButton } from "../../terminal/TermParts";
import { SmallButton, Spin } from "./Row";

/**
 * What an install pressed in Connections printed, under the row it installs — an agent's
 * (`AgentRows.tsx`) or a git program's (`GitRows.tsx`) — as it prints it, and after it, until Hide.
 * Drawn as the agents' terminal draws a command (decision 0028, `TermLog.tsx`): each command the
 * install ran on the terminal's ground — of several steps, which step it is — then what it printed in
 * its colours, a progress bar redrawn as its last drawing. How it looks:
 *
 *   the whole       30 in, under the sentence, as "Runs as" is
 *   the head        row, centred, gap 6: running, the spinner, "installing…" (--dim) and Cancel;
 *                   after, "installed" in --ok, "… cancelled" in --dim, or the reason it failed in
 *                   --bad, and Hide; Copy at its end
 *   the screen      under the head, 6 apart: the terminal's ground (#0f1120), radius 8, padding 8 14 10;
 *                   at most 260 tall, then it scrolls — pinned to the newest line until the reader
 *                   scrolls up, and pinned again at the bottom
 *   a command       its step (app 11, --hint ink) where there are several, then `❯` and the command
 *                   taken apart as the approval takes it, then its lines (data 11.5/12 on 19px); 10
 *                   between commands
 */
export function InstallLogBox({ log, dialect = "posix", onCancel, onHide }: { log: InstallLog; dialect?: CommandDialect; onCancel: () => void; onHide: () => void }): JSX.Element {
  const head = installLogHeadOf(log);
  const color = head.tone === "ok" ? "ok" : head.tone === "failed" ? "bad" : "dim";
  return (
    <View marginLeft={30} flexDirection="column" gap={6} minWidth={0} {...({ role: "log", "aria-live": "polite", "aria-label": "install output" } as object)}>
      <View flexDirection="row" alignItems="center" gap={6} minHeight={24}>
        {log.running ? <Spin /> : null}
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, lineHeight: 1.4, color }} flexShrink={1} minWidth={0} {...((isWeb ? { style: { overflowWrap: "anywhere" } } : {}) as object)}>
          {head.words}
        </Txt>
        {log.running ? (
          <SmallButton kind="ghost" title="stop the installer" onPress={onCancel}>
            Cancel
          </SmallButton>
        ) : (
          <SmallButton kind="ghost" title="put the output away" onPress={onHide}>
            Hide
          </SmallButton>
        )}
        <View flex={1} />
        <IconButton icon="copy" label="Copy the output" onPress={() => void copyText(installLogPlain(log, plainOf))} />
      </View>
      <TermLog blocks={log.blocks} dialect={dialect} reset={log.blocks.length === 0} maxHeight={260} />
    </View>
  );
}
