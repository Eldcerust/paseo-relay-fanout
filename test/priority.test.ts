import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRIORITY_TIMING as timing,
  decide,
  roleOf,
  type Preference,
  type RelayFacts,
} from "../server/priority";

const NOW = 1_000_000;

function relay(name: string, overrides: Partial<RelayFacts> = {}): RelayFacts {
  return {
    name,
    registered: false,
    ready: false,
    readyForMs: null,
    unreadyForMs: null,
    nextRetestAt: null,
    latencyMs: null,
    ...overrides,
  };
}

/** Registered and ready for a while. */
const serving = (name: string, overrides: Partial<RelayFacts> = {}) =>
  relay(name, { registered: true, ready: true, readyForMs: 60_000, ...overrides });
/** Registered but not ready for `ms`. */
const struggling = (name: string, ms: number) => relay(name, { registered: true, unreadyForMs: ms });
/** Given up on; to be tried again at `at`. */
const down = (name: string, at: number) => relay(name, { nextRetestAt: at });

const prefer = (name: string): Preference => ({ mode: "preferred", preferred: name });
const auto: Preference = { mode: "auto", preferred: null };

function run(preference: Preference, relays: RelayFacts[], fallbackActive = false, now = NOW) {
  return decide({ now, preference, relays, fallbackActive });
}

describe("auto", () => {
  it("keeps every relay open and lets each device pick the fastest", () => {
    const decision = run(auto, [serving("a"), serving("b"), relay("c")]);
    expect(decision).toEqual({ register: ["a", "b", "c"], declareDown: null, fallbackActive: false });
  });

  it("treats a preference for a relay that does not exist as auto", () => {
    expect(run(prefer("gone"), [serving("a"), serving("b")]).register).toEqual(["a", "b"]);
  });
});

describe("a preferred relay that is healthy", () => {
  it("is the only one open once it has proven itself, and the others stand by", () => {
    const decision = run(prefer("home"), [serving("official"), serving("home")]);
    expect(decision).toEqual({ register: ["home"], declareDown: null, fallbackActive: false });
  });

  it("is the only one tried at start-up, with no fallback while it is still connecting", () => {
    expect(run(prefer("home"), [relay("official"), relay("home")]).register).toEqual(["home"]);
    expect(run(prefer("home"), [relay("official"), struggling("home", 1_000)]).register).toEqual(["home"]);
  });

  it("is enough on its own just after it connects", () => {
    const justReady = serving("home", { readyForMs: 500 });
    expect(run(prefer("home"), [relay("official"), justReady])).toEqual({
      register: ["home"],
      declareDown: null,
      fallbackActive: false,
    });
  });
});

describe("when the preferred relay becomes unavailable", () => {
  it("rides out a short blip without bringing anyone else up", () => {
    const decision = run(prefer("home"), [relay("official"), struggling("home", timing.failoverAfterMs - 1)]);
    expect(decision.register).toEqual(["home"]);
    expect(decision.fallbackActive).toBe(false);
  });

  it("brings up the others when it has been gone a few seconds, while still trying it", () => {
    const decision = run(prefer("home"), [relay("official"), relay("backup"), struggling("home", timing.failoverAfterMs)]);
    expect(decision.register).toEqual(["official", "backup", "home"]);
    expect(decision.fallbackActive).toBe(true);
    expect(decision.declareDown).toBeNull();
  });

  it("keeps only the best fallback once one is serving, the fastest of several", () => {
    const decision = run(
      prefer("home"),
      [
        serving("slow", { latencyMs: 120 }),
        serving("quick", { latencyMs: 15 }),
        struggling("home", 5_000),
        relay("unmeasured"),
      ],
      true,
    );
    expect(decision.register).toEqual(["quick", "home"]);
  });

  it("keeps several fallbacks open while one of them has not been measured yet, so a stood-down relay cannot win by default", () => {
    const measured = serving("measured", { latencyMs: 20, readyForMs: 100 });
    const pending = serving("pending", { latencyMs: null, readyForMs: 100 });
    const decision = run(prefer("home"), [pending, measured, struggling("home", 5_000)], true);
    expect(decision.register).toEqual(["pending", "measured", "home"]);
  });

  it("stops waiting for a measurement after the settle time and ranks the unmeasured relay last", () => {
    const measured = serving("measured", { latencyMs: 20, readyForMs: timing.settleMs });
    const silent = serving("silent", { latencyMs: null, readyForMs: timing.settleMs });
    const decision = run(prefer("home"), [silent, measured, struggling("home", 5_000)], true);
    expect(decision.register).toEqual(["measured", "home"]);
  });

  it("does not wait when only one fallback is serving", () => {
    const only = serving("only", { latencyMs: null, readyForMs: 100 });
    expect(run(prefer("home"), [only, struggling("home", 5_000)], true).register).toEqual(["only", "home"]);
  });

  it("ranks a relay with no measurement last, and keeps the configured order on a tie", () => {
    const a = serving("a", { latencyMs: null });
    const b = serving("b", { latencyMs: 40 });
    expect(run(prefer("home"), [a, b, struggling("home", 5_000)], true).register).toEqual(["b", "home"]);

    const c = serving("c", { latencyMs: 30 });
    const d = serving("d", { latencyMs: 30 });
    expect(run(prefer("home"), [c, d, struggling("home", 5_000)], true).register).toEqual(["c", "home"]);
  });

  it("gives up on it after the grace period and stops trying until the retest", () => {
    const decision = run(prefer("home"), [serving("official"), struggling("home", timing.graceMs)], true);
    expect(decision.declareDown).toBe("home");
    expect(decision.register).toEqual(["official"]);
  });

  it("does not give up on it while another relay is not yet serving either", () => {
    const decision = run(prefer("home"), [relay("official"), struggling("home", timing.graceMs - 1)], true);
    expect(decision.declareDown).toBeNull();
    expect(decision.register).toEqual(["official", "home"]);
  });
});

describe("while the preferred relay is given up on", () => {
  const retestAt = NOW + 60_000;

  it("is left alone until the retest, and the fallback serves", () => {
    const decision = run(prefer("home"), [serving("official"), down("home", retestAt)], true);
    expect(decision.register).toEqual(["official"]);
    expect(decision.fallbackActive).toBe(true);
    expect(decision.declareDown).toBeNull();
  });

  it("brings the fallbacks up even if nothing remembered that they were needed", () => {
    const decision = run(prefer("home"), [relay("official"), down("home", retestAt)], false);
    expect(decision.fallbackActive).toBe(true);
    expect(decision.register).toEqual(["official"]);
  });

  it("is tried again when the retest is due, with the fallback still serving", () => {
    const decision = run(prefer("home"), [serving("official"), down("home", NOW)], true);
    expect(decision.register).toEqual(["official", "home"]);
  });

  it("keeps the fallback up at the exact moment of the retest even if nothing remembered it was needed", () => {
    const decision = run(prefer("home"), [relay("official"), down("home", NOW)], false);
    expect(decision.fallbackActive).toBe(true);
    expect(decision.register).toEqual(["official", "home"]);
  });

  it("tries it exactly at the retest time and not a moment before", () => {
    const before = run(prefer("home"), [serving("official"), down("home", NOW + 1)], true);
    const at = run(prefer("home"), [serving("official"), down("home", NOW)], true);
    expect(before.register).toEqual(["official"]);
    expect(at.register).toEqual(["official", "home"]);
  });
});

describe("when the preferred relay comes back", () => {
  it("keeps the fallback until the preferred relay has been ready for a while, so a flapping relay does not make others come and go", () => {
    const back = serving("home", { readyForMs: 2_000 });
    const decision = run(prefer("home"), [serving("official", { latencyMs: 20 }), back], true);
    expect(decision.register).toEqual(["official", "home"]);
    expect(decision.fallbackActive).toBe(true);
  });

  it("does not start anything new while it waits for the preferred relay to prove itself", () => {
    const back = serving("home", { readyForMs: 2_000 });
    const decision = run(prefer("home"), [relay("official"), relay("backup"), back], true);
    expect(decision.register).toEqual(["home"]);
  });

  it("lets the fallback go once the preferred relay is stable", () => {
    const stable = serving("home", { readyForMs: timing.stableMs });
    const decision = run(prefer("home"), [serving("official"), stable], true);
    expect(decision).toEqual({ register: ["home"], declareDown: null, fallbackActive: false });
  });
});

describe("nothing works", () => {
  it("tries every relay, the preferred one included, until one serves", () => {
    const decision = run(prefer("home"), [struggling("official", 8_000), struggling("home", 8_000)], true);
    expect(decision.register).toEqual(["official", "home"]);
  });
});

describe("a single relay", () => {
  it("is simply registered, preferred or not", () => {
    expect(run(prefer("only"), [relay("only")]).register).toEqual(["only"]);
    expect(run(auto, [relay("only")]).register).toEqual(["only"]);
  });
});

describe("roleOf", () => {
  it("describes what each relay is doing now", () => {
    expect(roleOf(serving("a"))).toBe("active");
    expect(roleOf(struggling("a", 100))).toBe("connecting");
    expect(roleOf(relay("a"))).toBe("standby");
    expect(roleOf(down("a", NOW + 1))).toBe("down");
  });
});
