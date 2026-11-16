/**
 * When a development build builds the Tailscale helper again (`buildTailnet.mjs --if-stale`): when it is
 * missing, or older than a source `go build .` reads. Nothing here runs Go.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error -- buildTailnet.mjs is plain JavaScript with no declarations; its exports are used as they are.
import { helperSources, staleBecause } from "../buildTailnet.mjs";

const sourcesOf = helperSources as (dir: string) => string[];
const stale = staleBecause as (binary: string, dir: string) => string | undefined;

let root: string;
let src: string;
let binary: string;

/** `path` written, dated `seconds` after the epoch. */
function at(path: string, seconds: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  utimesSync(path, seconds, seconds);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "build-tailnet-"));
  src = join(root, "tailnet");
  binary = join(root, "out", "jaira-tailnet");
  at(join(src, "go.mod"), 100);
  at(join(src, "go.sum"), 100);
  at(join(src, "main.go"), 100);
  at(join(src, "node", "node.go"), 100);
  at(join(src, "node", "node_test.go"), 100);
  at(join(src, "mobile", "tailnet.go"), 100);
  at(join(src, "README.md"), 100);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the helper's sources", () => {
  it("are go.mod, go.sum and the Go files but the tests' and the phone's package", () => {
    const names = sourcesOf(src).map((file) => file.slice(src.length + 1).split("\\").join("/"));
    expect(names.sort()).toEqual(["go.mod", "go.sum", "main.go", "node/node.go"]);
  });
});

describe("staleBecause", () => {
  it("says a helper never built is not built", () => {
    expect(stale(binary, src)).toBe("not built");
  });

  it("is nothing for a helper newer than every source", () => {
    at(binary, 200);
    expect(stale(binary, src)).toBeUndefined();
  });

  it("names each source changed since the helper was built", () => {
    at(binary, 200);
    at(join(src, "node", "node.go"), 300);
    at(join(src, "go.sum"), 300);
    expect(stale(binary, src)).toBe("go.sum, node/node.go changed since it was built");
  });

  it("ignores a newer test, the phone's package and the README", () => {
    at(binary, 200);
    at(join(src, "node", "node_test.go"), 300);
    at(join(src, "mobile", "tailnet.go"), 300);
    at(join(src, "README.md"), 300);
    expect(stale(binary, src)).toBeUndefined();
  });
});
