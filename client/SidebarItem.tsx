import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { StatusDot } from "./StatusDot";
import { useFanoutStatus } from "./status-query";
import { summarize } from "./view-model";
import { toneColor } from "./visual";

export const FANOUT_SCREEN_ID = "status";

/** One sidebar row; the dot is the whole plugin's health at a glance. */
export function FanoutSidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { data, isError } = useFanoutStatus(5_000);
  const summary = summarize(data, isError, Date.now());
  return (
    <SidebarRow
      icon="Waypoints"
      active={currentScreen?.screenId === FANOUT_SCREEN_ID}
      onPress={() => openScreen({ screenId: FANOUT_SCREEN_ID })}
      trailing={<StatusDot color={toneColor(theme, summary.tone)} label={summary.title} />}
    />
  );
}
