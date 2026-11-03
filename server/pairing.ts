import { readFileSync } from "node:fs";
import path from "node:path";
import type { PairingResult } from "../shared/status";
import type { Upstream } from "./config";

const DEFAULT_APP_BASE_URL = "https://app.paseo.sh";

export interface PairingInputs {
  /** The Paseo home directory of the daemon this plugin runs in. */
  home: string;
  upstreams: Upstream[];
  /** The server id the daemon registered with the proxy, when it is connected. */
  liveServerId: string | null;
}

function unavailable(reason: string): PairingResult {
  return { available: false, reason };
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readServerId(home: string): string | null {
  try {
    const value = readFileSync(path.join(home, "server-id"), "utf8").trim();
    return value && !/\s/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Only the public half of the keypair is kept; the secret half is never read out of the parsed file. */
function readDaemonPublicKey(home: string): string | null {
  const keypair = readJson(path.join(home, "daemon-keypair.json"));
  const publicKey = keypair?.publicKeyB64;
  return typeof publicKey === "string" && publicKey.trim() ? publicKey.trim() : null;
}

function readOfferSettings(home: string): { appBaseUrl: string; requireProtected: boolean } {
  const config = readJson(path.join(home, "config.json"));
  const app = config?.app as { baseUrl?: unknown } | undefined;
  const relay = (config?.daemon as { relay?: { requireProtectedSecurity?: unknown } } | undefined)?.relay;
  const baseUrl = typeof app?.baseUrl === "string" && app.baseUrl.trim() ? app.baseUrl.trim() : DEFAULT_APP_BASE_URL;
  return { appBaseUrl: baseUrl, requireProtected: relay?.requireProtectedSecurity === true };
}

/**
 * Builds the same `https://app/#offer=<base64url json>` link the daemon prints for its own
 * relay, once per upstream. An offer holds only public data: the server id, the daemon's
 * public key and where the relay is.
 */
export function buildPairingLinks(inputs: PairingInputs): PairingResult {
  const serverId = inputs.liveServerId ?? readServerId(inputs.home);
  if (!serverId) return unavailable("The daemon's server id is not available yet.");

  const publicKey = readDaemonPublicKey(inputs.home);
  if (!publicKey) return unavailable(`Could not read the daemon's public key from ${path.join(inputs.home, "daemon-keypair.json")}.`);

  const { appBaseUrl, requireProtected } = readOfferSettings(inputs.home);
  const links = inputs.upstreams.map((upstream) => {
    const offer = {
      v: 2,
      serverId,
      daemonPublicKeyB64: publicKey,
      relay: { endpoint: upstream.endpoint, useTls: upstream.useTls },
      ...(requireProtected ? { minimumSecurityMode: "protected" } : {}),
    };
    const encoded = Buffer.from(JSON.stringify(offer), "utf8").toString("base64url");
    return {
      name: upstream.name,
      endpoint: upstream.endpoint,
      link: `${appBaseUrl.replace(/\/$/, "")}/#offer=${encoded}`,
    };
  });
  return { available: true, links };
}
