/**
 * BOM-tolerant JSON parsing. Windows tools (PowerShell's `-Encoding utf8` among
 * them) write UTF-8 with a BOM, which `JSON.parse` rejects — and JaiRA's JSON
 * surfaces (config, task files, workflow states, @file CLI args) are all
 * plausibly hand-edited on Windows.
 *
 * Deliberately free of `node:fs`: this module is part of the browser-safe surface
 * (`@jaira/shared/browser`), and file reading lives in `jsonFile.ts` so importing
 * a parser cannot drag the filesystem into the renderer's bundle.
 */

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseJsonText(text: string, sourceLabel?: string): unknown {
  try {
    return JSON.parse(stripBom(text)) as unknown;
  } catch (e) {
    throw new Error(`${sourceLabel ?? "JSON"}: invalid JSON: ${(e as Error).message}`);
  }
}
