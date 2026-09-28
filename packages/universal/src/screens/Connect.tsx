import { useState, type JSX } from "react";
import { TextInput } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import { useTokens } from "../tokens";

/**
 * Where a phone says which desktop to talk to (decision 0013). THROWAWAY with the spike's transport:
 * an address and a token, both printed by a desktop started with `JAIRA_SPIKE_WS=<port>`. The real
 * remote step pairs instead.
 */
export function Connect({
  initial,
  problem,
  busy,
  onConnect,
}: {
  initial?: { address: string; token: string };
  problem?: string | null;
  busy?: boolean;
  onConnect: (address: string, token: string) => void;
}): JSX.Element {
  const t = useTokens();
  const [address, setAddress] = useState(initial?.address ?? "ws://192.168.1.10:8765/");
  const [token, setToken] = useState(initial?.token ?? "");
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
  return (
    <View flex={1} backgroundColor={t.v("bg") as never} alignItems="center" justifyContent="center" padding={16}>
      <View width="100%" maxWidth={420} gap={10}>
        <Text {...(app as object)} fontSize={15} fontWeight="600">
          Connect to a JaiRA desktop
        </Text>
        <Text {...(app as object)} fontSize={13} color={t.v("dim") as never}>
          Read only. The desktop prints its address and token when started with JAIRA_SPIKE_WS=&lt;port&gt;.
        </Text>
        <TextInput value={address} onChangeText={setAddress} autoCapitalize="none" autoCorrect={false} placeholder="ws://desktop:8765/" style={field} />
        <TextInput value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} placeholder="token" style={field} />
        <View
          role="button"
          onPress={() => onConnect(address.trim(), token.trim())}
          {...((isWeb ? { cursor: "pointer" } : {}) as object)}
          backgroundColor={t.v("fill-accent") as never}
          borderRadius={7}
          paddingVertical={7}
          alignItems="center"
          opacity={busy === true ? 0.6 : 1}
        >
          <Text {...(app as object)} fontSize={13} fontWeight="600" color={t.v("on-accent") as never}>
            {busy === true ? "Connecting…" : "Connect"}
          </Text>
        </View>
        {problem ? (
          <Text {...(app as object)} fontSize={13} color={t.v("bad") as never}>
            {problem}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
