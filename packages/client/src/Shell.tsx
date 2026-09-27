import { StrictMode, useEffect, useState, type FormEvent } from "react";
import App from "@jaira/ui/App";
import { CrashBoundary, LooseErrorBanner, installGlobalErrorReporting } from "@jaira/ui/crashScreen";
import { SlotsProvider, type Slots } from "@jaira/ui/slots";
import { setBridge } from "@jaira/ui/store";
import "@jaira/ui/styles.css";
import { readsOnly } from "../bridges/readOnly";
import { socketBridge } from "../bridges/socketBridge";

// Before the first render, as `packages/app/src/renderer/main.tsx` does it. Guarded because `one build`
// imports every page in Node to read its exports, even in SPA mode, and there is no window there.
if (typeof window !== "undefined") installGlobalErrorReporting();

/** Where the token is remembered in a browser. Throwaway, with the rest of 0013 S2. */
const TOKEN_KEY = "jaira.spike.token";

/**
 * Today's DOM tree, exactly as `main.tsx` mounts it, with `slots` standing in for the DOM
 * components that have universal copies (`/universal` provides them all; `/` none, yet). `#root` is
 * kept: the shots driver waits on it.
 *
 * In Electron the preload's bridge is there, and the tree renders at once. Anywhere else (a browser,
 * served by the desktop's spike socket) it first connects back to the host the page came from, read
 * only (ruling 5), and installs that as the bridge.
 */
export function Shell({ slots = {} }: { slots?: Partial<Slots> }) {
  const [ready, setReady] = useState(() => typeof window !== "undefined" && window.jaira !== undefined);
  const [lost, setLost] = useState<string | null>(null);
  if (!ready) return <Connect onConnected={() => setReady(true)} onLost={setLost} />;
  return (
    <div id="root">
      <StrictMode>
        {lost !== null ? <div style={BANNER}>Disconnected from the desktop: {lost}. Reload to reconnect.</div> : null}
        <LooseErrorBanner />
        <CrashBoundary>
          <SlotsProvider slots={slots}>
            <App />
          </SlotsProvider>
        </CrashBoundary>
      </StrictMode>
    </div>
  );
}

const BANNER = { position: "fixed", inset: "0 0 auto 0", zIndex: 1000, padding: "6px 12px", background: "var(--fill-accent, #2563c7)", color: "#fff", font: "12px var(--font-app)" } as const;

function Connect({ onConnected, onLost }: { onConnected: () => void; onLost: (reason: string) => void }) {
  const [address, setAddress] = useState(() => (typeof location === "undefined" ? "" : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/`));
  const [token, setToken] = useState(() => {
    if (typeof location === "undefined") return "";
    return new URLSearchParams(location.search).get("token") ?? safeGet(TOKEN_KEY) ?? "";
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [trying, setTrying] = useState(false);

  const connect = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    setTrying(true);
    setProblem(null);
    const bridge = socketBridge(address, token.trim(), readsOnly);
    try {
      await bridge.ready;
    } catch (err) {
      setProblem((err as Error).message);
      setTrying(false);
      return;
    }
    safeSet(TOKEN_KEY, token.trim());
    bridge.onClose(onLost);
    setBridge(bridge);
    onConnected();
  };

  // A remembered token connects without asking.
  useEffect(() => {
    if (token !== "") void connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <form onSubmit={connect} style={{ maxWidth: 420, margin: "15vh auto", display: "grid", gap: 10, font: "13px var(--font-app)", color: "var(--text)" }}>
      <b>Connect to a JaiRA desktop</b>
      <span style={{ color: "var(--dim)" }}>Read only. The desktop prints its address and token when started with JAIRA_SPIKE_WS=&lt;port&gt;.</span>
      <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="ws://desktop:8765/" style={{ font: "12px var(--font-data)" }} />
      <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="token" style={{ font: "12px var(--font-data)" }} />
      <button type="submit" disabled={trying}>
        {trying ? "Connecting…" : "Connect"}
      </button>
      {problem !== null ? <span style={{ color: "var(--failed, #c0392b)" }}>{problem}</span> : null}
    </form>
  );
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A browser that refuses storage asks for the token again next time; nothing else depends on it.
  }
}
