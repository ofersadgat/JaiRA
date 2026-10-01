import { StrictMode, useState } from "react";
import App from "@jaira/ui/App";
import { CrashBoundary, LooseErrorBanner, installGlobalErrorReporting } from "@jaira/ui/crashScreen";
import { SlotsProvider, type Slots } from "@jaira/ui/slots";
import { useConnectionLost } from "@jaira/universal";
import "@jaira/ui/styles.css";
import { DisconnectedBanner } from "./DisconnectedBanner";
import { Remote, pageLink } from "./Remote";

// Before the first render, as `packages/app/src/renderer/main.tsx` does it. Guarded because `one build`
// imports every page in Node to read its exports, even in SPA mode, and there is no window there.
if (typeof window !== "undefined") installGlobalErrorReporting();

/**
 * Today's DOM tree, exactly as `main.tsx` mounts it, with `slots` standing in for the DOM
 * components that have universal copies (`/universal` provides them all; `/` none, yet). `#root` is
 * kept: the shots driver waits on it.
 *
 * In Electron the preload's bridge is there, and the tree renders at once. Anywhere else (a browser,
 * served the page by a machine's engine) it is a device: `Remote` pairs it with that machine, by the
 * code the machine shows, and connects it over the engine's own transport (decision 0013, amended
 * 2026-09-30) — the same screen and the same bridge a phone uses.
 */
export function Shell({ slots = {} }: { slots?: Partial<Slots> }) {
  // Once, at mount: `Remote` takes the code out of the address bar when it has paired with it.
  const [link] = useState(pageLink);
  return (
    <Remote link={link} frame={(screen) => <div style={CONNECT}>{screen}</div>}>
      <div id="root">
        <StrictMode>
          <Lost />
          <LooseErrorBanner />
          <CrashBoundary>
            <SlotsProvider slots={slots}>
              <App />
            </SlotsProvider>
          </CrashBoundary>
        </StrictMode>
      </div>
    </Remote>
  );
}

/** The Connect screen fills the window: nothing above it gives it a height. */
const CONNECT = { height: "100vh", display: "flex", flexDirection: "column" } as const;

function Lost() {
  const lost = useConnectionLost();
  return lost !== null ? <DisconnectedBanner lost={lost} /> : null;
}
