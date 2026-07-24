/**
 * Node-only JSON file reading. Kept out of `json.ts` (and out of
 * `@jaira/shared/browser`) so the renderer's bundle can never pull in `node:fs`.
 */
import { readFileSync } from "node:fs";
import { parseJsonText } from "./json";

export function readJsonFile(file: string): unknown {
  return parseJsonText(readFileSync(file, "utf8"), file);
}
