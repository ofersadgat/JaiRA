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
import { useCallback, useEffect, useRef, useState } from "react";
import type { McpDetectedSource, McpToolsReport, SecretTarget } from "@jaira/shared/browser";
import { invoke, syncCache } from "./store";
import { useView } from "./useView";

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
 * The MCP data while `active`: views of the window's cache (decision 0018, group 7), read again as the
 * change log says the configuration moved — and when `stamp` changes (the configuration object a page
 * is editing: a save, a layer switch, another project).
 */
export function useMcpData(active: boolean, stamp: unknown): McpData {
  const tools = useView("mcp:tools", active ? undefined : null);
  const detected = useView("mcp:detect", active ? undefined : null).value;
  const report: McpToolsReport | undefined = tools.value;
  const [rechecking, setRechecking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const problem = failed ?? tools.error ?? null;

  const first = useRef(true);
  useEffect(() => {
    if (first.current || !active) return void (first.current = false);
    void syncCache().refresh("mcp:tools", undefined);
    void syncCache().refresh("mcp:detect", undefined);
  }, [active, stamp]);

  const recheck = useCallback((): void => {
    setRechecking(true);
    setFailed(null);
    void invoke("mcp:tools", { recheck: true })
      .then(
        () => syncCache().refresh("mcp:tools", undefined),
        (e: unknown) => setFailed(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setRechecking(false));
    void syncCache().refresh("mcp:detect", undefined);
  }, []);

  const storeSecret = useCallback(
    async (request: { name: string; value: string; target: SecretTarget }): Promise<void> => {
      setFailed(null);
      try {
        await invoke("secret:set", request);
      } catch (e) {
        setFailed(e instanceof Error ? e.message : String(e));
        return;
      }
      recheck();
    },
    [recheck],
  );

  return { report, detected, rechecking, recheck, storeSecret, problem };
}
