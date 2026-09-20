/**
 * The gate's second door, server-rendered to one static page — the real components over the real
 * stylesheet, with no Electron (decision 0004, "What draws").
 *
 * `npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/remote-gate-static.mts <out.html> [light|dark]`
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteStatusView, ReviewNote, ReviewRemote } from "@jaira/shared";
import { RemoteStrip, ReviewThread, SettledBy } from "../src/renderer/remoteStripView";
import { cardRemoteWord } from "../src/renderer/remoteStrip";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: remote-gate-static.mts <out.html> [light|dark]");

const now = Date.now();
const remote: ReviewRemote = { provider: "gitlab", host: "gitlab.com", project: "mistlabs/jaira", number: 41, url: "https://gitlab.com/mistlabs/jaira/-/merge_requests/41", branch: "jaira/t-qfr49rm80m/review", target: "main", key: "review" };
const status = (extra: Partial<RemoteStatusView>): RemoteStatusView => ({ key: "review", provider: "gitlab", host: "gitlab.com", project: "mistlabs/jaira", branch: remote.branch!, target: "main", number: 41, awaiting: true, commenters: [], checkedAt: now - 40_000, ...extra });

const general: ReviewNote[] = [
  { artifact: "$review", quote: "", body: "Should this wait for the 19.2 branch?", author: "mara", at: "2026-09-19T11:05:00Z", source: "gitlab" },
  { artifact: "$review", quote: "", body: "No — it is a digest bump.", author: "dov", at: "2026-09-19T11:12:00Z", source: "gitlab" },
];

const section = (title: string, body: ReactElement): ReactElement =>
  h("section", { style: { margin: "0 0 22px" } }, h("h4", { style: { margin: "0 0 8px", font: "600 12px var(--font-app)", color: "var(--dim)" } }, title), h("div", { className: "review-artifacts" }, body));

const page = h(
  "div",
  { style: { width: 960, margin: "24px auto", padding: 16, background: "var(--panel)" } },
  section("open on the forge, nothing said yet", h(RemoteStrip, { remote, status: status({}), busy: false, onCheck: () => undefined })),
  section(
    "quiet window running",
    h("div", null, h(RemoteStrip, { remote, status: status({ commenters: ["mara", "dov"], settleAt: now + 10 * 60_000 }), busy: false, onCheck: () => undefined }), h(ReviewThread, { notes: general })),
  ),
  section("the forge cannot be reached", h(RemoteStrip, { remote, status: status({ error: "reading: the forge answered 502", checkedAt: now - 4 * 60_000 }), busy: false, onCheck: () => undefined })),
  section(
    "answered on the forge: merged there",
    h(
      "div",
      null,
      h(RemoteStrip, { remote, status: undefined, busy: false }),
      h(SettledBy, {
        recorded: {
          settled_by: { via: "remote", who: "mara", act: "merged" },
          remote: { ...remote, head: "9f3c1a2b7e55", adopted: { reset: true, dropped: "refs/jaira/dropped/t-qfr49rm80m/1", target: "left-alone", why: "your main has commits origin/main does not, so it was left alone" } },
        },
      }),
    ),
  ),
  section("the publish question's rows", h("dl", { className: "publish-what" }, ...[["to", "origin · gitlab.com/mistlabs/jaira"], ["branch", "jaira/t-qfr49rm80m/review → main"], ["commits as", "Ofer Sadgat (git config)"], ["request opened by", "@ofer (the GitLab connection's token)"]].flatMap(([k, v]) => [h("dt", { key: k }, k), h("dd", { key: `${k}v` }, v)]))),
  section("on the board", h("span", { className: "card-status" }, cardRemoteWord({ provider: "gitlab", number: 41, url: remote.url! }))),
);

const css = pathToFileURL(join(import.meta.dirname, "..", "src", "renderer", "styles.css")).href;
writeFileSync(out, `<!doctype html><html data-theme="${process.argv[3] ?? "light"}"><head><meta charset="utf8"><link rel="stylesheet" href="${css}"></head><body>${renderToStaticMarkup(page)}</body></html>`);
console.log(`wrote ${out}`);
