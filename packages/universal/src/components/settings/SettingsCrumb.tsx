import { useState, type JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import { useMachines } from "@jaira/ui/machinesModel";
import { addOptionsOf, crumbsOf, trimmedTo, withoutPart, withPart, type SettingsPart, type SettingsPathContext } from "@jaira/ui/settingsScope";
import type { MenuItem } from "@jaira/ui/menuTypes";
import { useShell } from "../../app/shell";
import { useCanHover } from "../../canHover";
import { NO_DRAG, Press, Txt, useHover } from "../../primitives";
import { useTokens } from "../../tokens";
import { ContextMenu, type MenuAt } from "../Menu";
import { Icon } from "../panel/Icon";

/**
 * Settings' path, beside its name in the settings sheet's head (the person's design, 2026-11-17):
 *
 *   Settings › atlas › build-01 › Just you › +
 *
 * Whose settings the pages edit — a project, a machine, Just you, each left out meaning "all", always in
 * that order (`settingsScope.ts`). "Settings" itself is pressable while the path has a part, and goes
 * back to Shared; a crumb pressed keeps the path up to it; its × (on hover, or always on a touch screen)
 * takes just it out. `+` is a menu of what can be added next. How it looks:
 *
 *   the row          one line, centred, gap 2, NO_DRAG (it sits in the window's drag handle): where it is
 *                    short of room the crumbs' names shorten, with an ellipsis, and `+` stays — a path
 *                    that wrapped put `+` on a second line, under the head's height or off it
 *   "Settings"       the app-title register; with a path, a ghost press (radius 6, padding 0 4)
 *   ›                app 1×, --faint
 *   a crumb          data 11.5/12.5 600 --text, radius 6, padding 0 6, height 24, hovered
 *                    --fill-ghost-hover; a paired machine's dot (6, --ok online, else --warn) before it
 *   its ×            the cross icon 10, --dim, 16 square, there only while the crumb is under the pointer
 *                    (always on a touch screen): no room is kept for it, which a narrow sheet needs
 *   +                data 13/12.5 600 --dim, 22 square, radius 6, hovered --fill-ghost-hover
 */
export function SettingsCrumb({ label }: { label: string }): JSX.Element {
  const t = useTokens();
  const { state, actions } = useShell();
  const [machines] = useMachines();
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const path = state.settingsPath;
  const ctx: SettingsPathContext = {
    projects: state.projects,
    grouped: state.settings.ui.groupWorkspaces !== false,
    self: machines !== undefined ? { id: machines.self.id, label: machines.self.label } : undefined,
    machines: (machines?.machines ?? []).map((m) => ({ id: m.id, label: m.label, state: m.state })),
  };
  const crumbs = crumbsOf(path, ctx);
  const options = addOptionsOf(path, ctx);
  const go = actions.setSettingsPath;
  const anchor = (e: unknown): { x: number; y: number } => {
    const box = isWeb ? (e as { currentTarget: HTMLElement }).currentTarget.getBoundingClientRect() : undefined;
    const touch = (e as { nativeEvent?: { pageX?: number; pageY?: number } }).nativeEvent;
    return { x: box?.left ?? touch?.pageX ?? 0, y: box !== undefined ? box.bottom + 4 : (touch?.pageY ?? 0) };
  };
  const openAdd = (e: unknown): void => {
    const items: MenuItem[] = [];
    let kind: SettingsPart["kind"] | undefined;
    for (const option of options) {
      const separator = kind !== undefined && kind !== option.kind;
      kind = option.kind;
      items.push({
        label: option.label,
        ...(separator ? { separator: true } : {}),
        ...(option.kind === "project" && option.where !== undefined ? { note: option.where } : {}),
        ...(option.kind === "machine" ? { note: option.self ? "this machine" : option.state === undefined || option.state === "online" ? "paired" : `paired · ${option.state}` } : {}),
        ...(option.kind === "you" ? { note: "your own settings, on every machine of yours" } : {}),
        onSelect: () => go(withPart(path, option)),
      });
    }
    setMenu({ ...anchor(e), title: "Narrow to", items });
  };
  const sep = (
    <Txt spec={{ voice: "app", scale: 1, color: "faint" }} flexShrink={0}>
      ›
    </Txt>
  );
  return (
    <View flex={1} minWidth={0} flexDirection="row" flexWrap="nowrap" alignItems="center" gap={2} style={NO_DRAG as never} role="navigation" aria-label="Whose settings">
      {crumbs.length === 0 ? (
        <Txt register="app-title" ellip flexShrink={1} minWidth={0}>
          {label}
        </Txt>
      ) : (
        <Press
          onPress={() => go(trimmedTo(path, null))}
          label={`${label}: Shared, every project and machine`}
          title="Shared: every project, every machine, everyone"
          borderRadius={6}
          paddingHorizontal={4}
          flexShrink={0}
          box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
        >
          <Txt register="app-title">{label}</Txt>
        </Press>
      )}
      {crumbs.map((crumb) => (
        <View key={crumb.kind} flexDirection="row" alignItems="center" gap={2} minWidth={0} flexShrink={1}>
          {sep}
          <Crumb crumb={crumb} onPress={() => go(trimmedTo(path, crumb.kind))} onRemove={() => go(withoutPart(path, crumb.kind))} />
        </View>
      ))}
      {options.length > 0 ? (
        <View flexDirection="row" alignItems="center" gap={2} flexShrink={0}>
          {sep}
          <Press
            onPress={openAdd}
            label="Narrow these settings"
            title="Add a project, a machine or Just you"
            {...({ "aria-haspopup": "menu" } as object)}
            width={22}
            height={22}
            alignItems="center"
            justifyContent="center"
            borderRadius={6}
            box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
          >
            <Txt spec={{ voice: "data", scale: 13 / 12.5, weight: 600, color: "dim" }}>+</Txt>
          </Press>
        </View>
      ) : null}
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </View>
  );
}

/** One crumb: its name (a press keeps the path up to it) and, on hover, its ×. */
function Crumb({ crumb, onPress, onRemove }: { crumb: SettingsPart; onPress: () => void; onRemove: () => void }): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  const canHover = useCanHover();
  const peer = crumb.kind === "machine" && !crumb.self;
  const title =
    crumb.kind === "project"
      ? `${crumb.label}: its own settings`
      : crumb.kind === "machine"
        ? `${crumb.label}${crumb.self ? " (this machine)" : crumb.state !== undefined && crumb.state !== "online" ? ` · ${crumb.state}` : ""}: its own settings, kept on it`
        : "Just you: your own settings, on every machine of yours";
  return (
    <View flexDirection="row" alignItems="center" minWidth={0} flexShrink={1} {...hover}>
      <Press
        onPress={onPress}
        label={crumb.label}
        title={title}
        flexDirection="row"
        alignItems="center"
        gap={5}
        height={24}
        paddingHorizontal={6}
        borderRadius={6}
        minWidth={0}
        flexShrink={1}
        box={({ hovered: on }) => ({ backgroundColor: on ? t.v("fill-ghost-hover") : "transparent" })}
      >
        {peer ? <View width={6} height={6} borderRadius={999} flexShrink={0} backgroundColor={t.v(crumb.state === undefined || crumb.state === "online" ? "ok" : "warn") as never} /> : null}
        <Txt spec={{ voice: "data", scale: 11.5 / 12.5, weight: 600, color: "text" }} ellip minWidth={0} flexShrink={1}>
          {crumb.label}
        </Txt>
      </Press>
      {hovered || !canHover ? (
        <Press onPress={onRemove} label={`Take ${crumb.label} out`} title={`take ${crumb.label} out: all ${crumb.kind === "project" ? "projects" : crumb.kind === "machine" ? "machines" : "people"}`} width={16} height={16} flexShrink={0} alignItems="center" justifyContent="center" borderRadius={4} box={({ hovered: on }) => ({ backgroundColor: on ? t.v("fill-ghost-hover") : "transparent" })}>
          <Icon name="cross" size={10} color={String(t.v("dim"))} />
        </Press>
      ) : null}
    </View>
  );
}
