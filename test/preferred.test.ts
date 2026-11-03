import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { Upstream } from "../server/config";
import { FanoutProxy, type Timing } from "../server/proxy";
import type { Preference } from "../server/priority";
import { FakeDaemon, FakeRelay, fastTiming, rawEcho, silentLogger, toBuffer, waitFor } from "./helpers";

const SERVER_ID = "srv_test";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const auto: Preference = { mode: "auto", preferred: null };
const prefer = (name: string): Preference => ({ mode: "preferred", preferred: name });

async function startRelay(
  name: string,
  port = 0,
  options: { pongDelayMs?: number } = {},
): Promise<FakeRelay> {
  const relay = new FakeRelay(name, options);
  await relay.listen(port);
  cleanups.push(() => (relay.listening ? relay.close() : undefined));
  return relay;
}

const upstreamFor = (name: string, relay: FakeRelay): Upstream => ({ name, endpoint: `127.0.0.1:${relay.port}`, useTls: false });

async function startProxy(upstreams: Upstream[], preference: Preference, timing: Partial<Timing> = {}) {
  const proxy = new FanoutProxy({
    host: "127.0.0.1",
    port: 0,
    upstreams,
    preference,
    logger: silentLogger,
    timing: { ...fastTiming, ...timing },
  });
  await proxy.start();
  cleanups.push(() => proxy.stop());
  return proxy;
}

async function startDaemon(proxy: FanoutProxy): Promise<FakeDaemon> {
  const daemon = new FakeDaemon(proxy.port, SERVER_ID, rawEcho);
  cleanups.push(() => daemon.stop());
  await daemon.start();
  return daemon;
}

const upstreamOf = (proxy: FanoutProxy, name: string) => proxy.status().upstreams.find((u) => u.name === name);
const roleOf = (proxy: FanoutProxy, name: string) => upstreamOf(proxy, name)?.priority?.role;

async function echoOnce(client: WebSocket, text: string): Promise<string> {
  const reply = new Promise<string>((resolve) => client.once("message", (data) => resolve(toBuffer(data).toString("utf8"))));
  client.send(text);
  return await reply;
}

describe("auto", () => {
  it("keeps every relay open and lets each device pick the fastest", async () => {
    const official = await startRelay("official");
    const home = await startRelay("home");
    const proxy = await startProxy([upstreamFor("official", official), upstreamFor("home", home)], auto);
    await startDaemon(proxy);

    await waitFor(() => official.control !== null && home.control !== null, "both relays to see the daemon");
    expect(roleOf(proxy, "official")).toBe("active");
    expect(roleOf(proxy, "home")).toBe("active");
    expect(proxy.status().preference).toEqual(auto);
  });
});

describe("a preferred relay that is healthy", () => {
  it("is the only one the daemon registers with, and the others are never opened", async () => {
    const official = await startRelay("official");
    const home = await startRelay("home");
    const proxy = await startProxy([upstreamFor("official", official), upstreamFor("home", home)], prefer("home"));
    await startDaemon(proxy);

    await waitFor(() => home.control !== null, "the preferred relay to see the daemon");
    await sleep(900); // past the time a fallback would have been brought up, and past the stable time

    expect(official.controlAttempts).toBe(0);
    expect(official.control).toBeNull();
    expect(roleOf(proxy, "home")).toBe("active");
    expect(roleOf(proxy, "official")).toBe("standby");
    expect(upstreamOf(proxy, "home")?.priority?.preferred).toBe(true);
    expect(upstreamOf(proxy, "official")?.priority?.preferred).toBe(false);
    expect(proxy.status().fallbackActive).toBe(false);
  });

  it("rides out a short drop without opening anything else", async () => {
    const official = await startRelay("official");
    const home = await startRelay("home");
    const proxy = await startProxy([upstreamFor("official", official), upstreamFor("home", home)], prefer("home"));
    await startDaemon(proxy);
    await waitFor(() => home.control !== null, "the preferred relay to see the daemon");
    await sleep(500);

    home.dropControl();
    await waitFor(() => home.controlConnects === 2, "the preferred relay to be re-registered", 3000);
    await sleep(400);

    expect(official.controlAttempts).toBe(0);
    expect(proxy.status().fallbackActive).toBe(false);
  });
});

describe("when the preferred relay fails and comes back", () => {
  it("fails over, gives up, retests, returns, and leaves a phone's running session alone", async () => {
    const official = await startRelay("official");
    const home = await startRelay("home");
    const homePort = home.port;
    const proxy = await startProxy([upstreamFor("official", official), upstreamFor("home", home)], prefer("home"));
    const daemon = await startDaemon(proxy);
    await waitFor(() => home.control !== null, "the preferred relay to see the daemon");

    // The preferred relay dies.
    await home.close();
    await waitFor(() => official.control !== null, "the fallback to register", 5000);
    expect(proxy.status().fallbackActive).toBe(true);
    expect(roleOf(proxy, "official")).toBe("active");

    // A phone connects through the fallback and talks to the daemon.
    const phone = await official.connectClient(SERVER_ID);
    expect(await echoOnce(phone, "via the fallback")).toBe("via the fallback");

    // After the grace period it is given up on, with a time for the next try.
    await waitFor(() => roleOf(proxy, "home") === "down", "the preferred relay to be given up on", 6000);
    const retestAt = Date.parse(upstreamOf(proxy, "home")!.priority!.nextRetestAt!);
    expect(retestAt).toBeGreaterThan(Date.now());
    expect(upstreamOf(proxy, "home")?.priority?.preferred).toBe(true);

    // It comes back. The retest finds it, and once it has been stable the fallback is let go.
    const returned = await startRelay("home", homePort);
    await waitFor(() => returned.control !== null, "the retest to register with the returned relay", 6000);
    await waitFor(() => official.control === null, "the fallback to stand down", 6000);
    expect(roleOf(proxy, "home")).toBe("active");
    expect(roleOf(proxy, "official")).toBe("standby");
    expect(proxy.status().fallbackActive).toBe(false);

    // The session that was running through the fallback was not cut.
    expect(await echoOnce(phone, "still here")).toBe("still here");
    // And the daemon never lost its link to the proxy.
    expect(daemon.controlCloseCode).toBeNull();
    phone.close();
  }, 30_000);

  it("tries a relay that stays down once per retest and not continuously", async () => {
    const official = await startRelay("official");
    const home = await startRelay("home");
    home.refuseControl = true;
    const proxy = await startProxy([upstreamFor("official", official), upstreamFor("home", home)], prefer("home"));
    await startDaemon(proxy);

    await waitFor(() => roleOf(proxy, "home") === "down", "the preferred relay to be given up on", 6000);
    expect(official.control).not.toBeNull(); // the fallback serves meanwhile
    // An attempt that was already on its way when the relay was given up on still arrives a moment
    // later. Count from after that, then check that nothing more comes until the retest.
    await sleep(120);
    const attemptsWhenGivenUp = home.controlAttempts;
    expect(attemptsWhenGivenUp).toBeGreaterThan(1); // it was tried repeatedly during the grace period

    await sleep(500); // still inside the retest interval of 900 ms
    expect(home.controlAttempts).toBe(attemptsWhenGivenUp);

    await waitFor(() => home.controlAttempts > attemptsWhenGivenUp, "the next retest", 4000);
  }, 20_000);

  it("keeps the fastest of several fallbacks and stands the others down", async () => {
    const slow = await startRelay("slow", 0, { pongDelayMs: 120 });
    const fast = await startRelay("fast", 0, { pongDelayMs: 0 });
    const home = await startRelay("home");
    const proxy = await startProxy(
      [upstreamFor("slow", slow), upstreamFor("fast", fast), upstreamFor("home", home)],
      prefer("home"),
    );
    await startDaemon(proxy);
    await waitFor(() => home.control !== null, "the preferred relay to see the daemon");

    await home.close();

    await waitFor(() => fast.control !== null && slow.control === null, "only the fastest fallback to remain", 8000);
    expect(roleOf(proxy, "fast")).toBe("active");
    expect(roleOf(proxy, "slow")).toBe("standby");
  }, 20_000);
});

describe("changing the setup while it runs", () => {
  it("moves between Auto and a preferred relay without a restart", async () => {
    const official = await startRelay("official");
    const home = await startRelay("home");
    const upstreams = [upstreamFor("official", official), upstreamFor("home", home)];
    const proxy = await startProxy(upstreams, auto);
    await startDaemon(proxy);
    await waitFor(() => official.control !== null && home.control !== null, "both relays to see the daemon");

    proxy.applyConfig({ upstreams, preference: prefer("home") });
    await waitFor(() => official.control === null, "the other relay to stand by", 5000);
    expect(home.control).not.toBeNull();
    expect(proxy.status().preference).toEqual(prefer("home"));

    proxy.applyConfig({ upstreams, preference: auto });
    await waitFor(() => official.control !== null, "the other relay to come back", 5000);
    expect(home.control).not.toBeNull();
  }, 20_000);

  it("registers a relay that is added, and closes one that is removed along with its sessions", async () => {
    const first = await startRelay("first");
    const second = await startRelay("second");
    const upstreamFirst = upstreamFor("first", first);
    const upstreamSecond = upstreamFor("second", second);
    const proxy = await startProxy([upstreamFirst], auto);
    await startDaemon(proxy);
    await waitFor(() => first.control !== null, "the first relay to see the daemon");

    proxy.applyConfig({ upstreams: [upstreamFirst, upstreamSecond], preference: auto });
    await waitFor(() => second.control !== null, "the added relay to see the daemon", 4000);
    expect(proxy.status().upstreams.map((u) => u.name)).toEqual(["first", "second"]);

    const phone = await second.connectClient(SERVER_ID);
    expect(await echoOnce(phone, "via the new relay")).toBe("via the new relay");
    const closed = new Promise<number>((resolve) => phone.once("close", (code) => resolve(code)));

    proxy.applyConfig({ upstreams: [upstreamFirst], preference: auto });
    await waitFor(() => second.control === null, "the removed relay to lose the daemon", 4000);
    expect(proxy.status().upstreams.map((u) => u.name)).toEqual(["first"]);
    await closed; // its running session was closed
    expect(first.control).not.toBeNull();
  }, 20_000);

  it("keeps a relay's measurements when the list changes around it", async () => {
    const first = await startRelay("first");
    const second = await startRelay("second");
    const upstreamFirst = upstreamFor("first", first);
    const proxy = await startProxy([upstreamFirst], auto);
    await startDaemon(proxy);
    await waitFor(() => (upstreamOf(proxy, "first")?.latency?.ping.answered ?? 0) >= 2, "two pings to be answered", 4000);
    const before = upstreamOf(proxy, "first")!.latency!.ping.answered;

    proxy.applyConfig({ upstreams: [upstreamFirst, upstreamFor("second", second)], preference: auto });

    expect(upstreamOf(proxy, "first")!.latency!.ping.answered).toBeGreaterThanOrEqual(before);
  });
});
