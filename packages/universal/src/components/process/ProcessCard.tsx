import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { ScrollView } from "react-native";
import { View } from "@tamagui/core";
import type { CommandDialect, ProcessSummary } from "@jaira/shared/browser";
import { processEnded } from "@jaira/shared/browser";
import { processes } from "@jaira/ui/processStore";
import { terminals } from "@jaira/ui/terminalStore";
import { TERM_INK, TermScreen } from "@jaira/ui/terminalModel";
import { Txt } from "../../primitives";
import { TerminalView } from "../terminal/TerminalView";

/**
 * THE SEAM (decision 0032, ruling 1): the card a process is drawn as, in its task view and wherever a
 * pane or the side panel holds it. The card itself — ports, readings, load trace, "Tell Claude when it
 * prints…", Stop and the places — is the terminal card's (`components/terminal/`), built beside this;
 * here it is the terminal as it stands (`TerminalView`, filling), for a process with one, and for one
 * without (left running, escaped, Claude's own, watched) a read-only follow of what `process:read` can
 * read. Replace the body of this one component with the process card when it lands; its props are what
 * every caller has.
 */
export function ProcessCard({ process, project, fill = true }: { process: ProcessSummary; project?: string | undefined; fill?: boolean }): JSX.Element {
  if (process.terminal !== undefined && process.taskId !== undefined) {
    return <TerminalView taskId={process.taskId} project={project ?? process.project} callId={process.terminal} command={process.command} dialect={dialectOf(process)} fill={fill} />;
  }
  return <ProcessFollow process={process} project={project ?? process.project} />;
}

/** The dialect its terminal was started in, as the terminals store knows it; else this machine's shell's. */
function dialectOf(process: ProcessSummary): CommandDialect {
  const known = process.taskId !== undefined && process.terminal !== undefined ? terminals.get(process.taskId, process.terminal)?.summary.dialect : undefined;
  if (known !== undefined) return known;
  return /powershell|pwsh/i.test(process.command) ? "powershell" : "posix";
}

const FOLLOW_MS = 1500;

/**
 * What a process with no terminal printed, followed read-only (`process:read` from its offset, every
 * moment while it runs): the screen's ground and ink, no input line. Where nothing can be read, why.
 */
function ProcessFollow({ process, project }: { process: ProcessSummary; project: string | undefined }): JSX.Element {
  const screen = useMemo(() => new TermScreen(), [process.key]);
  const [version, setVersion] = useState(0);
  const [why, setWhy] = useState<string | null>(null);
  const offset = useRef<number | undefined>(undefined);
  const live = !processEnded(process.state);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (): void => {
      void processes
        .read(process.key, offset.current, project)
        .then((answer) => {
          if (stopped) return;
          offset.current = answer.offset;
          if (answer.output.length > 0) {
            screen.write(answer.output);
            setVersion((v) => v + 1);
          }
          setWhy(answer.source === "unreadable" ? (answer.why ?? "its output cannot be read") : null);
        })
        .catch((e: unknown) => !stopped && setWhy((e as Error).message))
        .finally(() => {
          if (!stopped && live) timer = setTimeout(read, FOLLOW_MS);
        });
    };
    read();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [process.key, project, live, screen]);
  const text = useMemo(() => screen.plain(), [screen, version]);
  return (
    <View flex={1} minHeight={0} backgroundColor={TERM_INK.ground as never}>
      <View flexDirection="row" alignItems="center" gap={8} paddingHorizontal={14} paddingVertical={6}>
        <Txt spec={{ voice: "data", scale: 11 / 12, color: TERM_INK.dim }} ellip flex={1} minWidth={0}>
          {why !== null ? `Not following: ${why}` : `Following ${process.output.source === "file" ? (process.output.path ?? "its file") : process.output.source === "console" ? "its console" : "its output"} · read-only`}
        </Txt>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 10 }}>
        <Txt spec={{ voice: "data", scale: 11.5 / 12, color: TERM_INK.text, lineHeight: { px: 19 } }} whiteSpace="pre-wrap">
          {text.length > 0 ? text : why === null ? "Nothing printed yet." : ""}
        </Txt>
      </ScrollView>
    </View>
  );
}
