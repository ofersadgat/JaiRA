import { useEffect, useState, type JSX } from "react";
import { Linking, useWindowDimensions } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { DesktopFrame } from "./DesktopFrame";
import { IslandsTab } from "./IslandsTab";
import { TamaguiProvider } from "@tamagui/core";
import { Connect, TokenRoot, UniversalApp, config, connectionLost, installNativeErrorReporting } from "@jaira/universal";
import { setBridge } from "@jaira/ui/store";
import { readsOnly } from "../../bridges/readOnly";
import { socketBridge } from "../../bridges/socketBridge";

/**
 * The phone (decision 0015). Ruling 1: "the exact same ui on mobile as there is on desktop", as a
 * migration step — and not in a WebView (the person, 2026-09-27: "the goal is to replicate the desktop
 * ui, but not in a webview"). Connect, then the universal shell (`UniversalApp`): the desktop's frame
 * drawn natively from the copies, region by region, over a socket bridge to the desktop's store — at a
 * desktop's width in `DesktopFrame`. A region with no copy yet says so where it stands.
 *
 * `&screen=islands` on the link opens the island harness instead (`IslandsTab`), which the emulator
 * test (`shots/android.mts`) measures.
 */
type Connection = { ws: string; token: string };

// Before the first render, as the desktop installs its own: what escapes everything else reaches the
// shell's banner (`LooseErrorBanner`), and React Native's own handler still runs after it.
installNativeErrorReporting();
type Screen = "app" | "islands";

/** In a browser (the `/native` preview), `?address=&token=` fill the form, as a QR code will on a phone. */
function initialFromLocation(): { address: string; token: string } | undefined {
  if (typeof location === "undefined" || typeof location.search !== "string") return undefined;
  const q = new URLSearchParams(location.search);
  const address = q.get("address");
  return address === null ? undefined : { address, token: q.get("token") ?? "" };
}
const initial = initialFromLocation();

/**
 * On a phone, `jaira:///?address=…&token=…` connects straight away — what a QR code from the desktop
 * would carry, and how the emulator test drives it. Parsed by hand: React Native's URLSearchParams
 * implements little of the standard.
 */
function connectionFromLink(url: string | null): { address: string; token: string; screen: Screen } | undefined {
  if (url === null) return undefined;
  const q = Object.fromEntries(
    (url.split("?")[1] ?? "").split("&").filter(Boolean).map((pair) => pair.split("=").map((s) => decodeURIComponent(s)) as [string, string]),
  );
  return q["address"] !== undefined ? { address: q["address"], token: q["token"] ?? "", screen: q["screen"] === "islands" ? "islands" : "app" } : undefined;
}

export function NativeApp(): JSX.Element {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [screen, setScreen] = useState<Screen>("app");
  const window = useWindowDimensions();

  useEffect(() => {
    if (initial !== undefined) return undefined;
    const take = (url: string | null): void => {
      const link = connectionFromLink(url);
      if (link === undefined) return;
      setScreen(link.screen);
      void connect(link.address, link.token);
    };
    void Linking.getInitialURL().then(take);
    const sub = Linking.addEventListener("url", (e) => take(e.url));
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async (address: string, token: string): Promise<void> => {
    setBusy(true);
    setProblem(null);
    const ws = /^wss?:\/\//.test(address) ? address : `ws://${address}`;
    const bridge = socketBridge(ws, token, readsOnly);
    try {
      await bridge.ready;
      // The shell says so when the desktop goes away (`floats/Disconnected.tsx`), as `Shell.tsx` does.
      bridge.onClose(connectionLost);
      setBridge(bridge);
      setConnection({ ws, token });
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaProvider>
      <TamaguiProvider config={config} defaultTheme="light">
        {/* The window's height, not flex alone: in a browser (the `/native` preview) nothing above sizes it.
            react-native-safe-area-context's SafeAreaView, not React Native's, which pads only on iOS: on
            Android the app sat under the status bar. */}
        <SafeAreaView style={{ height: window.height }}>
          {connection === null ? (
            <TokenRoot palette="ink" scheme="light">
              <Connect {...(initial !== undefined ? { initial } : {})} problem={problem} busy={busy} onConnect={(a, t) => void connect(a, t)} />
            </TokenRoot>
          ) : screen === "islands" ? (
            <TokenRoot palette="ink" scheme="light">
              <IslandsTab />
            </TokenRoot>
          ) : (
            <DesktopFrame>
              <UniversalApp />
            </DesktopFrame>
          )}
        </SafeAreaView>
      </TamaguiProvider>
    </SafeAreaProvider>
  );
}
