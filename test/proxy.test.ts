import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Upstream } from "../server/config";
import { FanoutProxy, type Timing } from "../server/proxy";
import {
  FakeDaemon,
  FakeRelay,
  encryptedRequest,
  encryptedUpperCase,
  fastTiming,
  newKeyPair,
  rawEcho,
  silentLogger,
  toBuffer,
  upgradeStatus,
  waitFor,
  type DataHandler,
} from "./helpers";

const SERVER_ID = "srv_test";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function startRelay(
  name: string,
  port = 0,
  options: { answerPings?: boolean; pongDelayMs?: number } = {},
): Promise<FakeRelay> {
  const relay = new FakeRelay(name, options);
  await relay.listen(port);
  cleanups.push(() => (relay.listening ? relay.close() : undefined));
  return relay;
}

function upstreamFor(name: string, port: number): Upstream {
  return { name, endpoint: `127.0.0.1:${port}`, useTls: false };
}

async function startProxy(upstreams: Upstream[], timing: Partial<Timing> = {}): Promise<FanoutProxy> {
  const proxy = new FanoutProxy({
    host: "127.0.0.1",
    port: 0,
    upstreams,
    logger: silentLogger,
    timing: { ...fastTiming, ...timing },
  });
  await proxy.start();
  cleanups.push(() => proxy.stop());
  return proxy;
}

async function startDaemon(proxy: FanoutProxy, onData: DataHandler): Promise<FakeDaemon> {
  const daemon = new FakeDaemon(proxy.port, SERVER_ID, onData);
  cleanups.push(() => daemon.stop());
  await daemon.start();
  return daemon;
}

/** A TCP port that nothing is listening on right now. */
async function freePort(): Promise<number> {
  const probe = new FakeRelay("probe");
  const port = await probe.listen();
  await probe.close();
  return port;
}

describe("two relays, one daemon", () => {
  it("registers the daemon with both relays and keeps their sessions apart", async () => {
    const { keyPair, publicKeyB64 } = newKeyPair();
    const official = await startRelay("official");
    const home = await startRelay("home");
    const proxy = await startProxy([
      upstreamFor("official", official.port),
      upstreamFor("home", home.port),
    ]);
    const daemon = await startDaemon(proxy, encryptedUpperCase(keyPair));

    await waitFor(() => official.control !== null && home.control !== null, "both relays to see the daemon");

    // Both relays mint "conn_1" for their first client; the daemon must see them as distinct.
    const [viaOfficial, viaHome] = await Promise.all([
      encryptedRequest(official, SERVER_ID, publicKeyB64, "hello official"),
      encryptedRequest(home, SERVER_ID, publicKeyB64, "hello home"),
    ]);

    expect(viaOfficial).toBe("HELLO OFFICIAL");
    expect(viaHome).toBe("HELLO HOME");
    expect(daemon.controlMessages.some((m) => m.type === "connected" && m.connectionId === "official:conn_1")).toBe(true);
    expect(daemon.controlMessages.some((m) => m.type === "connected" && m.connectionId === "home:conn_1")).toBe(true);
  });

  it("serves several clients on one relay while the other relay is busy", async () => {
    const { keyPair, publicKeyB64 } = newKeyPair();
    const official = await startRelay("official");
    const home = await startRelay("home");
    const proxy = await startProxy([
      upstreamFor("official", official.port),
      upstreamFor("home", home.port),
    ]);
    await startDaemon(proxy, encryptedUpperCase(keyPair));
    await waitFor(() => official.control !== null && home.control !== null, "both relays");

    const replies = await Promise.all([
      encryptedRequest(official, SERVER_ID, publicKeyB64, "a1"),
      encryptedRequest(official, SERVER_ID, publicKeyB64, "a2"),
      encryptedRequest(home, SERVER_ID, publicKeyB64, "h1"),
      encryptedRequest(home, SERVER_ID, publicKeyB64, "h2"),
    ]);
    expect(replies).toEqual(["A1", "A2", "H1", "H2"]);
  });

  it("keeps text and binary frame types intact in both directions", async () => {
    const official = await startRelay("official");
    const proxy = await startProxy([upstreamFor("official", official.port)]);
    await startDaemon(proxy, rawEcho);
    await waitFor(() => official.control !== null, "the relay to see the daemon");

    const client = await official.connectClient(SERVER_ID);
    const received: Array<{ text: string; isBinary: boolean }> = [];
    client.on("message", (data, isBinary) => {
      received.push({ text: toBuffer(data).toString("hex"), isBinary });
    });
    client.send("hi");
    client.send(Buffer.from([1, 2, 3, 255]), { binary: true });

    await waitFor(() => received.length === 2, "both echoes");
    expect(received[0]).toEqual({ text: Buffer.from("hi").toString("hex"), isBinary: false });
    expect(received[1]).toEqual({ text: "010203ff", isBinary: true });
    client.close();
  });

  it("holds frames the daemon sends before the upstream data socket is open", async () => {
    const official = await startRelay("official");
    official.dataUpgradeDelayMs = 200;
    const proxy = await startProxy([upstreamFor("official", official.port)]);
    const speaksFirst: DataHandler = (ws) => {
      ws.send("daemon-first-1");
      ws.send("daemon-first-2");
    };
    await startDaemon(proxy, speaksFirst);
    await waitFor(() => official.control !== null, "the relay to see the daemon");

    const client = await official.connectClient(SERVER_ID);
    const received: string[] = [];
    client.on("message", (data) => received.push(toBuffer(data).toString("utf8")));

    await waitFor(() => received.length === 2, "the daemon's first frames");
    expect(received).toEqual(["daemon-first-1", "daemon-first-2"]);
    client.close();
  });

  it("delivers frames the client sent before the daemon data socket existed", async () => {
    const official = await startRelay("official");
    const proxy = await startProxy([upstreamFor("official", official.port)]);
    await startDaemon(proxy, rawEcho);
    await waitFor(() => official.control !== null, "the relay to see the daemon");

    // The client talks immediately, long before the proxy has opened the upstream data socket.
    const client = await official.connectClient(SERVER_ID);
    const received: string[] = [];
    client.on("message", (data) => received.push(toBuffer(data).toString("utf8")));
    for (let i = 0; i < 20; i += 1) client.send(`frame-${i}`);

    await waitFor(() => received.length === 20, "all 20 echoes");
    expect(received).toEqual(Array.from({ length: 20 }, (_, i) => `frame-${i}`));
    client.close();
  });
});

describe("resilience", () => {
  it("keeps serving one relay while the other is down, then picks the other up when it returns", async () => {
    const { keyPair, publicKeyB64 } = newKeyPair();
    const official = await startRelay("official");
    const homePort = await freePort();
    const proxy = await startProxy([
      upstreamFor("official", official.port),
      upstreamFor("home", homePort),
    ]);
    const daemon = await startDaemon(proxy, encryptedUpperCase(keyPair));

    await waitFor(() => official.control !== null, "the live relay to see the daemon");
    expect(await encryptedRequest(official, SERVER_ID, publicKeyB64, "still works")).toBe("STILL WORKS");
    await waitFor(
      () => proxy.status().upstreams.find((u) => u.name === "home")?.state === "down",
      "the dead relay to be reported down",
    );
    expect(daemon.controlCloseCode).toBeNull();

    const home = await startRelay("home", homePort);
    await waitFor(() => home.control !== null, "the returning relay to see the daemon");
    expect(await encryptedRequest(home, SERVER_ID, publicKeyB64, "back again")).toBe("BACK AGAIN");
  });

  it("re-registers with a relay that drops the control socket", async () => {
    const official = await startRelay("official");
    const proxy = await startProxy([upstreamFor("official", official.port)]);
    await startDaemon(proxy, rawEcho);
    await waitFor(() => official.control !== null, "the relay to see the daemon");

    official.dropControl();
    await waitFor(() => official.controlConnects === 2, "the proxy to reconnect its control socket");
    expect(official.control).not.toBeNull();
  });

  it("lets a client that connected while the proxy was away be adopted from the relay's sync", async () => {
    const official = await startRelay("official");
    // A client is already waiting on the relay before any daemon registers.
    const waiting = await official.connectClient(SERVER_ID);
    const received: string[] = [];
    waiting.on("message", (data) => received.push(toBuffer(data).toString("utf8")));
    waiting.send("anyone there?");

    const proxy = await startProxy([upstreamFor("official", official.port)]);
    await startDaemon(proxy, rawEcho);

    await waitFor(() => received.length === 1, "the buffered frame to be echoed");
    expect(received).toEqual(["anyone there?"]);
    waiting.close();
  });

  it("answers a relay's JSON ping itself instead of passing it to the daemon", async () => {
    const official = await startRelay("official");
    const proxy = await startProxy([upstreamFor("official", official.port)]);
    const daemon = await startDaemon(proxy, rawEcho);
    await waitFor(() => official.control !== null, "the relay to see the daemon");

    official.notifyControl({ type: "ping" });
    await waitFor(() => official.controlMessages.some((m) => m.type === "pong"), "a pong from the proxy");
    expect(daemon.controlMessages.some((m) => m.type === "ping")).toBe(false);
  });
});

describe("data socket keepalive", () => {
  const stale = { staleTimeoutMs: 500 };

  async function echoOnce(client: Awaited<ReturnType<FakeRelay["connectClient"]>>, text: string) {
    const reply = new Promise<string>((resolve) => client.once("message", (data) => resolve(toBuffer(data).toString("utf8"))));
    client.send(text);
    return await reply;
  }

  it("cuts off a relay that goes silent mid-session so the daemon sees the disconnect, and leaves the other relay alone", async () => {
    const official = await startRelay("official");
    const home = await startRelay("home");
    const proxy = await startProxy([upstreamFor("official", official.port), upstreamFor("home", home.port)], stale);
    const daemon = await startDaemon(proxy, rawEcho);
    await waitFor(() => official.control !== null && home.control !== null, "both relays");

    const viaOfficial = await official.connectClient(SERVER_ID);
    const viaHome = await home.connectClient(SERVER_ID);
    expect(await echoOnce(viaOfficial, "a")).toBe("a");
    expect(await echoOnce(viaHome, "h")).toBe("h");
    await waitFor(() => daemon.dataIds.length === 2, "both sessions to be open");
    await new Promise((resolve) => setTimeout(resolve, 350)); // a few ping cycles, so each socket has answered one

    official.freezeData();

    await waitFor(() => daemon.dataIds.join() === "home:conn_1", "the silent session to be closed on the daemon");
    expect(proxy.status().upstreams.find((u) => u.name === "official")?.dataSockets).toBe(0);
    expect(await echoOnce(viaHome, "still here")).toBe("still here");
    expect(daemon.controlCloseCode).toBeNull();
  });

  it("keeps a quiet session alive for as long as the relay answers pings", async () => {
    const official = await startRelay("official");
    const proxy = await startProxy([upstreamFor("official", official.port)], stale);
    const daemon = await startDaemon(proxy, rawEcho);
    await waitFor(() => official.control !== null, "the relay to see the daemon");

    const client = await official.connectClient(SERVER_ID);
    expect(await echoOnce(client, "before")).toBe("before");
    await new Promise((resolve) => setTimeout(resolve, 1_600)); // more than three stale timeouts of silence

    expect(daemon.dataIds).toEqual(["official:conn_1"]);
    expect(await echoOnce(client, "after")).toBe("after");
  });

  it("does not punish a relay that never answers pings on data sockets", async () => {
    const quiet = await startRelay("quiet", 0, { answerPings: false });
    const proxy = await startProxy([upstreamFor("quiet", quiet.port)], stale);
    const daemon = await startDaemon(proxy, rawEcho);
    await waitFor(() => quiet.control !== null, "the relay to see the daemon");

    const client = await quiet.connectClient(SERVER_ID);
    expect(await echoOnce(client, "before")).toBe("before");
    await new Promise((resolve) => setTimeout(resolve, 1_600));

    expect(daemon.dataIds).toEqual(["quiet:conn_1"]);
    expect(await echoOnce(client, "after")).toBe("after");
  });
});

describe("latency", () => {
  const request = (proxy: FanoutProxy, name: string) => proxy.status().upstreams.find((u) => u.name === name)!.latency.request;
  const ping = (proxy: FanoutProxy, name: string) => proxy.status().upstreams.find((u) => u.name === name)!.latency.ping;

  /** Poll the status the way the screen does: every look asks for a refresh. */
  const looking = (proxy: FanoutProxy, done: () => boolean) => () => {
    proxy.touch();
    return done();
  };

  it("measures each relay's request round trip separately, even with no daemon connected", async () => {
    const fast = await startRelay("fast");
    const slow = await startRelay("slow");
    slow.healthDelayMs = 150;
    const proxy = await startProxy([upstreamFor("fast", fast.port), upstreamFor("slow", slow.port)]);

    await waitFor(
      looking(proxy, () => request(proxy, "fast").answered >= 1 && request(proxy, "slow").answered >= 1),
      "a warm sample from both relays",
    );

    expect(proxy.status().daemonConnected).toBe(false);
    expect(request(proxy, "slow").lastMs!).toBeGreaterThanOrEqual(120);
    expect(request(proxy, "fast").lastMs!).toBeLessThan(request(proxy, "slow").lastMs!);
    // The first request on a fresh connection is reported as connection time, not as the round trip.
    const connect = proxy.status().upstreams.find((u) => u.name === "slow")!.latency.connectMs;
    expect(connect).not.toBeNull();
    expect(request(proxy, "slow").maxMs!).toBeLessThan(connect! + 150);
  });

  it("sends nothing until someone asks, and never more often than the interval", async () => {
    const relay = await startRelay("relay");
    const proxy = await startProxy([upstreamFor("relay", relay.port)], { latencyMinIntervalMs: 200 });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(relay.healthRequests).toBe(0);

    for (let i = 0; i < 25; i += 1) proxy.touch();
    await waitFor(() => request(proxy, "relay").answered === 1, "the first warm sample");
    const afterBurst = relay.healthRequests;
    expect(afterBurst).toBeLessThanOrEqual(2); // one cold request plus one warm one

    // The proxy's own /health asks too, and is throttled by the same rule.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await fetch(`http://127.0.0.1:${proxy.port}/health`);
    await fetch(`http://127.0.0.1:${proxy.port}/health`);
    await waitFor(() => relay.healthRequests === afterBurst + 1, "exactly one more request");
  });

  it("reports a relay that stops answering as lost with the reason, and recovers", async () => {
    const relay = await startRelay("relay");
    const proxy = await startProxy([upstreamFor("relay", relay.port)]);
    await waitFor(looking(proxy, () => request(proxy, "relay").answered >= 1), "a first sample");

    relay.healthStatus = 503;
    await waitFor(looking(proxy, () => request(proxy, "relay").lastOk === false), "a failed sample");
    expect(proxy.status().upstreams[0]!.latency.error).toBe("HTTP 503");
    expect(request(proxy, "relay").lost).toBeGreaterThanOrEqual(1);

    relay.healthStatus = 200;
    await waitFor(looking(proxy, () => request(proxy, "relay").lastOk === true), "a recovered sample");
    expect(proxy.status().upstreams[0]!.latency.error).toBeNull();
  });

  it("reports a relay that cannot be reached", async () => {
    const port = await freePort();
    const proxy = await startProxy([upstreamFor("gone", port)]);

    await waitFor(looking(proxy, () => request(proxy, "gone").lost >= 1), "a failed sample");

    expect(request(proxy, "gone")).toMatchObject({ lastOk: false, lastMs: null, avgMs: null });
    expect(proxy.status().upstreams[0]!.latency.error).toMatch(/ECONNREFUSED/);
  });

  it("measures the control socket's ping round trip per relay", async () => {
    const near = await startRelay("near", 0, { pongDelayMs: 0 });
    const far = await startRelay("far", 0, { pongDelayMs: 60 });
    const proxy = await startProxy([upstreamFor("near", near.port), upstreamFor("far", far.port)]);
    await startDaemon(proxy, rawEcho);

    await waitFor(() => ping(proxy, "near").answered >= 2 && ping(proxy, "far").answered >= 2, "two pings answered by each relay");

    expect(ping(proxy, "far").minMs!).toBeGreaterThanOrEqual(55);
    expect(ping(proxy, "near").maxMs!).toBeLessThan(ping(proxy, "far").minMs!);
  });

  it("counts pings a relay never answers as lost, without dropping the relay", async () => {
    const mute = await startRelay("mute", 0, { answerPings: false });
    const proxy = await startProxy([upstreamFor("mute", mute.port)]);
    await startDaemon(proxy, rawEcho);

    await waitFor(() => ping(proxy, "mute").lost >= 2, "two unanswered pings");

    expect(ping(proxy, "mute")).toMatchObject({ answered: 0, lastOk: false, lastMs: null });
    expect(proxy.status().upstreams[0]!.state).toBe("connected");
  });

  it("does not take a late pong for the answer to a newer ping", async () => {
    // Each pong arrives after the next ping is already due, so every ping counts as lost.
    // A matcher that ignores which ping a pong answers would pair it with the newest ping and
    // report a latency far lower than the real one.
    const late = await startRelay("late", 0, { pongDelayMs: 250 });
    const proxy = await startProxy([upstreamFor("late", late.port)]);
    await startDaemon(proxy, rawEcho);

    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(ping(proxy, "late").lost).toBeGreaterThanOrEqual(2);
    expect(ping(proxy, "late").answered).toBe(0);
    expect(ping(proxy, "late").lastMs).toBeNull();
  });
});

describe("connection lifecycle", () => {
  it("closes the daemon data socket when the client leaves", async () => {
    const official = await startRelay("official");
    const proxy = await startProxy([upstreamFor("official", official.port)]);
    const daemon = await startDaemon(proxy, rawEcho);
    await waitFor(() => official.control !== null, "the relay to see the daemon");

    const client = await official.connectClient(SERVER_ID);
    await waitFor(() => daemon.dataIds.length === 1 && official.data.size === 1, "the data path to open");
    client.close();

    await waitFor(() => daemon.dataIds.length === 0, "the daemon data socket to close");
    await waitFor(() => official.data.size === 0, "the upstream data socket to close");
    expect(proxy.status().upstreams[0]?.dataSockets).toBe(0);
  });

  it("closes the client when the daemon closes its data socket", async () => {
    const official = await startRelay("official");
    const proxy = await startProxy([upstreamFor("official", official.port)]);
    const daemon = await startDaemon(proxy, rawEcho);
    await waitFor(() => official.control !== null, "the relay to see the daemon");

    const client = await official.connectClient(SERVER_ID);
    const closed = new Promise<number>((resolve) => client.once("close", (code) => resolve(code)));
    await waitFor(() => daemon.dataIds.length === 1 && official.data.size === 1, "the data path to open");
    daemon.closeData("official:conn_1");

    // The relay turns a closed server data socket into 1012 for the client.
    expect(await closed).toBe(1012);
  });

  it("deregisters from every relay when the daemon control socket drops", async () => {
    const official = await startRelay("official");
    const home = await startRelay("home");
    const proxy = await startProxy([
      upstreamFor("official", official.port),
      upstreamFor("home", home.port),
    ]);
    const daemon = await startDaemon(proxy, rawEcho);
    await waitFor(() => official.control !== null && home.control !== null, "both relays");

    daemon.stop();
    await waitFor(() => official.control === null && home.control === null, "both relays to lose the daemon");
    expect(proxy.status().daemonConnected).toBe(false);
  });

  it("lets the newest daemon control socket replace the previous one", async () => {
    const official = await startRelay("official");
    const proxy = await startProxy([upstreamFor("official", official.port)]);
    const first = await startDaemon(proxy, rawEcho);
    await waitFor(() => official.control !== null, "the relay to see the daemon");

    const second = await startDaemon(proxy, rawEcho);
    await waitFor(() => first.controlCloseCode === 1008, "the first control socket to be replaced");
    await waitFor(() => official.control !== null && second.controlMessages.length > 0, "the new control to register");
    expect(proxy.status().daemonConnected).toBe(true);
  });

  it("closes data sockets whose connection id has no known upstream prefix", async () => {
    const official = await startRelay("official");
    const proxy = await startProxy([upstreamFor("official", official.port)]);

    for (const connectionId of ["bogus", "nowhere:conn_1", ":conn_1", "official:"]) {
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxy.port}/ws?serverId=${SERVER_ID}&role=server&v=2&connectionId=${encodeURIComponent(connectionId)}`,
      );
      const code = await new Promise<number>((resolve) => ws.once("close", (c) => resolve(c)));
      expect(code, connectionId).toBe(1008);
    }
  });

  it("stops cleanly while connections are open", async () => {
    const official = await startRelay("official");
    const proxy = await startProxy([upstreamFor("official", official.port)]);
    const daemon = await startDaemon(proxy, rawEcho);
    await waitFor(() => official.control !== null, "the relay to see the daemon");
    await official.connectClient(SERVER_ID);
    await waitFor(() => daemon.dataIds.length === 1, "the data path to open");

    await proxy.stop();

    await waitFor(() => official.control === null && official.data.size === 0, "the relay to lose everything");
  });
});

describe("local access control", () => {
  async function proxyForAccessTests(): Promise<FanoutProxy> {
    const official = await startRelay("official");
    return await startProxy([upstreamFor("official", official.port)]);
  }

  it("refuses anything that is not a role=server v2 connection on /ws", async () => {
    const proxy = await proxyForAccessTests();
    const base = `ws://127.0.0.1:${proxy.port}`;
    expect(await upgradeStatus(`${base}/ws?serverId=x&role=client&v=2`)).toBe(400);
    expect(await upgradeStatus(`${base}/ws?role=server&v=2`)).toBe(400);
    expect(await upgradeStatus(`${base}/ws?serverId=x&role=server&v=1`)).toBe(400);
    expect(await upgradeStatus(`${base}/other?serverId=x&role=server&v=2`)).toBe(404);
    expect(await upgradeStatus(`${base}/ws?serverId=x&role=server&v=2`)).toBe(101);
  });

  it("refuses browser-originated and rebinding requests", async () => {
    const proxy = await proxyForAccessTests();
    const url = `ws://127.0.0.1:${proxy.port}/ws?serverId=x&role=server&v=2`;
    expect(await upgradeStatus(url, { Origin: "https://evil.example" })).toBe(403);
    expect(await upgradeStatus(url, { Host: "evil.example" })).toBe(403);
  });

  it("serves a status document on /health and nothing else over plain HTTP", async () => {
    const official = await startRelay("official");
    const proxy = await startProxy([upstreamFor("official", official.port)]);
    await startDaemon(proxy, rawEcho);
    await waitFor(() => official.control !== null && proxy.status().upstreams[0]?.ready === true, "the upstream to be ready");

    const get = (path: string, headers: http.OutgoingHttpHeaders = {}) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port: proxy.port, path, headers }, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
            );
          })
          .on("error", reject);
      });

    const health = await get("/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({
      status: "ok",
      daemonConnected: true,
      serverId: SERVER_ID,
      upstreams: [{ name: "official", state: "connected", ready: true }],
    });
    expect((await get("/anything")).status).toBe(404);
    expect((await get("/health", { Host: "evil.example" })).status).toBe(403);
  });
});
