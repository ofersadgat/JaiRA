import { StrictMode, useEffect, useState } from "react";
import { TamaguiProvider } from "@tamagui/core";
import { Replayed, UniversalApp, config } from "@jaira/universal";
import { setBridge } from "@jaira/ui/store";
import "../rn/fonts.css";
import { readsOnly } from "../../bridges/readOnly";
import { socketBridge } from "../../bridges/socketBridge";

/**
 * `/rn`: the phone's app, in a browser (decision 0015). The universal shell drawn by react-native-web,
 * on the NATIVE token path (`Replayed`), with no `styles.css` on the page — so every colour, size and
 * rule on it comes from the copies, as on a phone. The fidelity gate diffs it against `/`, the desktop's
 * own page, in the same window and the same state; the Android emulator is the final check after it.
 *
 * In Electron it reads the window's own bridge. Anywhere else it connects to the desktop's spike socket
 * with `?address=&token=`, as the phone does.
 */
export default function Rn() {
  const [ready, setReady] = useState(() => typeof window !== "undefined" && window.jaira !== undefined);
  useEffect(() => {
    if (ready || typeof location === "undefined") return;
    const q = new URLSearchParams(location.search);
    const address = q.get("address") ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/`;
    const bridge = socketBridge(address, q.get("token") ?? "", readsOnly);
    void bridge.ready.then(() => {
      setBridge(bridge);
      setReady(true);
    });
  }, [ready]);
  return (
    <div id="root">
      {ready ? (
        <StrictMode>
          <TamaguiProvider config={config} defaultTheme="light">
            <Replayed>
              <UniversalApp />
            </Replayed>
          </TamaguiProvider>
        </StrictMode>
      ) : null}
    </div>
  );
}
