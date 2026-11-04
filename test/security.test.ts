import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPairingLinks } from "../server/pairing";
import { MAX_IMPORT_BYTES, parseImportedConfig } from "../server/import";

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-fanout-security-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function homeWith(config: unknown): string {
  const home = tempHome();
  writeFileSync(path.join(home, "daemon-keypair.json"), JSON.stringify({ publicKeyB64: "public-key" }), "utf8");
  writeFileSync(path.join(home, "config.json"), JSON.stringify(config), "utf8");
  return home;
}

const upstreams = [{ name: "official", endpoint: "relay.paseo.sh:443", useTls: true }];

describe("pairing links", () => {
  it("keeps an http(s) app address the daemon's config names", () => {
    const home = homeWith({ app: { baseUrl: "https://app.example.com/" } });
    const result = buildPairingLinks({ home, upstreams, liveServerId: "srv_test" });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.links[0]!.link.startsWith("https://app.example.com/#offer=")).toBe(true);
  });

  it("refuses to build a link on a scheme that is not http(s)", () => {
    const home = homeWith({ app: { baseUrl: "javascript:alert(document.cookie)" } });
    const result = buildPairingLinks({ home, upstreams, liveServerId: "srv_test" });

    expect(result.available).toBe(true);
    if (!result.available) return;
    const link = result.links[0]!.link;
    expect(link.startsWith("https://app.paseo.sh/#offer=")).toBe(true);
    expect(link).not.toContain("javascript:");
  });

  it("falls back to the default app when the address is not a URL at all", () => {
    const home = homeWith({ app: { baseUrl: "not a url" } });
    const result = buildPairingLinks({ home, upstreams, liveServerId: "srv_test" });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.links[0]!.link.startsWith("https://app.paseo.sh/#offer=")).toBe(true);
  });
});

describe("importing a config", () => {
  it("refuses a payload far larger than a config before parsing it", () => {
    const huge = `{"padding":"${"a".repeat(MAX_IMPORT_BYTES)}"}`;
    expect(() => parseImportedConfig(huge)).toThrow(/larger than/);
  });

  it("still accepts a config of the usual size", () => {
    const text = JSON.stringify({ upstreams: [{ name: "official", endpoint: "relay.paseo.sh:443" }] });
    expect(parseImportedConfig(text).upstreams).toHaveLength(1);
  });
});
