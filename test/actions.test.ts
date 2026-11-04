import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createActions } from "../server/actions";
import { loadConfig, parseConfig, saveConfig, type FanoutConfig } from "../server/config";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const start = (): FanoutConfig =>
  parseConfig({
    upstreams: [
      { name: "official", endpoint: "relay.paseo.sh:443" },
      { name: "home", endpoint: "paseo.example.com:443" },
    ],
  });

/** A host that remembers what was committed, the way the plugin saves then applies. */
function harness(options: { failToSave?: boolean } = {}) {
  let current = start();
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

describe("actions", () => {
  it("sets the preference and goes back to Auto", () => {
    const { actions, config } = harness();
    expect(actions.setPreference({ mode: "preferred", preferred: "home" })).toEqual({ ok: true });
    expect(config().preference).toEqual({ mode: "preferred", preferred: "home" });
    expect(actions.setPreference({ mode: "auto" })).toEqual({ ok: true });
    expect(config().preference).toEqual({ mode: "auto", preferred: null });
  });

  it("adds a relay and reports the name it was given", () => {
    const { actions, config } = harness();
    expect(actions.addRelay({ address: "ws://198.51.100.10:8411" })).toEqual({ ok: true, name: "relay" });
    expect(config().upstreams.map((u) => u.name)).toEqual(["official", "home", "relay"]);
  });

  it("removes a relay", () => {
    const { actions, config } = harness();
    expect(actions.removeRelay({ name: "home" })).toEqual({ ok: true });
    expect(config().upstreams.map((u) => u.name)).toEqual(["official"]);
  });

  it("answers a refusal with a message and changes nothing", () => {
    const { actions, committed } = harness();
    const result = actions.addRelay({ address: "paseo.example.com" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/port/);
    expect(actions.removeRelay({ name: "ghost" }).ok).toBe(false);
    expect(actions.setPreference({ mode: "preferred", preferred: "ghost" }).ok).toBe(false);
    expect(committed).toHaveLength(0);
  });

  it("does not claim success, or change what is running, when the config cannot be saved", () => {
    const { actions, committed, config } = harness({ failToSave: true });
    const result = actions.addRelay({ address: "wss://relay.example.org" });
    expect(result).toEqual({ ok: false, error: "Could not save the config: EACCES: permission denied" });
    expect(committed).toHaveLength(0);
    expect(config().upstreams).toHaveLength(2);
  });

  it("reorders the relays and saves the order, or refuses without saving", () => {
    const { actions, committed, config } = harness();
    expect(actions.reorderRelays({ names: ["home", "official"] })).toEqual({ ok: true });
    expect(config().upstreams.map((u) => u.name)).toEqual(["home", "official"]);
    expect(committed).toHaveLength(1);

    const refused = actions.reorderRelays({ names: ["home"] });
    expect(refused.ok).toBe(false);
    expect(committed).toHaveLength(1);
  });

  it("builds each change on the one before it", () => {
    const { actions, config } = harness();
    actions.addRelay({ address: "wss://relay.example.org", name: "backup" });
    actions.setPreference({ mode: "preferred", preferred: "backup" });
    actions.removeRelay({ name: "home" });
    expect(config().upstreams.map((u) => u.name)).toEqual(["backup", "official"]);
    expect(config().preference).toEqual({ mode: "preferred", preferred: "backup" });
  });

  it("survives a round trip through the file, which is what a plugin reload does", () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "relay-fanout-actions-"));
    tempDirs.push(folder);
    const file = path.join(folder, "config.json");

    let current = start();
    const actions = createActions({
      config: () => current,
      runningListen: () => ({ host: "127.0.0.1", port: 7733 }),
      commit: (next) => {
        saveConfig(file, next);
        current = next;
      },
    });
    actions.addRelay({ address: "ws://198.51.100.10:8411", name: "netbird" });
    actions.setPreference({ mode: "preferred", preferred: "netbird" });

    const reloaded = loadConfig({ PASEO_RELAY_FANOUT_CONFIG: file }).config;
    expect(reloaded.upstreams.map((u) => [u.name, u.endpoint, u.useTls])).toEqual([
      ["netbird", "198.51.100.10:8411", false],
      ["official", "relay.paseo.sh:443", true],
      ["home", "paseo.example.com:443", true],
    ]);
    expect(reloaded.preference).toEqual({ mode: "preferred", preferred: "netbird" });
  });
});
