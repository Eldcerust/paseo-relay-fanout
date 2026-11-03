import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FanoutScreen } from "./client/FanoutScreen";
import { FANOUT_SCREEN_ID, FanoutSidebarItem } from "./client/SidebarItem";

const TITLE = "Relay Fan-out";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: FANOUT_SCREEN_ID, title: TITLE, Component: FanoutScreen });
  client.addSidebarHeaderItem({ id: FANOUT_SCREEN_ID, title: TITLE, Component: FanoutSidebarItem });
  client.addCommandCenterItem({
    id: "open-relay-fanout",
    title: "Open Relay Fan-out",
    icon: "Waypoints",
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: FANOUT_SCREEN_ID });
    },
  });
  return () => {};
}
