import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, parseConfig, saveConfig, serializeConfig } from "../server/config";

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-fanout-save-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("preference", () => {
  const two = [
    { name: "official", endpoint: "relay.paseo.sh:443" },
    { name: "home", endpoint: "paseo.example.com:443" },
  ];

  it("defaults to auto", () => {
    expect(parseConfig({ upstreams: two }).preference).toEqual({ mode: "auto", preferred: null });
    expect(parseConfig({ upstreams: two, preference: { mode: "auto" } }).preference).toEqual({ mode: "auto", preferred: null });
  });

  it("accepts a preferred relay that exists, and puts it first because the order is the priority", () => {
    const config = parseConfig({ upstreams: two, preference: { mode: "preferred", preferred: "home" } });
    expect(config.preference).toEqual({ mode: "preferred", preferred: "home" });
    expect(config.upstreams.map((upstream) => upstream.name)).toEqual(["home", "official"]);
  });

  it("keeps the order as written in Auto, where it is only remembered", () => {
    const config = parseConfig({ upstreams: two, preference: { mode: "auto" } });
    expect(config.upstreams.map((upstream) => upstream.name)).toEqual(["official", "home"]);
  });

  it.each([
    ["a relay that is not in the list", { mode: "preferred", preferred: "gone" }],
    ["no relay named at all", { mode: "preferred" }],
    ["an unknown mode", { mode: "fastest" }],
  ])("rejects %s", (_label, preference) => {
    expect(() => parseConfig({ upstreams: two, preference })).toThrow(/preference/);
  });
});

describe("saving", () => {
  const sample = parseConfig({
    listen: { port: 7800 },
    upstreams: [
      { name: "official", endpoint: "relay.paseo.sh:443" },
      { name: "lan", endpoint: "192.0.2.10:8411" },
    ],
    preference: { mode: "preferred", preferred: "lan" },
  });

  it("writes a file that reads back as the same config", () => {
    const file = path.join(tempHome(), "config.json");
    saveConfig(file, sample);
    expect(loadConfig({ PASEO_RELAY_FANOUT_CONFIG: file }).config).toEqual(sample);
  });

  it("creates the folder if it is missing and leaves no temporary file behind", () => {
    const folder = path.join(tempHome(), "plugin-data", "relay-fanout");
    const file = path.join(folder, "config.json");
    saveConfig(file, sample);
    saveConfig(file, { ...sample, preference: { mode: "auto", preferred: null } });
    expect(readdirSync(folder)).toEqual(["config.json"]);
    expect(loadConfig({ PASEO_RELAY_FANOUT_CONFIG: file }).config.preference.mode).toBe("auto");
  });

  it("writes readable, stable JSON that ends with a newline", () => {
    const text = serializeConfig(sample);
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(["listen", "upstreams", "preference"]);
    expect(serializeConfig(sample)).toBe(text);
  });

  it("spells out TLS for every relay, so the file does not depend on the port heuristic", () => {
    const parsed = JSON.parse(serializeConfig(sample)) as { upstreams: Array<{ useTls: boolean }> };
    expect(parsed.upstreams.map((u) => u.useTls)).toEqual([false, true]);
  });
});
