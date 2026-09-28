/**
 * Does native get the colours the desktop draws? (decision 0015)
 *
 *   npx tsx packages/app/shots/tokens-check.mts
 *
 * `@jaira/universal`'s `resolveAt` replays `styles.css`'s cascade for native, where there is no browser
 * to do it. This asks the browser that IS there — the app's own window — for the same colours: for
 * every palette, both schemes, at the root and inside the sidebar, each colour variable is painted on a
 * probe element and read back with `getComputedStyle`. Every one must equal what `resolveAt` produced,
 * to within a rounding step per channel. Lengths and font stacks are not colours and are skipped.
 */
import { join } from "node:path";
import { PALETTES } from "../../universal/src/cssTokens.generated";
import { parseColor, resolveAt } from "../../universal/src/cssTokens";
import { App } from "./driver.mjs";
import { buildWorld } from "./world.mjs";

interface Probe {
  name: string;
  ours: string;
}

const close = (a: string, b: string): boolean => {
  const x = parseColor(a);
  const y = parseColor(b);
  if (x === undefined || y === undefined) return false;
  if (x.a === 0 && y.a === 0) return true;
  return Math.abs(x.r - y.r) <= 1 && Math.abs(x.g - y.g) <= 1 && Math.abs(x.b - y.b) <= 1 && Math.abs(x.a - y.a) <= 0.01;
};

async function main(): Promise<void> {
  const world = buildWorld(join(import.meta.dirname, ".world-tokens"));
  process.env.JAIRA_RENDERER = "one";
  const app = await App.launch(world, { out: join(import.meta.dirname, "parity"), port: 9260 });
  let checked = 0;
  const wrong: string[] = [];
  try {
    await app.until("document.querySelector('.sidebar') !== null", "the sidebar to draw");
    for (const palette of PALETTES) {
      for (const scheme of ["light", "dark"] as const) {
        for (const scopes of [[], ["sidebar"]] as const) {
          const values = resolveAt({ palette, scheme, scopes: [...scopes] });
          const probes: Probe[] = Object.entries(values)
            .filter(([, v]) => typeof v === "string" && parseColor(v) !== undefined)
            .map(([name, v]) => ({ name, ours: String(v) }));
          const theirs = await app.evaluate<Record<string, string>>(`(() => {
            const root = document.documentElement;
            if (${JSON.stringify(palette)} === "classic") root.removeAttribute("data-palette"); else root.setAttribute("data-palette", ${JSON.stringify(palette)});
            root.setAttribute("data-theme", ${JSON.stringify(scheme)});
            const host = ${scopes.length > 0 ? `document.querySelector(".sidebar")` : `document.body`};
            const probe = document.createElement("i");
            host.appendChild(probe);
            const out = {};
            for (const name of ${JSON.stringify(probes.map((p) => p.name))}) {
              probe.style.color = "rgb(1, 2, 3)";
              probe.style.color = "var(--" + name + ")";
              out[name] = getComputedStyle(probe).color;
            }
            probe.remove();
            return out;
          })()`);
          for (const p of probes) {
            checked++;
            const got = theirs[p.name] ?? "";
            if (!close(p.ours, got)) wrong.push(`${palette}/${scheme}${scopes.length ? "/sidebar" : ""} --${p.name}: ours ${p.ours}, Chromium ${got}`);
          }
        }
      }
    }
  } finally {
    await app.close();
  }
  console.log(`${checked} colours checked across ${PALETTES.length} palettes × 2 schemes × {root, sidebar}`);
  if (wrong.length > 0) {
    console.log(`${wrong.length} differ:`);
    for (const w of wrong.slice(0, 40)) console.log(`  ${w}`);
    process.exitCode = 1;
  } else console.log("all equal");
}

await main();
