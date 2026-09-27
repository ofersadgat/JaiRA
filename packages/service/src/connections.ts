/**
 * What belongs to ONE window rather than to the engine (decision 0012 §3, "per connection"): with the
 * engine answering several clients — the desktop's own window, another desktop, `jaira` — the two
 * pieces of state that assumed a single window are kept per connection here.
 *
 * - **The current project.** `project:current` is where a window stands before anybody has navigated:
 *   the project IT opened last, while that is still open, and the engine's most recent otherwise.
 * - **Watching the limits.** `limits:watch` says a meter is on screen. With two windows, one closing its
 *   meter must not stop the other's refreshing, so the engine watches while ANY connection does.
 */
import { resolve } from "node:path";
import type { Handler } from "./handlers";
import type { AppService } from "./service";

/** The channels a connection answers for itself (see {@link EngineConnections.handlersFor}). */
export const CONNECTION_CHANNELS = ["project:open", "project:init", "project:current", "limits:watch"] as const;

type ConnectionService = Pick<AppService, "open" | "init" | "current" | "inspect" | "watchLimits">;

export class EngineConnections {
  private readonly opened = new Map<string, string>();
  private readonly watching = new Set<string>();

  constructor(private readonly service: ConnectionService) {}

  /** One connection's answers, over the service's own. */
  handlersFor(id: string): Partial<Record<string, Handler>> {
    const service = this.service;
    const remember = (result: { dir: string; recovered: string[] }): { dir: string; recovered: string[] } => {
      this.opened.set(id, result.dir);
      return result;
    };
    return {
      "project:open": (async (request: { dir: string; remember?: boolean }) =>
        remember(await service.open(resolve(request.dir), request.remember === false ? { remember: false } : {}))) as Handler,
      "project:init": (async (request: { dir: string }) => remember(await service.init(resolve(request.dir)))) as Handler,
      "project:current": (() => this.current(id)) as Handler,
      "limits:watch": ((request: { watching: boolean }) => this.watch(id, request.watching)) as Handler,
    };
  }

  current(id: string): { dir: string } | null {
    const mine = this.opened.get(id);
    if (mine !== undefined && this.service.inspect(mine).open) return { dir: mine };
    return this.service.current();
  }

  watch(id: string, watching: boolean): void {
    const before = this.watching.size > 0;
    if (watching) this.watching.add(id);
    else this.watching.delete(id);
    const after = this.watching.size > 0;
    if (after !== before) this.service.watchLimits(after);
  }

  /** A connection that went: it stands nowhere and watches nothing. */
  drop(id: string): void {
    this.opened.delete(id);
    this.watch(id, false);
  }
}
