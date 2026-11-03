import { describe, expect, it } from "vitest";
import type { PluginStatus, UpstreamView } from "../shared/status";
import { READY_GRACE_MS, describeLatency, describeUpstream, formatMs, formatSince, summarize } from "../client/view-model";
import { EMPTY_STAT } from "../server/latency";
import type { UpstreamLatencyView } from "../shared/status";

const stat = (overrides: Partial<UpstreamLatencyView["request"]> = {}) => ({ ...EMPTY_STAT, ...overrides });
const latencyOf = (overrides: Partial<UpstreamLatencyView> = {}): UpstreamLatencyView => ({
  request: stat(),
  ping: stat(),
  connectMs: null,
  error: null,
  ...overrides,
});

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function upstream(overrides: Partial<UpstreamView> = {}): UpstreamView {
  return {
    name: "official",
    endpoint: "relay.paseo.sh:443",
    state: "connected",
    ready: true,
    connectedAt: ago(90_000),
    lastError: null,
    dataSockets: 0,
    ...overrides,
  };
}

function status(upstreams: UpstreamView[], overrides: Partial<PluginStatus> = {}): PluginStatus {
  return {
    listening: "127.0.0.1:7733",
    daemonConnected: true,
    serverId: "srv_test",
    upstreams,
    configPath: "C:/home/plugin-data/relay-fanout/config.json",
    configSource: "file",
    ...overrides,
  };
}

describe("formatSince", () => {
  it.each([
    [2_000, "just now"],
    [12_000, "12s"],
    [90_000, "1m"],
    [59 * 60_000, "59m"],
    [60 * 60_000, "1h"],
    [125 * 60_000, "2h 5m"],
    [49 * 3_600_000, "2d"],
  ])("renders %d ms ago as %s", (ms, expected) => {
    expect(formatSince(ago(ms), NOW)).toBe(expected);
  });

  it("returns null for a missing or unparseable time and never goes negative", () => {
    expect(formatSince(null, NOW)).toBeNull();
    expect(formatSince("not a date", NOW)).toBeNull();
    expect(formatSince(new Date(NOW + 60_000).toISOString(), NOW)).toBe("just now");
  });
});

describe("describeUpstream", () => {
  it("shows a ready relay as connected with its uptime and session count", () => {
    expect(describeUpstream(upstream({ dataSockets: 0 }), NOW)).toEqual({
      label: "Connected",
      tone: "ok",
      detail: "Up for 1m · no sessions",
    });
    expect(describeUpstream(upstream({ dataSockets: 1, connectedAt: ago(1_000) }), NOW).detail).toBe(
      "Up just now · 1 session",
    );
    expect(describeUpstream(upstream({ dataSockets: 3 }), NOW).detail).toBe("Up for 1m · 3 sessions");
  });

  it("gives a freshly connected relay time to send its first message, then flags it", () => {
    const fresh = upstream({ ready: false, connectedAt: ago(READY_GRACE_MS - 1_000) });
    expect(describeUpstream(fresh, NOW)).toMatchObject({ label: "Connecting", tone: "idle" });

    const silent = upstream({ ready: false, connectedAt: ago(READY_GRACE_MS + 1_000) });
    expect(describeUpstream(silent, NOW)).toMatchObject({ label: "No reply", tone: "warn" });
    expect(describeUpstream(silent, NOW).detail).toMatch(/incompatible/);
  });

  it("reports a down relay with its error", () => {
    expect(describeUpstream(upstream({ state: "down", lastError: "connect ECONNREFUSED 192.0.2.1:8411" }), NOW)).toEqual({
      label: "Down",
      tone: "bad",
      detail: "connect ECONNREFUSED 192.0.2.1:8411. Retrying.",
    });
    expect(describeUpstream(upstream({ state: "down", lastError: null }), NOW).detail).toBe("Retrying.");
  });

  it("treats connecting and idle as neutral", () => {
    expect(describeUpstream(upstream({ state: "connecting", ready: false }), NOW)).toMatchObject({
      label: "Connecting",
      tone: "idle",
    });
    expect(describeUpstream(upstream({ state: "idle", ready: false }), NOW)).toMatchObject({
      label: "Not registered",
      tone: "idle",
    });
  });
});

describe("summarize", () => {
  it("says the proxy is not answering when the request itself failed, even with old data", () => {
    const summary = summarize(status([upstream()]), true, NOW);
    expect(summary).toMatchObject({ tone: "bad", title: "Proxy not answering" });
  });

  it("is neutral while the first answer is pending", () => {
    expect(summarize(undefined, false, NOW)).toEqual({ tone: "idle", title: "Checking relays", detail: null });
  });

  it("tells the user how to fix a daemon that is not using the proxy", () => {
    const summary = summarize(status([upstream({ state: "idle", ready: false })], { daemonConnected: false }), false, NOW);
    expect(summary.tone).toBe("warn");
    expect(summary.title).toBe("Daemon not using the proxy");
    expect(summary.detail).toBe("Set daemon.relay.endpoint to 127.0.0.1:7733 with TLS off, then restart the daemon.");
  });

  it("is green only when every relay is connected and ready", () => {
    const two = status([upstream(), upstream({ name: "home", endpoint: "paseo.example.com:443" })]);
    expect(summarize(two, false, NOW)).toEqual({ tone: "ok", title: "All 2 relays connected", detail: null });
    expect(summarize(status([upstream()]), false, NOW).title).toBe("Relay connected");
  });

  it("is amber when some relays are down and names them", () => {
    const mixed = status([upstream(), upstream({ name: "home", state: "down", ready: false, lastError: "x" })]);
    expect(summarize(mixed, false, NOW)).toEqual({
      tone: "warn",
      title: "1 of 2 relays connected",
      detail: "Not connected: home.",
    });
  });

  it("is red when the daemon is registered but no relay accepted it", () => {
    const none = status([
      upstream({ state: "down", ready: false }),
      upstream({ name: "home", state: "down", ready: false }),
    ]);
    expect(summarize(none, false, NOW)).toEqual({
      tone: "bad",
      title: "No relay connected",
      detail: "Not connected: official, home.",
    });
  });

  it("does not count a connected but silent relay as healthy", () => {
    const silent = status([upstream({ ready: false, connectedAt: ago(READY_GRACE_MS + 5_000) })]);
    expect(summarize(silent, false, NOW)).toMatchObject({ tone: "bad", title: "No relay connected" });
  });
});

describe("formatMs", () => {
  it.each([
    [0.4, "<1 ms"],
    [0.99, "<1 ms"],
    [1, "1.0 ms"],
    [2.44, "2.4 ms"],
    [9.96, "10.0 ms"],
    [10, "10 ms"],
    [73.4, "73 ms"],
    [999.4, "999 ms"],
    [1242, "1.2 s"],
    [4423, "4.4 s"],
    [12400, "12 s"],
  ])("renders %d ms as %s", (ms, expected) => {
    expect(formatMs(ms)).toBe(expected);
  });
});

describe("describeLatency", () => {
  const healthy = stat({ lastOk: true, lastMs: 15, avgMs: 16, minMs: 14, maxMs: 22, answered: 12, lost: 0 });
  const rowOf = (lines: ReturnType<typeof describeLatency>, label: string) => lines?.rows.find((row) => row.label === label);

  it("shows nothing for a plugin too old to measure", () => {
    expect(describeLatency(undefined)).toBeNull();
  });

  it("says it is measuring before the first sample", () => {
    expect(describeLatency(latencyOf())).toEqual({
      rows: [{ label: "Request", value: "Measuring", bad: false, detail: null }],
      error: null,
      note: null,
    });
  });

  it("shows the request, the socket ping and the connection time as separate rows", () => {
    const lines = describeLatency(
      latencyOf({ request: healthy, ping: stat({ lastOk: true, lastMs: 14, answered: 1 }), connectMs: 86 }),
    );
    expect(lines?.rows).toEqual([
      { label: "Request", value: "15 ms", bad: false, detail: "avg 16 ms · best 14 ms · worst 22 ms" },
      { label: "Socket ping", value: "14 ms", bad: false, detail: null },
      { label: "Connect", value: "86 ms", bad: false, detail: null },
    ]);
    expect(lines?.note).toBeNull();
  });

  it("does not print a spread from a single sample", () => {
    const one = stat({ lastOk: true, lastMs: 20, avgMs: 20, minMs: 20, maxMs: 20, answered: 1 });
    expect(rowOf(describeLatency(latencyOf({ request: one })), "Request")?.detail).toBeNull();
  });

  it("gives the ping its own spread and loss count", () => {
    const ping = stat({ lastOk: true, lastMs: 401, avgMs: 395, minMs: 388, maxMs: 401, answered: 4, lost: 1 });
    expect(rowOf(describeLatency(latencyOf({ request: healthy, ping })), "Socket ping")).toEqual({
      label: "Socket ping",
      value: "401 ms",
      bad: false,
      detail: "avg 395 ms · best 388 ms · worst 401 ms · 1 of 5 lost",
    });
  });

  it("does not rank the two: a quick request with a slow ping, as seen on the home relay's tunnel, shows both and a note", () => {
    const request = stat({ lastOk: true, lastMs: 45, avgMs: 60, minMs: 45, maxMs: 75, answered: 2 });
    const ping = stat({ lastOk: true, lastMs: 400, avgMs: 395, minMs: 388, maxMs: 401, answered: 4 });
    const lines = describeLatency(latencyOf({ request, ping, connectMs: 145 }));
    expect(rowOf(lines, "Request")?.value).toBe("45 ms");
    expect(rowOf(lines, "Socket ping")?.value).toBe("400 ms");
    expect(lines?.note).toMatch(/disagree/);
  });

  it("shows the same note when it is the request that is slow and the ping that is quick", () => {
    const request = stat({ lastOk: true, lastMs: 425, avgMs: 431, minMs: 404, maxMs: 1242, answered: 6 });
    const ping = stat({ lastOk: true, lastMs: 73, answered: 4 });
    expect(describeLatency(latencyOf({ request, ping }))?.note).toMatch(/disagree/);
  });

  it("stays quiet when the two are close, or when the gap is large only in ratio", () => {
    const close = stat({ lastOk: true, lastMs: 60, answered: 2, avgMs: 60, minMs: 60, maxMs: 60 });
    expect(describeLatency(latencyOf({ request: close, ping: stat({ lastOk: true, lastMs: 80, answered: 2 }) }))?.note).toBeNull();
    // 1 ms against 8 ms is eight times as much but nothing anyone would notice.
    const tiny = stat({ lastOk: true, lastMs: 1, answered: 2, avgMs: 1, minMs: 1, maxMs: 1 });
    expect(describeLatency(latencyOf({ request: tiny, ping: stat({ lastOk: true, lastMs: 8, answered: 2 }) }))?.note).toBeNull();
  });

  it("reports a relay that stopped answering requests, with the reason, and keeps the history", () => {
    const failing = stat({ lastOk: false, lastMs: 15, avgMs: 15, minMs: 14, maxMs: 16, answered: 3, lost: 2 });
    const lines = describeLatency(latencyOf({ request: failing, error: "HTTP 503" }));
    expect(rowOf(lines, "Request")).toEqual({
      label: "Request",
      value: "No answer",
      bad: true,
      detail: "avg 15 ms · best 14 ms · worst 16 ms · 2 of 5 failed",
    });
    expect(lines?.error).toBe("HTTP 503");
  });

  it("flags failures even while the latest request worked", () => {
    const flaky = stat({ lastOk: true, lastMs: 30, avgMs: 40, minMs: 30, maxMs: 50, answered: 8, lost: 2 });
    const row = rowOf(describeLatency(latencyOf({ request: flaky })), "Request");
    expect(row?.bad).toBe(false);
    expect(row?.detail).toContain("2 of 10 failed");
  });

  it("reports pings that go unanswered, without hiding the request", () => {
    const lines = describeLatency(latencyOf({ request: healthy, ping: stat({ lastOk: false, lost: 3 }) }));
    expect(rowOf(lines, "Socket ping")).toEqual({ label: "Socket ping", value: "No answer", bad: true, detail: "3 of 3 lost" });
    expect(rowOf(lines, "Request")?.value).toBe("15 ms");
    expect(lines?.error).toBeNull(); // the error text belongs to the request
  });

  it("omits the ping row while the relay is not connected and has produced no pings", () => {
    expect(describeLatency(latencyOf({ request: healthy }))?.rows.map((row) => row.label)).toEqual(["Request"]);
  });
});
