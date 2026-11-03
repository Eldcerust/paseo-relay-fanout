import { describe, expect, it } from "vitest";
import { EMPTY_STAT, LatencyProbe, LatencyWindow, type HealthClient, type HealthResult } from "../server/latency";

describe("LatencyWindow", () => {
  it("is empty until it has a sample", () => {
    expect(new LatencyWindow().stat()).toEqual(EMPTY_STAT);
  });

  it("summarizes answered samples", () => {
    const window = new LatencyWindow();
    for (const ms of [10, 20, 60]) window.record(ms);
    expect(window.stat()).toEqual({ lastOk: true, lastMs: 60, avgMs: 30, minMs: 10, maxMs: 60, answered: 3, lost: 0 });
  });

  it("keeps one decimal, so a sub-millisecond path is not shown as zero", () => {
    const window = new LatencyWindow();
    window.record(0.64);
    window.record(1.26);
    expect(window.stat()).toMatchObject({ lastMs: 1.3, minMs: 0.6, avgMs: 1 });
  });

  it("counts samples with no answer as lost and remembers the last answered one", () => {
    const window = new LatencyWindow();
    window.record(40);
    window.record(null);
    expect(window.stat()).toEqual({ lastOk: false, lastMs: 40, avgMs: 40, minMs: 40, maxMs: 40, answered: 1, lost: 1 });
    window.record(50);
    expect(window.stat()).toMatchObject({ lastOk: true, lastMs: 50, answered: 2, lost: 1 });
  });

  it("has no averages when nothing was ever answered", () => {
    const window = new LatencyWindow();
    window.record(null);
    window.record(null);
    expect(window.stat()).toEqual({ lastOk: false, lastMs: null, avgMs: null, minMs: null, maxMs: null, answered: 0, lost: 2 });
  });

  it("only remembers the most recent samples", () => {
    const window = new LatencyWindow(3);
    for (const ms of [1000, 10, 20, 30]) window.record(ms);
    expect(window.stat()).toMatchObject({ answered: 3, avgMs: 20, maxMs: 30 });
  });
});

/** A health client whose answers the test scripts, with a clock the test advances. */
function scriptedClient(script: Array<HealthResult | Error>) {
  const calls: number[] = [];
  const client: HealthClient = {
    async request() {
      calls.push(calls.length);
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      if (next instanceof Error) throw next;
      return next;
    },
    close() {},
  };
  return { client, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("LatencyProbe", () => {
  it("requests at most once per interval and never while a request is running", async () => {
    let clock = 1_000;
    const { client, calls } = scriptedClient([
      { ms: 12, reusedSocket: true },
      { ms: 14, reusedSocket: true },
    ]);
    const probe = new LatencyProbe(client, 5_000, () => clock);

    probe.sampleIfDue();
    probe.sampleIfDue(); // still running
    await settle();
    probe.sampleIfDue(); // finished, but too soon
    await settle();
    expect(calls).toHaveLength(1);

    clock += 5_000;
    probe.sampleIfDue();
    await settle();
    expect(calls).toHaveLength(2);
    expect(probe.snapshot().request).toMatchObject({ answered: 2, lastMs: 14 });
  });

  it("keeps connection setup apart from the round trip and takes a warm sample straight away", async () => {
    const { client, calls } = scriptedClient([
      { ms: 4_423, reusedSocket: false },
      { ms: 25, reusedSocket: true },
    ]);
    const probe = new LatencyProbe(client, 5_000, () => 0);

    probe.sampleIfDue();
    await settle();

    expect(calls).toHaveLength(2);
    expect(probe.snapshot()).toMatchObject({
      connectMs: 4_423,
      request: { answered: 1, lastMs: 25, maxMs: 25 },
      error: null,
    });
  });

  it("shows connection time, but no round trip, for a relay that never keeps connections alive", async () => {
    const { client } = scriptedClient([
      { ms: 90, reusedSocket: false },
      { ms: 80, reusedSocket: false },
    ]);
    const probe = new LatencyProbe(client, 5_000, () => 0);

    probe.sampleIfDue();
    await settle();

    expect(probe.snapshot()).toMatchObject({ connectMs: 80, request: { answered: 0, lost: 0 } });
  });

  it("records a failed request as lost with its reason, and recovers", async () => {
    let clock = 0;
    const { client } = scriptedClient([new Error("HTTP 503"), { ms: 30, reusedSocket: true }]);
    const probe = new LatencyProbe(client, 1_000, () => clock);

    probe.sampleIfDue();
    await settle();
    expect(probe.snapshot()).toMatchObject({ error: "HTTP 503", request: { lastOk: false, lost: 1, answered: 0 } });

    clock += 1_000;
    probe.sampleIfDue();
    await settle();
    expect(probe.snapshot()).toMatchObject({ error: null, request: { lastOk: true, lastMs: 30, lost: 1, answered: 1 } });
  });
});
