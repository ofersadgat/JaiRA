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
const about = (): string => renderToStaticMarkup(h(AboutPane, { config: null, health: [], onFix: noop, onTrack: noop }));

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
