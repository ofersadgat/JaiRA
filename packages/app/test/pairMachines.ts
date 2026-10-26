/**
 * Pair two fleets the way a person does (decision 0022 §5): Pair pressed on `a` asks `b` to show a code,
 * and the code `b` shows is typed on `a`. Both are signed in to a loopback stand-in for the tailnet.
 */
import type { Fleet } from "@jaira/service";

export async function pairMachines(a: Fleet, b: Fleet): Promise<void> {
  const url = b.view().self.tailnet.url;
  if (url === undefined) throw new Error("the second machine is not signed in");
  await a.askAt(url);
  await a.pairAt(url, b.view().asked!.code);
}
