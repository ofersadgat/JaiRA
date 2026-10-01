import { useState, type JSX } from "react";
import { Pressable, TextInput } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import { useTokens } from "../tokens";

/**
 * Where a phone or a browser says which machine it is a window onto (decisions 0015, and 0013 as
 * amended 2026-09-30): the machine's address and the one-time code it shows under Settings → Machines →
 * Pair a machine. Pairing happens once; after it the device keeps the machine's token and this screen
 * is only passed through — "Connecting to desk" — unless the machine cannot be reached, where it says
 * why and offers to forget it.
 *
 * The same screen on both: it draws and asks, and its host (`packages/client/src/Remote.tsx`) pairs,
 * keeps and connects.
 */
export interface ConnectProps {
  /** The machine this device is already paired with, while it is being connected to. */
  saved?: { label: string; address: string };
  /** What the fields start with: the page's own origin in a browser, a link's address and code. */
  initial?: { address?: string; code?: string };
  /** Why pairing or connecting has not worked, in the machine's or the bridge's words. */
  problem?: string | null;
  /** Pairing now. */
  busy?: boolean;
  onPair: (address: string, code: string) => void;
  /** Stop waiting and try the saved machine now. */
  onRetry?: () => void;
  /** Forget the saved machine: its token goes, and the form comes back. */
  onForget?: () => void;
}

const sentence = (text: string): string => {
  const t = text.trim();
  const c = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(c) ? c : `${c}.`;
};

export function Connect({ saved, initial, problem, busy, onPair, onRetry, onForget }: ConnectProps): JSX.Element {
  const t = useTokens();
  const [address, setAddress] = useState(initial?.address ?? "");
  const [code, setCode] = useState(initial?.code ?? "");
  const app = { fontFamily: t.v("font-app") as string, color: t.v("text") as string };
  const field = {
    fontFamily: t.v("font-data") as string,
    fontSize: 13,
    color: t.v("text") as string,
    borderWidth: 1,
    borderColor: t.v("line") as string,
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: t.v("panel") as string,
  };
  const ready = address.trim() !== "" && code.trim() !== "" && busy !== true;
  /* Pressable, not Tamagui's onPress, which did not fire from a tap on Android. */
  const button = (label: string, onPress: () => void, kind: "primary" | "quiet", dim = false): JSX.Element => (
    <Pressable role="button" accessibilityLabel={label} onPress={onPress}>
      <View
        {...((isWeb ? { cursor: "pointer" } : {}) as object)}
        backgroundColor={(kind === "primary" ? t.v("fill-accent") : "transparent") as never}
        borderWidth={1}
        borderColor={(kind === "primary" ? t.v("fill-accent") : t.v("line")) as never}
        borderRadius={7}
        paddingVertical={7}
        alignItems="center"
        opacity={dim ? 0.6 : 1}
      >
        <Text {...(app as object)} fontSize={13} fontWeight="600" color={(kind === "primary" ? t.v("on-accent") : t.v("text")) as never}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
  const trouble = problem ? (
    <Text {...(app as object)} fontSize={13} color={t.v("bad") as never}>
      {sentence(problem)}
    </Text>
  ) : null;
  return (
    <View flex={1} backgroundColor={t.v("bg") as never} alignItems="center" justifyContent="center" padding={16}>
      {saved !== undefined ? (
        <View width="100%" maxWidth={420} gap={10}>
          <Text {...(app as object)} fontSize={15} fontWeight="600">
            {`Connecting to ${saved.label}`}
          </Text>
          <Text fontFamily={t.v("font-data") as never} fontSize={13} color={t.v("dim") as never}>
            {saved.address}
          </Text>
          {trouble}
          {onRetry !== undefined ? button("Try again", onRetry, "primary") : null}
          {onForget !== undefined ? button("Forget this machine", onForget, "quiet") : null}
        </View>
      ) : (
        <View width="100%" maxWidth={420} gap={10}>
          <Text {...(app as object)} fontSize={15} fontWeight="600">
            Connect to a JaiRA machine
          </Text>
          <Text {...(app as object)} fontSize={13} color={t.v("dim") as never}>
            On that machine, Settings → Machines → Pair a machine shows its address and a code that works once.
          </Text>
          <TextInput value={address} onChangeText={setAddress} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Address" placeholder="desk.tail4c2e.ts.net" style={field} />
          <TextInput value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} accessibilityLabel="Code" placeholder="AMBER · RIVER · 7K2P" style={field} />
          {button(busy === true ? "Pairing…" : "Pair", () => (ready ? onPair(address.trim(), code.trim()) : undefined), "primary", !ready)}
          {trouble}
        </View>
      )}
    </View>
  );
}
