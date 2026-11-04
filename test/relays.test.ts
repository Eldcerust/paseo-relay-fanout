import { describe, expect, it } from "vitest";
import { parseConfig, type FanoutConfig } from "../server/config";
import { addRelay, removeRelay, reorderRelays, setPreference } from "../server/relays";

const base = (): FanoutConfig =>
  parseConfig({
    upstreams: [
      { name: "official", endpoint: "relay.paseo.sh:443" },
      { name: "home", endpoint: "paseo.example.com:443" },
    ],
  });

const names = (config: FanoutConfig) => config.upstreams.map((upstream) => upstream.name);

describe("addRelay", () => {
  it("adds a relay from a pasted address, naming it and working out TLS", () => {
    const result = addRelay(base(), { address: "ws://198.51.100.10:8411" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.upstream).toEqual({ name: "relay", endpoint: "198.51.100.10:8411", useTls: false });
    expect(names(result.config)).toEqual(["official", "home", "relay"]);
  });

  it("uses the name it is given", () => {
    const result = addRelay(base(), { address: "wss://relay.example.org", name: "backup" });
    expect(result.ok && result.upstream).toEqual({ name: "backup", endpoint: "relay.example.org:443", useTls: true });
  });

  it("does not change the config it was given", () => {
    const before = base();
    addRelay(before, { address: "wss://relay.example.org" });
    expect(names(before)).toEqual(["official", "home"]);
  });

  it.each([
    ["an address that does not parse", { address: "relay.example.org" }, /port/],
    ["an empty address", { address: "  " }, /Enter/],
    ["an address that is already there", { address: "wss://paseo.example.com" }, /already added as "home"/],
    ["a name that is taken", { address: "wss://relay.example.org", name: "home" }, /already a relay called "home"/],
    ["a name that is not allowed", { address: "wss://relay.example.org", name: "My Relay" }, /lowercase/],
  ])("refuses %s", (_label, input, message) => {
    const result = addRelay(base(), input);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(message);
  });

  it("refuses a ninth relay", () => {
    let config = base();
    for (let i = 0; i < 6; i += 1) {
      const result = addRelay(config, { address: `wss://r${i}.example.org` });
      if (!result.ok) throw new Error(result.error);
      config = result.config;
    }
    expect(config.upstreams).toHaveLength(8);
    const ninth = addRelay(config, { address: "wss://one-more.example.org" });
    expect(!ninth.ok && ninth.error).toMatch(/at most 8/);
  });

  it("gives two relays on the same host different names when the ports differ", () => {
    const first = addRelay(base(), { address: "ws://192.0.2.10:8411" });
    if (!first.ok) throw new Error(first.error);
    const second = addRelay(first.config, { address: "ws://192.0.2.10:8412" });
    expect(second.ok && second.upstream?.name).toBe("relay-2");
  });
});

describe("removeRelay", () => {
  it("removes a relay", () => {
    const result = removeRelay(base(), "home");
    expect(result.ok && names(result.config)).toEqual(["official"]);
  });

  it("keeps the preference when a different relay is removed", () => {
    const config = { ...base(), preference: { mode: "preferred" as const, preferred: "official" } };
    const result = removeRelay(config, "home");
    expect(result.ok && result.config.preference).toEqual({ mode: "preferred", preferred: "official" });
  });

  it("promotes the next relay when the preferred one is removed, and stays in priority mode", () => {
    const config = setPreference(base(), { mode: "preferred", preferred: "home" });
    if (!config.ok) throw new Error(config.error);
    const result = removeRelay(config.config, "home");
    expect(result.ok && result.config.preference).toEqual({ mode: "preferred", preferred: "official" });
  });

  it("stays in Auto when a relay is removed from Auto", () => {
    const result = removeRelay(base(), "official");
    expect(result.ok && result.config.preference).toEqual({ mode: "auto", preferred: null });
  });

  it("refuses to remove a relay that does not exist, or the last one", () => {
    const missing = removeRelay(base(), "nope");
    expect(!missing.ok && missing.error).toMatch(/no relay called "nope"/);
    const only = parseConfig({ upstreams: [{ name: "only", endpoint: "relay.paseo.sh:443" }] });
    const last = removeRelay(only, "only");
    expect(!last.ok && last.error).toMatch(/at least one/);
  });
});

describe("setPreference", () => {
  it("prefers a relay, and goes back to Auto", () => {
    const preferred = setPreference(base(), { mode: "preferred", preferred: "home" });
    expect(preferred.ok && preferred.config.preference).toEqual({ mode: "preferred", preferred: "home" });
    if (!preferred.ok) return;
    const auto = setPreference(preferred.config, { mode: "auto" });
    expect(auto.ok && auto.config.preference).toEqual({ mode: "auto", preferred: null });
  });

  it("refuses a relay that is not in the list", () => {
    const result = setPreference(base(), { mode: "preferred", preferred: "ghost" });
    expect(!result.ok && result.error).toMatch(/no relay called "ghost"/);
  });
});

describe("setPreference puts the preferred relay on top", () => {
  it("moves it first and keeps the others in their order", () => {
    const three = addRelay(base(), { address: "wss://relay.example.org", name: "backup" });
    if (!three.ok) throw new Error(three.error);
    const result = setPreference(three.config, { mode: "preferred", preferred: "backup" });
    expect(result.ok && names(result.config)).toEqual(["backup", "official", "home"]);
  });

  it("keeps the order when going back to Auto", () => {
    const preferred = setPreference(base(), { mode: "preferred", preferred: "home" });
    if (!preferred.ok) throw new Error(preferred.error);
    const auto = setPreference(preferred.config, { mode: "auto" });
    expect(auto.ok && names(auto.config)).toEqual(["home", "official"]);
  });
});

describe("reorderRelays", () => {
  const three = () => {
    const added = addRelay(base(), { address: "wss://relay.example.org", name: "backup" });
    if (!added.ok) throw new Error(added.error);
    return added.config;
  };

  it("sets the order, and makes the first relay the preferred one in priority mode", () => {
    const start = setPreference(three(), { mode: "preferred", preferred: "official" });
    if (!start.ok) throw new Error(start.error);
    const result = reorderRelays(start.config, ["backup", "official", "home"]);
    expect(result.ok && names(result.config)).toEqual(["backup", "official", "home"]);
    expect(result.ok && result.config.preference).toEqual({ mode: "preferred", preferred: "backup" });
  });

  it("only remembers the order in Auto", () => {
    const result = reorderRelays(three(), ["home", "backup", "official"]);
    expect(result.ok && names(result.config)).toEqual(["home", "backup", "official"]);
    expect(result.ok && result.config.preference).toEqual({ mode: "auto", preferred: null });
  });

  it("does not change the config it was given", () => {
    const before = three();
    reorderRelays(before, ["backup", "home", "official"]);
    expect(names(before)).toEqual(["official", "home", "backup"]);
  });

  it.each([
    ["a relay left out", ["official", "home"]],
    ["a relay named twice", ["official", "official", "home"]],
    ["a relay that does not exist", ["official", "home", "ghost"]],
    ["an empty list", []],
  ])("refuses %s", (_label, order) => {
    const result = reorderRelays(three(), order);
    expect(!result.ok && result.error).toMatch(/every relay once/);
  });
});
