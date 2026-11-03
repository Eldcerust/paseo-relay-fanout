/**
 * Which relays the daemon should be registered with, as a pure decision so every situation can be
 * tested without a socket.
 *
 * Why this exists: a phone chooses its own relay. It probes every relay it knows and uses the
 * fastest one that answers. The only lever the proxy has is which relays the daemon can be reached
 * through at a given moment. "Preferred" therefore means: while the preferred relay is healthy it is
 * the only one the daemon is registered with, and the others stand by. If it fails, the others are
 * brought up, and it is tried again every few minutes until it is back.
 *
 * "Auto" does not restrict anything. Every relay stays registered and every device picks the fastest
 * it measures itself, which beats any number the proxy could measure from the daemon's side.
 */

export interface Preference {
  mode: "auto" | "preferred";
  preferred: string | null;
}

export type Role = "active" | "connecting" | "standby" | "down";

export interface RelayFacts {
  name: string;
  /** A control socket exists for it: connecting, ready or reconnecting. */
  registered: boolean;
  ready: boolean;
  /** How long it has been continuously ready; null when it is not ready. */
  readyForMs: number | null;
  /** How long a registered relay has gone without being ready; null when ready or not registered. */
  unreadyForMs: number | null;
  /** When a relay declared down is tried next; null when it is not down. */
  nextRetestAt: number | null;
  /** Round trip used to rank relays against each other; null when unknown. */
  latencyMs: number | null;
}

export interface PriorityTiming {
  /** The preferred relay has been unavailable this long: give up on it until its next retest. */
  graceMs: number;
  /** The preferred relay has been unavailable this long: bring up the others as well. */
  failoverAfterMs: number;
  /** The preferred relay must have been ready this long before the others are let go. */
  stableMs: number;
  /** How often a relay that was given up on is tried again. */
  retestMs: number;
  /**
   * When several fallbacks are ready at once, wait this long for each to be measured before choosing.
   * A fallback that is stood down can no longer be measured, so choosing too early could lock in the wrong one.
   */
  settleMs: number;
}

export const DEFAULT_PRIORITY_TIMING: PriorityTiming = {
  graceMs: 20_000,
  failoverAfterMs: 3_000,
  stableMs: 15_000,
  retestMs: 120_000,
  settleMs: 2_000,
};

export interface Decision {
  /** The relays that should have a control socket after this decision. */
  register: string[];
  /** The preferred relay is to be given up on until its next retest. */
  declareDown: string | null;
  /** The others are up as a fallback. Latched until the preferred relay is stable again. */
  fallbackActive: boolean;
}

function byLatency(a: RelayFacts, b: RelayFacts): number {
  const x = a.latencyMs;
  const y = b.latencyMs;
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x - y;
}

export function decide(input: {
  now: number;
  preference: Preference;
  relays: RelayFacts[];
  fallbackActive: boolean;
  timing?: PriorityTiming;
}): Decision {
  const { now, preference, relays } = input;
  const timing = input.timing ?? DEFAULT_PRIORITY_TIMING;
  const everything = relays.map((relay) => relay.name);

  const preferred = preference.mode === "preferred" ? relays.find((relay) => relay.name === preference.preferred) : undefined;
  if (!preferred) return { register: everything, declareDown: null, fallbackActive: false };

  const others = relays.filter((relay) => relay.name !== preferred.name);
  const down = !preferred.registered && preferred.nextRetestAt !== null && now < preferred.nextRetestAt;
  const retestDue = !preferred.registered && preferred.nextRetestAt !== null && now >= preferred.nextRetestAt;
  const unreadyFor = preferred.unreadyForMs ?? 0;
  const stable = preferred.ready && (preferred.readyForMs ?? 0) >= timing.stableMs;
  const failing = preferred.registered && !preferred.ready && unreadyFor >= timing.failoverAfterMs;
  const giveUp = preferred.registered && !preferred.ready && unreadyFor >= timing.graceMs;

  // Once the others are up they stay up until the preferred relay has proven itself again, so a
  // relay that flaps does not make the others come and go.
  const fallbackActive = stable ? false : input.fallbackActive || failing || down || retestDue;

  const register = new Set<string>();
  if (!giveUp && !down) register.add(preferred.name); // being tried, ready, or due for its retest

  if (fallbackActive) {
    const readyOthers = others.filter((relay) => relay.ready).sort(byLatency);
    // Several fallbacks, and one has not been measured yet: keep them all until it has, or until it has
    // had long enough that "no answer" is itself the measurement.
    const settling = readyOthers.length > 1 && readyOthers.some((relay) => relay.latencyMs === null && (relay.readyForMs ?? 0) < timing.settleMs);
    if (settling) {
      for (const relay of readyOthers) register.add(relay.name);
    } else if (readyOthers.length > 0) {
      register.add(readyOthers[0]!.name);
    } else if (!preferred.ready) {
      for (const relay of others) register.add(relay.name); // nothing serves yet: try them all
    }
  }

  // Keep the configured order, which also breaks ties.
  return {
    register: everything.filter((name) => register.has(name)),
    declareDown: giveUp ? preferred.name : null,
    fallbackActive,
  };
}

export function roleOf(facts: RelayFacts): Role {
  if (facts.registered) return facts.ready ? "active" : "connecting";
  return facts.nextRetestAt !== null ? "down" : "standby";
}
