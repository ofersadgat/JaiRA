import { TamaguiProvider, View } from "@tamagui/core";
import { Replayed, TokenRoot, config, useTokens } from "@jaira/universal";
import "../rn/fonts.css";
import { specimenOf, lookOf } from "../specimens/registry";

/**
 * `/specimen-rn?name=…&look=…`: the universal copy of a specimen, drawn from the same fixture as
 * `/specimen-dom`, on the native token path and with no stylesheet — see `specimenDom.web.tsx`.
 */
export default function SpecimenRn() {
  const q = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  const specimen = specimenOf(q.get("name"));
  const look = lookOf(q.get("look"));
  if (specimen === undefined) return <p>No specimen by that name.</p>;
  return (
    <div id="root" style={{ display: "block", height: "auto" }}>
      <TamaguiProvider config={config} defaultTheme="light">
        <Replayed>
          <TokenRoot palette={look.palette} scheme={look.scheme} wash={look.wash}>
            <Box width={specimen.width}>
              <specimen.rn />
            </Box>
          </TokenRoot>
        </Replayed>
      </TamaguiProvider>
    </div>
  );
}

function Box({ width, children }: { width: number; children: React.ReactNode }) {
  const t = useTokens();
  return (
    <View id="specimen" width={width} padding={12} backgroundColor={t.v("bg") as never} alignSelf="flex-start">
      {children}
    </View>
  );
}
