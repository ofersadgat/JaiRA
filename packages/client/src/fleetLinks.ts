import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { hostOfUrl, type JairaBridge, type MachinesView } from "@jaira/shared/browser";
import { connectionLost, connectionRestored } from "@jaira/universal";
import { CLIENT_VERSION } from "../bridges/clientVersion";
import { deviceLabel } from "../bridges/deviceInfo";
import { engineBridge, type EngineBridge } from "../bridges/engineBridge";
import { fleetBridge, type FleetMember } from "../bridges/fleetBridge";
import { tailnet } from "../bridges/nearby";
import { addPairing, forgetMachine, loadPairings, type SavedPairing } from "../bridges/savedPairing";
import { tailnetEngineUrl, tailnetHostname } from "../bridges/tailnetJoin";

/**
 * Every machine a phone is paired with, reached at once (decision 0015, amended 2026-10-04): an engine
 * bridge to each (through Tailscale built into the app where it was paired so), the fleet each says it is
 * in (`machines:view`), and the one bridge the store stands on over all of them (`fleetBridge.ts`). The
 * shell's projects are those of the machines it reaches.
 *
 * A machine that refuses the token (the phone was forgotten there) is forgotten here too; one that speaks
 * another contract stays listed, saying which side to update. While at least one machine answers the
 * shell is live; when the last one goes the shell says so across its top (`connectionLost`), and is
 * itself again when one comes back.
 */
export type LinkState = "connecting" | "connected" | "waiting" | "mismatch";

export interface MachineLink {
  pairing: SavedPairing;
  state: LinkState;
  /** Why it is not connected, in words. */
  reason?: string | undefined;
}

interface Connection {
  pairing: SavedPairing;
  bridge?: EngineBridge;
  state: LinkState;
  reason?: string | undefined;
  fleet?: ReadonlySet<string>;
  /** Which attempt is the current one, while its address is worked out (the tailnet's proxy). */
  attempt: number;
}

export function useFleetLinks(enabled: boolean): {
  bridge: JairaBridge;
  loaded: boolean;
  links: MachineLink[];
  /** A machine was refused (forgotten there), in words, until something else is said. */
  notice: string | null;
  add: (pairing: SavedPairing) => void;
  forget: (machineId: string) => void;
  retry: () => void;
} {
  const fleet = useMemo(() => fleetBridge(), []);
  const conns = useRef(new Map<string, Connection>());
  const [links, setLinks] = useState<MachineLink[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const wasLive = useRef(false);

  /** Tell the fleet bridge who answers, the screen what each is doing, the shell whether any is there. */
  const update = useCallback((): void => {
    const all = [...conns.current.values()];
    const members: FleetMember[] = all.flatMap((c) => (c.bridge === undefined ? [] : [{ id: c.pairing.machine.id, bridge: c.bridge, connected: c.state === "connected", ...(c.fleet !== undefined ? { fleet: c.fleet } : {}) }]));
    fleet.setMembers(members);
    setLinks(all.map((c) => ({ pairing: c.pairing, state: c.state, ...(c.reason !== undefined ? { reason: c.reason } : {}) })));
    const live = all.some((c) => c.state === "connected");
    if (live) connectionRestored();
    else if (wasLive.current) connectionLost(all.find((c) => c.reason !== undefined)?.reason ?? "no machine is answering");
    if (live) wasLive.current = true;
  }, [fleet]);

  const drop = useCallback(
    (machineId: string): void => {
      const c = conns.current.get(machineId);
      c?.bridge?.close();
      conns.current.delete(machineId);
    },
    [],
  );

  /** Reach one machine: its own address, or the tailnet proxy's to it. */
  const reach = useCallback(
    (pairing: SavedPairing): void => {
      drop(pairing.machine.id);
      const conn: Connection = { pairing, state: "connecting", attempt: 0 };
      conns.current.set(pairing.machine.id, conn);
      update();
      const open = (url: string): void => {
        const mine = engineBridge({ url, token: pairing.token, client: deviceLabel(), version: CLIENT_VERSION, ...(url !== pairing.url ? { where: hostOfUrl(pairing.url) } : {}) });
        conn.bridge = mine;
        mine.onState((state) => {
          if (conns.current.get(pairing.machine.id) !== conn || conn.bridge !== mine) return;
          switch (state.state) {
            case "connected":
              conn.state = "connected";
              conn.reason = undefined;
              update();
              // Which fleet it is in: the machines it lists, and itself.
              void mine.invoke("machines:view", undefined as never).then(
                (view: MachinesView) => {
                  conn.fleet = new Set([view.self.id, ...view.machines.map((m) => m.id)]);
                  update();
                },
                () => undefined,
              );
              return;
            case "waiting":
              conn.state = "waiting";
              conn.reason = state.reason;
              update();
              return;
            case "refused":
              // The token is dead: the machine forgot this phone. Kept, it would be refused at every launch.
              void forgetMachine(pairing.machine.id);
              drop(pairing.machine.id);
              setNotice(`${pairing.machine.label} no longer knows this phone — it was forgotten there. Pair again with a new code`);
              update();
              return;
            case "mismatch":
              conn.state = "mismatch";
              conn.reason = state.reason;
              mine.close();
              update();
              return;
            default:
              return;
          }
        });
      };
      if (pairing.tailnet !== true) return open(pairing.url);
      if (tailnet === undefined) {
        conn.state = "waiting";
        conn.reason = "this build of JaiRA has no Tailscale built in, which this pairing needs: forget this machine and pair by address";
        return update();
      }
      const attempt = ++conn.attempt;
      tailnetEngineUrl(tailnet, tailnetHostname(deviceLabel()), pairing.address).then(
        (url) => {
          if (conns.current.get(pairing.machine.id) === conn && conn.attempt === attempt) open(url);
        },
        (e: Error) => {
          if (conns.current.get(pairing.machine.id) !== conn) return;
          conn.state = "waiting";
          conn.reason = `Tailscale on this phone did not start: ${e.message}`;
          update();
        },
      );
    },
    [drop, update],
  );

  // At launch: every machine kept.
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    void loadPairings().then((kept) => {
      if (!live) return;
      for (const pairing of kept) if (!conns.current.has(pairing.machine.id)) reach(pairing);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [enabled, reach]);

  // Back in front: no reason to sit out the rest of a wait.
  const retry = useCallback((): void => {
    for (const c of conns.current.values()) {
      if (c.state === "mismatch") reach(c.pairing);
      else c.bridge?.retryNow();
    }
  }, [reach]);
  useEffect(() => {
    if (!enabled) return undefined;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") retry();
    });
    return () => sub.remove();
  }, [enabled, retry]);
  useEffect(
    () => () => {
      for (const c of conns.current.values()) c.bridge?.close();
    },
    [],
  );

  const add = useCallback(
    (pairing: SavedPairing): void => {
      setNotice(null);
      void addPairing(pairing);
      reach(pairing);
    },
    [reach],
  );
  const forget = useCallback(
    (machineId: string): void => {
      void forgetMachine(machineId);
      drop(machineId);
      update();
    },
    [drop, update],
  );
  return { bridge: fleet.bridge, loaded, links, notice, add, forget, retry };
}
