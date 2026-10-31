/**
 * Bundles `support.js`, the one file every artboard's head loads, with React and ReactDOM inside it.
 *
 * An IIFE, minified: the artboard is a page of its own in a sandboxed frame, which loads this file with
 * a plain `<script src>` before its body is parsed, so it cannot be a module and must bring everything
 * it uses. `dist/support-modules.json` lists every file the bundle read, as absolute paths, the way
 * `packages/app/build.mjs` lists the main bundle's in `main-modules.json`: the Licenses page's manifest
 * is built from such lists (`licenses/thirdPartyLicenses.ts`), so React, ReactDOM and scheduler, which
 * ship inside this file, are listed there once the app's build hands this one over.
 */
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Builds `support.js` (and its module list) into `outdir`; answers the two files' paths. */
export async function buildSupport(outdir = join(here, "dist")) {
  await mkdir(outdir, { recursive: true });
  const outfile = join(outdir, "support.js");
  const result = await build({
    absWorkingDir: here,
    entryPoints: [join(here, "src", "support.ts")],
    outfile,
    bundle: true,
    format: "iife",
    platform: "browser",
    // The app's Electron and the phone's web views; nothing older draws an artboard.
    target: "es2022",
    minify: true,
    sourcemap: false,
    // React's production build: its development one is several times the size and warns in the console.
    define: { "process.env.NODE_ENV": '"production"' },
    // React's `@license` headers stay, gathered at the end of the file.
    legalComments: "eof",
    metafile: true,
    logLevel: "warning",
  });
  // A metafile input is relative to `absWorkingDir`; one in a namespace (`<define:…>`) is not a file.
  const modules = Object.keys(result.metafile.inputs)
    .filter((input) => !/^[\w-]*:|^<|^\(/.test(input))
    .map((input) => resolve(here, input));
  const modulesFile = join(outdir, "support-modules.json");
  await writeFile(modulesFile, `${JSON.stringify(modules, null, 2)}\n`);
  return { outfile, modulesFile };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { outfile } = await buildSupport();
  console.log(`built ${outfile}`);
}
