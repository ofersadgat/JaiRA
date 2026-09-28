import { TamaguiProvider } from "@tamagui/core";
import { COPIES, config } from "@jaira/universal";
import { Shell } from "../Shell";

/**
 * The universal tree in a browser (decision 0013, S3): the same shell as `/`, with every universal
 * copy standing in for its DOM original. `shots/parity.mts` diffs this page against `/` — the
 * fidelity gate — and a phone runs the same copies natively.
 */
export default function Universal() {
  return (
    <TamaguiProvider config={config} defaultTheme="light">
      <Shell slots={COPIES} />
    </TamaguiProvider>
  );
}
