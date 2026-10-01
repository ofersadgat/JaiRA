/**
 * The connection to the machine went away (`Shell.tsx`), said across the top of the window until the
 * bridge is welcomed again: it tries by itself, with growing waits (`bridges/engineBridge.ts`).
 * A file of its own, without the stylesheet `Shell.tsx` brings, so its specimen can import it beside
 * its universal copy (`packages/universal/src/components/floats/Disconnected.tsx`).
 */
export function DisconnectedBanner({ lost }: { lost: string }) {
  return <div style={BANNER}>Disconnected: {lost}. Reconnecting…</div>;
}

const BANNER = { position: "fixed", inset: "0 0 auto 0", zIndex: 1000, padding: "6px 12px", background: "var(--fill-accent, #2563c7)", color: "#fff", font: "12px var(--font-app)" } as const;
