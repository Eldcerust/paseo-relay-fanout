import { MAX_RELAYS, RELAY_NAME_PATTERN, parseRelayAddress, suggestRelayName } from "../shared/relay-input";
import type { FanoutConfig, Upstream } from "./config";
import type { Preference } from "./priority";

/** The three changes the screen can make to the relay list. All are pure: they return the new config. */
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

  // Removing the preferred relay leaves nothing to prefer, so go back to Auto rather than keep a dangling name.
  const preference: Preference =
    config.preference.mode === "preferred" && config.preference.preferred === name
      ? { mode: "auto", preferred: null }
      : config.preference;
  return { ok: true, config: { ...config, upstreams: config.upstreams.filter((upstream) => upstream.name !== name), preference } };
}

export function setPreference(config: FanoutConfig, preference: { mode: "auto" } | { mode: "preferred"; preferred: string }): Change {
  if (preference.mode === "auto") return { ok: true, config: { ...config, preference: { mode: "auto", preferred: null } } };
  if (!config.upstreams.some((upstream) => upstream.name === preference.preferred)) {
    return { ok: false, error: `There is no relay called "${preference.preferred}".` };
  }
  return { ok: true, config: { ...config, preference: { mode: "preferred", preferred: preference.preferred } } };
}
