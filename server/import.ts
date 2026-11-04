import { parseConfig, type FanoutConfig } from "./config";

/**
 * A config with at most 8 relays is a couple of kilobytes. Anything far larger is not a config,
 * and parsing it would only tie up the daemon, so it is refused before JSON.parse runs.
 */
export const MAX_IMPORT_BYTES = 256 * 1024;

/**
 * Read a config pasted from a `.json` file. Anything wrong with the text is reported with the field
 * that is wrong, because this is the only thing an import can tell the person who pasted it.
 */
export function parseImportedConfig(text: string): FanoutConfig {
  if (text.trim() === "") {
    throw new Error("Paste the contents of a relay-fanout .json file first.");
  }

  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) {
    throw new Error(
      `That file is larger than ${MAX_IMPORT_BYTES / 1024} KB. A relay-fanout config is a few kilobytes, so this is probably not one.`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`That is not valid JSON: ${(error as Error).message}`);
  }

  // parseConfig names the field, what it expected and what it found.
  return parseConfig(json);
}

export interface ConfigSummary {
  relays: Array<{ name: string; endpoint: string; useTls: boolean }>;
  preference: { mode: "auto" | "preferred"; preferred: string | null };
  listen: { host: string; port: number };
}

/** What the screen shows before a file replaces anything, so an import is never blind. */
export function describeConfig(config: FanoutConfig): ConfigSummary {
  return {
    relays: config.upstreams.map(({ name, endpoint, useTls }) => ({ name, endpoint, useTls })),
    preference: { ...config.preference },
    listen: { ...config.listen },
  };
}

/**
 * True when the file would move the proxy. The listen address is fixed once the plugin has bound
 * its port, so the new one only takes effect on the next plugin start.
 */
export function needsRestart(
  running: { host: string; port: number },
  next: { host: string; port: number },
): boolean {
  return running.host !== next.host || running.port !== next.port;
}
