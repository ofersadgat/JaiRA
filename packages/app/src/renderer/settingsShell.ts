/**
 * What the shell holds for the Settings pages and hands them — the forge sign-ins in flight, and what a
 * Needs-attention item's button does — as a hook and a function (`SettingsView.tsx` and
 * `SidebarRegion.tsx`, in `packages/universal/src/app`, call them).
 */
import { useCallback, useEffect, useState } from "react";
import type { EventsStatusView, ForgeCheck, ForgeSignInPending, HealthItem, HealthPage } from "@jaira/shared/browser";
import { isPluginId, SHARED_SESSION, type ConfigLayer } from "@jaira/shared/browser";
import type { AutomationsChannel } from "./automationsHost";
import type { PermissionSetsChannel } from "./permissionSetsHost";
import { invoke, subscribe } from "./store";
import { checkForUpdate, installPlugin } from "./updatesStore";

/** Signing in to a forge through the browser (OAuth device flow), as Connections draws it. */
export interface ForgeOAuth {
  signingIn: Set<string>;
  pending: Map<string, string>;
  errors: ReadonlyMap<string, string>;
  viaOAuth: Set<string>;
  onSignIn: (connection: string) => void;
  onCancel: (connection: string) => void;
  onDisconnect: (connection: string) => void;
}

/**
 * Signing in to a forge through the browser (OAuth device flow): the code the person types there
 * while main polls, and why the last one did not work. Main tells us when it is over — after the
 * token is stored and the check that names the account has landed.
 */
export function useForgeOAuth(forges: readonly ForgeCheck[] | undefined, readAvailability: () => void): ForgeOAuth {
  const [forgeSignIns, setForgeSignIns] = useState<ReadonlyMap<string, ForgeSignInPending>>(new Map());
  const [forgeErrors, setForgeErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const forgeError = useCallback((connection: string, reason: string | undefined): void => {
    setForgeErrors((current) => {
      const next = new Map(current);
      if (reason === undefined) next.delete(connection);
      else next.set(connection, reason);
      return next;
    });
  }, []);
  const forgePending = useCallback((connection: string, pending: ForgeSignInPending | undefined): void => {
    setForgeSignIns((current) => {
      const next = new Map(current);
      if (pending === undefined) next.delete(connection);
      else next.set(connection, pending);
      return next;
    });
  }, []);
  useEffect(() => {
    void invoke("forge:signIns", undefined).then((list) => setForgeSignIns(new Map(list.map((p) => [p.connection, p]))), () => undefined);
    return subscribe((message) => {
      if (message.type !== "forge:signInFinished") return;
      const { outcome } = message;
      forgePending(outcome.connection, undefined);
      forgeError(outcome.connection, outcome.ok || outcome.code === "canceled" ? undefined : outcome.reason);
      readAvailability();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribed once; the setters are stable
  }, []);
  return {
    signingIn: new Set(forgeSignIns.keys()),
    pending: new Map([...forgeSignIns].map(([connection, pending]) => [connection, pending.userCode])),
    errors: forgeErrors,
    viaOAuth: new Set((forges ?? []).filter((check) => check.via === "oauth").map((check) => check.name)),
    onSignIn: (connection: string) => {
      forgeError(connection, undefined);
      void invoke("forge:signIn", { connection }).then(
        (start) => (start.ok ? forgePending(connection, start.pending) : forgeError(connection, start.fix !== undefined ? `${start.reason} — ${start.fix}` : start.reason)),
        (e: unknown) => forgeError(connection, e instanceof Error ? e.message : String(e)),
      );
    },
    onCancel: (connection: string) => {
      void invoke("forge:cancelSignIn", { connection }).then(() => forgePending(connection, undefined));
    },
    onDisconnect: (connection: string) => {
      void invoke("forge:signOut", { connection }).then(
        (outcome) => {
          forgeError(connection, outcome.ok ? undefined : outcome.reason);
          readAvailability();
        },
        (e: unknown) => forgeError(connection, e instanceof Error ? e.message : String(e)),
      );
    },
  };
}

/** What a fix needs of the shell. */
export interface HealthFixers {
  forgeOAuth: Pick<ForgeOAuth, "viaOAuth" | "onSignIn">;
  signIn: (name: string) => void;
  recheck: () => void;
  setView: (view: "settings" | "logs") => void;
  setSection: (page: Exclude<HealthPage, "logs">) => void;
}

/** A Needs-attention page, opened. */
export function openHealthPage(page: HealthPage, f: Pick<HealthFixers, "setView" | "setSection">): void {
  if (page === "logs") return f.setView("logs");
  f.setSection(page);
  f.setView("settings");
}

/**
 * What an item's button does. A sign-in goes to the page it belongs to as well, because that is where
 * the flow shows its progress (a forge's device code, an agent's "waiting for the browser").
 */
export function fixHealthItem(item: HealthItem, f: HealthFixers): void {
  switch (item.action) {
    case "sign-in":
      if (item.subject !== undefined) {
        if (item.id.startsWith("forge:")) {
          if (f.forgeOAuth.viaOAuth.has(item.subject)) f.forgeOAuth.onSignIn(item.subject);
        } else f.signIn(item.subject);
      }
      openHealthPage(item.page, f);
      return;
    case "check":
      f.recheck();
      return;
    case "retry-plugin":
      if (item.subject !== undefined && isPluginId(item.subject)) installPlugin(item.subject);
      return;
    case "retry-update":
      checkForUpdate();
      return;
    case "open-logs":
      f.setView("logs");
      return;
    case undefined:
      openHealthPage(item.page, f);
  }
}

/**
 * Settings → Tools → Permission sets' three calls, for the project the window stands on. At the root the
 * window names the shared root rather than nothing: with several projects open, nothing named is a
 * refusal, and with one it would read that project instead of the root.
 */
export function permissionSetsChannelOf(at: string | null): PermissionSetsChannel {
  const project = { project: at ?? SHARED_SESSION };
  return {
    read: () => invoke("permissionSets:read", { ...project }),
    write: (request) => invoke("permissionSets:write", { ...request, ...project }),
    reset: (request) => invoke("permissionSets:reset", { ...request, ...project }),
  };
}

/** Settings → Tools → Automations' calls: the events workflow's three copies, through the ordinary workflow channels. */
export function automationsChannelOf(at: string | null): AutomationsChannel {
  const project = at !== null ? { project: at } : {};
  return {
    read: (layer, stateId) => invoke("workflow:read", { stateId, layer, ...(layer === "base" ? {} : project) }),
    write: (layer, stateId, text) => invoke("workflow:write", { stateId, layer, text, ...(layer === "base" ? {} : project) }),
    // An automation's state taken away: nothing names it once its line is gone, and a project's copy
    // of a Shared line's state is referred to by Shared's root, so the refusal is not the question.
    remove: (layer, stateId) => invoke("workflow:delete", { stateId, layer, force: true, ...(layer === "base" ? {} : project) }),
  };
}

/** The project Settings → Tools → Events and Automations read for — the shared root's on Shared. */
export function eventsProjectOf(layer: ConfigLayer, at: string | null): string {
  return (layer !== "base" ? at : null) ?? SHARED_SESSION;
}

/** How often Settings → Tools → Events re-reads what the watcher knows, while it is on screen. */
const STATUS_EVERY_MS = 20_000;

/**
 * Events' host half: `events:status` read for `key` (the project, or the shared root) and re-read while
 * the page is open, and a clock for "2 min ago". Nothing here asks a forge — main answers from git
 * and memory.
 */
export function useEventStatus(read: () => Promise<EventsStatusView>, key: string): { status: EventsStatusView | null; now: number } {
  const [status, setStatus] = useState<EventsStatusView | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    setStatus(null);
    const once = (): void => {
      read().then(
        (next) => {
          if (live) setStatus(next);
        },
        (e: unknown) => {
          if (live) setStatus({ remotes: [], tasks: {}, cadenceMs: 60_000, problem: e instanceof Error ? e.message : String(e) });
        },
      );
      setNow(Date.now());
    };
    once();
    const timer = setInterval(once, STATUS_EVERY_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // `read` is rebuilt with every render of the host; `key` is what makes it a different question.
  }, [key]);
  return { status, now };
}
