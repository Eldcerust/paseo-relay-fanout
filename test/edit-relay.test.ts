import { describe, expect, it } from "vitest";
import { createActions } from "../server/actions";
import { parseConfig, type FanoutConfig } from "../server/config";
import { editRelay } from "../server/relays";

const base = (): FanoutConfig =>
  parseConfig({
    upstreams: [
      { name: "official", endpoint: "relay.paseo.sh:443" },
      { name: "home", endpoint: "paseo.example.com:443" },
    ],
    preference: { mode: "preferred", preferred: "home" },
  });

const names = (config: FanoutConfig) => config.upstreams.map((upstream) => upstream.name);
const relay = (config: FanoutConfig, name: string) => config.upstreams.find((upstream) => upstream.name === name);

describe("editing a relay", () => {
  it("renames it and moves the preference with it", () => {
    const change = editRelay(base(), { name: "home", newName: "house" });
    expect(change.ok).toBe(true);
    if (!change.ok) return;

    expect(names(change.config)).toEqual(["house", "official"]);
    expect(change.config.preference).toEqual({ mode: "preferred", preferred: "house" });
    expect(relay(change.config, "house")).toEqual({ name: "house", endpoint: "paseo.example.com:443", useTls: true });
    expect(change.upstream?.name).toBe("house");
  });

  it("changes only the address, taking TLS from the new address", () => {
    const change = editRelay(base(), { name: "home", address: "ws://192.0.2.10:8411" });
    expect(change.ok).toBe(true);
    if (!change.ok) return;

    expect(relay(change.config, "home")).toEqual({ name: "home", endpoint: "192.0.2.10:8411", useTls: false });
    expect(change.config.preference).toEqual({ mode: "preferred", preferred: "home" });
  });

  it("does both at once", () => {
    const change = editRelay(base(), { name: "home", newName: "lan", address: "wss://relay.example.org" });
    expect(change.ok).toBe(true);
    if (!change.ok) return;

    expect(names(change.config)).toEqual(["lan", "official"]);
    expect(relay(change.config, "lan")).toEqual({ name: "lan", endpoint: "relay.example.org:443", useTls: true });
    expect(change.config.preference).toEqual({ mode: "preferred", preferred: "lan" });
  });

  it("leaves everything alone when nothing changes", () => {
    const before = base();
    const change = editRelay(before, { name: "home" });
    expect(change.ok).toBe(true);
    if (!change.ok) return;
    expect(change.config).toEqual(before);
  });

  it("keeps an Auto preference as it is", () => {
    const auto = parseConfig({ upstreams: [{ name: "home", endpoint: "paseo.example.com:443" }] });
    const change = editRelay(auto, { name: "home", newName: "house" });
    expect(change.ok).toBe(true);
    if (!change.ok) return;
    expect(change.config.preference).toEqual({ mode: "auto", preferred: null });
  });

  it.each([
    ["an unknown relay", { name: "ghost", newName: "x" }, /no relay called "ghost"/],
    ["a name that is already taken", { name: "home", newName: "official" }, /already a relay called "official"/],
    ["a name with capitals and spaces", { name: "home", newName: "Home Relay" }, /lowercase/],
    ["an address without a port", { name: "home", address: "relay.example.org" }, /port/],
    ["an address another relay already uses", { name: "home", address: "relay.paseo.sh:443" }, /already added as "official"/],
  ])("refuses %s", (_label, input, pattern) => {
    expect(() => {
      const change = editRelay(base(), input as { name: string; newName?: string; address?: string });
      if (!change.ok) throw new Error(change.error);
    }).toThrow(pattern);
  });
});

describe("the edit action", () => {
  function harness(options: { failToSave?: boolean } = {}) {
    let current = base();
    const runningListen = { ...current.listen };
    const committed: FanoutConfig[] = [];
    const actions = createActions({
      config: () => current,
      runningListen: () => runningListen,
      commit: (next) => {
        if (options.failToSave) throw new Error("EACCES: permission denied");
        committed.push(next);
        current = next;
      },
    });
    return { actions, committed, config: () => current };
  }

  it("commits once and answers with the new name", () => {
    const { actions, committed, config } = harness();
    expect(actions.editRelay({ name: "home", newName: "house" })).toEqual({ ok: true, name: "house" });
    expect(committed).toHaveLength(1);
    expect(names(config())).toEqual(["house", "official"]);
  });

  it("answers a refusal without saving", () => {
    const { actions, committed } = harness();
    const result = actions.editRelay({ name: "home", address: "relay.example.org" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/port/);
    expect(committed).toHaveLength(0);
  });

  it("does not claim success when the config cannot be saved", () => {
    const { actions, committed, config } = harness({ failToSave: true });
    expect(actions.editRelay({ name: "home", newName: "house" })).toEqual({
      ok: false,
      error: "Could not save the config: EACCES: permission denied",
    });
    expect(committed).toHaveLength(0);
    expect(names(config())).toEqual(["home", "official"]);
  });
});
