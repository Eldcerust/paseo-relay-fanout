import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { serializeConfig, type FanoutConfig } from "./config";

/** Exports go in their own folder beside the config, so they never pass for the config itself. */
export const EXPORT_DIR = "exports";

/** A filename every platform accepts: an ISO stamp with the colons Windows refuses taken out. */
export function exportFilename(at: Date): string {
  const stamp = at.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  return `relay-fanout-config-${stamp}.json`;
}

export interface ExportInput {
  /** The config that is running now, not the one that was loaded at startup. */
  config: FanoutConfig;
  /** The config file the plugin reads; the export lands in `exports/` beside it. */
  configPath: string;
  /** Only the tests pass one; the plugin takes the current time. */
  at?: Date;
}

export interface ExportedConfig {
  path: string;
  filename: string;
  /** The same text the file holds, so a screen can offer a copy where files are awkward. */
  json: string;
}

/**
 * Write the running config as a `.json` file. The text is byte for byte what the plugin would save
 * as its own config, so an export can be put in place as `config.json` and reads back unchanged.
 */
export function exportConfig({ config, configPath, at }: ExportInput): ExportedConfig {
  const directory = path.join(path.dirname(configPath), EXPORT_DIR);
  mkdirSync(directory, { recursive: true });

  const json = serializeConfig(config);
  const target = unusedPath(directory, exportFilename(at ?? new Date()));
  writeFileSync(target, json, "utf8");

  return { path: target, filename: path.basename(target), json };
}

/** Never overwrite an earlier export: a second export in the same second gets `-2`, then `-3`. */
function unusedPath(directory: string, filename: string): string {
  const first = path.join(directory, filename);
  if (!existsSync(first)) return first;

  const stem = filename.replace(/\.json$/, "");
  for (let copy = 2; ; copy += 1) {
    const candidate = path.join(directory, `${stem}-${copy}.json`);
    if (!existsSync(candidate)) return candidate;
  }
}
