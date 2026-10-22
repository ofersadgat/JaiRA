import { useEffect, useState, type JSX, type ReactNode } from "react";
import { Pressable, TextInput } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import { Pulse } from "../components/chat/Pulse";
import { MachineIcon } from "../components/MachineIcon";
import { useTokens } from "../tokens";
import { nearbySearchWords, nearbyStepWords, sentence, type NearbyAttempt, type NearbyChoice, type NearbySearch, type NearbyStep } from "./connectWords";

export { elapsedWords, nearbySearchWords, nearbyStepWords, type NearbyAttempt, type NearbyChoice, type NearbySearch, type NearbyStep } from "./connectWords";

/**
 * Where a phone or a browser says which machine it is a window onto (decisions 0015, and 0013 as
 * amended 2026-09-30 and 2026-10-04). Pairing happens once; after it the device keeps the machine's
 * token and this screen is only passed through — "Connecting to desk" — unless the machine cannot be
 * reached, where it says why and offers to forget it.
 *
 * A phone lists the machines on its Wi-Fi that are showing a pairing code (Settings → Machines → Pair a
 * machine): the person picks one and types its code, which pairs the phone and lets it onto the
 * machine's tailnet — a Tailscale page opens on the machine to approve it. While it looks, it says so
 * and moves, says for how long, what this phone's address is and what it has found, and can be told to
 * look again in any state. Pairing with one says each address it tries and what came of it. The address
 * and code form stays one tap away — a tailnet address, or the local address the machine shows when
 * the network hides it from the list — and is all a browser has (a page cannot look at the network).
 *
 * The same screen on both: it draws and asks, and its host (`packages/client/src/Remote.tsx`) looks,
 * pairs, keeps and connects.
 */

export interface ConnectProps {
  /** The machine this device is already paired with, while it is being connected to. */
  saved?: { label: string; address: string; /** What else is going on: the phone's Tailscale, when it carries the connection. */ detail?: string };
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
  /** The machines nearby, on a device that can look (a phone). */
  nearby?: NearbySearch;
  /** Look again, from scratch, whatever state the search is in. */
  onSearchAgain?: () => void;
  /** Pair with a machine found nearby, by the code it shows. */
  onPairNearby?: (key: string, code: string) => void;
  /** Pairing with a machine nearby, while it happens: the step, and each address tried. */
  pairing?: { label: string; step: NearbyStep; attempts?: NearbyAttempt[]; /** The phone's Tailscale, while it joins. */ detail?: string };
  /** The phone's Tailscale wants signing in again (its key expired): the page, opened here. */
  signIn?: () => void;
  /**
   * The machines this phone is already paired with (decision 0015, amended 2026-10-04: a phone reaches
   * every one), each with what it is doing and a way to forget it — over the way to pair another.
   */
  paired?: readonly PairedMachine[] | undefined;
  /**
   * What this phone keeps of its machines (decision 0018 §7): its mirror's size, against a limit the
   * person sets — or none, a permanent store — and a way to drop the conversations it holds.
   */
  kept?: KeptOnDevice | undefined;
}

/** A phone's mirror, as its Connect screen says it. */
export interface KeptOnDevice {
  bytes: number;
  limit: number | null;
  onLimit: (limit: number | null) => void;
  onClear: () => void;
}

/** The limits offered for a phone's mirror; `null` is none. */
export const KEPT_LIMITS: readonly (number | null)[] = [50 * 2 ** 20, 200 * 2 ** 20, 2 ** 30, null];

/** A size in words: "12.3 MB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 2 ** 20) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 2 ** 30) return `${(bytes / 2 ** 20).toFixed(bytes < 10 * 2 ** 20 ? 1 : 0)} MB`;
  const gb = bytes / 2 ** 30;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

/** One machine a phone is paired with, as its Connect screen lists it. */
export interface PairedMachine {
  key: string;
  label: string;
  address: string;
  state: "connected" | "connecting" | "waiting" | "mismatch";
  reason?: string | undefined;
  onForget: () => void;
}

const markOf = (os: string): "windows" | "mac" | "linux" | undefined => (os === "windows" || os === "mac" || os === "linux" ? os : undefined);

/** The time, once a second, while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

export function Connect({ saved, initial, problem, busy, onPair, onRetry, onForget, nearby, onSearchAgain, onPairNearby, pairing, signIn, paired, kept }: ConnectProps): JSX.Element {
  const t = useTokens();
  const [address, setAddress] = useState(initial?.address ?? "");
  const [code, setCode] = useState(initial?.code ?? "");
  // A phone starts at the machines nearby; a link with an address, or a browser, at the form.
  const [byAddress, setByAddress] = useState(nearby === undefined || (initial?.address ?? "") !== "");
  const [picked, setPicked] = useState<NearbyChoice | undefined>(undefined);
  const now = useNow(nearby !== undefined && !byAddress && picked === undefined);
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
  const data = (text: string, color: "text" | "dim" | "bad" = "dim"): JSX.Element => (
    <Text fontFamily={t.v("font-data") as never} fontSize={12} color={t.v(color) as never}>
      {text}
    </Text>
  );
  const trouble = problem ? words(sentence(problem), "bad") : null;
  const heading = (text: string): JSX.Element => (
    <Text {...(app as object)} fontSize={15} fontWeight="600">
      {text}
    </Text>
  );
  // The phone's own machines, each with what it is doing: over the way to pair another.
  const others = paired !== undefined && paired.length > 0;
  const mine = others ? (
    <View gap={6} marginBottom={10}>
      {heading("This phone's machines")}
      {paired.map((m) => (
        <View key={m.key} flexDirection="row" alignItems="center" gap={10} borderWidth={1} borderColor={t.v("line") as never} borderRadius={7} paddingHorizontal={10} paddingVertical={8} backgroundColor={t.v("panel") as never}>
          <View width={8} height={8} borderRadius={4} backgroundColor={t.v(m.state === "connected" ? "ok" : m.state === "connecting" ? "accent" : "warn") as never} />
          <View flex={1} gap={2} minWidth={0}>
            <Text {...(app as object)} fontSize={14} fontWeight="600" numberOfLines={1}>
              {m.label}
            </Text>
            <Text fontFamily={t.v("font-data") as never} fontSize={11} color={t.v("dim") as never} numberOfLines={1}>
              {m.address}
            </Text>
            <Text {...(app as object)} fontSize={12} color={t.v(m.state === "connected" ? "dim" : m.state === "connecting" ? "dim" : "bad") as never} numberOfLines={2}>
              {m.state === "connected" ? "Connected" : m.state === "connecting" ? "Connecting…" : sentence(m.reason ?? "not answering")}
            </Text>
          </View>
          <Pressable role="button" accessibilityLabel={`Forget ${m.label}`} onPress={m.onForget}>
            <Text {...(app as object)} fontSize={13} color={t.v("dim") as never} paddingHorizontal={6} paddingVertical={6}>
              Forget
            </Text>
          </Pressable>
        </View>
      ))}
      {kept !== undefined ? (
        <View gap={6} marginTop={6}>
          {heading("Kept on this phone")}
          {words(
            kept.limit === null
              ? `${sizeWords(kept.bytes)} of what its machines showed, read here when none answers — with no limit, nothing is dropped.`
              : `${sizeWords(kept.bytes)} of ${sizeWords(kept.limit)}: what its machines showed, read here when none answers. Past the limit, what was read longest ago goes.`,
          )}
          <View flexDirection="row" flexWrap="wrap" gap={6}>
            {KEPT_LIMITS.map((limit) => {
              const on = limit === kept.limit;
              const label = limit === null ? "No limit" : sizeWords(limit);
              return (
                <Pressable key={label} role="button" accessibilityLabel={`Keep ${limit === null ? "with no limit" : `up to ${label}`}`} accessibilityState={{ selected: on }} onPress={() => kept.onLimit(limit)}>
                  <View borderWidth={1} borderColor={(on ? t.v("fill-accent") : t.v("line")) as never} backgroundColor={(on ? t.v("fill-accent") : "transparent") as never} borderRadius={14} paddingHorizontal={10} paddingVertical={5}>
                    <Text {...(app as object)} fontSize={12} fontWeight="600" color={(on ? t.v("on-accent") : t.v("text")) as never}>
                      {label}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
          {button("Clear what is kept", kept.onClear, "quiet")}
        </View>
      ) : null}
    </View>
  ) : null;
  const where = (machine: NearbyChoice): string | undefined =>
    machine.addresses !== undefined && machine.addresses.length > 0 ? `${machine.addresses.join(" · ")}${machine.port !== undefined ? ` · port ${machine.port}` : ""}` : undefined;

  if (saved !== undefined) {
    return (
      <Frame t={t}>
        {heading(`Connecting to ${saved.label}`)}
        <Text fontFamily={t.v("font-data") as never} fontSize={13} color={t.v("dim") as never}>
          {saved.address}
        </Text>
        {saved.detail !== undefined ? words(saved.detail, /failed/.test(saved.detail) ? "bad" : "dim") : null}
        {trouble}
        {signIn !== undefined ? button("Sign in to Tailscale", signIn, "primary") : null}
        {onRetry !== undefined ? button("Try again", onRetry, signIn !== undefined ? "quiet" : "primary") : null}
        {onForget !== undefined ? button("Forget this machine", onForget, "quiet") : null}
      </Frame>
    );
  }

  if (!byAddress && nearby !== undefined) {
    // A machine picked: its code, and while pairing, each step and address tried.
    if (picked !== undefined) {
      const pairingThis = pairing !== undefined && pairing.label === picked.label;
      const canPair = code.trim() !== "" && !pairingThis;
      const place = where(picked);
      return (
        <Frame t={t}>
          <View flexDirection="row" alignItems="center" gap={8}>
            <MachineIcon face={{ shape: "desktop", ...(markOf(picked.os) !== undefined ? { mark: markOf(picked.os)! } : {}) }} size={20} ground="bg" />
            {heading(picked.label)}
          </View>
          {place !== undefined ? data(place) : null}
          {words(`Type the code ${picked.label} shows under Pair a machine.`)}
          <TextInput value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} autoFocus accessibilityLabel="Code" placeholder="AMBER · RIVER · 7K2P" style={field} editable={!pairingThis} />
          {button(pairingThis ? "Pairing…" : "Pair", () => (canPair ? onPairNearby?.(picked.key, code.trim()) : undefined), "primary", !canPair)}
          {pairingThis ? (
            <View gap={4}>
              <View flexDirection="row" alignItems="center" gap={8}>
                {pairing.step !== "approve" ? <Pulse /> : null}
                {words(nearbyStepWords(picked.label, pairing.step), pairing.step === "approve" ? "text" : "dim")}
              </View>
              {(pairing.attempts ?? []).map((a) => (
                <View key={a.address}>{data(`${a.address}  ${a.state === "trying" ? "reaching…" : a.state === "answered" ? "answered" : `no: ${a.reason ?? "no answer"}`}`, a.state === "failed" ? "bad" : "dim")}</View>
              ))}
              {pairing.detail !== undefined ? data(pairing.detail, /failed/.test(pairing.detail) ? "bad" : "dim") : null}
            </View>
          ) : null}
          {trouble}
          {pairingThis ? null : button("Another machine", () => setPicked(undefined), "quiet")}
        </Frame>
      );
    }
    const search = nearbySearchWords(nearby, now);
    return (
      <Frame t={t}>
        {mine}
        {heading(others ? "Pair another machine" : "Connect to a JaiRA machine")}
        <View flexDirection="row" alignItems="center" gap={8}>
          {search.looking ? <Pulse /> : null}
          <View flex={1}>{words(search.headline, search.trouble ? "bad" : "dim")}</View>
        </View>
        {nearby.phone.length > 0 ? data(`This phone: ${nearby.phone.join(" · ")}`) : null}
        {nearby.machines.length > 0 ? words(`Found ${nearby.machines.length === 1 ? "one machine" : `${nearby.machines.length} machines`} showing a code:`, "text") : null}
        {nearby.machines.map((machine) => {
          const place = where(machine);
          return (
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
                <View flex={1} gap={2}>
                  <Text {...(app as object)} fontSize={14} fontWeight="600" numberOfLines={1}>
                    {machine.label}
                  </Text>
                  {place !== undefined ? (
                    <Text fontFamily={t.v("font-data") as never} fontSize={11} color={t.v("dim") as never} numberOfLines={1}>
                      {place}
                    </Text>
                  ) : null}
                </View>
                <Text {...(app as object)} fontSize={15} color={t.v("dim") as never}>
                  ›
                </Text>
              </View>
            </Pressable>
          );
        })}
        {search.hint !== undefined ? words(search.hint) : null}
        {trouble}
        {onSearchAgain !== undefined ? button("Search again", onSearchAgain, "quiet") : null}
        {button("Enter an address instead", () => setByAddress(true), "quiet")}
      </Frame>
    );
  }

  return (
    <Frame t={t}>
      {mine}
      {heading(others ? "Pair another machine" : "Connect to a JaiRA machine")}
      {words(
        nearby !== undefined
          ? "On that machine, Settings → Machines → Pair a machine shows a code that works once, its tailnet address, and the local address to type when this phone cannot list it."
          : "On that machine, Settings → Machines → Pair a machine shows its address and a code that works once.",
      )}
      <TextInput value={address} onChangeText={setAddress} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Address" placeholder={nearby !== undefined ? "192.168.1.32 or desk.tail4c2e.ts.net" : "desk.tail4c2e.ts.net"} style={field} />
      <TextInput value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} accessibilityLabel="Code" placeholder="AMBER · RIVER · 7K2P" style={field} />
      {button(busy === true ? "Pairing…" : "Pair", () => (ready ? onPair(address.trim(), code.trim()) : undefined), "primary", !ready)}
      {busy === true && pairing !== undefined ? (
        <View gap={4}>
          <View flexDirection="row" alignItems="center" gap={8}>
            {pairing.step !== "approve" ? <Pulse /> : null}
            {words(nearbyStepWords(pairing.label, pairing.step), pairing.step === "approve" ? "text" : "dim")}
          </View>
          {(pairing.attempts ?? []).map((a) => (
            <View key={a.address}>{data(`${a.address}  ${a.state === "trying" ? "reaching…" : a.state === "answered" ? "answered" : `no: ${a.reason ?? "no answer"}`}`, a.state === "failed" ? "bad" : "dim")}</View>
          ))}
        </View>
      ) : null}
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
