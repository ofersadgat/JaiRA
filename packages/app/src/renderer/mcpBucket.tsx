/**
 * A permission set's MCP bucket — one group per configured MCP server, drawn as Execution draws a
 * program (decision 0007 §5; the units doc `mcp-servers`).
 *
 * A group is a fold, the server's name, a sentence, a count and the group's own mode button, which is
 * the server's line (`mcp__figma`): the mode for any tool of it no line names. Open, it is one line per
 * named tool with its own mode, then a line that names another from the list the server answered the
 * tools probe with. A tool named from that list starts at what the server says of it — read-only is
 * allowed, destructive refused — and otherwise at what it answered to before (`mcpBucketModel.ts`).
 *
 * The rows are the permission set card's own: `cx-cat cx-sub` for a group, `cx-tool set-held` with the
 * red minus for a line, the mode menu, the add line. A render function with no opinion about its place:
 * the card draws it where its MCP section goes.
 */
import type { JSX } from "react";
import { mcpToolLines, mcpToolSubject, MODE_WHEN_UNSET, type McpServerStatus, type PermissionSet, type ToolCategory } from "@jaira/shared/browser";
import { Icon } from "./icons";
import {
  holdsMcpServer,
  mcpAddLabel,
  mcpGroupHint,
  mcpGroupModeOf,
  mcpGroupsOf,
  mcpLineCount,
  mcpToolHint,
  unnamedMcpTools,
  withMcpServerMode,
  withMcpTool,
  withoutMcpServer,
  type McpGroup,
} from "./mcpBucketModel";
import { withSubjectMode, withoutSubject } from "./composerPermissionSet";
import { AddMenu, CategoryRow, ModePicker, RemoveLine, modeMeta } from "./permissionSetRows";

/** The key a server's fold is kept under, beside the section ids and the programs'. */
export const mcpServerFold = (server: string): string => `mcp:${server}`;

export interface McpBucketProps {
  category: ToolCategory;
  permissionSet: PermissionSet;
  /** The configured servers as the tools probe last found them. Absent ⇒ not asked yet. */
  servers: readonly McpServerStatus[] | undefined;
  locked: boolean;
  write: (next: PermissionSet) => void;
  open: ReadonlySet<string>;
  toggle: (id: string, to?: boolean) => void;
  startAdding?: string | undefined;
}

/** The MCP section of a permission set card: its groups, or the plain "nothing here" when there are none. */
export function McpBucket({ category, permissionSet, servers, locked, write, open, toggle, startAdding }: McpBucketProps): JSX.Element | null {
  const groups = mcpGroupsOf(permissionSet, servers);
  if (groups.length === 0) {
    if (locked) return null;
    return (
      <div className="cx-cat cx-cat-empty">
        <div className="cx-cat-head">
          <span className="cx-opt-text">
            <span className="cx-opt-name ellip">{category.label}</span>
            <span className="cx-opt-hint ellip">nothing here — add a server in Settings → Connections</span>
          </span>
        </div>
      </div>
    );
  }
  return (
    <CategoryRow category={category} granted={mcpLineCount(permissionSet)} total={groups.length} mode={undefined} open={open.has(category.id)} onOpen={() => toggle(category.id)}>
      {groups.map((group) => (
        <McpServerGroup
          key={group.server}
          group={group}
          permissionSet={permissionSet}
          locked={locked}
          write={write}
          open={open.has(mcpServerFold(group.server))}
          onOpen={() => toggle(mcpServerFold(group.server))}
          startAdding={startAdding === mcpServerFold(group.server)}
        />
      ))}
    </CategoryRow>
  );
}

function McpServerGroup({
  group,
  permissionSet,
  locked,
  write,
  open,
  onOpen,
  startAdding,
}: {
  group: McpGroup;
  permissionSet: PermissionSet;
  locked: boolean;
  write: (next: PermissionSet) => void;
  open: boolean;
  onOpen: () => void;
  startAdding: boolean;
}): JSX.Element {
  const lines = mcpToolLines(permissionSet, group.server);
  const held = holdsMcpServer(permissionSet, group.server) || lines.length > 0;
  const listed = new Map((group.status?.tools ?? []).map((tool) => [tool.name, tool]));
  const unnamed = unnamedMcpTools(permissionSet, group);
  return (
    <div className={`cx-cat cx-sub mcp-group${open ? " open" : ""}`}>
      <div className="cx-cat-head">
        {!locked && held ? <RemoveLine subject={group.server} onRemove={() => write(withoutMcpServer(permissionSet, group.server))} /> : null}
        <button type="button" className="cx-cat-fold" aria-expanded={open} onClick={onOpen}>
          <span className="cx-more cx-cat-chev">›</span>
          <span className="cx-chip-icon">
            <Icon name="model" />
          </span>
          <span className="cx-opt-text">
            <span className="cx-opt-name ellip">
              <span className="mono">{group.server}</span>
            </span>
            <span className="cx-opt-hint ellip">{mcpGroupHint(permissionSet, group, open)}</span>
          </span>
          {lines.length > 0 ? <span className="cx-cat-count">{lines.length}</span> : null}
        </button>
        <ModePicker
          mode={mcpGroupModeOf(permissionSet, group.server)}
          title={`${group.server}: any ${group.server} tool not named under it`}
          onMode={(next) => write(withMcpServerMode(permissionSet, group.server, next))}
          readOnly={locked}
        />
      </div>
      {open ? (
        <div className="cx-cat-body">
          {lines.map((line) => {
            const mode = line.mode ?? MODE_WHEN_UNSET;
            const hint = mcpToolHint(listed.get(line.tool));
            return (
              <div key={line.subject} className={`cx-tool on${locked ? "" : " set-held"}`}>
                {locked ? null : <RemoveLine subject={line.tool} onRemove={() => write(withoutSubject(permissionSet, line.subject))} />}
                <span className="cx-tool-grant" title={hint}>
                  <span className="cx-chip-icon">
                    <Icon name="tool" />
                  </span>
                  <span className="cx-opt-text">
                    <span className="cx-opt-name ellip">
                      <span className="mono">{line.tool}</span>
                    </span>
                    <span className="cx-opt-hint ellip">{hint}</span>
                  </span>
                </span>
                <ModePicker mode={mode} title={`${line.tool}: ${modeMeta(mode).hint}`} onMode={(next) => write(withSubjectMode(permissionSet, line.subject, next))} readOnly={locked} />
              </div>
            );
          })}
          {locked ? null : (
            <AddMenu
              label={mcpAddLabel(group.server, unnamed)}
              startOpen={startAdding}
              options={unnamed.map((tool) => ({ subject: mcpToolSubject(group.server, tool.name), label: tool.name, hint: mcpToolHint(tool), icon: "tool" as const, mono: true }))}
              onPick={(subject) => {
                const tool = unnamed.find((one) => mcpToolSubject(group.server, one.name) === subject);
                if (tool !== undefined) write(withMcpTool(permissionSet, group.server, tool));
              }}
              typed={{
                label: `name a ${group.server} tool`,
                example: unnamed[0]?.name ?? "get_code",
                onAdd: (typed) => {
                  const name = typed.trim();
                  if (name.length === 0 || /\s/.test(name)) return `a tool's name is one word, as the server lists it`;
                  const tool = listed.get(name);
                  write(withMcpTool(permissionSet, group.server, tool ?? name));
                  return undefined;
                },
              }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
