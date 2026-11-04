import { MAX_RELAYS, RELAY_NAME_PATTERN, parseRelayAddress, suggestRelayName } from "../shared/relay-input";
import type { FanoutConfig, Upstream } from "./config";
import type { Preference } from "./priority";

/** The changes the screen can make to the relay list. All are pure: they return the new config. */
export type Change =
  | { ok: true; config: FanoutConfig; upstream?: Upstream }
  | { ok: false; error: string };

export function addRelay(config: FanoutConfig, input: { address: string; name?: string }): Change {
  if (config.upstreams.length >= MAX_RELAYS) return { ok: false, error: `A proxy can have at most ${MAX_RELAYS} relays.` };

  const parsed = parseRelayAddress(input.address);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const same = config.upstreams.find((upstream) => upstream.endpoint === parsed.endpoint);
  if (same) return { ok: false, error: `${parsed.endpoint} is already added as "${same.name}".` };

  const taken = config.upstreams.map((upstream) => upstream.name);
  const requested = input.name?.trim();
  let name: string;
  if (requested) {
    if (!RELAY_NAME_PATTERN.test(requested)) {
      return { ok: false, error: "A name is 1 to 24 lowercase letters, digits or dashes, and starts with a letter or digit." };
    }
    if (taken.includes(requested)) return { ok: false, error: `There is already a relay called "${requested}".` };
    name = requested;
  } else {
    name = suggestRelayName(parsed.endpoint, taken);
  }

  const upstream: Upstream = { name, endpoint: parsed.endpoint, useTls: parsed.useTls };
  return { ok: true, config: { ...config, upstreams: [...config.upstreams, upstream] }, upstream };
}

export function removeRelay(config: FanoutConfig, name: string): Change {
  if (!config.upstreams.some((upstream) => upstream.name === name)) return { ok: false, error: `There is no relay called "${name}".` };
  if (config.upstreams.length === 1) return { ok: false, error: "The proxy needs at least one relay." };

  // Removing the preferred relay promotes the next one in the list, which stays in priority mode.
  const upstreams = config.upstreams.filter((upstream) => upstream.name !== name);
  const preference: Preference =
    config.preference.mode === "preferred" && config.preference.preferred === name
      ? { mode: "preferred", preferred: upstreams[0]!.name }
      : config.preference;
  return { ok: true, config: { ...config, upstreams, preference } };
}

export function setPreference(config: FanoutConfig, preference: { mode: "auto" } | { mode: "preferred"; preferred: string }): Change {
  if (preference.mode === "auto") return { ok: true, config: { ...config, preference: { mode: "auto", preferred: null } } };
  const chosen = config.upstreams.find((upstream) => upstream.name === preference.preferred);
  if (!chosen) return { ok: false, error: `There is no relay called "${preference.preferred}".` };
  // The list order is the priority, so the preferred relay goes to the top and the rest keep their order.
  const upstreams = [chosen, ...config.upstreams.filter((upstream) => upstream !== chosen)];
  return { ok: true, config: { ...config, upstreams, preference: { mode: "preferred", preferred: chosen.name } } };
}

/**
 * Set the priority order. `names` must list every relay exactly once. In priority mode the first
 * name becomes the preferred relay; in Auto the order is only remembered.
 */
export function reorderRelays(config: FanoutConfig, names: string[]): Change {
  const known = new Map(config.upstreams.map((upstream) => [upstream.name, upstream]));
  const unique = new Set(names);
  if (unique.size !== names.length || names.length !== known.size || names.some((name) => !known.has(name))) {
    return { ok: false, error: "The order must list every relay once." };
  }
  const upstreams = names.map((name) => known.get(name)!);
  const preference: Preference =
    config.preference.mode === "preferred" ? { mode: "preferred", preferred: names[0]! } : config.preference;
  return { ok: true, config: { ...config, upstreams, preference } };
}

/**
 * Change a relay's name, its address, or both. Fields left out stay as they are. The address goes
 * through the same rules as adding one, so a bare host is still refused. A rename carries the
 * preference with it, and a changed address makes the proxy drop that relay's connections and dial
 * the new one.
 */
export function editRelay(
  config: FanoutConfig,
  input: { name: string; newName?: string; address?: string },
): Change {
  const existing = config.upstreams.find((upstream) => upstream.name === input.name);
  if (!existing) return { ok: false, error: `There is no relay called "${input.name}".` };

  let name = existing.name;
  const requestedName = input.newName?.trim();
  if (requestedName !== undefined && requestedName !== "" && requestedName !== existing.name) {
    if (!RELAY_NAME_PATTERN.test(requestedName)) {
      return { ok: false, error: "A name is 1 to 24 lowercase letters, digits or dashes, and starts with a letter or digit." };
    }
    if (config.upstreams.some((upstream) => upstream.name === requestedName)) {
      return { ok: false, error: `There is already a relay called "${requestedName}".` };
    }
    name = requestedName;
  }

  let endpoint = existing.endpoint;
  let useTls = existing.useTls;
  const requestedAddress = input.address?.trim();
  if (requestedAddress !== undefined && requestedAddress !== "") {
    const parsed = parseRelayAddress(requestedAddress);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const other = config.upstreams.find(
      (upstream) => upstream.endpoint === parsed.endpoint && upstream.name !== existing.name,
    );
    if (other) return { ok: false, error: `${parsed.endpoint} is already added as "${other.name}".` };
    endpoint = parsed.endpoint;
    useTls = parsed.useTls;
  }

  const upstream: Upstream = { name, endpoint, useTls };
  const upstreams = config.upstreams.map((entry) => (entry.name === existing.name ? upstream : entry));
  const preference: Preference =
    name !== existing.name && config.preference.mode === "preferred" && config.preference.preferred === existing.name
      ? { mode: "preferred", preferred: name }
      : config.preference;

  return { ok: true, config: { ...config, upstreams, preference }, upstream };
}
