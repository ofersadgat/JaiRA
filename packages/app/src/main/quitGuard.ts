/**
 * Quitting with work going (the person, 2026-11-12: "if I try and close JaiRA, I want you to pop up a
 * dialog if there are still running workflows/sessions asking me what I want to do: wait for it to
 * finish and then exit, exit immediately, or cancel").
 *
 * Every quit attempt — the window's close, a menu's or the OS's quit — comes here first. With nothing
 * WORKING it lets the quit go at once, exactly as before. Otherwise the quit is held and the person is
 * asked, in the window when it can draw, else in the OS's own box:
 *
 *  - `wait`   the app stays open and quits by itself once nothing is working, which it re-reads every
 *             `pollMs`. What is parked on the person or the world does not count (see `blockingOf`),
 *             so a run that stops to ask cannot hold the quit for ever.
 *  - `now`    the ordinary quit: `before-quit` drains, which stops what is working (see `desktop.ts`).
 *  - `cancel` nothing; the app stays as it was.
 *
 * One question at a time: an attempt while the dialog is up draws it again, and one while waiting
 * changes nothing (the strip offers Quit now). A quit the app asks for itself (an update's restart,
 * which has its own waiting) goes through {@link letGo}. Electron is reached through the options, so
 * all of it is tested without it.
 */
import type { QuitChoice, QuitState, RunningWork } from "@jaira/shared";

/** What holds a quit: work in flight that is not parked on the person or the world. */
export function blockingOf(work: readonly RunningWork[]): RunningWork[] {
  return work.filter((item) => item.waiting === undefined);
}

/**
 * What a quit attempt, or an answer, comes to with this work going: `quit` lets it go, `ask` raises
 * the dialog, `wait` holds it until nothing is working, `stay` does nothing.
 */
export function quitStep(work: readonly RunningWork[], choice?: QuitChoice): "quit" | "ask" | "wait" | "stay" {
  const busy = blockingOf(work).length > 0;
  if (choice === undefined) return busy ? "ask" : "quit";
  if (choice === "now") return "quit";
  if (choice === "cancel") return "stay";
  return busy ? "wait" : "quit";
}

export interface QuitGuardOptions {
  /** What a quit of this process would cut, now; empty when it would cut nothing. */
  work: () => Promise<RunningWork[]>;
  /** Let the ordinary quit go. */
  quit: () => void;
  /** Every change of state, for the window. */
  publish: (state: QuitState) => void;
  /** Whether the window is there to draw the dialog. */
  canDraw: () => boolean;
  /** Ask with the OS's own box: there is no window, or it did not draw the dialog in time. */
  askNatively: (work: RunningWork[], signal: AbortSignal) => Promise<QuitChoice>;
  /** Bring the window forward, for an attempt while the question is already up. */
  focus?: () => void;
  log?: (level: "info" | "warn", message: string) => void;
  /** How often "wait" re-reads what is going. */
  pollMs?: number;
  /** How long the window has to say it drew the dialog (`shown`) before the OS's box is used. */
  shownWithinMs?: number;
}

export class QuitGuard {
  private state: QuitState = { phase: "idle", work: [] };
  /** The quit has been let go: every attempt from here passes. */
  private released = false;
  /** An attempt is reading what is going. */
  private reading = false;
  private poll: ReturnType<typeof setInterval> | undefined;
  private shownTimer: ReturnType<typeof setTimeout> | undefined;
  private native = false;
  /** The window said it drew the dialog now up. */
  private drawn = false;
  /** Closes the OS's box when the window answered first. */
  private nativeBox: AbortController | undefined;

  constructor(private readonly options: QuitGuardOptions) {}

  current(): QuitState {
    return this.state;
  }

  /** Whether a quit may go through now. False means: hold it, and call {@link request}. */
  allows(): boolean {
    return this.released;
  }

  /** A quit the app asks for itself, which must not be asked about. */
  letGo(): void {
    this.stop();
    this.closeNativeBox();
    this.released = true;
  }

  /** A quit attempt the guard held. */
  async request(): Promise<void> {
    if (this.released || this.reading) return;
    if (this.state.phase === "asking") {
      // Not a second dialog: the same one, again, in front.
      this.options.focus?.();
      if (!this.native) this.present();
      return;
    }
    if (this.state.phase === "waiting") {
      this.options.focus?.();
      return;
    }
    this.reading = true;
    let work: RunningWork[];
    try {
      work = await this.read();
    } finally {
      this.reading = false;
    }
    if (quitStep(work) === "quit") return this.release();
    this.drawn = false;
    this.state = { phase: "asking", work };
    this.present();
  }

  /** The person's answer, from the window or the OS's box. */
  async answer(choice: QuitChoice): Promise<QuitState> {
    if (this.released) return this.state;
    this.clearShown();
    this.closeNativeBox();
    this.drawn = false;
    if (choice === "wait") {
      const work = await this.read();
      if (quitStep(work, "wait") === "quit") {
        this.release();
        return this.state;
      }
      this.set({ phase: "waiting", work });
      this.startWaiting();
      return this.state;
    }
    this.stop();
    if (quitStep(this.state.work, choice) === "quit") {
      this.release();
      return this.state;
    }
    this.set({ phase: "idle", work: [] });
    return this.state;
  }

  /** The window drew the dialog. */
  shown(): void {
    if (this.state.phase === "asking") this.drawn = true;
    this.clearShown();
  }

  private present(): void {
    if (this.options.canDraw()) {
      this.options.publish(this.state);
      // Drawn already (an attempt while it is up), or the clock already running.
      if (this.drawn || this.shownTimer !== undefined) return;
      this.shownTimer = setTimeout(() => {
        this.shownTimer = undefined;
        if (this.state.phase === "asking") this.askNatively();
      }, this.options.shownWithinMs ?? 3000);
      this.shownTimer.unref?.();
      return;
    }
    this.askNatively();
  }

  private askNatively(): void {
    if (this.native) return;
    this.native = true;
    const box = new AbortController();
    this.nativeBox = box;
    this.options.log?.("info", "quit: asking in the OS's own box");
    void this.options.askNatively(this.state.work, box.signal).then(
      (choice) => {
        // Answered in the window meanwhile, which closed this box.
        if (!this.native || box.signal.aborted) return;
        void this.answer(choice);
      },
      () => {
        this.native = false;
      },
    );
  }

  private startWaiting(): void {
    if (this.poll !== undefined) clearInterval(this.poll);
    const poll = setInterval(() => {
      void this.read().then((work) => {
        if (this.poll !== poll) return;
        if (quitStep(work, "wait") === "quit") return this.release();
        if (!sameWork(work, this.state.work)) this.set({ phase: "waiting", work });
      });
    }, this.options.pollMs ?? 1000);
    this.poll = poll;
  }

  /** What is going, or nothing when the engine cannot say: a failed ask must not keep the app from quitting. */
  private async read(): Promise<RunningWork[]> {
    try {
      return await this.options.work();
    } catch (e) {
      this.options.log?.("warn", `quit: could not ask the engine what is running: ${(e as Error).message}`);
      return [];
    }
  }

  private release(): void {
    this.stop();
    this.released = true;
    this.set({ phase: "idle", work: [] });
    this.options.quit();
  }

  private stop(): void {
    if (this.poll !== undefined) clearInterval(this.poll);
    this.poll = undefined;
    this.clearShown();
  }

  /** Close the OS's box, if one is up, without its answer counting. */
  private closeNativeBox(): void {
    this.native = false;
    this.nativeBox?.abort();
    this.nativeBox = undefined;
  }

  private clearShown(): void {
    if (this.shownTimer !== undefined) clearTimeout(this.shownTimer);
    this.shownTimer = undefined;
  }

  private set(state: QuitState): void {
    this.state = state;
    this.options.publish(state);
  }
}

function sameWork(a: readonly RunningWork[], b: readonly RunningWork[]): boolean {
  return a.length === b.length && a.every((item, i) => item.taskId === b[i]!.taskId && item.waiting === b[i]!.waiting && item.title === b[i]!.title);
}
