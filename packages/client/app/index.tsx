import { TamaguiProvider } from "@tamagui/core";
import { SHARED, config } from "@jaira/universal";
import { Shell } from "../src/Shell";

/**
 * The desktop's page, as Electron loads it (decision 0013): today's DOM tree, with the universal
 * copies that have passed the fidelity gate standing in for their DOM originals (`SHARED`, S4).
 */
export default function Index() {
  return (
    <TamaguiProvider config={config} defaultTheme="light">
      <Shell slots={SHARED} />
    </TamaguiProvider>
  );
}
