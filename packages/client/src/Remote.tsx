import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { AppState } from "react-native";
import { engineUrlOf } from "@jaira/shared/browser";
import { Connect, connectionLost, connectionRestored } from "@jaira/universal";
import { setBridge } from "@jaira/ui/store";
import { CLIENT_VERSION } from "../bridges/clientVersion";
import { DEVICE_KIND, deviceLabel } from "../bridges/deviceInfo";
import { engineBridge, pairDevice, type EngineBridge } from "../bridges/engineBridge";
import { deviceId, forgetPairing, loadPairing, savePairing, type SavedPairing } from "../bridges/savedPairing";

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

export function Remote({ link, frame, children }: { link?: Partial<PairLink>; frame?: (screen: JSX.Element) => JSX.Element; children: ReactNode }): JSX.Element | null {
  const electron = typeof window !== "undefined" && window.jaira !== undefined;
  const [phase, setPhase] = useState<Phase>(electron ? "connected" : "loading");
  const [saved, setSaved] = useState<SavedPairing | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bridge = useRef<EngineBridge | undefined>(undefined);
  /** Which attempt is the current one: a slower, older one must not overwrite it. */
  const turn = useRef(0);

  const connect = useCallback((pairing: SavedPairing): void => {
    bridge.current?.close();
    const mine = engineBridge({ url: pairing.url, token: pairing.token, client: deviceLabel(), version: CLIENT_VERSION });
    bridge.current = mine;
    let installed = false;
    setSaved(pairing);
    setPhase("connecting");
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

  const pair = useCallback(
    async (address: string, code: string, fallback?: SavedPairing): Promise<void> => {
      const mine = ++turn.current;
      setBusy(true);
      setProblem(null);
      try {
        const paired = await pairDevice(address, code, { id: await deviceId(), label: deviceLabel(), kind: DEVICE_KIND });
        if (turn.current !== mine) return;
        const pairing: SavedPairing = { ...paired, address };
        await savePairing(pairing);
        dropPageCode();
        connect(pairing);
      } catch (e) {
        if (turn.current !== mine) return;
        // A link opened twice carries a spent code: the pairing it made the first time still stands.
        if (fallback !== undefined) connect(fallback);
        else {
          setProblem((e as Error).message);
          setPhase((was) => (was === "connected" ? was : "ask"));
        }
      } finally {
        if (turn.current === mine) setBusy(false);
      }
    },
    [connect],
  );

  // At launch, and whenever a link arrives: a link with a code pairs (it is a person's deliberate act);
  // otherwise the machine remembered from last time is connected to; otherwise the form.
  // A code alone, on a page a machine's engine served, is a code for that machine.
  const code = link?.code;
  const address = link?.address ?? (code !== undefined ? pageAddress() : undefined);
  useEffect(() => {
    if (electron) return;
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
  }, [electron, address, code, pair, connect]);

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

  useEffect(() => () => bridge.current?.close(), []);

  if (phase === "connected") return <>{children}</>;
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
    phase === "connecting" && saved !== undefined ? (
      <Connect
        saved={{ label: saved.machine.label, address: saved.address }}
        problem={problem}
        onPair={() => undefined}
        onRetry={() => (bridge.current !== undefined ? bridge.current.retryNow() : connect(saved))}
        onForget={forget}
      />
    ) : (
      <Connect
        // A link that arrives later fills the fields it carries.
        key={`${address ?? ""}|${code ?? ""}`}
        initial={{ address: address ?? pageAddress() ?? "", code: code ?? "" }}
        problem={problem}
        busy={busy}
        onPair={(a, c) => void pair(a, c)}
      />
    );
  return frame !== undefined ? frame(screen) : screen;
}
