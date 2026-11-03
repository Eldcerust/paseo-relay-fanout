import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createActions } from "./server/actions";
import { loadConfig, resolvePaseoHome, saveConfig, type FanoutConfig } from "./server/config";
import { exportConfig } from "./server/export";
import { buildPairingLinks } from "./server/pairing";
import { FanoutProxy, type Logger } from "./server/proxy";
import { createStatusHandler, type StatusMeta } from "./server/status";
import {
  addRelayRpc,
  editRelayRpc,
  exportConfigRpc,
  importConfigRpc,
  pairingRpc,
  preferenceRpc,
  removeRelayRpc,
  statusRpc,
} from "./shared/status";

const logger: Logger = {
  info: (message, fields) => console.log(format(message, fields)),
  warn: (message, fields) => console.error(format(message, fields)),
};

function format(message: string, fields?: Record<string, unknown>): string {
  const details = fields
    ? Object.entries(fields)
        .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join(" ")
    : "";
  return details ? `[relay-fanout] ${message} ${details}` : `[relay-fanout] ${message}`;
}

// Paseo needs the cleanup function back synchronously, but binding a port is asynchronous.
// A bad config therefore throws from here (the plugin shows as failed with the reason), and a
// port that cannot be bound ends the plugin process, so a dead proxy never looks healthy while
// the daemon is left with no relay path.
export default function contribute(server: PluginServerContext) {
  const loaded = loadConfig();
  logger.info(loaded.source === "file" ? "config loaded" : "no config file, using defaults", { path: loaded.path });

  // The relay list and the preference can change while running, so the handlers read the latest.
  let current: FanoutConfig = loaded.config;
  const meta: StatusMeta = { configPath: loaded.path, configSource: loaded.source };
  // The proxy keeps the address it started on: an import can change the file's listen, not this.
  const runningListen = { ...current.listen };

  const proxy = new FanoutProxy({
    host: current.listen.host,
    port: current.listen.port,
    upstreams: current.upstreams,
    preference: current.preference,
    logger,
  });

  const actions = createActions({
    config: () => current,
    runningListen: () => runningListen,
    commit: (next) => {
      // Save first: if the disk refuses, nothing running has changed.
      saveConfig(loaded.path, next);
      current = next;
      meta.configSource = "file";
      proxy.applyConfig({ upstreams: next.upstreams, preference: next.preference });
      logger.info("config changed", {
        relays: next.upstreams.map((upstream) => upstream.name),
        preference: next.preference.mode === "preferred" ? `prefer ${next.preference.preferred}` : "auto",
      });
    },
  });

  server.handle(statusRpc, createStatusHandler(proxy, meta));
  server.handle(preferenceRpc, (input) => actions.setPreference(input));
  server.handle(addRelayRpc, (input) => actions.addRelay(input));
  server.handle(removeRelayRpc, (input) => actions.removeRelay(input));
  server.handle(editRelayRpc, (input) => actions.editRelay(input));
  // An export is a copy of what is running now, so it is taken from `current`, not from `loaded`.
  server.handle(exportConfigRpc, () => {
    try {
      const exported = exportConfig({ config: current, configPath: loaded.path });
      logger.info("config exported", { path: exported.path });
      return { ok: true as const, ...exported };
    } catch (error) {
      return { ok: false as const, error: `Could not write the export: ${(error as Error).message}` };
    }
  });
  server.handle(importConfigRpc, (input) => {
    const result = actions.importConfig(input);
    if (result.ok && result.applied) {
      logger.info("config imported", {
        relays: result.summary.relays.map((relay) => relay.name),
        restartRequired: result.restartRequired,
      });
    }
    return result;
  });
  server.handle(pairingRpc, () =>
    buildPairingLinks({
      home: resolvePaseoHome(),
      upstreams: current.upstreams,
      liveServerId: proxy.status().serverId,
    }),
  );

  proxy.start().then(
    () => {
      logger.info("proxy listening", {
        address: `${current.listen.host}:${proxy.port}`,
        upstreams: current.upstreams.map((upstream) => `${upstream.name}=${upstream.endpoint}`),
        preference: current.preference.mode === "preferred" ? `prefer ${current.preference.preferred}` : "auto",
      });
    },
    (error: Error) => {
      logger.warn("proxy cannot listen, stopping the plugin; the daemon has no relay path until this is fixed", {
        address: `${current.listen.host}:${current.listen.port}`,
        error: error.message,
      });
      // Let the log line flush before the process goes away.
      setTimeout(() => process.exit(1), 100);
    },
  );

  return () => proxy.stop();
}
