/**
 * Merge electron-builder's update manifests across architectures (decision 0011 §4).
 *
 * Each build machine writes its channel's manifest — `latest.yml` / `nightly.yml` (Windows),
 * `latest-mac.yml` / `nightly-mac.yml` (macOS), `latest-linux[-arm64].yml` (Linux) — naming only its
 * own installer. Windows x64 and arm64 write the SAME file name, as do the two macs, and a release can
 * hold one file per name; so the release pipeline collects each machine's copy as `<name>@<build>` and
 * this merges the copies of one name into one manifest listing every architecture's file, which is
 * how electron-updater expects to find them (it picks the file for its own architecture).
 *
 * Adapted from pingdotgg/t3code `scripts/lib/update-manifest.ts`:
 *
 *   MIT License. Copyright (c) 2026 T3 Tools Inc.
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 *   associated documentation files (the "Software"), to deal in the Software without restriction,
 *   including without limitation the rights to use, copy, modify, merge, publish, distribute,
 *   sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions: The above copyright notice and this
 *   permission notice shall be included in all copies or substantial portions of the Software.
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 *   NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
 *   OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * Changed from the original: plain JavaScript; a file entry keeps any extra scalar field it carries
 * (electron-builder adds `blockMapSize` to some) instead of refusing it.
 *
 * The format read is the subset electron-builder writes: top-level `key: scalar` lines and a `files:`
 * list of `- url:` entries with indented scalar fields. The legacy top-level `path`/`sha512` (the first
 * file again) are dropped; electron-updater reads `files`.
 */

const unquote = (value) => (value.length >= 2 && value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : value);

function scalar(raw) {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return unquote(trimmed);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** Read one manifest. `where` names it in an error. */
export function parseManifest(text, where) {
  const files = [];
  const extras = {};
  let version;
  let releaseDate;
  let file;
  const close = () => {
    if (file === undefined) return;
    if (typeof file.url !== "string" || typeof file.sha512 !== "string" || typeof file.size !== "number") {
      throw new Error(`${where}: incomplete file entry for ${String(file.url)}`);
    }
    files.push(file);
    file = undefined;
  };
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trimEnd();
    if (line === "" || line === "files:") continue;
    const item = /^  - ([A-Za-z][A-Za-z0-9]*):\s*(.+)$/.exec(line);
    if (item !== null) {
      close();
      file = { [item[1]]: scalar(item[2]) };
      continue;
    }
    const field = /^    ([A-Za-z][A-Za-z0-9]*):\s*(.+)$/.exec(line);
    if (field !== null) {
      if (file === undefined) throw new Error(`${where}:${index + 1}: a file field outside a file entry`);
      file[field[1]] = scalar(field[2]);
      continue;
    }
    close();
    const top = /^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/.exec(line);
    if (top === null) throw new Error(`${where}:${index + 1}: unsupported line '${line}'`);
    const value = scalar(top[2]);
    if (top[1] === "version") version = String(value);
    else if (top[1] === "releaseDate") releaseDate = String(value);
    else if (top[1] !== "path" && top[1] !== "sha512") extras[top[1]] = value;
  }
  close();
  if (version === undefined) throw new Error(`${where}: no version`);
  if (releaseDate === undefined) throw new Error(`${where}: no releaseDate`);
  if (files.length === 0) throw new Error(`${where}: no files`);
  return { version, releaseDate, files, extras };
}

/** One manifest listing every architecture's files. They must agree on version and on shared fields. */
export function mergeManifests(manifests, name) {
  const [first, ...rest] = manifests;
  if (first === undefined) throw new Error(`${name}: nothing to merge`);
  const byUrl = new Map();
  const extras = { ...first.extras };
  let releaseDate = first.releaseDate;
  for (const manifest of manifests) {
    if (manifest.version !== first.version) throw new Error(`${name}: versions differ (${first.version} vs ${manifest.version})`);
    for (const file of manifest.files) {
      const seen = byUrl.get(file.url);
      if (seen !== undefined && (seen.sha512 !== file.sha512 || seen.size !== file.size)) throw new Error(`${name}: two different files named ${file.url}`);
      byUrl.set(file.url, file);
    }
    if (manifest.releaseDate > releaseDate) releaseDate = manifest.releaseDate;
  }
  for (const manifest of rest) {
    for (const [key, value] of Object.entries(manifest.extras)) {
      if (key in extras && extras[key] !== value) throw new Error(`${name}: '${key}' differs (${extras[key]} vs ${value})`);
      extras[key] = value;
    }
  }
  return { version: first.version, releaseDate, files: [...byUrl.values()], extras };
}

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const write = (value) => (typeof value === "string" ? quote(value) : String(value));

export function serializeManifest(manifest) {
  const lines = [`version: ${quote(manifest.version)}`, "files:"];
  for (const file of manifest.files) {
    const { url, ...fields } = file;
    lines.push(`  - url: ${write(url)}`);
    for (const [key, value] of Object.entries(fields)) lines.push(`    ${key}: ${write(value)}`);
  }
  for (const key of Object.keys(manifest.extras).sort()) lines.push(`${key}: ${write(manifest.extras[key])}`);
  lines.push(`releaseDate: ${quote(manifest.releaseDate)}`, "");
  return lines.join("\n");
}
