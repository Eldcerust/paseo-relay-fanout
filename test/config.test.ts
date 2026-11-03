import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LISTEN_HOST,
  DEFAULT_LISTEN_PORT,
  loadConfig,
  parseConfig,
  resolveConfigPath,
} from "../server/config";
import { parsePrefixedConnectionId, prefixConnectionId } from "../server/ids";

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-fanout-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("parseConfig", () => {
  it("fills in listen defaults and infers TLS from port 443", () => {
    const config = parseConfig({
      upstreams: [
        { name: "official", endpoint: "relay.paseo.sh:443" },
        { name: "lan", endpoint: "192.0.2.10:8411" },
        { name: "forced", endpoint: "relay.example.org:8443", useTls: true },
      ],
    });
    expect(config.listen).toEqual({ host: DEFAULT_LISTEN_HOST, port: DEFAULT_LISTEN_PORT });
    expect(config.upstreams.map((u) => [u.name, u.useTls])).toEqual([
      ["official", true],
      ["lan", false],
      ["forced", true],
    ]);
  });

  it("accepts bracketed IPv6 endpoints", () => {
    const config = parseConfig({ upstreams: [{ name: "v6", endpoint: "[fd00::66]:8411" }] });
    expect(config.upstreams[0]?.endpoint).toBe("[fd00::66]:8411");
  });

  it.each([
    ["no upstreams", { upstreams: [] }, /upstreams/],
    ["a missing endpoint port", { upstreams: [{ name: "a", endpoint: "relay.paseo.sh" }] }, /host:port/],
    ["an endpoint with a scheme", { upstreams: [{ name: "a", endpoint: "wss://relay.paseo.sh:443" }] }, /host:port/],
    ["an uppercase name", { upstreams: [{ name: "Official", endpoint: "a.b:1" }] }, /lowercase/],
    ["a name with a colon", { upstreams: [{ name: "a:b", endpoint: "a.b:1" }] }, /lowercase/],
    [
      "duplicate names",
      { upstreams: [{ name: "a", endpoint: "a.b:1" }, { name: "a", endpoint: "c.d:2" }] },
      /duplicate upstream name "a"/,
    ],
    [
      "a network-facing listen host",
      { listen: { host: "0.0.0.0" }, upstreams: [{ name: "a", endpoint: "a.b:1" }] },
      /loopback/,
    ],
    [
      "an out-of-range port",
      { listen: { port: 70000 }, upstreams: [{ name: "a", endpoint: "a.b:1" }] },
      /port/,
    ],
  ])("rejects %s", (_label, input, message) => {
    expect(() => parseConfig(input)).toThrow(message);
  });

  it("rejects more than eight upstreams", () => {
    const upstreams = Array.from({ length: 9 }, (_, i) => ({ name: `r${i}`, endpoint: `h${i}.test:443` }));
    expect(() => parseConfig({ upstreams })).toThrow(/upstreams/);
  });
});

describe("loadConfig", () => {
  it("falls back to the official relay when no config file exists", () => {
    const home = tempHome();
    const loaded = loadConfig({ PASEO_HOME: home });
    expect(loaded.source).toBe("default");
    expect(loaded.config.upstreams).toEqual([
      { name: "official", endpoint: "relay.paseo.sh:443", useTls: true },
    ]);
  });

  it("reads plugin-data/relay-fanout/config.json under PASEO_HOME", () => {
    const home = tempHome();
    const file = resolveConfigPath({ PASEO_HOME: home });
    expect(file).toBe(path.join(home, "plugin-data", "relay-fanout", "config.json"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        listen: { port: 7800 },
        upstreams: [
          { name: "official", endpoint: "relay.paseo.sh:443" },
          { name: "home", endpoint: "198.51.100.10:8411" },
        ],
      }),
    );
    const loaded = loadConfig({ PASEO_HOME: home });
    expect(loaded.source).toBe("file");
    expect(loaded.config.listen.port).toBe(7800);
    expect(loaded.config.upstreams.map((u) => u.name)).toEqual(["official", "home"]);
  });

  it("honors PASEO_RELAY_FANOUT_CONFIG", () => {
    const home = tempHome();
    const file = path.join(home, "custom.json");
    writeFileSync(file, JSON.stringify({ upstreams: [{ name: "only", endpoint: "a.b:443" }] }));
    expect(loadConfig({ PASEO_RELAY_FANOUT_CONFIG: file }).config.upstreams[0]?.name).toBe("only");
  });

  it("fails loudly on broken JSON and on invalid content, naming the file", () => {
    const home = tempHome();
    const file = path.join(home, "bad.json");
    writeFileSync(file, "{ not json");
    expect(() => loadConfig({ PASEO_RELAY_FANOUT_CONFIG: file })).toThrow(/bad\.json is not valid JSON/);
    writeFileSync(file, JSON.stringify({ upstreams: [] }));
    expect(() => loadConfig({ PASEO_RELAY_FANOUT_CONFIG: file })).toThrow(/Invalid relay-fanout config/);
  });
});

describe("connection id prefixing", () => {
  it("round-trips ids, including ones that contain a colon", () => {
    expect(prefixConnectionId("home", "conn_1")).toBe("home:conn_1");
    expect(parsePrefixedConnectionId("home:conn_1")).toEqual({ upstream: "home", connectionId: "conn_1" });
    expect(parsePrefixedConnectionId("home:a:b")).toEqual({ upstream: "home", connectionId: "a:b" });
  });

  it.each(["", "conn_1", ":conn_1", "home:"])("rejects %j", (value) => {
    expect(parsePrefixedConnectionId(value)).toBeNull();
  });
});
