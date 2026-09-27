/**
 * Which Chromium profile this process draws with, when several JaiRA processes run at once.
 *
 * Electron keeps two folders that default to one. `userData` is ours — the keychain's `secrets.json`
 * lives there, and sharing it is the point: `--serve` reads the keychain the desktop wrote. But
 * `sessionData`, Chromium's profile (`Cache`, `GPUCache`, `Code Cache`, `Local Storage`, …), defaults
 * to the same folder, and Chromium assumes one process per profile. Every process after the first
 * found the caches held, printed "Unable to move the cache: Access is denied" and "Gpu Cache
 * Creation failed: -2" to a stderr nobody reads, and drew with no cache — and its `localStorage`, where
 * composer drafts are kept, never reached the disk. A second window, a `--serve` beside a window, the
 * shots harness and a second checkout's dev app (they all share `%APPDATA%\@jaira\app`) all did it.
 *
 * So `userData` stays shared and each running process claims a profile of its own from a numbered
 * pool. Profile 0 is Chromium's default — `userData` itself, where the profile has always been — so
 * the ordinary case of one process is exactly what it was, drafts and caches included. A process
 * started while 0 is held takes 1 (`profiles/1`), then 2, and so on; each is reused by whoever next
 * finds it free, so the pool is as large as the most processes ever run at once, not one per launch.
 *
 * A claim is a file named for its holder, `profiles/<index>.<pid>.lock`. The pid is in the NAME,
 * not the contents, so a claim can be tested and a dead one removed without a read-then-replace
 * race: removing a dead pid's file can never remove a live claim. Claiming is create-then-look: make
 * your own file, then list, and yield if any other live holder is there. Two processes racing for
 * one index cannot both keep it — whichever listed second saw the other's file — and at worst both
 * yield and meet again one index up.
 */
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ClaimedProfile {
  readonly index: number;
  /** The folder to give `app.setPath("sessionData", …)`; undefined for 0, which is `userData` itself. */
  readonly dir: string | undefined;
  /** Give the profile back. Safe to call more than once; a process that dies without it is reclaimed. */
  readonly release: () => void;
}

const LOCK = /^(\d+)\.(\d+)\.lock$/;

/**
 * Claim the lowest profile no other live process holds. `alive` answers whether a pid is running;
 * a PID Windows has handed to an unrelated process reads as alive, which only costs a skipped index.
 */
export function claimProfile(userData: string, pid: number, alive: (pid: number) => boolean): ClaimedProfile {
  const root = join(userData, "profiles");
  mkdirSync(root, { recursive: true });

  /** The other live holders of `index`, removing the dead ones found on the way. */
  const others = (index: number): number[] =>
    readdirSync(root).flatMap((name) => {
      const match = LOCK.exec(name);
      if (match === null || Number(match[1]) !== index) return [];
      const holder = Number(match[2]);
      if (holder === pid) return [];
      if (alive(holder)) return [holder];
      try {
        unlinkSync(join(root, name));
      } catch {
        // Another process removed it first, or it is not ours to remove: either way it holds nothing.
      }
      return [];
    });

  for (let index = 0; ; index += 1) {
    if (others(index).length > 0) continue;
    const lock = join(root, `${index}.${pid}.lock`);
    writeFileSync(lock, "");
    if (others(index).length > 0) {
      unlinkSync(lock);
      continue;
    }
    const dir = index === 0 ? undefined : join(root, String(index));
    // `setPath` refuses a folder that does not exist.
    if (dir !== undefined) mkdirSync(dir, { recursive: true });
    return {
      index,
      dir,
      release: () => {
        try {
          unlinkSync(lock);
        } catch {
          // Released already.
        }
      },
    };
  }
}
