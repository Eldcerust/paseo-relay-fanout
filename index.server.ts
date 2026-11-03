import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadConfig, resolvePaseoHome } from "./server/config";
import { buildPairingLinks } from "./server/pairing";
import { FanoutProxy, type Logger } from "./server/proxy";
import { createStatusHandler } from "./server/status";
import { pairingRpc, statusRpc } from "./shared/status";

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
  const { config, source, path } = loadConfig();
  logger.info(source === "file" ? "config loaded" : "no config file, using defaults", { path });

  const proxy = new FanoutProxy({
    host: config.listen.host,
    port: config.listen.port,
    upstreams: config.upstreams,
    logger,
  });

  server.handle(statusRpc, createStatusHandler(proxy, { configPath: path, configSource: source }));
  server.handle(pairingRpc, () =>
    buildPairingLinks({
      home: resolvePaseoHome(),
      upstreams: config.upstreams,
      liveServerId: proxy.status().serverId,
    }),
  );

  proxy.start().then(
    () => {
      logger.info("proxy listening", {
        address: `${config.listen.host}:${proxy.port}`,
        upstreams: config.upstreams.map((upstream) => `${upstream.name}=${upstream.endpoint}`),
      });
    },
    (error: Error) => {
      logger.warn("proxy cannot listen, stopping the plugin; the daemon has no relay path until this is fixed", {
        address: `${config.listen.host}:${config.listen.port}`,
        error: error.message,
      });
      // Let the log line flush before the process goes away.
      setTimeout(() => process.exit(1), 100);
    },
  );

  return () => proxy.stop();
}
