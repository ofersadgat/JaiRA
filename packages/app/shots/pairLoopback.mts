/**
 * Pairing the window with a `jaira serve` on loopback (`JAIRA_REACH=loopback`), the way a person pairs
 * two machines on a tailnet (decision 0022 §5): the server signs in, the window is told the server is
 * the tailnet's one device (`JAIRA_LOOPBACK_PEERS`, set before the window starts), Pair is pressed for
 * it, and the code the server shows (`jaira machine list`) is typed in the window.
 */
import type { MachinesView } from "@jaira/shared";
import type { App } from "./driver.mjs";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Sign the server in, and say where it is to the window that starts next. */
export function serverOnTailnet(jaira: (...args: string[]) => string): string {
  const signedIn = JSON.parse(jaira("machine", "signin")) as { url?: string };
  if (signedIn.url === undefined) throw new Error("the other machine did not sign in");
  process.env["JAIRA_LOOPBACK_PEERS"] = signedIn.url;
  return signedIn.url;
}

/** The window: signed in, Pair pressed for the server once it is found, and the server's code typed. */
export async function pairWithServer(app: App, jaira: (...args: string[]) => string): Promise<string> {
  await app.ipc("machines:signIn", undefined);
  let device: string | undefined;
  for (let i = 0; i < 80 && device === undefined; i += 1) {
    const view = await app.ipc<MachinesView>("machines:view", undefined);
    device = view.tailnetDevices.find((d) => d.jaira?.kind === "machine")?.id;
    if (device === undefined) await sleep(250);
  }
  if (device === undefined) throw new Error("the window never found the other machine on the tailnet");
  await app.ipc("machines:pairAsk", { device });
  const asked = (JSON.parse(jaira("machine", "list")) as { asked?: { code: string } }).asked;
  if (asked === undefined) throw new Error("the other machine showed no code");
  await app.ipc("machines:pair", { device, code: asked.code });
  return device;
}
