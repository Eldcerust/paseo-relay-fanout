import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createActions } from "../server/actions";
import { parseConfig, serializeConfig, type FanoutConfig } from "../server/config";
import { exportConfig } from "../server/export";
import { describeConfig, needsRestart, parseImportedConfig } from "../server/import";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const base = (): FanoutConfig =>
  parseConfig({
    upstreams: [
      { name: "official", endpoint: "relay.paseo.sh:443" },
      { name: "home", endpoint: "paseo.example.com:443" },
    ],
  });

const incoming = (): FanoutConfig =>
  parseConfig({
    listen: { port: 7800 },
    upstreams: [
      { name: "official", endpoint: "relay.paseo.sh:443" },
      { name: "lan", endpoint: "192.0.2.10:8411" },
    ],
    preference: { mode: "preferred", preferred: "lan" },
  });

/** The same host the plugin wires: the proxy keeps the address it started on. */
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

describe("reading a pasted file", () => {
  it("reads back what the plugin exported", () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "relay-fanout-import-"));
    tempDirs.push(folder);
    const exported = exportConfig({ config: incoming(), configPath: path.join(folder, "config.json") });
    expect(parseImportedConfig(exported.json)).toEqual(incoming());
  });

  it("accepts a hand-written file that leaves the optional fields out", () => {
    const config = parseImportedConfig(
      JSON.stringify({ upstreams: [{ name: "only", endpoint: "relay.example.org:443" }] }),
    );
    expect(config.upstreams).toHaveLength(1);
    expect(config.preference).toEqual({ mode: "auto", preferred: null });
    expect(config.listen).toEqual({ host: "127.0.0.1", port: 7733 });
  });

  it.each([
    ["empty text", "", /Paste/],
    ["text that is not JSON", "upstreams: official", /not valid JSON/],
    ["JSON with no relays", '{"upstreams": []}', /upstreams/],
    ["a relay without a port", '{"upstreams":[{"name":"home","endpoint":"relay.example.org"}]}', /host:port/],
    [
      "a preference for a relay that is not there",
      '{"upstreams":[{"name":"home","endpoint":"relay.example.org:443"}],"preference":{"mode":"preferred","preferred":"ghost"}}',
      /preference/,
    ],
  ])("refuses %s with a message", (_label, text, pattern) => {
    expect(() => parseImportedConfig(text)).toThrow(pattern);
  });
});

describe("showing the file before it is applied", () => {
  it("lists the relays, the priority and the address", () => {
    expect(describeConfig(incoming())).toEqual({
      relays: [
        { name: "lan", endpoint: "192.0.2.10:8411", useTls: false },
        { name: "official", endpoint: "relay.paseo.sh:443", useTls: true },
      ],
      preference: { mode: "preferred", preferred: "lan" },
      listen: { host: "127.0.0.1", port: 7800 },
    });
  });

  it("knows when the file would move the proxy", () => {
    expect(needsRestart({ host: "127.0.0.1", port: 7733 }, { host: "127.0.0.1", port: 7733 })).toBe(false);
    expect(needsRestart({ host: "127.0.0.1", port: 7733 }, { host: "127.0.0.1", port: 7800 })).toBe(true);
    expect(needsRestart({ host: "127.0.0.1", port: 7733 }, { host: "::1", port: 7733 })).toBe(true);
  });
});

describe("importing", () => {
  it("only checks the file until it is applied", () => {
    const { actions, committed, config } = harness();
    const result = actions.importConfig({ json: serializeConfig(incoming()) });

    expect(result).toEqual({
      ok: true,
      applied: false,
      summary: describeConfig(incoming()),
      restartRequired: true,
    });
    expect(committed).toHaveLength(0);
    expect(config().upstreams).toHaveLength(2);
  });

  it("saves and applies when asked", () => {
    const { actions, committed, config } = harness();
    const result = actions.importConfig({ json: serializeConfig(incoming()), apply: true });

    expect(result.ok && result.applied).toBe(true);
    expect(committed).toHaveLength(1);
    expect(config()).toEqual(incoming());
  });

  it("says a moved proxy address waits for the next start", () => {
    const { actions } = harness();
    const result = actions.importConfig({ json: serializeConfig(incoming()), apply: true });
    expect(result.ok && result.restartRequired).toBe(true);
  });

  it("does not call a file with the same address a restart", () => {
    const { actions } = harness();
    const same = { ...incoming(), listen: { host: "127.0.0.1", port: 7733 } };
    const result = actions.importConfig({ json: serializeConfig(same), apply: true });
    expect(result.ok && result.restartRequired).toBe(false);
  });

  it("changes nothing when the file cannot be read", () => {
    const { actions, committed, config } = harness();
    const result = actions.importConfig({ json: "{}", apply: true });

    expect(result.ok).toBe(false);
    expect(committed).toHaveLength(0);
    expect(config().upstreams.map((upstream) => upstream.name)).toEqual(["official", "home"]);
  });

  it("does not claim success when the config cannot be saved", () => {
    const { actions, committed, config } = harness({ failToSave: true });
    const result = actions.importConfig({ json: serializeConfig(incoming()), apply: true });

    expect(result).toEqual({ ok: false, error: "Could not save the config: EACCES: permission denied" });
    expect(committed).toHaveLength(0);
    expect(config().upstreams.map((upstream) => upstream.name)).toEqual(["official", "home"]);
  });
});
