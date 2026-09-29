/**
 * Settings → Machines' model (decision 0013 §1–§3): what its rows say and the fleet it reads — the
 * words and the reading `machinesPane.tsx` draws, in a module of its own so the universal copy
 * (decision 0015) says and reads the same. A sentence that holds a link or a value is a list of
 * {@link WordPart}s, which each side draws in its own way.
 */
import { useEffect, useState } from "react";
import { PAIRING_CODE_MS, type CopyChoice, type MachinesView, type PeerView } from "@jaira/shared/browser";
import { invoke, subscribe as subscribePush } from "./store";

/** A run of a sentence: words, a value (`<code>`), an error (`.upd-err`), a quiet note (`.cfg-hint`), or a link. */
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

/** The On disk row's sentence. */
export function diskWords(disk: { bytes: number; machines: number } | undefined): string {
  return disk === undefined ? "…" : disk.bytes === 0 ? "Nothing copied yet." : `${sizeOf(disk.bytes)} from ${disk.machines} machine${disk.machines === 1 ? "" : "s"}, under ~/.jaira/remote.`;
}

/** The fleet, fetched once and kept current by `machines:changed`. */
export function useMachines(): [MachinesView | undefined, (next: MachinesView) => void] {
  const [view, setView] = useState<MachinesView | undefined>(undefined);
  useEffect(() => {
    void invoke("machines:view", undefined).then(setView, () => undefined);
    return subscribePush((message) => {
      if (message.type === "machines:changed") setView(message.view);
    });
  }, []);
  return [view, setView];
}

export const errorOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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

/** Whether this machine is reachable, and the sentence that says how. */
export function reachWords(view: MachinesView): { description: WordPart[]; on: boolean } {
  const reach = view.self.reach;
  const signIn = (url: string): WordPart => ({ link: "Sign in to your tailnet", href: url });
  switch (reach.state) {
    case "off":
      return { on: false, description: ["Off: your other machines cannot reach this one, and it cannot be paired with."] };
    case "starting":
      return {
        on: true,
        description: reach.signInUrl !== undefined ? ["JaiRA's Tailscale helper needs you to sign in to your tailnet once.", " ", signIn(reach.signInUrl)] : ["Publishing this machine through Tailscale…"],
      };
    case "on":
      return {
        on: true,
        description: [`On, through ${reach.via === "helper" ? "JaiRA's Tailscale helper" : "Tailscale"}: `, { code: reach.url ?? "" }, ". Nothing is opened to the internet, and only paired machines get in."],
      };
    case "unavailable":
      return {
        on: true,
        description: [
          { error: sentence(reach.reason ?? "It cannot be published.") },
          ...((reach.reason ?? "").includes("not installed") ? [" ", { link: "Get Tailscale", href: "https://tailscale.com/download" }] : []),
          ...(reach.signInUrl !== undefined ? [" ", signIn(reach.signInUrl)] : []),
        ],
      };
  }
}

/** The Pair a machine row's sentence. */
export function pairWords(view: MachinesView): string {
  return view.self.reach.state === "on"
    ? `Show a code to type on the other machine. It works once, for ${PAIRING_CODE_MS / 60_000} minutes.`
    : "Turn on Reachable first: the other machine connects to this one to pair.";
}

/** The code-for-pairing row's sentence. */
export function pairCodeWords(view: MachinesView, expiresAt: number): WordPart[] {
  return [
    "On the other machine: Settings → Machines → Add a machine, with ",
    { code: view.self.reach.url ?? "" },
    `. Works until ${new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`,
  ];
}

/** A paired machine's line: whether it is there, what it runs, and where. */
export function peerWords(peer: PeerView): WordPart[] {
  const where: WordPart[] = peer.url !== undefined ? [" · ", { code: new URL(peer.url).host }] : [];
  switch (peer.state) {
    case "online":
      return [`Online · JaiRA ${peer.version ?? "?"}`, ...where];
    case "connecting":
      return ["Connecting…"];
    case "mismatch":
      return [{ error: sentence(peer.reason ?? `It runs JaiRA ${peer.version ?? "?"}`) }, ` ${ago(peer.lastSeenAt)}`];
    case "offline":
      return [`Offline · ${ago(peer.lastSeenAt)}`, ...(peer.reason !== undefined ? [{ hint: ` · ${peer.reason}` }] : [])];
  }
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
  reach: {
    name: "Reachable from my other machines",
    info: "JaiRA publishes its own port on your tailnet with Tailscale (tailscale serve) — or, without the Tailscale app, with the Tailscale helper it ships with — and turns it off again with this switch. Funnel is never used.",
  },
  pair: { name: "Pair a machine", button: "Show a code" },
  pairCode: { name: "Code for pairing" },
  yours: { title: "Your machines", info: "Remembered on every machine you pair: pairing one new machine with any of these introduces it to the rest." },
  none: { name: "None yet", description: "Pair a machine below, or show a code here and type it there." },
  add: { title: "Add a machine", info: "Pairing is once per machine: after that they find each other by themselves, and a machine paired with any of yours joins all of them." },
  other: { name: "The other machine" },
  paired: "Paired. It is listed under Your machines, with any machines it was already paired with.",
  copies: {
    title: "Copies of other machines' work",
    info: "Kept so you can read and answer other machines' tasks here while they are off. Deleting a task anywhere deletes it everywhere; a machine clearing old history for space does not delete your copies.",
  },
  copy: { name: "Copy" },
  disk: { name: "On disk" },
  outbox: {
    title: "Waiting to be delivered",
    info: "What you answered for a machine that was offline. Each is delivered when its machine reconnects; until then it can be taken back, and the question is open again.",
  },
  projects: { title: "Projects across machines", info: "A project is known by its git remote: clones of the same repository, here and on your other machines, are its workspaces." },
  grouped: { name: "One project per repository" },
  reading: "Reading this machine…",
} as const;

export const ADD_SCHEMA = {
  type: "object",
  properties: {
    address: { type: "string", title: "address", minLength: 1, description: "The other machine's address, shown on its Machines page: mac-mini.tail4c2e.ts.net" },
    code: { type: "string", title: "code", minLength: 1, description: "The code the other machine shows under Pair a machine." },
  },
  required: ["address", "code"],
} as const;

/**
 * Pairing with another machine (`machinesPane.tsx`'s `AddMachine`): the address and code typed, whether
 * Pair can be pressed, and what it came to — the page's view refreshed, or why not.
 */
export function useAddMachine(onView: (v: MachinesView) => void): {
  value: { address?: string; code?: string };
  setValue: (next: { address?: string; code?: string }) => void;
  busy: boolean;
  error: string | undefined;
  done: string | undefined;
  ready: boolean;
  pair: () => void;
} {
  const [value, setValue] = useState<{ address?: string; code?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  const ready = (value.address ?? "").trim() !== "" && (value.code ?? "").trim() !== "";
  const pair = (): void => {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    invoke("machines:add", { address: value.address!.trim(), code: value.code!.trim() })
      .then((view) => {
        onView(view);
        setValue({});
        setDone(MACHINES_WORDS.paired);
      }, (e: unknown) => setError(errorOf(e)))
      .finally(() => setBusy(false));
  };
  return { value, setValue, busy, error, done, ready, pair };
}
