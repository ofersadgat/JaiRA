/**
 * The update screens, server-rendered from the store's state (decision 0011 §4–§6): the sidebar row
 * draws only while there is something to do, About's Status row says where the updater stands with the
 * one control that moves it on, and a page's Needs attention section appears only while it has items.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HealthItem, UpdateState } from "@jaira/shared";
import { AboutPane } from "../src/renderer/aboutPane";
import { NeedsAttention } from "../src/renderer/healthView";
import { LogsPanel } from "../src/renderer/logs";
import { publishPlugins, publishUpdate } from "../src/renderer/updatesStore";
import { SidebarUpdateRow } from "../src/renderer/updatesView";

const noop = (): void => undefined;
const NEXT = "0.1.1-nightly.20260927.3";
const at = (extra: Partial<UpdateState>): UpdateState => ({
  status: "available",
  version: "0.1.1-nightly.20260927.1",
  channel: "nightly",
  available: { version: NEXT, url: "https://example.invalid/v", notes: "JaiRA nightly." },
  ...extra,
});

const row = (): string => renderToStaticMarkup(h(SidebarUpdateRow, { collapsed: false, onOpenAbout: noop, onNotes: noop, onRetry: noop }));
const about = (): string => renderToStaticMarkup(h(AboutPane, { config: null, health: [], onFix: noop, onTrack: noop, onEngine: noop }));

describe("the sidebar's Update row, drawn", () => {
  it("reads 'nightly' for a nightly, with the × and the chevron", () => {
    publishUpdate(at({}));
    const html = row();
    expect(html).toContain("upd-side");
    expect(html).toContain(">nightly<");
    expect(html).toContain("upd-dismiss");
    expect(html).toContain("upd-caret");
  });

  it("draws nothing once dismissed for that version", () => {
    publishUpdate(at({ dismissed: NEXT }));
    expect(row()).toBe("");
  });
});

describe("About's Status row", () => {
  it("offers the split Update even when the sidebar's notice was dismissed", () => {
    publishPlugins([]);
    publishUpdate(at({ dismissed: NEXT }));
    const html = about();
    expect(html).toContain("split primary upd-split");
    expect(html).toContain("hidden from the sidebar");
    expect(html).toContain("Release notes");
  });

  it("says why a build cannot update, as an error, with no Check now", () => {
    publishUpdate({ status: "disabled", version: "0.1.0", channel: "stable", reason: "a development build does not update itself" });
    const html = about();
    expect(html).toContain("A development build does not update itself.");
    expect(html).not.toContain("Check now");
  });

  it("after Not now, says it installs on close and offers Restart now", () => {
    publishUpdate(at({ status: "downloaded", pending: "on-quit" }));
    const html = about();
    expect(html).toContain("installs when JaiRA next closes");
    expect(html).toContain("Restart now");
  });

  it("is up to date with Check now", () => {
    publishUpdate({ status: "up-to-date", version: "0.2.0", channel: "stable", checkedAt: Date.now() - 12 * 60_000 });
    const html = about();
    expect(html).toContain("Up to date · checked 12 min ago");
    expect(html).toContain("Check now");
  });
});

describe("Needs attention", () => {
  const item: HealthItem = { id: "executor:claude-cli", level: "error", page: "connections", title: "Claude (cli)", detail: "signed out — its token expired", action: "sign-in", subject: "claude-cli", since: Date.now() };

  it("is drawn only for the page's own items", () => {
    expect(renderToStaticMarkup(h(NeedsAttention, { items: [item], page: "about", onFix: noop }))).toBe("");
    const html = renderToStaticMarkup(h(NeedsAttention, { items: [item], page: "connections", onFix: noop }));
    expect(html).toContain("Needs attention");
    expect(html).toContain("Sign in again");
    expect(html).toContain("prob prob-error");
  });
});

describe("About's Plugins, drawn", () => {
  it("shows a development checkout's own copy as present, with no Download, Update or Remove", () => {
    publishUpdate({ status: "disabled", version: "0.1.0", channel: "stable", reason: "a development build does not update itself" });
    publishPlugins([
      { id: "claude-agent-sdk", version: "1.0.0", available: true, installed: "0.9.0", from: "workspace", downloadBytes: 1024 },
      { id: "llama", version: "3.0.0", available: true, installed: "3.1.0", from: "workspace" },
      { id: "llama-cpu", version: "3.0.0", available: true, installed: "3.1.0", from: "workspace" },
    ]);
    const html = about();
    expect(html).toContain("from this checkout");
    expect(html).toContain("<code>0.9.0</code>");
    expect(html).toContain("<code>3.1.0</code>");
    for (const verb of [">Download<", ">Update<", ">Add<", "plg-more", "is installed; this build uses"]) expect(html).not.toContain(verb);
  });
});

describe("the Logs panel's entries not seen yet", () => {
  const noopQuery = (): void => undefined;
  const panel = (unseen: Parameters<typeof LogsPanel>[0]["unseen"]): string =>
    renderToStaticMarkup(
      h(LogsPanel, {
        entries: [
          { id: 3, at: 300, level: "warn", source: "app", message: "could not install the Local models: CUDA plugin", detail: { message: "EPERM: operation not permitted" }, raised: "plugin:llama-cuda" },
          { id: 2, at: 200, level: "warn", source: "runtime", message: "could not look at github for events" },
          { id: 1, at: 50, level: "error", source: "ipc", message: "an old failure" },
        ],
        hasOlder: false,
        loading: false,
        onSearch: noopQuery,
        onOlder: noopQuery,
        policy: { minLevel: "debug", overrides: [] },
        onPolicy: noop,
        output: null,
        onOpenJob: noop,
        onOpenTask: noop,
        onClearOutput: noop,
        unseen,
        onDismissUnseen: noop,
      }),
    );

  it("marks what was logged since the last dismissal, counts it, and offers Dismiss", () => {
    const html = panel({ since: { warn: 100, error: 100 }, counts: { warning: 1 }, ids: ["log:warnings"] });
    // The runtime warning is marked; the old error and the one About already shows are not.
    expect(html.match(/log-unseen-warn/g)).toHaveLength(1);
    expect(html).not.toContain("log-unseen-error");
    expect(html).toContain("not seen");
    expect(html).toContain(">Dismiss<");
  });

  it("draws no marks and no Dismiss once dismissed, and shows warnings and a detail's reason all the same", () => {
    const html = panel(undefined);
    expect(html).not.toContain("log-unseen");
    expect(html).not.toContain(">Dismiss<");
    expect(html).toContain("could not look at github for events");
    // The EPERM lives only in the detail; it is read on the row without unfolding it.
    expect(html).toContain("EPERM: operation not permitted");
  });
});
