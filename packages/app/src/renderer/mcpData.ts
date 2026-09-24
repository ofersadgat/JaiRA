/**
 * What Settings knows about MCP servers, asked of main — the configured servers' state and tools
 * (`mcp:tools`), and what other tools on this machine already run (`mcp:detect`).
 *
 * One hook for the two pages that draw it: Connections (the servers, and the panel that adds them) and
 * Tools (a permission set's MCP bucket, which names a server's tools from the list it answered with).
 * Asked when either page is open and whenever the configuration changes — main answers from its cache
 * unless the servers' block changed, because the tools probe STARTS the servers — and again on Re-check,
 * which asks main to start them over.
 *
 * A secret's VALUE goes straight to main (`secret:set`) and is never held here; storing one re-checks,
 * since a server that was waiting for it may start now.
 */
import { useCallback, useEffect, useState } from "react";
import type { McpDetectedSource, McpToolsReport, SecretTarget } from "@jaira/shared/browser";
import { invoke } from "./store";

export interface McpData {
  /** The configured servers, as last asked. Absent until the first answer. */
  report: McpToolsReport | undefined;
  /** What other tools on this machine list. Absent until the first answer. */
  detected: McpDetectedSource[] | undefined;
  rechecking: boolean;
  /** Start every configured server again and list its tools. */
  recheck: () => void;
  /** Store a secret's value in the chosen store, then re-check. */
  storeSecret: (request: { name: string; value: string; target: SecretTarget }) => Promise<void>;
  /** What the last ask or store was refused with. */
  problem: string | null;
}

/**
 * The MCP data, asked for while `active`, and again whenever `stamp` changes (the configuration
 * object — a save, a layer switch, another project).
 */
export function useMcpData(active: boolean, stamp: unknown): McpData {
  const [report, setReport] = useState<McpToolsReport | undefined>(undefined);
  const [detected, setDetected] = useState<McpDetectedSource[] | undefined>(undefined);
  const [rechecking, setRechecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let live = true;
    void invoke("mcp:tools", undefined).then(
      (next) => live && setReport(next),
      (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)),
    );
    void invoke("mcp:detect", undefined).then(
      (next) => live && setDetected(next),
      () => live && setDetected(undefined),
    );
    return () => {
      live = false;
    };
  }, [active, stamp]);

  const recheck = useCallback((): void => {
    setRechecking(true);
    setProblem(null);
    void invoke("mcp:tools", { recheck: true })
      .then(setReport, (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
      .finally(() => setRechecking(false));
    void invoke("mcp:detect", undefined).then(setDetected, () => setDetected(undefined));
  }, []);

  const storeSecret = useCallback(
    async (request: { name: string; value: string; target: SecretTarget }): Promise<void> => {
      setProblem(null);
      try {
        await invoke("secret:set", request);
      } catch (e) {
        setProblem(e instanceof Error ? e.message : String(e));
        return;
      }
      recheck();
    },
    [recheck],
  );

  return { report, detected, rechecking, recheck, storeSecret, problem };
}
