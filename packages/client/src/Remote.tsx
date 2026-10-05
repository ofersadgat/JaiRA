import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { AppState, Linking, Pressable, Text, View } from "react-native";
import { engineUrlOf, hostOfUrl, typedLanMachine, type LanAnnouncement } from "@jaira/shared/browser";
import { Connect, connectionLost, connectionRestored, phoneMachines, remoteStatus, type NearbyAttempt, type NearbyStep } from "@jaira/universal";
import { setBridge } from "@jaira/ui/store";
import { CLIENT_VERSION } from "../bridges/clientVersion";
import { DEVICE_KIND, deviceLabel } from "../bridges/deviceInfo";
import { engineBridge, pairDevice, type EngineBridge } from "../bridges/engineBridge";
import { pairNearby } from "../bridges/lanPair";
import { NEARBY_SUPPORTED, browseNearby, localAddresses, randomBytes, tailnet, type NearbyState, type TailnetState } from "../bridges/nearby";
import { addPairing, deviceId, forgetPairing, loadPairing, savePairing, type SavedPairing } from "../bridges/savedPairing";
import { useFleetLinks } from "./fleetLinks";
import { tailnetEngineUrl, tailnetHostname, tailnetJoin, tailnetWords } from "../bridges/tailnetJoin";

/**
 * A window that is not Electron's — a phone, a browser tab — standing on a machine's engine (decisions
 * 0015, and 0013 as amended 2026-09-30). It pairs once, by the one-time code the machine shows; keeps
 * the token the machine issued (the phone's keystore, a browser's `localStorage`); and from then on
 * connects by itself at every launch, and again whenever the connection drops. Until it is connected
 * it draws the universal `Connect` screen; connected, its children — with the bridge installed in the
 * store, so nothing below knows what carries a request.
 *
 * In Electron none of this happens: the window has its preload's bridge, and the children draw at once.
 *
 * A machine that refuses the token (the device was forgotten there) forgets the token here too and
 * brings the form back, saying so. One that speaks another contract keeps the pairing and says which
 * side to update.
 *
 * A phone also lists the machines on its Wi-Fi that are showing a code, and pairs with one by its code
 * alone (amended 2026-10-04, `bridges/lanPair.ts`); it then joins that machine's tailnet with Tailscale
 * built into the app, and from then on connects through it (`bridges/tailnetJoin.ts`) wherever it is.
 *
 * `shell` (the phone app, decision 0015 amended 2026-10-04): the shell is NOT held back until a machine
 * answers, and the phone keeps every machine it pairs with. The shell is drawn at once on the fleet
 * bridge (`fleetLinks.ts`, `fleetBridge.ts`), whose requests wait until a machine answers, so it stands
 * empty — no projects — while the line under its title bar says why (`remoteStatus`) and opens the
 * Connect screen over it. Its projects are those of every machine it reaches. The Connect screen lists
 * the phone's machines and pairs another; the drawer opens it at any time (`phoneMachines`).
 */

/** An address and a one-time code that came with the page's URL or the app's link — what a QR code carries. */
export interface PairLink {
  address: string;
  code: string;
}

/** `?address=…&code=…` (either alone fills its field). Parsed by hand: React Native's URLSearchParams implements little of the standard. */
export function linkOf(url: string | null | undefined): Partial<PairLink> & { query: Record<string, string> } {
  const query: Record<string, string> = {};
  for (const pair of ((url ?? "").split("#")[0]!.split("?")[1] ?? "").split("&")) {
    if (pair === "") continue;
    const at = pair.indexOf("=");
    try {
      query[decodeURIComponent(at < 0 ? pair : pair.slice(0, at))] = at < 0 ? "" : decodeURIComponent(pair.slice(at + 1).replace(/\+/g, " "));
    } catch {
      // A pair that does not decode is not one of ours.
    }
  }
  return { ...(query["address"] !== undefined ? { address: query["address"] } : {}), ...(query["code"] !== undefined ? { code: query["code"] } : {}), query };
}

/** The link a browser's page was opened with. */
export function pageLink(): Partial<PairLink> {
  if (typeof location === "undefined" || typeof location.search !== "string" || location.search === "") return {};
  const { query: _query, ...link } = linkOf(location.href);
  return link;
}

/**
 * Take a spent code OUT of a browser's address bar: it works once, and a reload, a bookmark or a
 * shared link must not carry it. Done once the pairing is made, not as the page loads — One's router
 * is still settling the URL then, and puts back what it read.
 */
function dropPageCode(): void {
  if (typeof location === "undefined" || typeof location.search !== "string" || typeof history === "undefined") return;
  const { query } = linkOf(location.href);
  if (query["code"] === undefined) return;
  try {
    const rest = Object.entries(query).filter(([key]) => key !== "code" && key !== "address");
    const search = rest.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
    history.replaceState(history.state, "", `${location.pathname}${search === "" ? "" : `?${search}`}${location.hash}`);
  } catch {
    // No history to rewrite (a preview without one): the code stays, and a reload falls back to the saved pairing.
  }
}

/** In a browser served by a machine's engine, the machine is the page's own origin. */
function pageAddress(): string | undefined {
  if (typeof location === "undefined" || typeof location.protocol !== "string") return undefined;
  return location.protocol === "http:" || location.protocol === "https:" ? location.origin : undefined;
}

type Phase = "loading" | "ask" | "connecting" | "connected";

export function Remote({ link, frame, shell = false, children }: { link?: Partial<PairLink>; frame?: (screen: JSX.Element) => JSX.Element; shell?: boolean; children: ReactNode }): JSX.Element | null {
  const electron = typeof window !== "undefined" && window.jaira !== undefined;
  const ungated = shell && !electron;
  // Every machine the phone is paired with (`shell`), and the one bridge over them — installed before the
  // shell first draws.
  const fleet = useFleetLinks(ungated);
  useState(() => {
    if (ungated) setBridge(fleet.bridge);
    return true;
  });
  /** The link (address and code) a pairing was already started for (`shell`). */
  const linkPaired = useRef<string | null>(null);
  /** The Connect screen over the shell, opened from its line or the drawer (`shell`). */
  const [form, setForm] = useState(false);
  const [phase, setPhase] = useState<Phase>(electron ? "connected" : "loading");
  const [saved, setSaved] = useState<SavedPairing | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bridge = useRef<EngineBridge | undefined>(undefined);
  /** Which attempt is the current one: a slower, older one must not overwrite it. */
  const turn = useRef(0);
  /** Which connection is the current one, while its URL is worked out (the tailnet's proxy). */
  const connecting = useRef(0);
  const [nearby, setNearby] = useState<NearbyState & { since: number; phone: string[] }>(() => ({ machines: [], state: "starting", since: Date.now(), phone: [] }));
  /** Bumped to look again from scratch: Search again, or the app back in front. */
  const [search, setSearch] = useState(0);
  const [nearbyPairing, setNearbyPairing] = useState<{ label: string; step: NearbyStep; attempts: NearbyAttempt[] } | undefined>(undefined);
  /** The phone's Tailscale asks to be signed in again (its key expired, or it was signed out). */
  const [signInUrl, setSignInUrl] = useState<string | undefined>(undefined);
  /** What the phone's Tailscale is doing, said on the screen while it matters. */
  const [tailnetLine, setTailnetLine] = useState<string | undefined>(undefined);

  /** Connect the bridge to a pairing's engine at `url`: its own, or the tailnet proxy's to it. */
  const open = useCallback((pairing: SavedPairing, url: string): void => {
    const mine = engineBridge({ url, token: pairing.token, client: deviceLabel(), version: CLIENT_VERSION, ...(url !== pairing.url ? { where: hostOfUrl(pairing.url) } : {}) });
    bridge.current = mine;
    let installed = false;
    mine.onState((state) => {
      if (bridge.current !== mine) return;
      switch (state.state) {
        case "connected":
          if (!installed) setBridge(mine);
          installed = true;
          connectionRestored();
          setProblem(null);
          setPhase("connected");
          return;
        case "waiting":
          // Connected before: the shell says so across its top and stays up. Never yet: this screen does.
          if (installed) connectionLost(state.reason);
          else setProblem(state.reason);
          return;
        case "refused":
          // The token is dead: the machine forgot this device. Kept, it would be refused at every launch.
          void forgetPairing();
          bridge.current = undefined;
          connectionRestored();
          setSaved(undefined);
          setProblem(`${pairing.machine.label} no longer knows this device — it was forgotten there. Pair again with a new code`);
          setPhase("ask");
          return;
        case "mismatch":
          bridge.current = undefined;
          connectionRestored();
          setProblem(state.reason);
          setPhase("connecting");
          return;
        default:
          return;
      }
    });
  }, []);

  const connect = useCallback(
    (pairing: SavedPairing): void => {
      bridge.current?.close();
      bridge.current = undefined;
      const attempt = ++connecting.current;
      setSaved(pairing);
      setPhase("connecting");
      if (pairing.tailnet !== true) return open(pairing, pairing.url);
      // Through Tailscale built into the app: its loopback proxy to the engine.
      if (tailnet === undefined) {
        setProblem("this build of JaiRA has no Tailscale built in, which this pairing needs: forget this machine and pair by address");
        return;
      }
      tailnetEngineUrl(tailnet, tailnetHostname(deviceLabel()), pairing.address).then(
        (url) => {
          if (connecting.current === attempt) open(pairing, url);
        },
        (e: Error) => {
          if (connecting.current === attempt) setProblem(`Tailscale on this phone did not start: ${e.message}`);
        },
      );
    },
    [open],
  );

  /**
   * A pairing made: connected to — alone, or (`shell`) among the phone's other machines, the Connect
   * screen going back to the shell once it is done (`done`).
   */
  const adopt = (pairing: SavedPairing, done = true): void => {
    if (!ungated) return connect(pairing);
    fleet.add(pairing);
    if (done) setForm(false);
  };

  /**
   * Pair with a machine on this Wi-Fi — one found in the list, or a local address typed — by the code it
   * shows, then join its tailnet. Says each step and each address it tries.
   */
  const pairLocally = useCallback(
    async (machine: LanAnnouncement, code: string): Promise<void> => {
      const mine = ++turn.current;
      setProblem(null);
      setBusy(true);
      let attempts: NearbyAttempt[] = [];
      let step: NearbyStep = "reaching";
      const show = (): void => {
        if (turn.current === mine) setNearbyPairing({ label: machine.label, step, attempts });
      };
      show();
      let kept: SavedPairing | undefined;
      try {
        await pairNearby({
          machine,
          code,
          device: { id: await deviceId(), label: deviceLabel(), kind: "phone" },
          random: randomBytes,
          ...(tailnet !== undefined ? { tailnet: tailnetJoin(tailnet, tailnetHostname(deviceLabel())) } : {}),
          // Kept as soon as it is issued: joining the tailnet can take minutes, and the token stands either way.
          onPaired: async (paired) => {
            kept = { address: paired.address, url: engineUrlOf(paired.address), token: paired.token, machine: { id: paired.machine.id, label: paired.machine.label }, ...(tailnet !== undefined ? { tailnet: true as const } : {}) };
            await (ungated ? addPairing(kept) : savePairing(kept));
          },
          onStep: (next) => {
            step = next;
            show();
          },
          onAttempt: (attempt) => {
            attempts = [...attempts.filter((a) => a.address !== attempt.address), attempt];
            show();
          },
        });
        if (turn.current !== mine) return;
        setNearbyPairing(undefined);
        adopt(kept!);
      } catch (e) {
        if (turn.current !== mine) return;
        // The attempts stay on screen beside the reason, to read what was tried.
        setNearbyPairing(undefined);
        // Paired, but not onto the tailnet: connecting carries on, offering the sign-in on the phone.
        if (kept !== undefined) adopt(kept, false);
        setProblem((e as Error).message + (attempts.length > 0 && kept === undefined ? ` (tried ${attempts.map((a) => `${a.address}: ${a.state === "failed" ? (a.reason ?? "no answer") : a.state}`).join("; ")})` : ""));
      } finally {
        if (turn.current === mine) setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connect, ungated, fleet.add],
  );

  const pairWithNearby = useCallback(
    (key: string, code: string): void => {
      const machine = nearby.machines.find((m) => m.key === key);
      if (machine === undefined) setProblem("that machine is no longer showing its code: show a new one there, then search again");
      else void pairLocally(machine, code);
    },
    [nearby, pairLocally],
  );

  const pair = useCallback(
    async (address: string, code: string, fallback?: SavedPairing): Promise<void> => {
      // A machine's local address, typed where the list cannot see it: paired over the local network.
      const local = NEARBY_SUPPORTED ? typedLanMachine(address) : undefined;
      if (local !== undefined) return pairLocally(local, code);
      const mine = ++turn.current;
      setBusy(true);
      setProblem(null);
      try {
        const paired = await pairDevice(address, code, { id: await deviceId(), label: deviceLabel(), kind: DEVICE_KIND });
        if (turn.current !== mine) return;
        const pairing: SavedPairing = { ...paired, address };
        if (!ungated) await savePairing(pairing);
        dropPageCode();
        adopt(pairing);
      } catch (e) {
        if (turn.current !== mine) return;
        // A link opened twice carries a spent code: the pairing it made the first time still stands.
        if (fallback !== undefined) adopt(fallback);
        else {
          setProblem((e as Error).message);
          setPhase((was) => (was === "connected" ? was : "ask"));
        }
      } finally {
        if (turn.current === mine) setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connect, pairLocally, ungated, fleet.add],
  );

  // At launch, and whenever a link arrives: a link with a code pairs (it is a person's deliberate act);
  // otherwise the machine remembered from last time is connected to; otherwise the form.
  // A code alone, on a page a machine's engine served, is a code for that machine.
  const code = link?.code;
  const address = link?.address ?? (code !== undefined ? pageAddress() : undefined);
  useEffect(() => {
    if (electron) return;
    // The phone's machines are `fleetLinks.ts`'s to reach; a link with a code pairs another — once: a
    // second try spends nothing but the code, and would set aside the first one's pairing as stale (a
    // development build runs every effect twice).
    if (ungated) {
      setPhase("ask");
      const key = `${address ?? ""}|${code ?? ""}`;
      if (address !== undefined && code !== undefined && code !== "" && linkPaired.current !== key) {
        linkPaired.current = key;
        void pair(address, code);
      }
      return;
    }
    let live = true;
    void loadPairing().then((kept) => {
      if (!live) return;
      if (address !== undefined && code !== undefined && code !== "") {
        let same = false;
        try {
          same = kept !== undefined && kept.url === engineUrlOf(address);
        } catch {
          // Not an address: pairing says so.
        }
        // The form, filled and saying "Pairing…", rather than nothing while the machine answers.
        setPhase((was) => (was === "loading" ? "ask" : was));
        void pair(address, code, same ? kept : undefined);
      } else if (kept !== undefined) {
        if (bridge.current === undefined) connect(kept);
      } else setPhase((was) => (was === "loading" ? "ask" : was));
    });
    return () => {
      live = false;
    };
  }, [electron, ungated, address, code, pair, connect]);

  // Back in front, or back on a network: no reason to sit out the rest of a wait.
  useEffect(() => {
    if (electron) return;
    const again = (): void => bridge.current?.retryNow();
    const state = AppState.addEventListener("change", (next) => {
      if (next === "active") again();
    });
    const web = typeof window !== "undefined" && typeof window.addEventListener === "function";
    if (web) window.addEventListener("online", again);
    return () => {
      state.remove();
      if (web) window.removeEventListener("online", again);
    };
  }, [electron]);

  // The machines on this Wi-Fi showing a code, while the form is up.
  const formUp = !ungated || form;
  useEffect(() => {
    if (electron || !NEARBY_SUPPORTED || phase !== "ask" || !formUp) return;
    const since = Date.now();
    setNearby({ machines: [], state: "starting", since, phone: localAddresses() });
    return browseNearby((state) => setNearby({ ...state, since, phone: localAddresses() }));
  }, [electron, phase, search, formUp]);

  // Back in front: the system may have dropped the browse while the app was away, so it starts afresh.
  useEffect(() => {
    if (electron || !NEARBY_SUPPORTED) return;
    const listener = AppState.addEventListener("change", (next) => {
      if (next === "active") setSearch((n) => n + 1);
    });
    return () => listener.remove();
  }, [electron]);

  // A pairing through the tailnet: the phone's Tailscale may ask to be signed in again.
  const viaTailnet = saved?.tailnet === true || nearbyPairing?.step === "joining" || nearbyPairing?.step === "approve";
  useEffect(() => {
    if (!viaTailnet || tailnet === undefined) return;
    const hear = (state: TailnetState): void => {
      setSignInUrl(state.state === "needs-login" ? state.url : undefined);
      setTailnetLine(tailnetWords(state));
    };
    hear(tailnet.state());
    return tailnet.onState(hear);
  }, [viaTailnet]);

  useEffect(() => () => bridge.current?.close(), []);

  // The shell's line (`shell`): why it has no projects yet, and the way to the Connect screen — and the
  // drawer's way to it, whatever the line says.
  const links = fleet.links;
  useEffect(() => {
    if (!ungated) return undefined;
    const open = (): void => setForm(true);
    phoneMachines.set({ open, labels: links.map((l) => l.pairing.machine.label), connected: links.filter((l) => l.state === "connected").length });
    const why = fleet.notice ?? problem ?? links.find((l) => l.reason !== undefined)?.reason;
    if (!fleet.loaded || links.some((l) => l.state === "connected")) remoteStatus.set(null);
    else if (links.length === 0) remoteStatus.set({ state: "none", ...(why !== undefined && why !== null ? { detail: why } : {}), open });
    else
      remoteStatus.set({
        state: links.some((l) => l.reason !== undefined) ? "problem" : "connecting",
        label: links.length === 1 ? links[0]!.pairing.machine.label : `${links.length} machines`,
        ...(why !== undefined && why !== null ? { detail: why } : {}),
        open,
      });
    return undefined;
  }, [ungated, links, fleet.loaded, fleet.notice, problem]);
  useEffect(
    () => () => {
      remoteStatus.set(null);
      phoneMachines.set(null);
    },
    [],
  );


  if (ungated) {
    if (!form) return <>{children}</>;
  } else if (phase === "connected") return <>{children}</>;
  if (phase === "loading") return null;
  const forget = (): void => {
    turn.current += 1;
    bridge.current?.close();
    bridge.current = undefined;
    void forgetPairing();
    connectionRestored();
    setSaved(undefined);
    setProblem(null);
    setPhase("ask");
  };
  const screen =
    !ungated && phase === "connecting" && saved !== undefined ? (
      <Connect
        saved={{ label: saved.machine.label, address: saved.address, ...(saved.tailnet === true && tailnetLine !== undefined ? { detail: tailnetLine } : {}) }}
        problem={signInUrl !== undefined ? "Tailscale on this phone needs its sign-in approved before it can reach the machine: open it here, or pair again with a code to open it on the machine" : problem}
        onPair={() => undefined}
        onRetry={() => (bridge.current !== undefined ? bridge.current.retryNow() : connect(saved))}
        onForget={forget}
        {...(signInUrl !== undefined ? { signIn: () => void Linking.openURL(signInUrl) } : {})}
      />
    ) : (
      <Connect
        // A link that arrives later fills the fields it carries.
        key={`${address ?? ""}|${code ?? ""}`}
        initial={{ address: address ?? pageAddress() ?? "", code: code ?? "" }}
        problem={ungated ? (fleet.notice ?? problem) : problem}
        busy={busy}
        onPair={(a, c) => void pair(a, c)}
        {...(ungated
          ? {
              paired: links.map((l) => ({
                key: l.pairing.machine.id,
                label: l.pairing.machine.label,
                address: l.pairing.address,
                state: l.state,
                ...(l.reason !== undefined ? { reason: l.reason } : {}),
                onForget: () => fleet.forget(l.pairing.machine.id),
              })),
            }
          : {})}
        {...(NEARBY_SUPPORTED
          ? {
              nearby: {
                machines: nearby.machines.map((m) => ({ key: m.key, label: m.label, os: m.os, addresses: m.addresses, port: m.port })),
                state: nearby.state,
                since: nearby.since,
                phone: nearby.phone,
                ...(nearby.problem !== undefined ? { problem: nearby.problem } : {}),
              },
              onSearchAgain: () => {
                setProblem(null);
                setSearch((n) => n + 1);
              },
              onPairNearby: (key: string, c: string) => pairWithNearby(key, c),
              ...(nearbyPairing !== undefined ? { pairing: { ...nearbyPairing, ...(tailnetLine !== undefined && (nearbyPairing.step === "joining" || nearbyPairing.step === "approve") ? { detail: tailnetLine } : {}) } } : {}),
            }
          : {})}
      />
    );
  const framed = frame !== undefined ? frame(screen) : screen;
  if (!ungated) return framed;
  // Over the shell, with a way back to it.
  return (
    <>
      {children}
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>
        {framed}
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setForm(false)} style={{ position: "absolute", top: 8, right: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: "rgba(20, 22, 40, 0.08)" }}>
          <Text style={{ fontSize: 15, color: "#4a4fd1", fontWeight: "600" }}>Close</Text>
        </Pressable>
      </View>
    </>
  );
}
