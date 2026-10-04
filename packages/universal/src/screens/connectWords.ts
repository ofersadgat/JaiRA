/**
 * What the Connect screen says (`Connect.tsx`), kept apart from it so a test with no React Native reads
 * it: the types of a search nearby, and the words for its state, its steps and how long it has looked.
 */

/** A machine showing a pairing code on this device's network. */
export interface NearbyChoice {
  key: string;
  label: string;
  /** `windows`, `mac`, `linux`: the mark on its icon. */
  os: string;
  /** Where it said it can be reached, the likeliest first. */
  addresses?: string[];
  port?: number;
}

/** Where pairing with a machine found nearby stands. */
export type NearbyStep = "reaching" | "proving" | "joining" | "approve";

/** Looking for machines nearby, as the phone's browse says it. */
export interface NearbySearch {
  machines: NearbyChoice[];
  /** `starting`, `browsing`, `waiting` (the system cannot look now), `retrying` (failed; starts again), `denied`. */
  state: "starting" | "browsing" | "waiting" | "retrying" | "denied";
  /** Why it is not looking, in the system's words. */
  problem?: string;
  /** When this search began, for how long it has looked. */
  since: number;
  /** This phone's addresses on its networks. */
  phone: string[];
}

/** One address being tried while reaching a machine. */
export interface NearbyAttempt {
  address: string;
  state: "trying" | "answered" | "failed";
  reason?: string;
}

export const sentence = (text: string): string => {
  const t = text.trim();
  const c = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(c) ? c : `${c}.`;
};

/** What a step of pairing nearby says. */
export function nearbyStepWords(label: string, step: NearbyStep): string {
  switch (step) {
    case "reaching":
      return `Reaching ${label}…`;
    case "proving":
      return "Checking the code…";
    case "joining":
      return `Joining ${label}'s tailnet…`;
    case "approve":
      return `A Tailscale page opened on ${label}: approve this phone there.`;
  }
}

/** `0:42`, `3:05`. */
export function elapsedWords(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * What the search says: whether it is looking (it moves while it is), and the line under it. A search
 * that has looked a while with nothing found says what to check.
 */
export function nearbySearchWords(search: NearbySearch, now: number): { looking: boolean; headline: string; hint: string | undefined; trouble: boolean } {
  const found = search.machines.length;
  const elapsed = now - search.since;
  if (search.state === "denied") {
    return { looking: false, headline: "JaiRA may not look at this network", hint: "Allow Local Network for JaiRA in Settings → Privacy & Security, then search again.", trouble: true };
  }
  if (search.state === "waiting" || search.state === "retrying") {
    return { looking: search.state === "retrying", headline: sentence(search.problem ?? "Looking stopped"), hint: undefined, trouble: true };
  }
  const headline = `${search.state === "starting" ? "Starting to look" : "Looking"} on this Wi-Fi · ${elapsedWords(elapsed)}`;
  if (found > 0) return { looking: true, headline, hint: undefined, trouble: false };
  return {
    looking: true,
    headline,
    hint:
      elapsed < 15_000
        ? "On the machine: Settings → Machines → turn on Reachable, then Show a code. It shows up here while its code does."
        : "Nothing yet. Is the machine showing a code, and on this Wi-Fi? Some networks (guest Wi-Fi) keep devices from seeing each other: then type the local address the machine shows under its code.",
    trouble: false,
  };
}

