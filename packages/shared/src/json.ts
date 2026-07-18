/**
 * BOM-tolerant JSON file reading. Windows tools (PowerShell's `-Encoding utf8`
 * among them) write UTF-8 with a BOM, which `JSON.parse` rejects — and JaiRA's
 * JSON surfaces (config, task files, workflow states, @file CLI args) are all
 * plausibly hand-edited on Windows.
 */
import { readFileSync } from "node:fs";

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

export function readJsonFile(file: string): unknown {
  return parseJsonText(readFileSync(file, "utf8"), file);
}
