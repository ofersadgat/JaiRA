import { useState, type JSX } from "react";
import { SafeAreaView, useWindowDimensions } from "react-native";
import { WebFrame } from "./WebFrame";
import { TamaguiProvider, Text, View } from "@tamagui/core";
import { Connect, CopiesBoard, TokenRoot, config, useTokens } from "@jaira/universal";
import { setBridge, useApp } from "@jaira/ui/store";
import { readsOnly } from "../../bridges/readOnly";
import { socketBridge } from "../../bridges/socketBridge";

/**
 * The phone (decision 0013). Ruling 1: "the exact same ui on mobile as there is on desktop", as a
 * migration step. Two views of one connection:
 *
 * - DESKTOP: the desktop's own UI, served by its spike socket and drawn in a WebView — the whole app as
 *   one island. Identical by construction, read only (its socket bridge's allowlist). This is what a
 *   person uses until the frame is copied, region by region, into native.
 * - COPIES: the universal copies that exist, drawn natively from live data through the same store,
 *   over a socket bridge of our own. What it proves is the native path, not a finished screen.
 */
type Connection = { ws: string; http: string; token: string };
type Tab = "desktop" | "copies";

/** In a browser (the `/native` preview), `?address=&token=` fill the form, as a QR code will on a phone. */
function initialFromLocation(): { address: string; token: string } | undefined {
  if (typeof location === "undefined" || typeof location.search !== "string") return undefined;
  const q = new URLSearchParams(location.search);
  const address = q.get("address");
  return address === null ? undefined : { address, token: q.get("token") ?? "" };
}
const initial = initialFromLocation();

export function NativeApp(): JSX.Element {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("desktop");
  const window = useWindowDimensions();

  const connect = async (address: string, token: string): Promise<void> => {
    setBusy(true);
    setProblem(null);
    const ws = /^wss?:\/\//.test(address) ? address : `ws://${address}`;
    const bridge = socketBridge(ws, token, readsOnly);
    try {
      await bridge.ready;
      setBridge(bridge);
      setConnection({ ws, http: ws.replace(/^ws/, "http"), token });
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <TamaguiProvider config={config} defaultTheme="light">
      <TokenRoot palette="ink" scheme="light">
        {/* The window's height, not flex alone: in a browser (the `/native` preview) nothing above sizes it. */}
        <SafeAreaView style={{ height: window.height }}>
          {connection === null ? (
            <Connect {...(initial !== undefined ? { initial } : {})} problem={problem} busy={busy} onConnect={(a, t) => void connect(a, t)} />
          ) : (
            <View flex={1}>
              <Tabs tab={tab} onTab={setTab} />
              {tab === "desktop" ? (
                <WebFrame source={{ uri: `${connection.http.replace(/\/?$/, "/")}?token=${connection.token}` }} style={{ flex: 1 }} />
              ) : (
                <Copies />
              )}
            </View>
          )}
        </SafeAreaView>
      </TokenRoot>
    </TamaguiProvider>
  );
}

/** The copies, in the look the desktop's settings give (the store's `appearance`). */
function Copies(): JSX.Element {
  const { state, appearance } = useApp();
  return (
    <TokenRoot palette={appearance.palette} scheme={appearance.scheme} wash={appearance.wash}>
      {/* The board you stand on, or at the root ("All projects") every project's, as the desktop's Tasks shows them. */}
      <CopiesBoard
        boards={
          state.at !== null
            ? [{ name: state.at, board: state.board }]
            : state.projects.map((p) => ({ name: p.project, board: state.boards[p.project] ?? null }))
        }
      />
    </TokenRoot>
  );
}

function Tabs({ tab, onTab }: { tab: Tab; onTab: (next: Tab) => void }): JSX.Element {
  const t = useTokens();
  const button = (value: Tab, label: string): JSX.Element => (
    <View
      key={value}
      role="button"
      onPress={() => onTab(value)}
      paddingHorizontal={12}
      paddingVertical={6}
      borderRadius={6}
      backgroundColor={(tab === value ? t.v("tint-accent") : "transparent") as never}
    >
      <Text fontFamily={t.v("font-app") as never} fontSize={13} color={(tab === value ? t.v("accent") : t.v("dim")) as never}>
        {label}
      </Text>
    </View>
  );
  return (
    <View flexDirection="row" gap={6} padding={6} borderBottomWidth={1} borderColor={t.v("line") as never} backgroundColor={t.v("panel") as never}>
      {button("desktop", "Desktop UI")}
      {button("copies", "Native copies")}
    </View>
  );
}
