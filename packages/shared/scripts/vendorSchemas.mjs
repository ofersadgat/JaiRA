/**
 * Fetch the published schemas the registry holds files to by NAME — `package.json`, `tsconfig.json`,
 * a Compose file, `.gitlab-ci.yml`, a GitHub Actions workflow — into `src/vendor/schemas/`, with the
 * license each is published under.
 *
 * Vendored rather than fetched at run time: the app works offline, and a schema that changed under an
 * open editor would move the verdict on a file nobody touched. Re-run this to take a newer revision:
 *
 *     npm run schemas:sync
 *
 * Two rewrites, and only two:
 *
 *  - SchemaStore's `package.json` delegates a few tool-config fields (`eslintConfig`, `prettier`,
 *    `ava`, …) to OTHER SchemaStore documents by `$ref`. Those are not bundled, and ajv refuses to
 *    compile a document with a reference it cannot resolve — so each such `$ref` is dropped, leaving
 *    the field unconstrained and its description standing.
 *  - A `markdownDescription` beside a `description` is dropped. It is the same text marked up for
 *    VS Code's hover, the app reads `description` first, and in `tsconfig.json`'s schema the copies
 *    are a quarter of the file — which ships in the window's bundle.
 *
 * Every other byte is upstream's.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "vendor", "schemas");

const SOURCES = [
  {
    file: "package.json.schema.json",
    url: "https://json.schemastore.org/package.json",
    rewrite: dropForeignRefs,
  },
  { file: "tsconfig.schema.json", url: "https://json.schemastore.org/tsconfig.json" },
  { file: "github-workflow.schema.json", url: "https://json.schemastore.org/github-workflow.json" },
  { file: "compose-spec.schema.json", url: "https://raw.githubusercontent.com/compose-spec/compose-spec/main/schema/compose-spec.json" },
  { file: "gitlab-ci.schema.json", url: "https://gitlab.com/gitlab-org/gitlab/-/raw/master/app/assets/javascripts/editor/schema/ci.json" },
];

const LICENSES = [
  { file: "schemastore.LICENSE", url: "https://raw.githubusercontent.com/SchemaStore/schemastore/master/LICENSE" },
  { file: "schemastore.NOTICE", url: "https://raw.githubusercontent.com/SchemaStore/schemastore/master/NOTICE" },
  { file: "compose-spec.LICENSE", url: "https://raw.githubusercontent.com/compose-spec/compose-spec/main/LICENSE" },
  { file: "compose-spec.NOTICE", url: "https://raw.githubusercontent.com/compose-spec/compose-spec/main/NOTICE" },
  { file: "gitlab.LICENSE", url: "https://gitlab.com/gitlab-org/gitlab/-/raw/master/LICENSE" },
];

/** Drop every `markdownDescription` that repeats a `description` beside it. */
function dropDuplicateMarkdown(node) {
  if (Array.isArray(node)) return node.map(dropDuplicateMarkdown);
  if (node === null || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "markdownDescription" && typeof node.description === "string") continue;
    out[key] = dropDuplicateMarkdown(value);
  }
  return out;
}

/** Remove every `$ref` that does not point into the document itself. */
function dropForeignRefs(node) {
  if (Array.isArray(node)) return node.map(dropForeignRefs);
  if (node === null || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string" && !value.startsWith("#")) continue;
    out[key] = dropForeignRefs(value);
  }
  return out;
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

mkdirSync(OUT, { recursive: true });
for (const source of SOURCES) {
  const document = JSON.parse(await fetchText(source.url));
  const written = dropDuplicateMarkdown(source.rewrite ? source.rewrite(document) : document);
  writeFileSync(join(OUT, source.file), `${JSON.stringify(written, null, 2)}\n`);
  console.log(`${source.file} ← ${source.url}`);
}
for (const license of LICENSES) {
  writeFileSync(join(OUT, license.file), (await fetchText(license.url)).replace(/\r\n/g, "\n"));
  console.log(`${license.file} ← ${license.url}`);
}
