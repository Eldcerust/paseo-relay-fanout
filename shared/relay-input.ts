/**
 * Rules for a relay's name and address, shared by the screen (to check input) and the daemon (to
 * enforce it). This file runs inside the app, where `URL` is incomplete on phones, so the address
 * is parsed by hand.
 */

export const RELAY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const ENDPOINT_PATTERN = /^(\[[0-9a-fA-F:.]+\]|[^\s:/[\]]+):(\d{1,5})$/;
export const MAX_RELAYS = 8;

export interface ParsedAddress {
  endpoint: string;
  useTls: boolean;
}

export type ParseResult = ({ ok: true } & ParsedAddress) | { ok: false; error: string };

const TLS_SCHEMES = new Set(["wss", "https"]);
const PLAIN_SCHEMES = new Set(["ws", "http"]);
const HOST_PORT = /^(\[[0-9a-fA-F:.]+\]|[^\s:/[\]@]+)(?::(\d{1,5}))?$/;

/**
 * Turns what someone types or pastes into the `host:port` and TLS flag the proxy uses.
 *
 *   wss://paseo.example.com            -> paseo.example.com:443, TLS
 *   https://relay.example.org/ws        -> relay.example.org:443, TLS (the path is dropped)
 *   ws://198.51.100.10:8411             -> 198.51.100.10:8411, plain
 *   relay.paseo.sh:443                  -> TLS, because the port is 443
 *   192.0.2.10:8411                  -> plain
 *   paseo.example.com                  -> refused: say which port
 */
export function parseRelayAddress(input: string): ParseResult {
  const text = input.trim();
  if (!text) return { ok: false, error: "Enter the relay's address." };
  if (/\s/.test(text)) return { ok: false, error: "An address has no spaces." };

  const split = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(.*)$/i.exec(text);
  const scheme = split?.[1]?.toLowerCase() ?? null;
  const rest = split?.[2] ?? "";
  if (scheme && !TLS_SCHEMES.has(scheme) && !PLAIN_SCHEMES.has(scheme)) {
    return { ok: false, error: `Use wss://, ws://, https:// or http://, not ${scheme}://.` };
  }

  // Anything after the host and port (a path such as /ws, a query, a fragment) is not part of the address.
  const authority = rest.split(/[/?#]/, 1)[0] ?? "";
  if (authority.includes("@")) return { ok: false, error: "Leave out the user name and password." };

  const match = HOST_PORT.exec(authority);
  if (!match) {
    return scheme
      ? { ok: false, error: "That does not look like an address." }
      : { ok: false, error: "Add the port, for example relay.example.org:443, or start with wss://." };
  }
  const host = match[1]!.toLowerCase();
  const givenPort = match[2];
  if (!scheme && !givenPort) {
    return { ok: false, error: "Add the port, for example relay.example.org:443, or start with wss://." };
  }

  const useTls = scheme ? TLS_SCHEMES.has(scheme) : Number(givenPort) === 443;
  const port = givenPort !== undefined ? Number(givenPort) : useTls ? 443 : 80;
  if (port < 1 || port > 65535) return { ok: false, error: "The port must be between 1 and 65535." };

  return { ok: true, endpoint: `${host}:${port}`, useTls };
}

/** A short unique name from an address: `paseo.example.com:443` -> `paseo`, an IP -> `relay`. */
export function suggestRelayName(endpoint: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const host = endpoint.replace(/:\d+$/, "");
  const isIp = /^\[.*\]$/.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const label = isIp ? "relay" : (host.split(".")[0] ?? "relay");
  const base = label.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "relay";
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-x`;
}
