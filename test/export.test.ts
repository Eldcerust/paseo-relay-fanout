import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig, serializeConfig } from "../server/config";
import { EXPORT_DIR, exportConfig, exportFilename } from "../server/export";

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-fanout-export-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const sample = parseConfig({
  listen: { port: 7800 },
  upstreams: [
    { name: "official", endpoint: "relay.paseo.sh:443" },
    { name: "lan", endpoint: "192.0.2.10:8411" },
  ],
  preference: { mode: "preferred", preferred: "lan" },
});

const at = new Date("2026-11-04T12:30:00.123Z");

describe("exporting the config", () => {
  it("names the file by the moment it was written, without characters Windows refuses", () => {
    const name = exportFilename(at);
    expect(name).toBe("relay-fanout-config-2026-11-04T12-30-00Z.json");
    expect(name).not.toMatch(/[:*?"<>|]/);
  });

  it("writes a file beside the config that reads back as the same config", () => {
    const configPath = path.join(tempHome(), "plugin-data", "relay-fanout", "config.json");
    const exported = exportConfig({ config: sample, configPath, at });

    expect(exported.path).toBe(path.join(path.dirname(configPath), EXPORT_DIR, exported.filename));
    expect(readFileSync(exported.path, "utf8")).toBe(serializeConfig(sample));
    expect(parseConfig(JSON.parse(exported.json))).toEqual(sample);
  });

  it("answers with the exact text it wrote, so a copy on a phone is the same file", () => {
    const exported = exportConfig({ config: sample, configPath: path.join(tempHome(), "config.json"), at });
    expect(exported.json).toBe(readFileSync(exported.path, "utf8"));
  });

  it("creates the exports folder when it is missing, and leaves the config alone", () => {
    const folder = path.join(tempHome(), "plugin-data", "relay-fanout");
    const configPath = path.join(folder, "config.json");
    const exported = exportConfig({ config: sample, configPath, at });

    expect(existsSync(path.join(folder, EXPORT_DIR))).toBe(true);
    expect(existsSync(configPath)).toBe(false);
    expect(readdirSync(path.dirname(exported.path))).toEqual([exported.filename]);
  });

  it("keeps an earlier export when the same moment comes round twice", () => {
    const configPath = path.join(tempHome(), "config.json");
    const first = exportConfig({ config: sample, configPath, at });
    const second = exportConfig({
      config: { ...sample, preference: { mode: "auto", preferred: null } },
      configPath,
      at,
    });

    expect(second.filename).toBe(first.filename.replace(/\.json$/, "-2.json"));
    expect(readdirSync(path.dirname(first.path)).sort()).toEqual([first.filename, second.filename].sort());
    expect(parseConfig(JSON.parse(second.json)).preference).toEqual({ mode: "auto", preferred: null });
  });

  it("exports what is running now, not what was loaded at startup", () => {
    let current = sample;
    const configPath = path.join(tempHome(), "config.json");
    current = { ...sample, upstreams: sample.upstreams.slice(0, 1), preference: { mode: "auto", preferred: null } };

    const exported = exportConfig({ config: current, configPath, at });
    const written = JSON.parse(exported.json) as { upstreams: Array<{ name: string }> };
    expect(written.upstreams.map((upstream) => upstream.name)).toEqual(["lan"]);
  });
});
