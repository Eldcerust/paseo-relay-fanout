import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Upstream } from "../server/config";
import { buildPairingLinks } from "../server/pairing";
import { buildStatus, createStatusHandler } from "../server/status";
import { pairingRpc, statusRpc } from "../shared/status";
import type { ProxyStatus } from "../server/proxy";
import { EMPTY_STAT } from "../server/latency";

const noLatency = { request: { ...EMPTY_STAT }, ping: { ...EMPTY_STAT }, connectMs: null, error: null };
const activePriority = { role: "active" as const, preferred: false, nextRetestAt: null };

const PUBLIC_KEY = "KgDGdTYaGmRUI20FLchhDKJfl17Y2d1vGe8LhMXnv2s=";
const SECRET_KEY = "SECRET-DO-NOT-LEAK-c2VjcmV0LWtleS1ieXRlcw==";

const upstreams: Upstream[] = [
  { name: "official", endpoint: "relay.paseo.sh:443", useTls: true },
  { name: "home", endpoint: "198.51.100.10:8411", useTls: false },
];

const tempDirs: string[] = [];

function homeWith(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-fanout-pairing-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return dir;
}

const identity = {
  "server-id": "srv_MrW6ZeMA7Xet",
  "daemon-keypair.json": JSON.stringify({ v: 2, publicKeyB64: PUBLIC_KEY, secretKeyB64: SECRET_KEY }),
};

function decodeOffer(link: string) {
  const encoded = link.split("#offer=")[1] ?? "";
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("buildPairingLinks", () => {
  it("builds one offer per relay in the daemon's own format", () => {
    const result = buildPairingLinks({ home: homeWith(identity), upstreams, liveServerId: null });
    if (!result.available) throw new Error(result.reason);

    expect(result.links.map((l) => l.name)).toEqual(["official", "home"]);
    expect(result.links[0]?.link.startsWith("https://app.paseo.sh/#offer=")).toBe(true);
    expect(decodeOffer(result.links[0]!.link)).toEqual({
      v: 2,
      serverId: "srv_MrW6ZeMA7Xet",
      daemonPublicKeyB64: PUBLIC_KEY,
      relay: { endpoint: "relay.paseo.sh:443", useTls: true },
    });
    expect(decodeOffer(result.links[1]!.link).relay).toEqual({ endpoint: "198.51.100.10:8411", useTls: false });
  });

  it("keeps the exact key order the daemon writes, so links match byte for byte", () => {
    const result = buildPairingLinks({ home: homeWith(identity), upstreams: [upstreams[0]!], liveServerId: null });
    if (!result.available) throw new Error(result.reason);
    const json = Buffer.from(result.links[0]!.link.split("#offer=")[1]!, "base64url").toString("utf8");
    expect(json).toBe(
      `{"v":2,"serverId":"srv_MrW6ZeMA7Xet","daemonPublicKeyB64":"${PUBLIC_KEY}","relay":{"endpoint":"relay.paseo.sh:443","useTls":true}}`,
    );
  });

  it("never exposes the secret key anywhere in the result", () => {
    const result = buildPairingLinks({ home: homeWith(identity), upstreams, liveServerId: null });
    const everything = JSON.stringify(result) + JSON.stringify(result.available ? result.links.map((l) => decodeOffer(l.link)) : "");
    expect(everything).not.toContain("SECRET");
    expect(everything).not.toContain(SECRET_KEY);
  });

  it("prefers the server id the daemon registered with over the file", () => {
    const result = buildPairingLinks({ home: homeWith(identity), upstreams: [upstreams[0]!], liveServerId: "srv_live" });
    if (!result.available) throw new Error(result.reason);
    expect(decodeOffer(result.links[0]!.link).serverId).toBe("srv_live");
  });

  it("uses the app base url from config.json and requires protected mode when the daemon does", () => {
    const home = homeWith({
      ...identity,
      "config.json": JSON.stringify({
        app: { baseUrl: "https://paseo.example.org/" },
        daemon: { relay: { requireProtectedSecurity: true } },
      }),
    });
    const result = buildPairingLinks({ home, upstreams: [upstreams[0]!], liveServerId: null });
    if (!result.available) throw new Error(result.reason);
    expect(result.links[0]!.link.startsWith("https://paseo.example.org/#offer=")).toBe(true);
    expect(decodeOffer(result.links[0]!.link).minimumSecurityMode).toBe("protected");
  });

  it("omits minimumSecurityMode when protected mode is not required", () => {
    const home = homeWith({ ...identity, "config.json": JSON.stringify({ daemon: { relay: {} } }) });
    const result = buildPairingLinks({ home, upstreams: [upstreams[0]!], liveServerId: null });
    if (!result.available) throw new Error(result.reason);
    expect(decodeOffer(result.links[0]!.link)).not.toHaveProperty("minimumSecurityMode");
  });

  it("explains what is missing instead of guessing", () => {
    const noServerId = buildPairingLinks({
      home: homeWith({ "daemon-keypair.json": identity["daemon-keypair.json"] }),
      upstreams,
      liveServerId: null,
    });
    expect(noServerId).toEqual({ available: false, reason: "The daemon's server id is not available yet." });

    const noKey = buildPairingLinks({ home: homeWith({ "server-id": "srv_x" }), upstreams, liveServerId: null });
    expect(noKey.available).toBe(false);
    expect(!noKey.available && noKey.reason).toMatch(/public key/);

    const brokenKey = buildPairingLinks({
      home: homeWith({ "server-id": "srv_x", "daemon-keypair.json": "{ not json" }),
      upstreams,
      liveServerId: null,
    });
    expect(brokenKey.available).toBe(false);
  });
});

describe("rpc contracts", () => {
  const proxyStatus: ProxyStatus = {
    status: "ok",
    listening: "127.0.0.1:7733",
    daemonConnected: true,
    serverId: "srv_test",
    preference: { mode: "auto", preferred: null },
    fallbackActive: false,
    upstreams: [
      {
        name: "official",
        endpoint: "relay.paseo.sh:443",
        state: "connected",
        ready: true,
        connectedAt: "2026-11-03T12:00:00.000Z",
        lastError: null,
        dataSockets: 2,
        latency: noLatency,
        priority: activePriority,
      },
      {
        name: "home",
        endpoint: "198.51.100.10:8411",
        state: "down",
        ready: false,
        connectedAt: null,
        lastError: "connect ECONNREFUSED",
        dataSockets: 0,
        latency: noLatency,
        priority: activePriority,
      },
    ],
  };

  it("maps the proxy status into the status contract and drops the internal field", () => {
    const status = buildStatus({ status: () => proxyStatus }, { configPath: "C:/c.json", configSource: "file" });
    expect(statusRpc.output.parse(status)).toEqual(status);
    expect(status).not.toHaveProperty("status");
    expect(status.configSource).toBe("file");
  });

  it("accepts both pairing outcomes and rejects an inconsistent one", () => {
    const ok = buildPairingLinks({ home: homeWith(identity), upstreams, liveServerId: null });
    expect(pairingRpc.output.parse(ok)).toEqual(ok);
    expect(pairingRpc.output.parse({ available: false, reason: "nope" })).toEqual({ available: false, reason: "nope" });
    expect(() => pairingRpc.output.parse({ available: true, reason: "nope" })).toThrow();
  });
});

describe("status handler", () => {
  const meta = { configPath: "C:/c.json", configSource: "file" as const };
  const status: ProxyStatus = {
    status: "ok",
    listening: "127.0.0.1:7733",
    daemonConnected: false,
    serverId: null,
    upstreams: [],
    preference: { mode: "auto", preferred: null },
    fallbackActive: false,
  };

  it("refreshes the relays' latency only when the caller asks for a measurement", () => {
    let touched = 0;
    const handler = createStatusHandler({ status: () => status, touch: () => void (touched += 1) }, meta);

    handler({});
    handler({ measure: false });
    expect(touched).toBe(0); // the sidebar's background polling

    handler({ measure: true });
    expect(touched).toBe(1); // the open screen
  });

  it("answers with the same status either way", () => {
    const handler = createStatusHandler({ status: () => status, touch: () => undefined }, meta);
    expect(handler({ measure: true })).toEqual(handler({}));
    expect(statusRpc.input.parse({})).toEqual({});
    expect(statusRpc.input.parse({ measure: true })).toEqual({ measure: true });
  });
});
