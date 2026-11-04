import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ENDPOINT_PATTERN, MAX_RELAYS, RELAY_NAME_PATTERN } from "../shared/relay-input";
import type { Preference } from "./priority";

export const PLUGIN_ID = "relay-fanout";
export const DEFAULT_LISTEN_HOST = "127.0.0.1";
export const DEFAULT_LISTEN_PORT = 7733;
export const MAX_UPSTREAMS = MAX_RELAYS;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface Upstream {
  /** Short stable label, also used to prefix connection ids. */
  name: string;
  /** `host:port`, with IPv6 hosts in brackets. */
  endpoint: string;
  useTls: boolean;
}

export interface FanoutConfig {
  listen: { host: string; port: number };
  /** In priority order: when `preference` is "preferred", the first relay is the preferred one. */
  upstreams: Upstream[];
  /** "preferred" ranks the relays by their order; "auto" keeps every relay open and lets each device pick. */
  preference: Preference;
}

export interface LoadedConfig {
  config: FanoutConfig;
  source: "file" | "default";
  path: string;
}

const upstreamSchema = z.object({
  name: z.string().regex(RELAY_NAME_PATTERN, "use 1-24 lowercase letters, digits or dashes"),
  endpoint: z
    .string()
    .trim()
    .regex(ENDPOINT_PATTERN, "expected host:port, for example relay.paseo.sh:443"),
  useTls: z.boolean().optional(),
});

const configSchema = z.object({
  listen: z
    .object({
      host: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
    })
    .optional(),
  upstreams: z.array(upstreamSchema).min(1).max(MAX_UPSTREAMS),
  preference: z
    .object({
      mode: z.enum(["auto", "preferred"]),
      preferred: z.string().optional(),
    })
    .optional(),
});

export const DEFAULT_UPSTREAMS: Upstream[] = [
  { name: "official", endpoint: "relay.paseo.sh:443", useTls: true },
];

export function resolvePaseoHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PASEO_HOME?.trim();
  return configured || path.join(os.homedir(), ".paseo");
}

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PASEO_RELAY_FANOUT_CONFIG?.trim();
  if (override) return override;
  return path.join(resolvePaseoHome(env), "plugin-data", PLUGIN_ID, "config.json");
}

function portOf(endpoint: string): number {
  const match = ENDPOINT_PATTERN.exec(endpoint);
  return match ? Number(match[2]) : 0;
}

/** Validate untrusted JSON into a complete config. Throws with a readable message. */
export function parseConfig(raw: unknown): FanoutConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new Error(`Invalid relay-fanout config: ${problems.join("; ")}`);
  }

  const host = parsed.data.listen?.host?.trim() || DEFAULT_LISTEN_HOST;
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Invalid relay-fanout config: listen.host must be a loopback address (got "${host}"). ` +
        "The proxy has no authentication, so it must not be reachable from the network.",
    );
  }

  const seen = new Set<string>();
  const upstreams = parsed.data.upstreams.map((entry): Upstream => {
    if (seen.has(entry.name)) {
      throw new Error(`Invalid relay-fanout config: duplicate upstream name "${entry.name}"`);
    }
    seen.add(entry.name);
    return {
      name: entry.name,
      endpoint: entry.endpoint,
      useTls: entry.useTls ?? portOf(entry.endpoint) === 443,
    };
  });

  const preference = parsed.data.preference;
  let resolved: Preference = { mode: "auto", preferred: null };
  let ranked = upstreams;
  if (preference?.mode === "preferred") {
    if (!preference.preferred || !seen.has(preference.preferred)) {
      throw new Error(
        `Invalid relay-fanout config: preference.preferred must name one of the relays (${[...seen].join(", ")}), got ${JSON.stringify(preference.preferred ?? null)}`,
      );
    }
    resolved = { mode: "preferred", preferred: preference.preferred };
    // The list order is the priority, so the preferred relay is always first.
    ranked = [...upstreams.filter((upstream) => upstream.name === preference.preferred), ...upstreams.filter((upstream) => upstream.name !== preference.preferred)];
  }

  return { listen: { host, port: parsed.data.listen?.port ?? DEFAULT_LISTEN_PORT }, upstreams: ranked, preference: resolved };
}

/** The file's contents for a config. Stable key order so the file reads the same every time. */
export function serializeConfig(config: FanoutConfig): string {
  const preference =
    config.preference.mode === "preferred"
      ? { mode: "preferred", preferred: config.preference.preferred }
      : { mode: "auto" };
  return (
    JSON.stringify(
      {
        listen: { host: config.listen.host, port: config.listen.port },
        upstreams: config.upstreams.map(({ name, endpoint, useTls }) => ({ name, endpoint, useTls })),
        preference,
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Write the config next to where it is read from. Written to a temporary file and renamed into
 * place, so a crash cannot leave a half-written file that stops the plugin from loading.
 */
export function saveConfig(configPath: string, config: FanoutConfig): void {
  mkdirSync(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.tmp-${process.pid}`;
  writeFileSync(temporary, serializeConfig(config), "utf8");
  renameSync(temporary, configPath);
}

/** Read the config file; a missing file means "official relay only". */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const configPath = resolveConfigPath(env);
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        config: parseConfig({ upstreams: DEFAULT_UPSTREAMS }),
        source: "default",
        path: configPath,
      };
    }
    throw new Error(`Cannot read relay-fanout config ${configPath}: ${(error as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`relay-fanout config ${configPath} is not valid JSON: ${(error as Error).message}`);
  }
  return { config: parseConfig(json), source: "file", path: configPath };
}
