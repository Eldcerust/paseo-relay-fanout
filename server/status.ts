import type { PluginStatus } from "../shared/status";
import type { ProxyStatus } from "./proxy";

export interface StatusMeta {
  configPath: string;
  configSource: "file" | "default";
}

/** The proxy's own status plus where its configuration came from. */
export function buildStatus(proxy: { status(): ProxyStatus }, meta: StatusMeta): PluginStatus {
  const { listening, daemonConnected, serverId, upstreams, preference, fallbackActive } = proxy.status();
  // `meta` is read here, not captured, because saving a change turns "default" into "file".
  return { listening, daemonConnected, serverId, upstreams, preference, fallbackActive, ...meta };
}

/**
 * The handler behind the status request. A relay's latency is only refreshed when the caller asks
 * for it, which only the open screen does, so an idle app never sends a request to a relay.
 */
export function createStatusHandler(
  proxy: { status(): ProxyStatus; touch(): void },
  meta: StatusMeta,
): (input: { measure?: boolean }) => PluginStatus {
  return (input) => {
    if (input.measure === true) proxy.touch();
    return buildStatus(proxy, meta);
  };
}
