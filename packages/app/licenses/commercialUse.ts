/**
 * Whether a third-party license lets JaiRA ship in a closed, commercial product.
 *
 * JaiRA carries no license of its own: it is not open source, and whatever it bundles or installs
 * must allow being redistributed inside proprietary software that is sold. That rules out every
 * license that makes the whole work open (GPL, AGPL) and every license that forbids commercial use
 * (the Creative Commons NC family, source-available licenses such as SSPL, BUSL and Elastic).
 * `thirdPartyLicenses.test.ts` runs this over every entry in the app's manifest, so a dependency
 * that brings one in fails the suite with its name and license.
 *
 * An ALLOW list, not a deny list: a license nobody has looked at yet is refused until someone adds
 * it here, which is the only way a new, unusual license gets a reading before it ships.
 *
 * The entry's `license` is an SPDX expression. `OR` passes if any branch passes (the licensee picks),
 * `AND` only if every part does, and `X WITH exception` is judged by `X` unless the pair itself is
 * listed below.
 */

/**
 * Licenses that allow use, modification and redistribution in proprietary commercial software. Most
 * ask only for their notice to be kept, which the Licenses page does.
 */
export const COMMERCIAL_USE_LICENSES: ReadonlySet<string> = new Set([
  "0BSD",
  "AFL-2.1",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  // File-level copyleft only: changes to an MPL file must stay MPL, and nothing else is touched.
  // Shipping an MPL package unmodified inside a proprietary product is ordinary.
  "MPL-2.0",
  // A font license: the font may be bundled with software that is sold, just not sold on its own.
  "OFL-1.1",
  "Python-2.0",
  "Unlicense",
  "WTFPL",
  "Zlib",
]);

/** A `license WITH exception` pair allowed even though the license alone is not. */
const COMMERCIAL_USE_EXCEPTIONS: ReadonlySet<string> = new Set([
  // GCC's runtime exception: code linked against the runtime is not made GPL by it.
  "GPL-3.0-only WITH GCC-exception-3.1",
  "GPL-3.0-or-later WITH GCC-exception-3.1",
]);

/**
 * Packages whose license is not an SPDX expression but has been read, and allows shipping. Keyed by
 * name AND the exact `license` string the package states, so a package that changes its license is
 * refused again until someone reads the new one.
 *
 * The Claude Agent SDK and its per-platform binary are Anthropic's, all rights reserved, "subject to
 * the Legal Agreements" (their LICENSE.md). Those agreements put the SDK under Anthropic's Commercial
 * Terms "including when you use it to power products and services that you make available to your
 * own customers and end users" (https://code.claude.com/docs/en/agent-sdk/overview, "License and
 * terms", read 2026-09-25) — shipping it is contemplated, on conditions JaiRA keeps elsewhere: the
 * binary unmodified, each person on their own API key and never a Claude subscription
 * (`runtime/src/sdkCredential.ts`), and the route not called "Claude Code" (`EXECUTOR_TITLES`).
 */
const READ_PACKAGE_LICENSES: ReadonlyMap<string, string> = new Map([
  ["@anthropic-ai/claude-agent-sdk", "SEE LICENSE IN README.md"],
  // The SDK's `optionalDependencies`, one per platform; win32-x64's string was read, the rest are
  // assumed to match it, and any that does not is refused on the machine that installs it.
  ...["linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"].map(
    (platform) => [`@anthropic-ai/claude-agent-sdk-${platform}`, "SEE LICENSE IN LICENSE.md"] as const,
  ),
]);

type Expr ={ kind: "id"; id: string } | { kind: "with"; id: string; exception: string } | { kind: "and" | "or"; parts: Expr[] };

function tokenize(expression: string): string[] {
  return expression.replace(/[()]/g, (paren) => ` ${paren} `).split(/\s+/).filter((token) => token.length > 0);
}

/** A small SPDX expression parser: `OR` binds loosest, then `AND`, then `WITH`; parentheses group. */
export function parseSpdxExpression(expression: string): Expr {
  const tokens = tokenize(expression);
  let at = 0;
  const peek = (): string | undefined => tokens[at];
  const take = (): string => {
    const token = tokens[at++];
    if (token === undefined) throw new Error(`"${expression}" ends early.`);
    return token;
  };
  const primary = (): Expr => {
    const token = take();
    if (token === "(") {
      const inner = or();
      if (take() !== ")") throw new Error(`"${expression}" has an unclosed parenthesis.`);
      return inner;
    }
    if (/^(?:AND|OR|WITH|\))$/i.test(token)) throw new Error(`"${expression}" has "${token}" where a license belongs.`);
    if (peek()?.toUpperCase() === "WITH") {
      take();
      return { kind: "with", id: token, exception: take() };
    }
    return { kind: "id", id: token };
  };
  const and = (): Expr => {
    const parts = [primary()];
    while (peek()?.toUpperCase() === "AND") {
      take();
      parts.push(primary());
    }
    return parts.length === 1 ? parts[0]! : { kind: "and", parts };
  };
  const or = (): Expr => {
    const parts = [and()];
    while (peek()?.toUpperCase() === "OR") {
      take();
      parts.push(and());
    }
    return parts.length === 1 ? parts[0]! : { kind: "or", parts };
  };
  const result = or();
  if (at !== tokens.length) throw new Error(`"${expression}" has "${tokens[at]}" after a complete expression.`);
  return result;
}

function allowed(expr: Expr): boolean {
  switch (expr.kind) {
    case "id":
      // `MIT+` (this version or later) is the same grant for the version named.
      return COMMERCIAL_USE_LICENSES.has(expr.id.replace(/\+$/, ""));
    case "with":
      return COMMERCIAL_USE_EXCEPTIONS.has(`${expr.id} WITH ${expr.exception}`) || COMMERCIAL_USE_LICENSES.has(expr.id);
    case "and":
      return expr.parts.every(allowed);
    case "or":
      return expr.parts.some(allowed);
  }
}

/** Null when the license allows commercial use, else why not. `name` is the package it belongs to,
 *  for the few whose license was read by hand ({@link READ_PACKAGE_LICENSES}). */
export function commercialUseProblem(license: string, name?: string): string | null {
  if (name !== undefined && READ_PACKAGE_LICENSES.get(name) === license) return null;
  let expr: Expr;
  try {
    expr = parseSpdxExpression(license);
  } catch (error) {
    return `its license is not an SPDX expression (${(error as Error).message})`;
  }
  return allowed(expr) ? null : `"${license}" is not on the commercial-use list (packages/app/licenses/commercialUse.ts)`;
}
