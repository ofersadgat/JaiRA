import { TamaguiProvider, View } from "@tamagui/core";
import { Replayed, TokenRoot, config, useTokens } from "@jaira/universal";
import "../rn/fonts.css";
import { SPECIMENS, specimenOf, lookOf } from "../specimens/registry";

/**
 * `/specimen-rn?name=…&look=…`: one component drawn alone from a fixture, in a box of the specimen's
 * width (`#specimen`), on the native token path and with no stylesheet. `pair.mts --specimen`
 * photographs it and holds the picture against the reference picture of the same name — the fidelity
 * gate for a leaf, without a world to seed or a scene to reach (decision 0015).
 */
export default function SpecimenRn() {
  const q = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  const specimen = specimenOf(q.get("name"));
  const look = lookOf(q.get("look"));
  // With no specimen named, the page says which there are: `pair.mts --all` and `--accept` read the
  // names here, since the registry imports the universal tree and cannot be read from Node.
  if (specimen === undefined) return <p id="specimens" data-names={JSON.stringify(Object.keys(SPECIMENS))}>No specimen by that name.</p>;
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
