---
id: engineering/contracts/ios-tailnet-module
type: engineering-contract
status: proposed
updated: 2026-10-03
visibility: internal
kind: api
owned_by: [engineering/units/machines]
consumers: ["packages/client (the phone app)", "the iOS build flow"]
since: 2026-10-03
siblings: [engineering/decisions/0022-one-tailscale-sign-in, engineering/decisions/0015-one-universal-client]
---

# The iOS app on the tailnet

The plan for the iOS app's own Tailscale sign-in (decision [0022](../decisions/0022-one-tailscale-sign-in.md)
§6), and the contract between three parties: the **iOS build flow** (designed separately), the
**native module** `JairaTailnet` it compiles in, and the **JavaScript** in `packages/client` that calls it.
The person, 2026-10-03: "we're working on an ios app first, so we can leave the android app for later."

Nothing here is built yet. What is built and this plan stands on:

- The desktop side of 0022 (committed with this document): the machine list, Pair making the other
  device show a code, `pair-ask` and `pair` frames a phone can already send (`askToPair` and
  `pairDevice` in `packages/client/bridges/engineBridge.ts`), and a machine's code pop-up.
- In the meantime the phone pairs from its Connect screen: a typed tailnet address, "Ask for a code", then
  the code. This works only while the phone can already reach the tailnet (the Tailscale app). This plan
  replaces that screen.

## When the build flow reaches for this contract, and when it does not

**Use when** producing any iOS build that pairs or connects: a development build on the simulator or a
device, TestFlight, the App Store. The build flow owns §1. This document owns §2 to §5.

**Do not use when** building Android: Android is later, and differs (it needs its own Go wrapper:
embedded Tailscale fails there at start, tailscale/tailscale#17311).

## 1. What the build flow provides

| Item | Requirement | Why |
| --- | --- | --- |
| Host | macOS with Xcode 16.1 or later | TailscaleKit is Swift 6 and needs Xcode 16.1+ |
| Native project | `npx one prebuild --platform ios` in `packages/client` (continuous native generation; `ios/` stays git-ignored, as `android/` is) | The project is generated; nothing native is committed but config plugins and the module |
| Deployment target | iOS 17.0 | React Native 0.87 and One's native code need it (decision 0015) |
| TailscaleKit | `TailscaleKit.xcframework` built from [tailscale/libtailscale](https://github.com/tailscale/libtailscale) at a pinned commit: `make ios-fat` (device + simulator) for development builds, `make ios` (device only) for App Store builds, then signed | libtailscale keeps the simulator slice out of the store framework on purpose |
| Where it lands | `packages/client/modules/jaira-tailnet/ios/Frameworks/TailscaleKit.xcframework`, which the module's podspec lists under `vendored_frameworks`. Not committed: the build flow fetches or builds it, cached by the libtailscale commit | One input with one version, which the module code is written against |
| Module | The local Expo module `packages/client/modules/jaira-tailnet` (Swift, `expo-module.config.json`), picked up by Expo autolinking from `modules/` | §2 |
| Info.plist | `NSAppTransportSecurity` → `NSExceptionDomains` → `ts.net`: `NSIncludesSubdomains` true, `NSExceptionAllowsInsecureHTTPLoads` true (beside the existing `NSAllowsLocalNetworking`) | A machine whose tailnet has no certificates is published as plain `http://<name>.<tailnet>.ts.net`. WireGuard encrypts it, but ATS would refuse it |
| Export compliance | `ITSAppUsesNonExemptEncryption` declared, and the export answers given for WireGuard | The app now carries an encrypted tunnel |
| Signing | A team and provisioning profiles; no extra entitlement (no Network Extension, no VPN profile: the node runs in the app's own process, as in [tunnelless](https://github.com/indiagrams/tunnelless)) | Keeps App Review to an ordinary app |
| Artifacts | A simulator build, a device build, and a TestFlight build, each with its Metro bundle | §5 runs on all three |

Open for the build-flow design (this plan does not decide them): EAS Build versus local Xcode, the macOS
CI runner that builds and caches the xcframework, and TestFlight distribution.

## 2. The native module `JairaTailnet`

One `TailscaleNode` per app, kept in `Application Support/tailnet/` (excluded from backup). It survives
app updates; deleting the app deletes it locally. The device stays on the tailnet until it is removed
in the admin console, which is 0022's Remove.

### Functions (JavaScript → Swift)

| Function | Returns | Meaning |
| --- | --- | --- |
| `start(hostName: string)` | `Promise<void>` | Bring the node up (`jaira-<phone name>`). Signed out or never signed in: a `sign-in` event follows with Tailscale's page. Calling it again while up does nothing |
| `login()` | `Promise<void>` | A new sign-in page (`StartLoginInteractive` through the LocalAPI) |
| `logout()` | `Promise<void>` | Sign out, keeping the identity (0022 §3 Sign out), then stop |
| `forget()` | `Promise<void>` | Stop and delete `Application Support/tailnet/` (0022 §3 Remove, once Tailscale has dropped the device) |
| `stop()` | `Promise<void>` | Take the node down, still signed in |
| `status()` | `Promise<Status>` | The same `running` payload as the event below, or `{ state: "needs-login" }` |
| `devices()` | `Promise<void>` | Say the devices now (a `devices` event) |
| `fetch(url: string)` | `Promise<{ status: number; body: string }>` | One GET over the tailnet (`URLSession.tailscaleSession`): `/.well-known/jaira` on each device |
| `socketOpen(url: string)` | `Promise<number>` | A WebSocket to `ws://` or `wss://<device>/engine` over the tailnet; returns its id |
| `socketSend(id: number, text: string)` | `Promise<void>` | One text frame |
| `socketClose(id: number)` | `Promise<void>` | Close it |
| `serve(handler: true)` | `Promise<void>` | Listen on the tailnet's port 80 for the two requests a machine makes of a phone (§3) |

### Events (Swift → JavaScript)

They are the desktop helper's events (`packages/tailnet/node/node.go`), so the phone and the desktop
share one reading of them: `packages/service/src/tailnetHelper.ts` turns the helper's lines into
`TailnetEvent`s, and the phone's port turns these events into the same type.

| Event | Payload |
| --- | --- |
| `sign-in` | `{ url }`: Tailscale's sign-in page, opened in the browser (`Linking.openURL`) |
| `running` | `{ self: { id, name, dnsName, ips }, user, tailnet }` |
| `dropped` | `{}`: it was running, and Tailscale signed it out (key expired, or removed in the console) |
| `devices` | `{ devices: [{ id, name, dnsName, os, online, lastSeen?, ips }] }`, from the LocalAPI status, after a network-map change settles |
| `socket` | `{ id, kind: "open" \| "message" \| "close" \| "error", text?, reason? }` |
| `request` | `{ id, path, body }`: a machine's request to this phone (§3); answered with `respond(id, status, body)` |
| `error` | `{ message }` |

How each is made from TailscaleKit (verify on the first build, §5):

- Sign-in: the IPN bus's `browseToURL`. TailscaleKit's `LocalAPIClient` is marked incomplete, so a
  missing call is made against the LocalAPI directly through the node's loopback.
- Devices: the LocalAPI's `status` (`Peer`: `ID`, `HostName`, `DNSName`, `OS`, `Online`, `LastSeen`,
  `TailscaleIPs`), as the desktop helper reads it.
- Sockets: a `URLSessionWebSocketTask` on `URLSession.tailscaleSession(node)`. React Native's own
  `WebSocket` on iOS does not use `URLSession`, so it cannot be routed through the node, and the engine
  bridge takes a transport (§3). **Fallback** if the proxied session does not carry WebSocket tasks: a
  loopback door, as the desktop helper has. The module listens on `127.0.0.1` and pipes each connection
  through `node.dial` to the device's port 80. A machine's port 80 answers plainly when its tailnet has
  no certificates; with certificates, the helper also listens on 80, a small engine-side change.

## 3. The JavaScript side

| Piece | Where | Does |
| --- | --- | --- |
| The phone's tailnet port | `packages/client/bridges/phoneTailnet.ts` (and a `.web.ts` saying it is unavailable) | Wraps the module as the desktop's `TailnetPort` reading: `sign-in`, `running`, `dropped`, `devices` |
| The phone's machine list | the universal `MachinesPage` pieces: `machinesModel.ts`'s `tailnetWords` and `machineRowsOf`, fed a view the phone builds | The same rows, icons, Pair, Unpair and code field as the desktop. The phone is "this phone"; its devices come from the module, its paired machines from its saved pairings |
| Probing | the phone's model | `fetch("https://<dns>/.well-known/jaira")`, then `http://` (and serve's 8443, 10000), as `Fleet.probe` does |
| Phone → machine pairing | already built | `askToPair` (the machine shows the code), then `pairDevice` with the code typed on the phone. Both open through `socketOpen` instead of the global `WebSocket` |
| Machine → phone pairing | §4 | The phone answers `/.well-known/jaira` with `{ jaira: true, device: { id, label, kind: "phone" }, os: "ios", version }` and takes a `pair-ask` on `/engine`. It shows the code in the same pop-up the desktop uses (`PairCodeDialog`'s words). The code then arrives in the machine's `pair` frame |
| The engine bridge | `engineBridge.ts` | Takes a socket factory: the global `WebSocket` on the web build, the module's sockets on iOS. Frames, hello, resync and reconnect are unchanged |
| Saved pairings | `savedPairing.native.ts` (the keychain, through `expo-secure-store`) | One pairing becomes several, one per machine in the group (§4), each with its token and engine address |
| Connect screen | `universal/src/screens/Connect.tsx` | Replaced by the phone's machine list. "Connecting to desk" stays as the phase between |

## 4. What the engine adds

| Change | Where | Does |
| --- | --- | --- |
| Pair a phone from the desktop list | `Fleet.pairAsk` / `Fleet.pair` | A device that answers as a phone is asked with `pair-ask { machine }`. The code typed on the desktop goes in `{ t: "pair", code, machine, token }`, where `token` is the token the desktop issued for the phone. The phone answers a new host frame, `{ t: "paired-device", device }`, and the desktop lists it as a phone |
| A phone joins the whole group (0022 §6) | `fleet:introduceDevice` and `fleet:meetDevice` | Like a machine's introductions: the machine the phone paired with asks each other member to issue the phone a token and carries it back. Unpair reaches every machine |
| Phones in `tailnetDevices` | already there | A phone's tailnet node is listed. Once it answers as a phone, it is "Pair" or "Unpair" by its device id |

## 5. Verification, on the first build

| Check | Where | Pass |
| --- | --- | --- |
| Sign in | device and simulator | The sign-in page opens in Safari; after signing in, the phone shows "Signed in as …" and `jaira-<phone>` appears in the admin console once |
| The node survives | device | Background the app, return: the same device, no second registration; after an app update, still the same |
| Devices | device | The tailnet's devices listed with the right icons; a desktop running JaiRA answers as a machine |
| Pair from the phone | device | The desktop shows the code; typed on the phone, the phone connects and draws the desktop's board |
| Pair from the desktop | device | The phone shows the code; typed on the desktop, the phone is listed there as paired |
| Group | device + two desktops | Paired with one, the phone can open the other while the first is off |
| Plain HTTP tailnet | device | A machine on a tailnet without certificates is reached (the ATS exception) |
| Sign out, Remove | device | Sign out keeps the registration; Remove, then deleting it in the console, leaves no identity on the phone |
| Store build | TestFlight | The same without the simulator slice; App Review asks for nothing beyond the export answers |

## The errors, and what the caller does about each

| Condition | Response | Caller does |
| --- | --- | --- |
| The xcframework is missing or the wrong slice | The module does not link: the build fails | The build flow rebuilds it for the target (`make ios` / `make ios-fat`) |
| Tailscale cannot start (no state directory, sandbox) | `error` with the library's message | Shown in the Tailscale row in `--bad`. An earlier sandbox failure ("cannot find executable path", tailscale/tailscale#15410) is closed upstream: check it on the first device build |
| Signed out by Tailscale | `dropped` | The row says so and offers Sign in |
| A device does not answer as JaiRA | `fetch` rejects or is not JaiRA | The row says JaiRA is not running there |
| The proxied session does not carry a WebSocket | `socket` `error` on open | Switch to the loopback door (§2) |

## What a change here breaks, and the deprecation path

The event names and payloads are shared with the desktop helper. A change to one changes the other, in
`node.go`, `tailnetHelper.ts` and the phone's port together. The module's functions are JaiRA's own;
there are no outside callers.

## What fails silently or works differently than the obvious reading

- iOS suspends a backgrounded app, and the node with it: a phone is online on the tailnet only while
  JaiRA is open on it. The desktop list says so ("A phone is online while JaiRA is open on it").
- Deleting the app does not remove the device from the tailnet. Reinstalling makes a new registration,
  `jaira-<phone>-1`, which the desktop list marks as an older registration of… nothing: it is the phone's
  own old one, offline, removed in the console.
- The Tailscale app on the same phone is a different device on the tailnet. Both may be listed.
