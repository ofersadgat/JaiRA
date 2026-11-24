import { useState, type JSX } from "react";
import { View } from "@tamagui/core";
import type { PathWrite } from "@jaira/shared/browser";
import { mappingWriteOf, pickerGroupsOf, toggledResources, toolMappingGroupsOf, type MappedResource, type ToolMappingRow } from "@jaira/ui/toolMappingModel";
import { Press, Txt } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { Icon, type IconName } from "../panel/Icon";
import { SettingsSection } from "./SettingsPage";

/**
 * Settings → Tools → Tool mapping (decision 0034): which resource permissions each tool touches — what
 * the permission board groups tools by. Right after Permission sets, so what a set answers and what a
 * tool touches are read in one place. Layered like the rest of the page: a row the page's layer states
 * is marked, and Reset takes the layer's word away. The rows are `toolMappingModel.ts`'s.
 *
 * How it looks:
 *
 *   a group's head   app 9.5/600 upper, --tok-hint, padding 10 0 4
 *   a row            row, centred, gap 10, min height 34, a --panel-2 line under it
 *   the tool         data 11.5/500, 190 wide
 *   a resource chip  app 10.5/600 in its resource's colour, at 8% over --panel, at 30% around, radius 6,
 *                    padding 2 7, its access's icon 11; × takes it off
 *   + resource       app 10.5/500 --accent, a dashed --accent at 40% around, radius 6
 *   the picker       under the row: each resource's accesses as chips, the held ones filled
 *   its word         app 10 --tok-hint (built in) or --accent (changed here) at the right end, and Reset
 */

const RESOURCE_HUE: Readonly<Record<string, string>> = { files: "ws-read", commands: "p3", sites: "p1", repositories: "p2", programs: "ws-run", services: "p2", packages: "warn", machine: "p0", workflows: "ws-tool", skills: "p3", artifacts: "ws-tool" };

export function ToolMappingSection({ effective, layerDoc, locked, onWrite }: { effective: unknown; layerDoc: unknown; locked: boolean; onWrite: (writes: PathWrite[]) => void }): JSX.Element {
  const t = useTokens();
  const groups = toolMappingGroupsOf(effective, layerDoc);
  const [picking, setPicking] = useState<string | undefined>(undefined);
  const untouched = groups.flatMap((group) => group.rows).filter((row) => row.resources.length === 0).map((row) => row.tool);
  return (
    <SettingsSection
      id="tool-mapping"
      title="Tool mapping"
      info="Which resources each tool touches. The permission board groups tools by these, and answering a resource answers every tool on it. A tool that touches several resources is allowed only where all of them allow."
      wide
    >
      {untouched.length > 0 ? (
        <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={6} paddingVertical={8} paddingHorizontal={10} marginBottom={6} borderRadius={9} borderWidth={1} borderStyle="dashed" borderColor={t.tint("ws-tool", 45) as never} backgroundColor={t.mix(t.v("ws-tool"), 5, t.v("panel")) as never}>
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, weight: 600 }}>
            {untouched.length} tool{untouched.length === 1 ? " touches" : "s touch"} no resource
          </Txt>
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }}>the board shows them as themselves, under Other.</Txt>
        </View>
      ) : null}
      {groups.map((group) => (
        <View key={group.label} flexDirection="column">
          <Txt spec={{ voice: "app", scale: 9.5 / 12.5, weight: 600, upper: true, ls: 0.06, color: "tok-hint" }} paddingTop={10} paddingBottom={4}>
            {group.label}
          </Txt>
          {group.rows.map((row) => (
            <MappingRow key={row.tool} t={t} row={row} locked={locked} picking={picking === row.tool} onPick={() => setPicking((was) => (was === row.tool ? undefined : row.tool))} onWrite={onWrite} />
          ))}
        </View>
      ))}
    </SettingsSection>
  );
}

function ResourceChip({ t, resource, on = true, onPress, removable = false }: { t: Tokens; resource: MappedResource; on?: boolean; onPress?: () => void; removable?: boolean }): JSX.Element {
  const hue = String(t.v(RESOURCE_HUE[resource.resource] ?? "dim"));
  return (
    <Press
      onPress={onPress}
      disabled={onPress === undefined}
      label={removable ? `take ${resource.label} off` : resource.label}
      grow={false}
      box={({ hovered }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingVertical: 2,
        paddingHorizontal: 7,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: t.mix(hue, on ? 40 : 22, "transparent"),
        backgroundColor: on ? t.mix(hue, hovered ? 16 : 10, t.v("panel")) : hovered ? t.v("panel-2") : t.v("panel"),
      })}
    >
      <Icon name={resource.icon as IconName} size={11} color={on ? hue : String(t.v("tok-hint"))} />
      <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 600, color: on ? hue : "dim" }}>{resource.label}</Txt>
      {removable ? <Icon name="cross" size={9} color={String(t.v("tok-hint"))} /> : null}
    </Press>
  );
}

function MappingRow({ t, row, locked, picking, onPick, onWrite }: { t: Tokens; row: ToolMappingRow; locked: boolean; picking: boolean; onPick: () => void; onWrite: (writes: PathWrite[]) => void }): JSX.Element {
  const set = (name: string): void => onWrite([mappingWriteOf(row.tool, toggledResources(row, name))]);
  return (
    <View flexDirection="column" borderBottomWidth={1} borderBottomColor={t.v("panel-2") as never}>
      <View flexDirection="row" alignItems="center" gap={10} minHeight={34} paddingVertical={4}>
        <Txt spec={{ voice: "data", scale: 11.5 / 12, weight: 500 }} width={190} flexShrink={0} ellip>
          {row.tool}
        </Txt>
        <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={5} flex={1} minWidth={0}>
          {row.resources.length === 0 ? (
            <Txt spec={{ voice: "app", scale: 10 / 12.5, weight: 600, upper: true, ls: 0.05, color: "ws-tool" }}>no resource</Txt>
          ) : (
            row.resources.map((resource) => <ResourceChip key={resource.name} t={t} resource={resource} removable={!locked} {...(!locked ? { onPress: () => set(resource.name) } : {})} />)
          )}
          {!locked ? (
            <Press onPress={onPick} label={`map ${row.tool} to a resource`} grow={false} box={({ hovered }) => ({ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 2, paddingHorizontal: 7, borderRadius: 6, borderWidth: 1, borderStyle: "dashed", borderColor: t.tint("accent", 40), backgroundColor: hovered || picking ? t.tint("accent", 8) : "transparent" })}>
              <Icon name="plus" size={10} color={String(t.v("accent"))} />
              <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 500, color: "accent" }}>resource</Txt>
            </Press>
          ) : null}
        </View>
        <View flexDirection="row" alignItems="center" gap={8} flexShrink={0}>
          <Txt spec={{ voice: "app", scale: 10 / 12.5, color: row.stated ? "accent" : "tok-hint" }}>{row.stated ? "set here" : row.changed ? "set in a layer under this" : "built in"}</Txt>
          {row.stated && !locked ? (
            <Press onPress={() => onWrite([mappingWriteOf(row.tool, undefined)])} label={`reset ${row.tool}`} grow={false} box={({ hovered }) => ({ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: hovered ? t.tint("accent", 9) : "transparent" })}>
              <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 500, color: "accent" }}>Reset</Txt>
            </Press>
          ) : null}
        </View>
      </View>
      {picking && !locked ? (
        <View flexDirection="column" gap={6} paddingBottom={10} paddingLeft={200}>
          {pickerGroupsOf().map((group) => (
            <View key={group.resource} flexDirection="row" flexWrap="wrap" alignItems="center" gap={5}>
              <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 600, color: "dim" }} width={90}>
                {group.label}
              </Txt>
              {group.options.map((option) => (
                <ResourceChip key={option.name} t={t} resource={option} on={row.resources.some((each) => each.name === option.name)} onPress={() => set(option.name)} />
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
