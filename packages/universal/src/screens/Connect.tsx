import { useState, type JSX, type ReactNode } from "react";
import { Pressable, TextInput } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import { MachineIcon } from "../components/MachineIcon";
import { useTokens } from "../tokens";

/**
 * Where a phone or a browser says which machine it is a window onto (decisions 0015, and 0013 as
 * amended 2026-09-30 and 2026-10-04). Pairing happens once; after it the device keeps the machine's
 * token and this screen is only passed through — "Connecting to desk" — unless the machine cannot be
 * reached, where it says why and offers to forget it.
 *
 * A phone lists the machines on its Wi-Fi that are showing a pairing code (Settings → Machines → Pair a
 * machine): the person picks one and types its code, which pairs the phone and lets it onto the
 * machine's tailnet — a Tailscale page opens on the machine to approve it. The address and code form
 * stays one tap away, and is all a browser has (a page cannot look at the network).
 *
 * The same screen on both: it draws and asks, and its host (`packages/client/src/Remote.tsx`) looks,
 * pairs, keeps and connects.
 */

/** A machine showing a pairing code on this device's network. */
export interface NearbyChoice {
  key: string;
  label: string;
  /** `windows`, `mac`, `linux`: the mark on its icon. */
  os: string;
}

/** Where pairing with a machine found nearby stands. */
export type NearbyStep = "reaching" | "proving" | "joining" | "approve";

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
  /**
   * The machines nearby, on a device that can look (a phone). `problem`: why none can be found —
   * `denied` when the person refused local-network access.
   */
  nearby?: { machines: NearbyChoice[]; problem?: string };
  /** Pair with a machine found nearby, by the code it shows. */
  onPairNearby?: (key: string, code: string) => void;
  /** Pairing with a machine found nearby, while it happens. */
  pairing?: { label: string; step: NearbyStep };
  /** The phone's Tailscale wants signing in again (its key expired): the page, opened here. */
  signIn?: () => void;
}

const sentence = (text: string): string => {
  const t = text.trim();
  const c = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(c) ? c : `${c}.`;
};

/** What a step of pairing nearby says. */
export function nearbyStepWords(label: string, step: NearbyStep): string {
  switch (step) {
    case "reaching":
      return `Reaching ${label}…`;
    case "proving":
      return "Checking the code…";
    case "joining":
      return `Joining ${label}'s tailnet…`;
    case "approve":
      return `A Tailscale page opened on ${label}: approve this phone there.`;
  }
}

const markOf = (os: string): "windows" | "mac" | "linux" | undefined => (os === "windows" || os === "mac" || os === "linux" ? os : undefined);

export function Connect({ saved, initial, problem, busy, onPair, onRetry, onForget, nearby, onPairNearby, pairing, signIn }: ConnectProps): JSX.Element {
  const t = useTokens();
  const [address, setAddress] = useState(initial?.address ?? "");
  const [code, setCode] = useState(initial?.code ?? "");
  // A phone starts at the machines nearby; a link with an address, or a browser, at the form.
  const [byAddress, setByAddress] = useState(nearby === undefined || (initial?.address ?? "") !== "");
  const [picked, setPicked] = useState<NearbyChoice | undefined>(undefined);
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
  const words = (text: string, color: "text" | "dim" | "bad" = "dim"): JSX.Element => (
    <Text {...(app as object)} fontSize={13} color={t.v(color) as never}>
      {text}
    </Text>
  );
  const trouble = problem ? words(sentence(problem), "bad") : null;
  const heading = (text: string): JSX.Element => (
    <Text {...(app as object)} fontSize={15} fontWeight="600">
      {text}
    </Text>
  );

  if (saved !== undefined) {
    return (
      <Frame t={t}>
        {heading(`Connecting to ${saved.label}`)}
        <Text fontFamily={t.v("font-data") as never} fontSize={13} color={t.v("dim") as never}>
          {saved.address}
        </Text>
        {trouble}
        {signIn !== undefined ? button("Sign in to Tailscale", signIn, "primary") : null}
        {onRetry !== undefined ? button("Try again", onRetry, signIn !== undefined ? "quiet" : "primary") : null}
        {onForget !== undefined ? button("Forget this machine", onForget, "quiet") : null}
      </Frame>
    );
  }

  if (!byAddress && nearby !== undefined) {
    // A machine picked: its code.
    if (picked !== undefined) {
      const pairingThis = pairing !== undefined && pairing.label === picked.label;
      const canPair = code.trim() !== "" && !pairingThis;
      return (
        <Frame t={t}>
          <View flexDirection="row" alignItems="center" gap={8}>
            <MachineIcon face={{ shape: "desktop", ...(markOf(picked.os) !== undefined ? { mark: markOf(picked.os)! } : {}) }} size={20} ground="bg" />
            {heading(picked.label)}
          </View>
          {words(`Type the code ${picked.label} shows under Pair a machine.`)}
          <TextInput value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} autoFocus accessibilityLabel="Code" placeholder="AMBER · RIVER · 7K2P" style={field} editable={!pairingThis} />
          {button(pairingThis ? "Pairing…" : "Pair", () => (canPair ? onPairNearby?.(picked.key, code.trim()) : undefined), "primary", !canPair)}
          {pairingThis ? words(nearbyStepWords(picked.label, pairing.step), pairing.step === "approve" ? "text" : "dim") : null}
          {trouble}
          {pairingThis ? null : button("Another machine", () => setPicked(undefined), "quiet")}
        </Frame>
      );
    }
    const none =
      nearby.problem === "denied"
        ? "JaiRA may not look at this network: allow Local Network for JaiRA in Settings, then come back."
        : nearby.problem !== undefined
          ? sentence(nearby.problem)
          : "Looking on this Wi-Fi… On the machine, Settings → Machines → Pair a machine: it shows up here while its code does.";
    return (
      <Frame t={t}>
        {heading("Connect to a JaiRA machine")}
        {nearby.machines.length === 0 ? words(none, nearby.problem === undefined ? "dim" : "bad") : words("On this Wi-Fi, showing a code:")}
        {nearby.machines.map((machine) => (
          <Pressable key={machine.key} role="button" accessibilityLabel={`Pair with ${machine.label}`} onPress={() => setPicked(machine)}>
            <View
              {...((isWeb ? { cursor: "pointer" } : {}) as object)}
              flexDirection="row"
              alignItems="center"
              gap={10}
              borderWidth={1}
              borderColor={t.v("line") as never}
              borderRadius={7}
              paddingHorizontal={10}
              paddingVertical={9}
              backgroundColor={t.v("panel") as never}
            >
              <MachineIcon face={{ shape: "desktop", ...(markOf(machine.os) !== undefined ? { mark: markOf(machine.os)! } : {}) }} size={20} />
              <Text {...(app as object)} fontSize={14} fontWeight="600" flex={1} numberOfLines={1}>
                {machine.label}
              </Text>
              <Text {...(app as object)} fontSize={15} color={t.v("dim") as never}>
                ›
              </Text>
            </View>
          </Pressable>
        ))}
        {trouble}
        {button("Enter an address instead", () => setByAddress(true), "quiet")}
      </Frame>
    );
  }

  return (
    <Frame t={t}>
      {heading("Connect to a JaiRA machine")}
      {words("On that machine, Settings → Machines → Pair a machine shows its address and a code that works once.")}
      <TextInput value={address} onChangeText={setAddress} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Address" placeholder="desk.tail4c2e.ts.net" style={field} />
      <TextInput value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} accessibilityLabel="Code" placeholder="AMBER · RIVER · 7K2P" style={field} />
      {button(busy === true ? "Pairing…" : "Pair", () => (ready ? onPair(address.trim(), code.trim()) : undefined), "primary", !ready)}
      {trouble}
      {nearby !== undefined ? button("Machines on this Wi-Fi", () => setByAddress(false), "quiet") : null}
    </Frame>
  );
}

function Frame({ t, children }: { t: ReturnType<typeof useTokens>; children: ReactNode }): JSX.Element {
  return (
    <View flex={1} backgroundColor={t.v("bg") as never} alignItems="center" justifyContent="center" padding={16}>
      <View width="100%" maxWidth={420} gap={10}>
        {children}
      </View>
    </View>
  );
}
