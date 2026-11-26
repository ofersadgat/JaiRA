/**
 * Settings → Machines' model (decisions 0013 §1–§3, 0022): what its rows say and the fleet it reads — the
 * words and the reading `MachinesPage` (`packages/universal/src/components/settings/MachinesPage.tsx`)
 * draws. A sentence that holds a link or a value is a list of {@link WordPart}s, which the page draws
 * run by run (`Words.tsx`).
 */
import { LAN_PAIRING_PORT, MACHINE_PIECE_WORDS, PAIRING_CODE_MS, parseRemoteProjectKey, type CopyChoice, type MachineForm, type MachinesView, type NearbyEvent, type PeerView, type SettingsSyncView } from "@jaira/shared/browser";
import { dotOf, faceOf, machineKindOf, type MachineFace } from "./environmentModel";
import type { MachineMark } from "./machineIcons";
import { syncCache } from "./store";
import { useView } from "./useView";

/** A run of a sentence: words, a value (drawn as code), an error, a quiet note, or a link. */
export type WordPart = string | { code: string } | { error: string } | { hint: string } | { link: string; href: string };

/** Bytes, for the On disk row. */
export function sizeOf(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export const COPY_WORDS: Record<CopyChoice["mode"], string> = {
  everything: "Every task and conversation from every paired machine, archived ones too.",
  "not-archived": "Every task that is not archived, from every paired machine. A task archived on its machine leaves this copy.",
  chosen: "The tasks that are not archived, of the projects switched on below.",
  nothing: "No copy. Other machines' tasks are read from them while they are online.",
};

/** The Copy row's choices. */
export const COPY_CHOICES: ReadonlyArray<readonly [string, CopyChoice["mode"]]> = [
  ["Everything", "everything"],
  ["Not archived", "not-archived"],
  ["Chosen projects", "chosen"],
  ["Nothing", "nothing"],
];

/** What an agent is called in Settings → Machines' sign-ins row. */
const AGENT_NAMES: Record<string, string> = { "claude-cli": "Claude Code", "codex-cli": "Codex" };

/**
 * Settings → Machines' settings section (decision 0026): what the switch's row says, what stays on this
 * machine, how the agents' sign-ins fare here, and what another machine sent that was not taken.
 */
export function settingsSyncWords(sync: SettingsSyncView | undefined, now = Date.now()): { keep: string; stays: string; logins: string; refused: string[] } {
  if (sync === undefined) return { keep: "…", stays: "", logins: "", refused: [] };
  const when =
    sync.at === undefined
      ? "Not in step with another machine yet."
      : (() => {
          const minutes = Math.round((now - sync.at) / 60_000);
          return minutes < 1 ? "Last in step just now." : minutes < 60 ? `Last in step ${minutes} minute${minutes === 1 ? "" : "s"} ago.` : `Last in step ${new Date(sync.at).toLocaleString()}.`;
        })();
  const keep = sync.on
    ? `Your Shared and Just you settings with their permission sets and workflows, the keys in JaiRA's keychain, your forge sign-ins and your agents' sign-ins follow you to every paired machine; the latest change to each wins. ${when}`
    : "This machine keeps its own settings: it neither sends its changes nor takes the other machines'.";
  const following = sync.logins.filter((l) => l.synced);
  const followed = following.map((l) => AGENT_NAMES[l.agent] ?? l.agent);
  const where = following.find((l) => l.where !== undefined)?.where;
  const not = sync.logins.filter((l) => !l.synced);
  const logins = [
    followed.length > 0
      ? `${followed.join(" and ")} ${followed.length === 1 ? "follows" : "follow"}${where !== undefined ? `, kept ${where}` : ""}: signed in or out on one machine, signed in or out on all.`
      : "",
    ...not.map((l) => `${AGENT_NAMES[l.agent] ?? l.agent} does not here: ${l.why ?? "it cannot be reached"}.`),
  ]
    .filter((line) => line !== "")
    .join(" ");
  const stays = `${MACHINE_PIECE_WORDS.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join("; ")}.`;
  return { keep, stays, logins, refused: (sync.refused ?? []).map((r) => `${r.what.charAt(0).toUpperCase()}${r.what.slice(1)}: ${r.why}`) };
}

/** The On disk row's sentence. */
export function diskWords(disk: { bytes: number; machines: number } | undefined): string {
  return disk === undefined ? "…" : disk.bytes === 0 ? "Nothing copied yet." : `${sizeOf(disk.bytes)} from ${disk.machines} machine${disk.machines === 1 ? "" : "s"}, under ~/.jaira/remote.`;
}

/**
 * The fleet: a view of the window's cache, read again when the change log says the machines moved
 * (decision 0018, group 7). The second half is for an action that answered with the fleet as it now
 * stands — it has the view read again, ahead of the change log.
 */
export function useMachines(): [MachinesView | undefined, (next: MachinesView) => void] {
  return [useView("machines:view", undefined).value, machinesMoved];
}

/** Something this window did moved the fleet: read it again now. */
export function machinesMoved(): void {
  void syncCache().refresh("machines:view", undefined);
  void syncCache().refresh("machines:outbox", undefined);
}

/**
 * The machine a project belongs to, when it is another machine and that machine is away — what
 * `OfflineBanner` says. Nothing for this machine's own.
 */
export function offlinePeerOf(view: MachinesView | undefined, project: string | undefined): PeerView | undefined {
  const machineId = parseRemoteProjectKey(project)?.machineId;
  const peer = machineId === undefined ? undefined : view?.machines.find((m) => m.id === machineId);
  return peer === undefined || peer.state === "online" ? undefined : peer;
}

export const errorOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Whether an error is a machine refusing a channel it does not know: it runs an older JaiRA. */
export const isOlderEngine = (e: unknown): boolean => /does not answer '/.test(errorOf(e));

export function ago(at: number | undefined): string {
  if (at === undefined) return "never seen";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "last seen now";
  if (minutes < 60) return `last seen ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `last seen ${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `last seen ${Math.round(hours / 24)} days ago`;
}

export function sentence(text: string): string {
  const t = text.trim();
  const c = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(c) ? c : `${c}.`;
}

/** A tailnet device is signed in to Tailscale as the account this machine is: auto pair's test. */
export function sameAccountOf(view: MachinesView, device: { user?: string }): boolean {
  const mine = view.self.tailnet.user;
  return device.user !== undefined && mine !== undefined && device.user.toLowerCase() === mine.toLowerCase();
}

/** What Allow auto pair says (decision 0022, amended 2026-11-25), on or off. */
export function autoPairWords(view: MachinesView): string {
  const as = view.self.tailnet.user !== undefined ? `signed in to Tailscale as ${view.self.tailnet.user}` : "signed in to Tailscale as you";
  return view.self.autoPair
    ? `Your machines ${as} pair with this one with no code, and this one pairs by itself with those that allow it too. A machine you unpair is not paired again by itself.`
    : `Pairing takes a code shown on the other machine. On, your machines ${as} pair with this one with no code.`;
}

/**
 * What an unpaired JaiRA machine's row says under its name: why auto pair did not pair, or what Pair
 * will do when it allows auto pair.
 */
export function autoPairSubOf(view: MachinesView, device: { user?: string; autoPairFailed?: string; jaira?: { kind: string; autoPair?: boolean } }): string | undefined {
  if (device.jaira?.kind !== "machine") return undefined;
  if (device.autoPairFailed !== undefined) return `Auto pair did not pair: ${sentence(device.autoPairFailed).replace(/^./, (c) => c.toLowerCase())}`;
  if (device.jaira.autoPair !== true) return undefined;
  if (!sameAccountOf(view, device)) return `Allows auto pair, but is signed in to Tailscale as ${device.user ?? "another account"}: Pair asks for a code.`;
  return view.self.autoPair ? "Allows auto pair: pairing with this machine by itself." : "Allows auto pair: Pair pairs it with no code.";
}

/** What the Tailscale row says (decision 0022 §3), and which of its buttons it has. */
export type TailnetAction = "signIn" | "signOut" | "remove" | "cancel" | "removeCancel" | "reconnect";

export function tailnetWords(view: MachinesView): { description: WordPart[]; actions: TailnetAction[] } {
  const tn = view.self.tailnet;
  const named = (node: string | undefined, tailnet: string | undefined): WordPart[] =>
    node === undefined ? [] : [" This machine is ", { code: node }, ...(tailnet !== undefined ? [" on ", { code: tailnet }] : []), "."];
  switch (tn.state) {
    case "unavailable":
      if (tn.home !== undefined) return { description: ["Only JaiRA's default home, ", { code: "~/.jaira" }, ", connects to Tailscale. This window runs from ", { code: tn.home }, "."], actions: [] };
      return {
        description: [{ error: sentence(tn.reason ?? "Tailscale cannot be used here.") }, ...((tn.reason ?? "").includes("not installed") ? [" ", { link: "Get Tailscale", href: "https://tailscale.com/download" }] : [])],
        actions: [],
      };
    case "off": {
      const reason: WordPart[] = tn.reason !== undefined ? [" ", { error: sentence(tn.reason) }] : [];
      if (tn.user === undefined) {
        return {
          description: ["Sign in to reach your other machines and phones and pair with them.", ...(tn.node !== undefined ? [" JaiRA joins your tailnet as ", { code: tn.node }, "."] : []), " Nothing is opened to the internet.", ...reason],
          actions: ["signIn"],
        };
      }
      return {
        description: ["Signed out.", ...(tn.node !== undefined ? [" This machine is still ", { code: tn.node }, ...(tn.tailnet !== undefined ? [" on ", { code: tn.tailnet }] : []), `; ${tn.user} signed in last.`] : []), ...reason],
        actions: tn.via === "tailscale" ? ["signIn"] : ["signIn", "remove"],
      };
    }
    case "signing-in":
      return {
        description: tn.signInUrl !== undefined ? ["Finish signing in in your browser. ", { link: "Open the sign-in page again", href: tn.signInUrl }] : ["Connecting to Tailscale…", ...(tn.reason !== undefined ? [" ", { error: sentence(tn.reason) }] : [])],
        actions: ["cancel"],
      };
    case "on":
      if (tn.via === "tailscale") {
        return { description: [`Through the Tailscale app, signed in as ${tn.user ?? "?"}.`, ...named(tn.node, tn.tailnet), " Sign this computer in or out in the Tailscale app."], actions: [] };
      }
      return { description: [`Signed in as ${tn.user ?? "?"}.`, ...named(tn.node, tn.tailnet)], actions: ["signOut", "remove"] };
    case "removing":
      return {
        description: ["Waiting for Tailscale to remove ", { code: tn.node ?? "this machine" }, ". ", ...(tn.consoleUrl !== undefined ? [{ link: "Open it in the admin console", href: tn.consoleUrl }] : [])],
        actions: ["removeCancel"],
      };
    case "down":
      return {
        description: [
          { error: sentence(`Tailscale went down: ${tn.reason ?? "it stopped"}`) },
          " ",
          ...(tn.node !== undefined ? [{ code: tn.node }, " is off your tailnet, so your other machines and phones cannot reach it."] : ["This machine is off your tailnet, so your other machines and phones cannot reach it."]),
          " JaiRA tries again by itself.",
        ],
        actions: tn.via === "tailscale" ? ["reconnect"] : ["reconnect", "signOut"],
      };
  }
}

/** What the Remove dialog says: signed in, JaiRA waits for Tailscale to drop it; signed out, it forgets it now. */
export function removeSpecWords(view: MachinesView): { title: string; note: string; confirmLabel: string } {
  const node = view.self.tailnet.node ?? "this machine";
  return view.self.tailnet.state === "on"
    ? {
        title: "Remove this machine from your tailnet?",
        note: `JaiRA opens ${node} in the Tailscale admin console: press Remove there. Once Tailscale drops it, JaiRA forgets it here, and signing in again later registers it new.`,
        confirmLabel: "Open the admin console",
      }
    : {
        title: "Remove this machine from your tailnet?",
        note: `JaiRA forgets ${node} here now and opens it in the Tailscale admin console: press Remove there too, or Tailscale keeps listing it. Signing in again later registers it new.`,
        confirmLabel: "Forget it and open the admin console",
      };
}

/** A machine's icon mark, from the word Tailscale uses for its system. */
export function markOfTailscaleOs(os: string): MachineMark | undefined {
  const o = os.toLowerCase();
  return o === "windows" ? "windows" : o === "macos" ? "mac" : o === "linux" ? "linux" : o === "android" ? "android" : o === "ios" ? "ios" : undefined;
}

const SYSTEM_WORDS: Record<MachineMark, string> = { windows: "Windows", mac: "Mac", linux: "Linux", android: "Android", ios: "iOS" };

/** One row of the machine list (decision 0022 §4): a device on the tailnet, or a paired one that is not on it now. */
export interface MachineRow {
  key: string;
  /** The bold name: "this machine", a machine's own name, a phone's, or the device's tailnet name. */
  name: string;
  /** What it is, in grey: "Windows desktop", "Android phone", "Linux". */
  kind: string;
  face: MachineFace;
  /** The words at the right, and their tone. */
  state?: { text: string; tone: "ok" | "warn" | "bad" | "dim" };
  /** A second line. */
  sub?: string;
  /** No JaiRA there, or offline and unpaired: drawn in grey. */
  grey: boolean;
  /** The button at the right. */
  action?: { kind: "pair"; device: string } | { kind: "unpair"; id: string; label: string } | { kind: "console"; href: string };
  /** Pair was pressed for it: the code field is open, until then. */
  asking?: number;
  /**
   * The machine's id, on this machine's row and a paired machine's: pressing the row puts it in
   * Settings' path, and the page shows its own section. Absent for a phone, or a device not paired.
   */
  machine?: string;
  /** This machine's own row. */
  self?: true;
}

function day(at: number | undefined): string {
  return at === undefined ? "a while" : new Date(at).toLocaleDateString([], { day: "numeric", month: "short" });
}

function pairedState(state: PeerView["state"]): { text: string; tone: "ok" | "warn" | "bad" } {
  return state === "online" ? { text: "paired · connected", tone: "ok" } : state === "connecting" ? { text: "paired · connecting…", tone: "warn" } : state === "mismatch" ? { text: "paired · another version", tone: "warn" } : { text: "paired · offline", tone: "bad" };
}

/** The host of a paired machine's address, to find it among the tailnet's devices while it is offline. */
function hostOf(url: string | undefined): string | undefined {
  return url === undefined ? undefined : /^[a-z]+:\/\/([^/:]+)/i.exec(url)?.[1]?.toLowerCase();
}

/** Paired first, then JaiRA to pair, then devices still being asked, then ones without JaiRA, then offline ones. */
const RANK = (row: MachineRow): number =>
  row.key === "self" ? 0 : row.action?.kind === "unpair" ? 1 : row.action?.kind === "pair" ? 2 : row.state?.text === "checking…" ? 3 : row.state?.tone !== "bad" ? 4 : 5;

/**
 * The machine list: this machine, then every device on the tailnet — paired ones with Unpair, JaiRA
 * machines and phones with Pair, the rest saying JaiRA is not running there or that they are offline —
 * and paired ones that are not on the tailnet now.
 */
export function machineRowsOf(view: MachinesView): MachineRow[] {
  const self: MachineRow = {
    key: "self",
    name: "this machine",
    kind: machineKindOf(view.self),
    face: { shape: view.self.form, mark: view.self.os, dot: view.self.tailnet.state === "on" ? "on" : "off" },
    grey: false,
    machine: view.self.id,
    self: true,
  };
  const usedMachines = new Set<string>();
  const usedPhones = new Set<string>();
  const rows: MachineRow[] = [];
  for (const d of view.tailnetDevices) {
    const mark = markOfTailscaleOs(d.os);
    const phone = mark === "android" || mark === "ios";
    const system = mark !== undefined ? SYSTEM_WORDS[mark] : d.os;
    const paired = d.jaira?.kind === "machine" ? view.machines.find((m) => m.id === d.jaira!.id) : view.machines.find((m) => hostOf(m.url) === d.dnsName.toLowerCase());
    const pairedPhone = d.jaira?.kind === "phone" ? view.devices.find((p) => p.id === d.jaira!.id) : undefined;
    const asking = view.asking?.device === d.id ? view.asking.expiresAt : undefined;
    // The tailnet's own name for it, which is unique where host names are not (a re-registered machine keeps its host name and gets a `-1`).
    const shown = d.dnsName.split(".")[0] || d.name;
    if (paired !== undefined) {
      usedMachines.add(paired.id);
      rows.push({
        key: d.id,
        name: paired.label,
        kind: machineKindOf(paired),
        face: { shape: paired.form, mark: paired.os, dot: dotOf(paired.state === "mismatch" ? "online" : paired.state) },
        state: pairedState(paired.state),
        ...(paired.state === "offline" ? { sub: ago(paired.lastSeenAt).replace(/^l/, "L") + "." } : {}),
        grey: false,
        action: { kind: "unpair", id: paired.id, label: paired.label },
        machine: paired.id,
      });
      continue;
    }
    if (pairedPhone !== undefined) {
      usedPhones.add(pairedPhone.id);
      rows.push({
        key: d.id,
        name: pairedPhone.label,
        kind: `${system} phone`,
        face: { shape: "phone", ...(mark !== undefined ? { mark } : {}), dot: pairedPhone.connected ? "on" : "off" },
        state: pairedPhone.connected ? { text: "paired · connected", tone: "ok" } : { text: "paired · offline", tone: "bad" },
        ...(!pairedPhone.connected ? { sub: "A phone is online while JaiRA is open on it." } : {}),
        grey: false,
        action: { kind: "unpair", id: pairedPhone.id, label: pairedPhone.label },
      });
      continue;
    }
    if (d.jaira !== undefined) {
      const isPhone = d.jaira.kind === "phone";
      const jmark = d.jaira.os ?? mark;
      const autoSub = autoPairSubOf(view, d);
      rows.push({
        key: d.id,
        name: d.jaira.label,
        kind: isPhone ? `${jmark !== undefined ? SYSTEM_WORDS[jmark] : system} phone` : machineKindOf({ form: d.jaira.form ?? "desktop", os: d.jaira.os === "windows" || d.jaira.os === "mac" || d.jaira.os === "linux" ? d.jaira.os : "linux" }),
        face: { shape: isPhone ? "phone" : (d.jaira.form ?? "desktop"), ...(jmark !== undefined ? { mark: jmark } : {}), dot: "on" },
        state: { text: isPhone ? "JaiRA open" : `JaiRA ${d.jaira.version}`, tone: "dim" },
        ...(autoSub !== undefined ? { sub: autoSub } : {}),
        grey: false,
        action: { kind: "pair", device: d.id },
        ...(asking !== undefined ? { asking } : {}),
      });
      continue;
    }
    const face: MachineFace = { shape: phone ? "phone" : "auto", ...(mark !== undefined ? { mark } : {}), dot: d.online ? "on" : "off" };
    if (d.olderSelf === true) {
      rows.push({ key: d.id, name: shown, kind: system, face, state: { text: "offline", tone: "bad" }, sub: "An older registration of this machine.", grey: true, ...(d.consoleUrl !== undefined ? { action: { kind: "console", href: d.consoleUrl } } : {}) });
      continue;
    }
    if (!d.online) {
      rows.push({ key: d.id, name: shown, kind: system, face, state: { text: "offline", tone: "bad" }, sub: `Since ${day(d.lastSeenAt)}. Whether JaiRA runs there is checked when it comes online.`, grey: true });
      continue;
    }
    if (d.noJaira === true) {
      rows.push({
        key: d.id,
        name: shown,
        kind: system,
        face,
        state: { text: phone ? "JaiRA isn't open" : "JaiRA isn't running", tone: "dim" },
        sub: phone ? "Open JaiRA there and sign in to Tailscale: it is listed within a minute." : "Start JaiRA there: it is listed within a minute.",
        grey: true,
      });
      continue;
    }
    rows.push({ key: d.id, name: shown, kind: system, face, state: { text: "checking…", tone: "dim" }, grey: true });
  }
  for (const m of view.machines) {
    if (usedMachines.has(m.id)) continue;
    rows.push({
      key: `m:${m.id}`,
      name: m.label,
      kind: machineKindOf(m),
      face: faceOf({ form: m.form, os: m.os, state: m.state === "mismatch" ? "online" : m.state }),
      state: pairedState(m.state),
      ...(m.state === "offline" ? { sub: `${ago(m.lastSeenAt).replace(/^l/, "L")}. Not on your tailnet now.` } : {}),
      grey: false,
      action: { kind: "unpair", id: m.id, label: m.label },
      machine: m.id,
    });
  }
  for (const p of view.devices) {
    if (usedPhones.has(p.id)) continue;
    rows.push({
      key: `p:${p.id}`,
      name: p.label,
      kind: "Phone",
      face: { shape: "phone", dot: p.connected ? "on" : "off" },
      state: p.connected ? { text: "paired · connected", tone: "ok" } : { text: "paired · offline", tone: "bad" },
      ...(!p.connected ? { sub: p.lastUsedAt === undefined ? "Not connected yet." : `${ago(p.lastUsedAt).replace(/^l/, "L")}.` } : {}),
      grey: false,
      action: { kind: "unpair", id: p.id, label: p.label },
    });
  }
  rows.sort((a, b) => RANK(a) - RANK(b) || a.name.localeCompare(b.name));
  return [self, ...rows];
}

/** The Pair a phone row's sentence: a phone reaches this machine through the tailnet, so only once signed in. */
export function pairWords(view: MachinesView): string {
  return view.self.tailnet.state === "on"
    ? `Show a code, then pick this machine in JaiRA on a phone on this Wi-Fi and type the code there. It works once, for ${PAIRING_CODE_MS / 60_000} minutes.`
    : "Sign in to Tailscale first: a phone reaches this machine through your tailnet.";
}

/** The Pair a phone row's sentence, while its code shows (decision 0013, amended 2026-10-04). */
export function pairCodeWords(view: MachinesView, expiresAt: number): WordPart[] {
  return [
    // Announced on the local network: a phone lists it by name, or takes its local address where the
    // network hides it.
    ...(view.pairing?.nearby !== undefined ? nearbyWords(view.self.label, view.pairing.nearby) : ["Finding this machine's address on the local network…"]),
    ` Works until ${new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`,
  ];
}

/** How a phone on this Wi-Fi finds the machine: by name in its list, else by the address typed. */
export function nearbyWords(label: string, nearby: { port: number; addresses: string[] }): WordPart[] {
  const first = nearby.addresses[0];
  if (first === undefined) return ["This machine has no address on a local network, so no phone nearby can find it."];
  return [`On a phone on this Wi-Fi: open JaiRA and pick ${label}. Not listed? Type `, { code: nearby.port === LAN_PAIRING_PORT ? first : `${first}:${nearby.port}` }, " there."];
}

/** What phones did on the pairing listener lately, one line each, oldest first. */
export function nearbyLogLines(events: NearbyEvent[]): string[] {
  return events.map((e) => {
    const when = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const what =
      e.what === "connected"
        ? "connected"
        : e.what === "wrong-code"
          ? "typed a code that is not this one"
          : e.what === "paired"
            ? `paired as ${e.detail ?? "a phone"}`
            : e.what === "sign-in"
              ? "asked to join your tailnet: its Tailscale page was opened"
              : e.what === "left"
                ? "left"
                : `was refused: ${e.detail ?? "no reason given"}`;
    return `${when}  ${e.from}  ${what}`;
  });
}

/** A phone that paired over the local network and is joining the tailnet: what to do about it here. */
export function phoneJoinWords(phone: NonNullable<MachinesView["phone"]>): WordPart[] {
  return phone.signInUrl !== undefined
    ? [`${phone.label} is paired. To let it onto your tailnet, approve it in the Tailscale page that opened in your browser. `, { link: "Open the page again", href: phone.signInUrl }]
    : [`${phone.label} is paired, and is joining your tailnet…`];
}

/** When the list was last asked, for the line beside Refresh. */
export function checkedWords(checkedAt: number | undefined, now = Date.now()): string {
  if (checkedAt === undefined) return "Checking…";
  const minutes = Math.round((now - checkedAt) / 60_000);
  return minutes < 1 ? "Checked just now" : minutes === 1 ? "Checked a minute ago" : minutes < 60 ? `Checked ${minutes} minutes ago` : "Checked over an hour ago";
}

/** The code-field row's sentence, while a device shows a code. */
export function askingWords(name: string, expiresAt: number): string {
  return `${name} is showing a code now. Type it here. It works until ${new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
}

/** The pop-up's words, on the machine asked to show a code. */
export function askedWords(view: MachinesView): { title: string; note: string } | undefined {
  const asked = view.asked;
  if (asked === undefined) return undefined;
  const until = new Date(asked.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return { title: `${asked.by.label} wants to pair with this machine`, note: `Type this code on ${asked.by.label}. It works once, until ${until}. If you didn't ask for this, refuse it.` };
}

/** The Unpair dialog's words. */
export function unpairSpecWords(label: string): { title: string; note: string; confirmLabel: string } {
  return { title: `Unpair ${label}?`, note: "It leaves the group: none of your machines or phones can reach it, and it can't reach them. You can pair it again from this list.", confirmLabel: "Unpair" };
}

/** The Projects across machines row's sentence. */
export const groupedWords = (grouped: boolean): string =>
  grouped
    ? "Clones of the same repository are one project in the sidebar and on the board, and each task's chip says which machine and folder it is in."
    : "Every clone is its own row, named by its machine and folder.";

/** What the page's sections and rows are called and say. */
export const MACHINES_WORDS = {
  this: {
    title: "This machine",
    info: "Every machine you use JaiRA on runs its own engine. Paired machines see each other's projects and tasks, and tasks go to whichever has room.",
  },
  name: { name: "Name", description: "How other machines and the task chips call this one." },
  tags: { name: "Tags", description: "What a workflow can ask for. The operating system is added by itself." },
  form: { name: "What it is", description: "The shape of this machine's icon, wherever it is named. Guessed once; yours to correct." },
  projectsFolder: {
    name: "Projects folder",
    description:
      "New workspaces go here, each in a folder named after its project: atlas, or atlas-1, atlas-2… when that's taken. Any other folder can be picked in Open → Where it goes.",
    empty: "Empty, it goes back to where most of this machine's projects already are.",
    change: "Change…",
    older: "runs an older JaiRA, which keeps no projects folder of its own: update it to choose one from here.",
  },
  another: {
    info: "Another of your machines, read and changed there. Pressing a machine in Your machines shows it here; take it out of Settings' path to see this machine again.",
    offline: "is offline, so what it says of itself cannot be read now.",
  },
  tailnet: {
    name: "Tailscale",
    info: "Signed in, JaiRA is on your tailnet, through the Tailscale app or the Tailscale helper it ships with, and your paired machines and phones can reach this one. Nothing is opened to the internet (Funnel is never used), and only what you paired gets in.",
  },
  yours: {
    title: "Your machines",
    info: "Every device on your tailnet, asked every minute whether JaiRA runs there. Pair asks the other one to show a code, which you type here — or, where it allows auto pair and is signed in to Tailscale as you, pairs with no code. Pairing one machine introduces it to the rest; Unpair takes it out of all of them.",
  },
  autoPair: { name: "Allow auto pair" },
  pair: { name: "Pair a phone", button: "Show a code" },
  pairCode: { name: "Code for pairing" },
  nearbyLog: { name: "Phones nearby" },
  phone: { name: "A phone joining" },
  notSignedIn: { name: "Not signed in", description: "The devices on your tailnet are listed here once this machine is signed in." },
  copies: {
    title: "Copies of other machines' work",
    info: "Kept so you can read and answer other machines' tasks here while they are off. Deleting a task anywhere deletes it everywhere; a machine clearing old history for space does not delete your copies.",
  },
  copy: { name: "Copy" },
  disk: { name: "On disk" },
  settings: {
    title: "Settings on every machine",
    info: "What you set up once is set up everywhere: connections, models, tools, permission sets and workflows, how JaiRA looks, and the keys and sign-ins they use. What belongs to one machine stays on it.",
  },
  syncSettings: { name: "Keep in step" },
  stays: { name: "Kept on each machine" },
  logins: { name: "Agents' sign-ins" },
  refused: { name: "Not taken" },
  outbox: {
    title: "Waiting to be delivered",
    info: "What you answered for a machine that was offline. Each is delivered when its machine reconnects; until then it can be taken back, and the question is open again.",
  },
  projects: { title: "Projects across machines", info: "A project is known by its git remote: clones of the same repository, here and on your other machines, are its workspaces." },
  grouped: { name: "One project per repository" },
  reading: "Reading this machine…",
} as const;

export const CODE_SCHEMA = {
  type: "object",
  properties: {
    code: { type: "string", title: "code", minLength: 1, description: "The code the other machine or phone is showing now." },
  },
  required: ["code"],
} as const;

export type MachineChipState = "on" | "off" | "warn" | "none";

/** A peer's connection state as a chip's. */
export function chipStateOf(state: "online" | "offline" | "connecting" | "mismatch"): MachineChipState {
  return state === "online" ? "on" : state === "mismatch" ? "warn" : "off";
}

/** What a machine can be, as Settings offers it. */
export const FORM_CHOICES: ReadonlyArray<readonly [string, MachineForm]> = [
  ["Desktop", "desktop"],
  ["Laptop", "laptop"],
  ["Mini", "mini"],
  ["Server", "server"],
];
