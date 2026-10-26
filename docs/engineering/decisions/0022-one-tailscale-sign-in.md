---
id: engineering/decisions/0022-one-tailscale-sign-in
type: decision
status: built
updated: 2026-10-26
decides_for: [engineering/units/machines]
---

# 0022. One Tailscale sign-in

Amends decision 0013 §1–§3 (reach and pairing) and its 2026-09-30 amendment (phones and browsers).
Built 2026-10-03 as "0017"; lost from main and restored 2026-10-26 under this number (see the
amendment at the end), since 0017 is the iOS releases' decision.
Mockups, three rounds at one address: https://claude.ai/artifact/EPJzihth8zQvdQ3Bf2yJeo (round 3 is
what this builds). The person's words are quoted where they settle something; nothing below reopens
them.

## Context

2026-10-02. The person found the same PC twice on their tailnet: `jaira-desktop-vuvo7fl` and
`jaira-desktop-vuvo7fl-1`. The second was the screenshot rig's home in another clone
(`JaiRA-2/packages/app/shots/.world-goldens/home`): a second JaiRA home has its own machine id, its
"Reachable" switch was turned on, and the bundled helper signed it in a minute after the real one.
Nothing tied a tailnet registration to one home, and nothing showed what was registered, or let it be
signed out or removed.

Pairing also asked for an address typed by hand, though both machines were already on the same
tailnet and could see each other.

Three facts about Tailscale shaped what follows:

- Signing a regular device out only expires it. It stays on the admin console's Machines page until
  someone removes it there or through the API. Only an ephemeral device goes on sign-out, and an
  ephemeral device also goes after a while offline (so it would need a new sign-in after a long sleep).
- Tailscale's OAuth apps (alpha, made through the API) authorize only users of the tailnet that owns
  the app, and the device scope they document is a single-use `auth_keys:create:once`. A JaiRA app
  built into the installer would work on one tailnet, the author's.
- A device on a tailnet sees every other device on it: name, system, online, last seen. No API
  credential is needed for that.

## Decision

### 1. One sign-in

The person: "i dont want two login processes to tailscale, i want one." The Tailscale sign-in is the
only one: the bundled helper's, or the Tailscale app's where it is installed. JaiRA holds no Tailscale
API credential. (An OAuth client the person creates was mocked up and dropped, and so was a JaiRA app
built into the installer, since it would serve one tailnet.)

A JaiRA account that a person associates with their Tailscale account, and a website they log in to as
another remote control like the phone, are a later goal (the person: "the jaira account + website is a
future goal"). Nothing here builds them; §6 leaves room for them.

### 2. Only the default home

The person: "only the default root/home can have a tailscale connection. the reason for this is that
the test harness uses the second home to not interfere with the users actual operation." A base root
other than `~/.jaira` (`JAIRA_BASE_DIR`, `--home`) never signs in or publishes; its Tailscale row says
which home it is. Development rigs keep `JAIRA_REACH=loopback`, which is no tailnet at all.

### 3. Signed in replaces Reachable

Signed in means this machine is on the tailnet and paired machines can reach it; the tokens from
pairing still decide who gets in. The Reachable switch is gone. The Tailscale row has these states:

| State | Says | Offers |
| --- | --- | --- |
| not signed in | what signing in does, and the name it will have | Sign in to Tailscale |
| signing in | finish in the browser | open the page again, Cancel |
| signed in | the account, this machine's tailnet name and tailnet | Sign out, Remove this machine… |
| signed out | still registered as …; who signed in last | Sign in to Tailscale, Remove this machine… |
| removing | waiting for Tailscale to remove it | open the admin console, Cancel |
| other home | only `~/.jaira` connects | nothing |
| the Tailscale app | signed in through the app, as … | nothing: sign in and out belong to the app |

- **Sign out** (the person: "the machine is still recognized, but a different user might be signed
  in to the machine right now and the original user might sign back in later"): the helper signs
  out and keeps its identity, so signing in again, as anyone, reuses this registration. The original
  user signs back in through Tailscale's sign-in page; there is no remembered-accounts switch.
- **Remove this machine** ("tailscale shouldnt recognize this machine"): only the admin console or the
  API can delete a device, so JaiRA opens this device's page in the admin console. The helper stays
  signed in until Tailscale drops the device; JaiRA sees that, then deletes the helper's identity and
  stops it. Until then the identity is kept, so a later sign-in reuses the registration rather than
  making a `-1`.
- With the Tailscale app, JaiRA never runs `tailscale logout`, which would take the whole PC off the
  tailnet. It only turns its own `tailscale serve` on and off.

### 4. The list is the tailnet

The person: "a list of machines much like you'd see in the workspace list; only that there is a button
on the right of the row for 'pair' if you havent paired with the machine and 'unpair' if you have."

- **Every device on the tailnet is listed**, signed in or with machines paired alike. A device where no
  JaiRA answers says so, "so that the user knows they need to start jaira on that machine to get it to
  appear". Whether JaiRA runs on an offline device is not known until it comes online.
- A device answers as JaiRA at `/.well-known/jaira`, asked over the tailnet: HTTPS on 443 (and 8443 and
  10000, where `tailscale serve` may have put it), then plain HTTP on 80 (the helper on a tailnet
  without certificates).
- **Refresh** asks every device again. The list also asks again by itself when a device comes online.
- Rows use the conversation's machine icon (`MachineIcon`: the form is the shape, the system the mark,
  the connection the dot) and the environment list's layout (the person: "the machines should use the
  same icons that they would use in the machine list in the conversation"). A device with no JaiRA has
  no form: the dashed shape the conversation uses for "not decided", with Tailscale's system as the
  mark; a phone's shape comes from its system.
- An offline device with this machine's tailnet name and a `-N` suffix is marked as an older
  registration of this machine, with its admin console page.
- Paired machines that are not on the tailnet now (another tailnet, a loopback rig) are listed too, as
  offline.

### 5. Pair and Unpair

- **Pair** on machine A for machine B asks B to show a one-time code (a `pair-ask` frame before any
  token). B shows it over whatever its window shows, with Refuse; a `jaira serve` with no window writes
  it to its log. The person types it on A, which then pairs as before (`pair` with the code, tokens
  both ways, introductions to the rest of the group). Typing it on A proves the person can use both
  screens. Either side can start.
- **Unpair** takes the machine out of the whole group (the person: "whole group"), which is what
  `forget` did.
- Typing an address by hand is gone (the person: "for now, we shouldnt need this as every connection
  will use tailscale"), and so is the Show a code row.

### 6. Phones and browsers

- **A phone signs in to Tailscale inside JaiRA** (the person: "phones should also use the tailscale
  flow and not a separate one"), with Tailscale's library built into the app, as the desktop helper
  is. It joins the tailnet as `jaira-<name>`, needs no Tailscale app, and has the same list and the
  same Pair. Pair on the phone makes the machine show the code; Pair on a machine makes the phone show
  it.
- **A phone joins the whole group** like a machine: each machine issues it a token, it can open any of
  them, and Unpair on it reaches every machine. It still runs no engine and keeps no copies.
- **Browser pairing is removed** until the website exists (the person: "leave it out until the website
  is built"), and with it the engine serving the web client to browsers over the tailnet.

### 7. Reaching other devices through the helper

The engine's own process is not on the tailnet when the helper is what joined it: only the helper is.
The helper therefore also opens local doors: asked for a device's address, it serves a loopback port
that forwards HTTP (WebSockets included) to that address over the tailnet, TLS and all. The engine
connects to the loopback port. The phone's built-in Tailscale does the same for the phone's client.

## Consequences

- `MachineReach`, the `machines:reach` channel and `machines:add` are replaced by the Tailscale row's
  channels and `machines:pair`; the device pairing frame no longer takes a browser. (`machines:pairCode`
  stays for Pair a phone: see the 2026-10-26 amendment.)
- The helper becomes a long-running process JaiRA talks to over stdin and stdout (sign in, sign out,
  devices, doors), rather than a one-shot that publishes and stays.
- A second home on a developer's machine can no longer register by accident.
- Remove is two clicks, one of them in Tailscale's admin console. That is the price of one sign-in.

## Built (2026-10-03, the desktop)

- `packages/tailnet/node` is the node (sign in and out, devices, publishing, doors); `jaira-tailnet` is
  a thin stdin/stdout wrapper over it, which exits when JaiRA does. `service/src/tailnet.ts` is the one
  port with three routes (the helper, the Tailscale app, loopback for rigs) and the default-home rule.
- `Fleet` holds the Tailscale row's state, the tailnet's devices and their probes, `pair-ask` both
  ways, Refuse, and Remove's wait. Settings → Machines draws it (`MachinesPage`, `PairCodeDialog`),
  from `machinesModel.ts`'s `tailnetWords` and `machineRowsOf`.
- The phone keeps pairing in the meantime: its Connect screen asks the machine for a code first. The
  iOS app's own sign-in is planned in [ios-tailnet-module](../contracts/ios-tailnet-module.md).
- **Seen on the real tailnet** (this computer, `~/.jaira`, the person's tailnet): the new helper came up
  on the existing identity with no new sign-in, said who is signed in and the tailnet, listed the
  tailnet's devices (the `-1` duplicate, offline, marked as an older registration with its console
  link), and a door to this machine's own tailnet address reached the published port with the right
  Host. In the real app the Settings page said all of it. Two engines on loopback paired through Pair and
  the code (`shots/machines-real.mts`).
- **Not seen on the real tailnet:** Sign out and a fresh sign-in, Remove completing (both change the
  person's registration), and pairing two real machines (there is no second one yet).

## Amendment, 2026-10-26: restored, phones as built since, and Tailscale going down

**Restored.** The commit that built this (2026-10-03) was never pushed, and on 2026-10-06 the checkout
was reset to the remote's main, which dropped it. The app then started the helper the old way (its
stdin closed) while the helper on disk was this one, which leaves when its stdin closes: it quit at
every start, and the person's phone said the machine "did not answer". Restored onto main 2026-10-26
under this number.

**Phones keep the 2026-10-04 flow** (decision 0013, amended 2026-10-04), which came after §6 and is
what the person's phone uses: Settings → Machines → Your machines → **Pair a phone** shows a code while
this machine announces itself on the local network; the phone finds it, proves the code, joins the
tailnet with Tailscale built in and is told this machine's tailnet address — now the one the
Tailscale row is signed in at, and only while it is (Pair a phone is greyed until then). §6's "Pair on
the phone makes the machine show the code" is not built; a `pair` frame takes either code, the one a
`pair-ask` showed or the one Pair a phone shows. The phone's Connect screen is the 2026-10-04 one.
With the engine serving no client (§6), the phone rigs serve `dist/client` themselves
(`shots/serveClient.mts`).

**Tailscale going down is an error** (the person: "if tailscale goes down, then that should be an
error that surfaces both through the logs and the error badge system"). The Tailscale row has an
eighth state:

| State | Says | Offers |
| --- | --- | --- |
| down | Tailscale went down, and why; this machine is off the tailnet; JaiRA tries again by itself | Reconnect, Sign out (the helper's) |

- **When.** This machine wants to be on the tailnet and has been on it (its registration is kept), and
  Tailscale stops without being asked: the helper exits or will not start, or the Tailscale app
  disconnects. A first sign-in that fails is not one — nothing was lost — and neither is a sign-out
  or Remove the person asked for.
- **Said once per outage**, as an error in the log (source `machines`) that names the Settings item it
  is also shown as (`raised: "tailnet"`), so the log's own count does not count it twice (a later try
  that fails another way is a warning, likewise not counted); and as a
  **Tailscale** error on Settings → Machines' Needs attention, counted on the Settings row and in the
  sidebar like Connections' errors, with **Reconnect**. It clears itself once this machine is back on
  the tailnet; dismissed, it stays hidden until then.
- **Tried again by itself**, 15 seconds after and then twice as long each time up to ten minutes:
  nobody may be at the machine, and a phone cannot press anything on a machine it cannot reach.
  Reconnect tries now.
- **Signed out by Tailscale** (the key expired, or the device was removed in the admin console) is an
  error too, with nothing to try again: it clears once the person signs in.
