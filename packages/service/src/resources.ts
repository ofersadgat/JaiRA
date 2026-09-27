/**
 * How busy this machine is (decision 0013 §5, ruled 2026-09-27: "look at memory, cores, etc." as t3code
 * does): its cores, how much of their time was spent working over the last few seconds, and its free
 * memory. Placement admits a run on a machine with room by these, not by a fixed count.
 *
 * CPU is measured from `os.cpus()` times between two samples, which every platform has; `loadavg` is
 * zero on Windows.
 */
import { cpus, freemem, totalmem } from "node:os";

export interface MachineResources {
  cores: number;
  /** 0–1: the share of all cores' time spent working since the previous sample. */
  cpu: number;
  freeMemory: number;
  totalMemory: number;
  /** When it was measured, epoch ms. */
  at: number;
}

function totals(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Samples every `everyMs`, and answers the last reading at once. */
export class ResourceSampler {
  private last = totals();
  private reading: MachineResources;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(everyMs = 3000) {
    this.reading = { cores: cpus().length, cpu: 0, freeMemory: freemem(), totalMemory: totalmem(), at: Date.now() };
    this.timer = setInterval(() => this.sample(), everyMs);
    this.timer.unref?.();
  }

  private sample(): void {
    const now = totals();
    const total = now.total - this.last.total;
    const idle = now.idle - this.last.idle;
    this.last = now;
    this.reading = {
      cores: cpus().length,
      cpu: total > 0 ? Math.min(1, Math.max(0, 1 - idle / total)) : this.reading.cpu,
      freeMemory: freemem(),
      totalMemory: totalmem(),
      at: Date.now(),
    };
  }

  current(): MachineResources {
    // Older than two samples means the timer is starved: measure now rather than answer stale.
    if (Date.now() - this.reading.at > 10_000) this.sample();
    return this.reading;
  }

  close(): void {
    clearInterval(this.timer);
  }
}
