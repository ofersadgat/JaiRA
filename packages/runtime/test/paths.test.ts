/**
 * Table-driven path mapping (DESIGN §9.1, and the §16 mitigation for "WSL path
 * mapping edge cases": one mapper, exhaustively exercised).
 */
import { describe, expect, it } from "vitest";
import { distroOf, hostPathFor, isWslEnv, pathFor, samePath, samePathKey, toWindowsPath, toWslPath } from "../src/paths";

describe("toWslPath", () => {
  const cases: Array<[string, string]> = [
    ["C:\\UbuntuCode\\JaiRA", "/mnt/c/UbuntuCode/JaiRA"],
    ["c:\\work", "/mnt/c/work"],
    ["D:\\a\\b\\c", "/mnt/d/a/b/c"],
    ["C:/forward/slashes", "/mnt/c/forward/slashes"],
    ["C:\\mixed/separators\\here", "/mnt/c/mixed/separators/here"],
    ["C:\\", "/mnt/c"],
    // Bare `C:` is drive-relative in Windows and has no WSL equivalent; the drive
    // root is the documented approximation.
    ["C:", "/mnt/c"],
    ["C:\\trailing\\", "/mnt/c/trailing"],
    ["\\\\wsl.localhost\\Ubuntu\\home\\ofer\\repo", "/home/ofer/repo"],
    ["\\\\wsl$\\Ubuntu-22.04\\home\\ofer", "/home/ofer"], // legacy share spelling
    ["\\\\wsl.localhost\\Ubuntu", "/"],
    ["/already/posix", "/already/posix"],
    ["relative/path", "relative/path"],
    ["", ""],
  ];
  it.each(cases)("%s → %s", (input, expected) => {
    expect(toWslPath(input, "Ubuntu")).toBe(expected);
  });

  it("keeps a path with spaces intact", () => {
    expect(toWslPath("C:\\Program Files\\git", "Ubuntu")).toBe("/mnt/c/Program Files/git");
  });
});

describe("toWindowsPath", () => {
  const cases: Array<[string, string]> = [
    ["/mnt/c/UbuntuCode/JaiRA", "C:\\UbuntuCode\\JaiRA"],
    ["/mnt/d/a/b", "D:\\a\\b"],
    ["/mnt/c", "C:\\"],
    ["/mnt/c/", "C:\\"],
    ["/home/ofer/repo", "\\\\wsl.localhost\\Ubuntu\\home\\ofer\\repo"],
    ["/", "\\\\wsl.localhost\\Ubuntu"],
    ["relative/path", "relative\\path"],
  ];
  it.each(cases)("%s → %s", (input, expected) => {
    expect(toWindowsPath(input, "Ubuntu")).toBe(expected);
  });

  it("refuses a distro-internal path with no distro to attribute it to", () => {
    expect(() => toWindowsPath("/home/ofer")).toThrow(/without a distro name/);
    // A /mnt path needs no distro: it is a Windows drive either way.
    expect(toWindowsPath("/mnt/c/x")).toBe("C:\\x");
  });
});

describe("round trips", () => {
  it("preserves Windows drive paths", () => {
    for (const p of ["C:\\UbuntuCode\\JaiRA", "D:\\a\\b\\c", "C:\\Program Files\\git"]) {
      expect(toWindowsPath(toWslPath(p, "Ubuntu"), "Ubuntu")).toBe(p);
    }
  });

  it("preserves distro-internal paths", () => {
    for (const p of ["/home/ofer/repo", "/var/tmp"]) {
      expect(toWslPath(toWindowsPath(p, "Ubuntu"), "Ubuntu")).toBe(p);
    }
  });
});

describe("ExecEnv helpers", () => {
  it("discriminates environments and picks the right path view", () => {
    expect(isWslEnv("windows")).toBe(false);
    expect(isWslEnv({ wsl: "Ubuntu" })).toBe(true);
    expect(distroOf("windows")).toBeUndefined();
    expect(distroOf({ wsl: "Ubuntu" })).toBe("Ubuntu");

    // Native execution leaves paths exactly as Windows wrote them.
    expect(pathFor("windows", "C:\\a\\b")).toBe("C:\\a\\b");
    expect(pathFor({ wsl: "Ubuntu" }, "C:\\a\\b")).toBe("/mnt/c/a/b");

    // …and the reverse direction is what makes a WSL project readable from the app.
    expect(hostPathFor("windows", "C:\\a")).toBe("C:\\a");
    expect(hostPathFor({ wsl: "Ubuntu" }, "/home/ofer")).toBe("\\\\wsl.localhost\\Ubuntu\\home\\ofer");
  });
});

describe("samePath", () => {
  it("matches spellings that differ only by separator, case, or trailing slash", () => {
    // The real case this exists for: joining `git worktree list` output (forward
    // slashes) against JaiRA's recorded paths (backslashes).
    expect(samePath("C:/work/repo", "C:\\work\\repo")).toBe(true);
    expect(samePath("C:\\Work\\Repo", "c:\\work\\repo")).toBe(true);
    expect(samePath("C:/work/repo/", "C:/work/repo")).toBe(true);
    expect(samePath("C:/work/repo", "C:/work/other")).toBe(false);
    expect(samePathKey("C:\\A\\B\\")).toBe("c:/a/b");
  });

  it("joins a WSL project's git output against recorded host paths", () => {
    // `git worktree list` inside a distro reports `/mnt/c/…`, while JaiRA recorded
    // the Windows path. Mapping back to the host view is what makes them match —
    // without it the worktree/task join silently finds nothing.
    const recorded = "C:\\work\\.jaira-worktrees\\proj\\t-1";
    const fromGit = "/mnt/c/work/.jaira-worktrees/proj/t-1";
    expect(samePath(hostPathFor({ wsl: "Ubuntu" }, fromGit), recorded)).toBe(true);
    // Native projects need only the separator/case normalization.
    expect(samePath(hostPathFor("windows", "C:/work/x"), "C:\\work\\x")).toBe(true);
  });
});
