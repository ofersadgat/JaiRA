/**
 * Settings → Tools → Tool mapping (decision 0034): which resource permissions each tool touches — what
 * the permission board groups tools by. A row per tool JaiRA ships (by its category), the shell's
 * `script` and runners, and any other tool a settings layer maps (an MCP tool, `mcp__<server>__<tool>`).
 * What ships is `DEFAULT_TOOL_RESOURCES`; a layer's `permissions.resources.<tool>` replaces it for that
 * tool. Nothing here draws.
 */
import { DEFAULT_TOOL_RESOURCES, RESOURCES, TOOL_CATEGORIES, TOOL_SPECS, resourceAccessOf, type PathWrite } from "@jaira/shared/browser";

export interface MappedResource {
  /** `files.read`. */
  name: string;
  /** `Files · Read`. */
  label: string;
  /** The resource's id, for its colour. */
  resource: string;
  icon: string;
}

export interface ToolMappingRow {
  tool: string;
  resources: MappedResource[];
  /** What ships for it. */
  shipped: string[];
  /** The page's layer says it. */
  stated: boolean;
  /** What it comes to differs from what ships. */
  changed: boolean;
}

export interface ToolMappingGroup {
  label: string;
  rows: ToolMappingRow[];
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** A layer document's (or the effective settings') `permissions.resources`. */
export function resourcesSettingOf(doc: unknown): Record<string, string[]> {
  const permissions = isObject(doc) ? doc["permissions"] : undefined;
  const resources = isObject(permissions) ? permissions["resources"] : undefined;
  if (!isObject(resources)) return {};
  return Object.fromEntries(Object.entries(resources).filter(([, list]) => Array.isArray(list)).map(([tool, list]) => [tool, (list as unknown[]).filter((each): each is string => typeof each === "string")]));
}

/** `files.read` as a chip says it. */
export function mappedResourceOf(name: string): MappedResource | undefined {
  const found = resourceAccessOf(name);
  return found === undefined ? undefined : { name, label: `${found.resource.label} · ${found.access.label}`, resource: found.resource.id, icon: found.access.icon };
}

/** Every resource permission, by resource, for the picker. */
export function pickerGroupsOf(): Array<{ resource: string; label: string; options: MappedResource[] }> {
  return RESOURCES.map((resource) => ({ resource: resource.id, label: resource.label, options: resource.accesses.map((access) => mappedResourceOf(`${resource.id}.${access.id}`)!) }));
}

/** The page's rows: what each tool comes to, and whether the page's layer says it. */
export function toolMappingGroupsOf(effective: unknown, layerDoc: unknown): ToolMappingGroup[] {
  const settled = resourcesSettingOf(effective);
  const stated = resourcesSettingOf(layerDoc);
  const rowOf = (tool: string): ToolMappingRow => {
    const shipped = [...(DEFAULT_TOOL_RESOURCES[tool] ?? [])];
    const now = Object.hasOwn(settled, tool) ? settled[tool]! : shipped;
    const resources = now.map(mappedResourceOf).filter((each): each is MappedResource => each !== undefined);
    const changed = now.length !== shipped.length || now.some((name) => !shipped.includes(name));
    return { tool, resources, shipped, stated: Object.hasOwn(stated, tool), changed };
  };
  const groups: ToolMappingGroup[] = TOOL_CATEGORIES.map((category) => ({ label: category.label, rows: TOOL_SPECS.filter((spec) => spec.category === category.id).map((spec) => rowOf(spec.name)) })).filter((group) => group.rows.length > 0);
  const execution = groups.find((group) => TOOL_CATEGORIES.find((category) => category.label === group.label)?.id === "execution");
  for (const tool of ["script", "runner:*", "command:*"]) (execution ?? groups[0]!).rows.push(rowOf(tool));
  const known = new Set(groups.flatMap((group) => group.rows.map((row) => row.tool)));
  const others = Object.keys(settled).filter((tool) => !known.has(tool)).sort();
  if (others.length > 0) groups.push({ label: "Other tools", rows: others.map(rowOf) });
  return groups;
}

/** A tool's list with one resource permission put in or taken out. */
export function toggledResources(row: Pick<ToolMappingRow, "resources">, name: string): string[] {
  const now = row.resources.map((each) => each.name);
  return now.includes(name) ? now.filter((each) => each !== name) : [...now, name];
}

/** The write that keeps a tool's list in the page's layer — or, `undefined`, takes the layer's word away. */
export function mappingWriteOf(tool: string, next: readonly string[] | undefined): PathWrite {
  return [["permissions", "resources", tool], next === undefined ? undefined : [...next]];
}
