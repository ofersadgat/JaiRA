import { useEffect, useState, type JSX } from "react";
import { View } from "@tamagui/core";
import { agentShellProblem } from "@jaira/shared/browser";
import { FormInput } from "../../form/inputs";
import { Txt } from "../../../primitives";
import { Segmented } from "../controls";

/**
 * The shell an agent's commands run in (decision 0030), on its opened row: `Emulated` (the default) or
 * `Live shell` with the path of a zsh, bash or sh. How it looks:
 *
 *   the column     gap 6, up to 520 wide
 *   the choice     the settings' segmented control: `Emulated` | `Live shell`
 *   the path       a mono text box (`/bin/zsh`), shown while `Live shell` is chosen, written when it
 *                  is left or ⏎ is pressed; a path that is not a zsh, bash or sh says why in --bad
 *   the words      app 11.5/12.5 --dim: what carries over in the shell chosen
 */
export function ShellChoice({ here, merged, locked, onWrite }: { here: unknown; merged: unknown; locked: boolean; onWrite: (shell: string | undefined) => void }): JSX.Element {
  const saved = typeof merged === "string" && merged !== "emulated" ? merged : undefined;
  const [live, setLive] = useState(saved !== undefined);
  const [path, setPath] = useState(saved ?? "/bin/zsh");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  useEffect(() => {
    setLive(saved !== undefined);
    if (saved !== undefined) setPath(saved);
  }, [saved]);

  const commit = (next: string): void => {
    const why = agentShellProblem(next);
    setProblem(why);
    if (why === undefined && next !== saved) onWrite(next);
  };

  return (
    <View flexDirection="column" gap={6} maxWidth={520} minWidth={0}>
      <Segmented
        value={live ? "live" : "emulated"}
        label="the shell this agent's commands run in"
        disabled={locked}
        options={[
          ["Emulated", "emulated"],
          ["Live shell", "live"],
        ]}
        onChange={(next) => {
          if (next === "live") {
            setLive(true);
            commit(path);
            return;
          }
          setLive(false);
          setProblem(undefined);
          // Set in this layer: taken out. Inherited from another: overridden.
          if (typeof here === "string") onWrite(undefined);
          else if (saved !== undefined) onWrite("emulated");
        }}
      />
      {live ? (
        <View width={300} maxWidth="100%">
          <FormInput
            value={path}
            mono
            label="the path of the live shell: a zsh, bash or sh"
            placeholder="/bin/zsh"
            disabled={locked}
            bad={problem !== undefined}
            suggest={[{ value: "/bin/zsh" }, { value: "/bin/bash" }, { value: "/bin/sh" }]}
            onChange={setPath}
            onBlur={() => commit(path)}
            onSubmit={() => commit(path)}
          />
        </View>
      ) : null}
      {problem !== undefined ? (
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "bad" }}>The shell {problem}.</Txt>
      ) : null}
      <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>
        {live
          ? "One live shell per conversation: cd, variables, aliases and functions carry over between commands. Closed after 5 idle minutes and started again where it was, and the agent is told. macOS and Linux; in WSL, a container or on Windows the emulated shell is used."
          : "Each command runs on its own and starts where the last one ended, so cd carries over; variables and aliases do not."}
      </Txt>
    </View>
  );
}
