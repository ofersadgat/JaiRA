/**
 * `attention.ts` on the desktop: Windows toasts with the ask's own answers as buttons, the taskbar
 * button's overlay badge, its progress bar, and a flash when something new asks while the window is
 * not the one in front. Fed every push the window hears (`pushToWindow`); asks the engine through the
 * window's own link, so an answer from a toast is the same request as one from the app.
 */
import { BrowserWindow, Notification, nativeImage } from "electron";
import type { PushMessage, TaskSummary } from "@jaira/shared";
import { AttentionLedger, taskbarOf, toastOf, type AttentionItem, type ToastAnswer } from "./attention";
import { BADGE_SIZE, badgeBitmap, badgeText } from "./badgeIcon";

export interface AttentionPorts {
  window: () => BrowserWindow | undefined;
  invoke: (channel: string, request: unknown) => Promise<unknown>;
  /** Whether any run or turn is working (not parked on a person or an event). */
  working: () => Promise<boolean>;
  /** Bring the window forward on a task. */
  open: (taskId: string, project: string | undefined) => void;
  warn: (message: string) => void;
}

export class DesktopAttention {
  private readonly ledger = new AttentionLedger();
  /** Shown toasts, by their tag — held so their events fire, and closed when what they ask is answered. */
  private readonly toasts = new Map<string, Notification>();
  private readonly titles = new Map<string, { at: number; rows: TaskSummary[] }>();
  private isWorking = false;
  private workingCheck: ReturnType<typeof setTimeout> | undefined;
  private lastBadge = "";

  constructor(private readonly ports: AttentionPorts) {}

  /** The asks already open when the window came to its engine: counted, not toasted. */
  async seed(): Promise<void> {
    try {
      const [questions, approvals, gates] = await Promise.all([
        this.ports.invoke("question:pending", undefined),
        this.ports.invoke("approval:pending", undefined),
        this.ports.invoke("interaction:pending", undefined),
      ]);
      this.ledger.seed(questions as never, approvals as never, gates as never);
    } catch (e) {
      this.ports.warn(`attention: could not read what is waiting: ${(e as Error).message}`);
    }
    this.checkWorking();
    this.draw();
  }

  push(message: PushMessage): void {
    const item = this.ledger.take(message);
    if (message.type === "question:resolved" || message.type === "approval:resolved" || message.type === "interaction:resolved") this.closeToast(message.requestId);
    if (message.type === "store:invalidate" || message.type === "run:finished" || message.type === "session:turn") this.checkWorking();
    if (item !== undefined && !this.inFront()) {
      void this.toast(item);
      if (item.kind === "asking") this.ports.window()?.flashFrame(true);
    }
    if (item !== undefined || message.type.endsWith(":resolved") || message.type === "run:finished") this.draw();
  }

  /** The window came to the front: what ended is seen, and the button stops flashing. */
  focused(): void {
    this.ledger.looked();
    this.ports.window()?.flashFrame(false);
    for (const [id, toast] of this.toasts) {
      if (id.startsWith("failed:") || id.startsWith("done:")) {
        toast.close();
        this.toasts.delete(id);
      }
    }
    this.draw();
  }

  private inFront(): boolean {
    const window = this.ports.window();
    return window !== undefined && !window.isDestroyed() && window.isFocused() && window.isVisible() && !window.isMinimized();
  }

  /** The working bar, read a moment after things move rather than on every delta. */
  private checkWorking(): void {
    if (this.workingCheck !== undefined) return;
    this.workingCheck = setTimeout(() => {
      this.workingCheck = undefined;
      void this.ports.working().then(
        (working) => {
          if (working !== this.isWorking) {
            this.isWorking = working;
            this.draw();
          }
        },
        () => undefined,
      );
    }, 750);
  }

  private draw(): void {
    const window = this.ports.window();
    if (window === undefined || window.isDestroyed()) return;
    const state = taskbarOf(this.ledger, this.isWorking);
    const key = state.badge === undefined ? "" : `${state.badge.kind}:${badgeText(state.badge)}`;
    if (key !== this.lastBadge) {
      this.lastBadge = key;
      if (process.platform === "win32") {
        const icon = state.badge === undefined ? null : nativeImage.createFromBitmap(Buffer.from(badgeBitmap(state.badge)), { width: BADGE_SIZE, height: BADGE_SIZE });
        window.setOverlayIcon(icon, state.description);
      }
    }
    window.setProgressBar(state.progress === "none" ? -1 : state.progress === "indeterminate" ? 2 : 1, { mode: state.progress });
  }

  private async toast(item: AttentionItem): Promise<void> {
    if (!Notification.isSupported()) return;
    const spec = toastOf(item, await this.titleOf(item.taskId, item.project));
    this.closeToast(spec.id);
    const toast = new Notification({
      id: spec.id,
      title: spec.title,
      body: spec.body,
      actions: spec.buttons.map((b) => ({ type: "button" as const, text: b.text })),
      ...(spec.reply !== undefined ? { hasReply: true, replyPlaceholder: "Reply…" } : {}),
    });
    const project = item.project;
    toast.on("click", () => this.ports.open(item.taskId ?? "", project));
    toast.on("action", (details, index) => {
      const button = spec.buttons[details?.actionIndex ?? index];
      if (button !== undefined) void this.answer(button.answer, item);
    });
    toast.on("reply", (details, text) => {
      const message = ((details as { reply?: string } | undefined)?.reply ?? text ?? "").trim();
      if (spec.reply !== undefined && message !== "") {
        void this.ports.invoke("chat:send", { taskId: spec.reply.taskId, instanceId: "", message, project: spec.reply.project }).catch((e: Error) => this.ports.warn(`attention: the reply did not send: ${e.message}`));
      }
    });
    toast.on("close", () => {
      if (this.toasts.get(spec.id) === toast) this.toasts.delete(spec.id);
    });
    this.toasts.set(spec.id, toast);
    toast.show();
  }

  private async answer(answer: ToastAnswer, item: AttentionItem): Promise<void> {
    if ("open" in answer) {
      this.ports.open(item.taskId ?? "", item.project);
      return;
    }
    try {
      await this.ports.invoke(answer.channel, answer.request);
    } catch (e) {
      this.ports.warn(`attention: the answer did not go: ${(e as Error).message}`);
      this.ports.open(item.taskId ?? "", item.project);
    }
  }

  private closeToast(id: string): void {
    const toast = this.toasts.get(id);
    if (toast === undefined) return;
    this.toasts.delete(id);
    toast.close();
  }

  /** A task's name, from its project's list (read at most every few seconds). */
  private async titleOf(taskId: string | undefined, project: string | undefined): Promise<string | undefined> {
    if (taskId === undefined || taskId === "") return undefined;
    const key = project ?? "";
    let cached = this.titles.get(key);
    if (cached === undefined || Date.now() - cached.at > 5_000 || !cached.rows.some((r) => r.taskId === taskId)) {
      try {
        const rows = (await this.ports.invoke("task:list", project !== undefined ? { project } : undefined)) as TaskSummary[];
        cached = { at: Date.now(), rows };
        this.titles.set(key, cached);
      } catch {
        return undefined;
      }
    }
    return cached.rows.find((r) => r.taskId === taskId)?.title;
  }
}
