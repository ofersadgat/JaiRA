/**
 * What the window shows when the window has stopped working.
 *
 * React unmounts the whole tree when a render throws and nothing catches it, and this app caught
 * nothing anywhere — so one bad value four components deep replaced the entire application with a
 * white rectangle. No message, no stack, no clue which panel did it. That is not a degraded app, it
 * is an app that has become indistinguishable from a crashed one while still running perfectly well
 * everywhere except the subtree that threw.
 *
 * Two nets, because they catch different falls:
 *
 *  - {@link CrashBoundary} catches a throw during RENDER and draws the error in place of the tree.
 *  - {@link installGlobalErrorReporting} catches what has no render to be part of — a rejected
 *    promise nobody awaited, an exception from an event handler or a timer — and shows a banner
 *    over whatever is still on screen, because the app is still usable and saying so is the point.
 *
 * Both also `console.error`. That is not decoration: main mirrors renderer console errors into the
 * app's own log (see `createWindow`), so a crash that happens while nobody is watching leaves a
 * record that outlives the window — which is exactly what the first white screen did not.
 */
import { Component, useEffect, useState, type ErrorInfo, type JSX, type ReactNode } from "react";

/** An error as text worth pasting: the message, and the frames under it. */
function textOf(error: unknown, extra?: string): string {
  const e = error instanceof Error ? error : new Error(String(error));
  return [e.stack ?? `${e.name}: ${e.message}`, extra].filter((part) => part !== undefined && part !== "").join("\n\n");
}

interface CrashState {
  error: unknown;
  /** React's own component stack — which panel, not which function, and usually the useful half. */
  where?: string;
}

/**
 * The boundary itself. A class, because that is the only form React offers for this.
 *
 * Deliberately NOT a retry loop. A boundary that silently re-renders the thing that just threw
 * either works by luck or spins, and both hide the failure. The reader gets the error and a reload
 * button, and reloading is honest about being a reload.
 */
export class CrashBoundary extends Component<{ children: ReactNode }, CrashState> {
  override state: CrashState = { error: undefined };

  static getDerivedStateFromError(error: unknown): Partial<CrashState> {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.setState({ where: info.componentStack ?? undefined });
    // Across to main, and from there into the log — see the module header.
    console.error("[jaira] the interface threw while rendering:", textOf(error, info.componentStack ?? undefined));
  }

  override render(): ReactNode {
    if (this.state.error === undefined) return this.props.children;
    return <CrashScreen error={this.state.error} {...(this.state.where !== undefined ? { where: this.state.where } : {})} />;
  }
}

function CrashScreen({ error, where }: { error: unknown; where?: string }): JSX.Element {
  const text = textOf(error, where);
  return (
    <div className="crash">
      <div className="crash-card">
        <h1>The interface stopped drawing.</h1>
        <p className="sub">
          Nothing that was running has been lost — this is the window, not the work. Reloading rebuilds the
          view from what is already recorded.
        </p>
        <pre className="crash-stack">{text}</pre>
        <div className="crash-actions">
          <button className="primary" onClick={() => window.location.reload()}>
            Reload the window
          </button>
          <button onClick={() => void navigator.clipboard?.writeText(text)}>Copy the error</button>
        </div>
      </div>
    </div>
  );
}

/** A failure with no render to belong to — see the module header. */
export interface LooseError {
  at: number;
  text: string;
}

let report: ((error: LooseError) => void) | undefined;

/**
 * Catch what escapes everything else, once, at module scope.
 *
 * Registered from the entry point rather than from a component, because a rejection can land before
 * the first render and a net installed after the fall is not a net. The sink is a mutable binding so
 * the banner can subscribe when it mounts without the handlers having to exist twice.
 */
export function installGlobalErrorReporting(): void {
  window.addEventListener("error", (event) => {
    const text = textOf(event.error ?? event.message, `${event.filename}:${event.lineno}`);
    console.error("[jaira] uncaught in the interface:", text);
    report?.({ at: Date.now(), text });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const text = textOf(event.reason);
    console.error("[jaira] a promise rejected with nobody waiting:", text);
    report?.({ at: Date.now(), text });
  });
}

/**
 * The banner. Over the app rather than instead of it: the tree still renders, so replacing it would
 * throw away a working window to report a failure it survived.
 */
export function LooseErrorBanner(): JSX.Element | null {
  const [latest, setLatest] = useState<LooseError | null>(null);
  useEffect(() => {
    report = (error) => setLatest(error);
    return () => {
      report = undefined;
    };
  }, []);
  if (latest === null) return null;
  return (
    <div className="crash-banner" role="alert">
      <span className="grow ellip" title={latest.text}>
        Something failed in the interface: {latest.text.split("\n")[0]}
      </span>
      <button onClick={() => void navigator.clipboard?.writeText(latest.text)}>Copy</button>
      <button onClick={() => setLatest(null)}>Dismiss</button>
    </div>
  );
}
