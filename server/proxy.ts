import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { performance } from "node:perf_hooks";
import type { Upstream } from "./config";
import { parsePrefixedConnectionId, prefixConnectionId } from "./ids";
import { EMPTY_STAT, LatencyProbe, LatencyWindow, createHealthClient, type LatencyStat } from "./latency";
import {
  DEFAULT_PRIORITY_TIMING,
  decide,
  roleOf,
  type Preference,
  type PriorityTiming,
  type RelayFacts,
  type Role,
} from "./priority";

/**
 * A relay fan-out proxy.
 *
 * The Paseo daemon dials exactly one relay. This proxy plays the relay for the
 * daemon and plays the daemon for every real relay, so one daemon ends up
 * registered with all of them. It speaks the relay v2 server protocol:
 *
 *  - control socket   `?role=server&serverId=X&v=2`
 *      relay -> daemon: ping | pong | sync{connectionIds} | connected{connectionId} | disconnected{connectionId}
 *      daemon -> relay: pong (and protocol-level pings)
 *  - data socket      `?role=server&serverId=X&v=2&connectionId=Y`
 *      opaque frames, relayed in both directions with their text/binary type kept.
 *
 * Connection ids are prefixed with the upstream name on the way to the daemon so
 * ids from different relays cannot collide. Data frames are never inspected:
 * the end-to-end encryption handshake runs between the phone and the daemon,
 * straight through this proxy.
 */

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface Timing {
  pingIntervalMs: number;
  staleTimeoutMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  handshakeTimeoutMs: number;
  dataOpenTimeoutMs: number;
  readyWarnMs: number;
  /** A relay's /health is requested at most this often, and only while someone asks for the status. */
  latencyMinIntervalMs: number;
  latencyTimeoutMs: number;
  /** See PriorityTiming: when to bring up the others, give up on the preferred relay, retest it. */
  graceMs: number;
  failoverAfterMs: number;
  stableMs: number;
  retestMs: number;
  settleMs: number;
  /** How often the proxy re-checks which relays should be open. */
  reconcileIntervalMs: number;
}

export const DEFAULT_TIMING: Timing = {
  ...DEFAULT_PRIORITY_TIMING,
  reconcileIntervalMs: 1_000,
  pingIntervalMs: 10_000,
  staleTimeoutMs: 30_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
  handshakeTimeoutMs: 10_000,
  dataOpenTimeoutMs: 15_000,
  readyWarnMs: 8_000,
  latencyMinIntervalMs: 5_000,
  latencyTimeoutMs: 5_000,
};

export interface FanoutProxyOptions {
  host: string;
  port: number;
  upstreams: Upstream[];
  /** Defaults to Auto: every relay open, each device picks the fastest. */
  preference?: Preference;
  logger: Logger;
  timing?: Partial<Timing>;
}

/** What the screen needs to say about a relay's place in the preference. */
export interface UpstreamPriority {
  /**
   * active: registered and serving. connecting: registered, not serving yet. standby: not registered,
   * by choice. down: given up on, to be tried again at `nextRetestAt`.
   */
  role: Role;
  preferred: boolean;
  nextRetestAt: string | null;
}

export interface UpstreamLatency {
  /**
   * Round trip of GET /health over a kept-alive connection: the relay (or whatever fronts it)
   * answering a request. Measured whether or not the daemon is connected.
   */
  request: LatencyStat;
  /**
   * WebSocket ping on the control socket. Behind an edge such as Cloudflare the edge can answer
   * it, so it can read far lower than the real latency. Only measured while connected.
   */
  ping: LatencyStat;
  /** Time of the last request that had to open a new connection (TCP, TLS and the request). */
  connectMs: number | null;
  /** Why the last request failed, when it did. */
  error: string | null;
}

export interface UpstreamStatus {
  name: string;
  endpoint: string;
  state: "idle" | "connecting" | "connected" | "down";
  /** True once the relay has sent at least one control message on this connection. */
  ready: boolean;
  connectedAt: string | null;
  lastError: string | null;
  dataSockets: number;
  latency: UpstreamLatency;
  priority: UpstreamPriority;
}

export interface ProxyStatus {
  status: "ok";
  listening: string;
  daemonConnected: boolean;
  serverId: string | null;
  upstreams: UpstreamStatus[];
  preference: Preference;
  /** The preferred relay is not serving, so the others are up in its place. */
  fallbackActive: boolean;
}

const LOOPBACK_HOST_HEADERS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const MAX_PENDING_FRAMES = 256;

interface PendingFrame {
  data: RawData;
  isBinary: boolean;
}

type ControlMessage =
  | { type: "ping" }
  | { type: "pong" }
  | { type: "sync"; connectionIds: string[] }
  | { type: "connected"; connectionId: string }
  | { type: "disconnected"; connectionId: string };

function parseControlMessage(raw: RawData): ControlMessage | null {
  try {
    const text = Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : raw.toString();
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const nonEmpty = (value: unknown): value is string =>
      typeof value === "string" && value.trim().length > 0;
    switch (record.type) {
      case "ping":
        return { type: "ping" };
      case "pong":
        return { type: "pong" };
      case "sync":
        if (!Array.isArray(record.connectionIds)) return null;
        return { type: "sync", connectionIds: record.connectionIds.filter(nonEmpty).map((id) => id.trim()) };
      case "connected":
      case "disconnected":
        if (!nonEmpty(record.connectionId)) return null;
        return { type: record.type, connectionId: record.connectionId.trim() };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Close codes 1005, 1006 and 1015 are reserved and cannot be sent. */
function sendableCloseCode(code: number, fallback = 1011): number {
  if (code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014)) return code;
  if (code >= 3000 && code <= 4999) return code;
  return fallback;
}

function closeQuietly(ws: WebSocket | null, code: number, reason: string): void {
  if (!ws) return;
  if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
  try {
    ws.close(sendableCloseCode(code), reason.slice(0, 120));
  } catch {
    try {
      ws.terminate();
    } catch {
      // already gone
    }
  }
}

function buildUpstreamUrl(upstream: Upstream, serverId: string, connectionId?: string): string {
  const url = new URL(`${upstream.useTls ? "wss" : "ws"}://${upstream.endpoint}/ws`);
  url.searchParams.set("serverId", serverId);
  url.searchParams.set("role", "server");
  url.searchParams.set("v", "2");
  if (connectionId) url.searchParams.set("connectionId", connectionId);
  return url.toString();
}

const upstreamSocketOptions = (timing: Timing) => ({
  handshakeTimeout: timing.handshakeTimeoutMs,
  perMessageDeflate: false,
  autoSelectFamilyAttemptTimeout: 5_000,
});

/** One control connection from the proxy to one real relay. */
class UpstreamControl {
  state: UpstreamStatus["state"] = "idle";
  ready = false;
  connectedAt: Date | null = null;
  lastError: string | null = null;
  private readySince: number | null = null;
  private unreadySince = Date.now();

  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private lastSeenAt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private readonly pingWindow = new LatencyWindow();
  private pingSeq = 0;
  private outstandingPing: { seq: number; sentAt: number } | null = null;

  constructor(
    readonly upstream: Upstream,
    private readonly serverId: string,
    private readonly timing: Timing,
    private readonly logger: Logger,
    private readonly onMessage: (upstream: Upstream, message: ControlMessage) => void,
  ) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    closeQuietly(this.ws, 1000, "Daemon disconnected");
    this.ws = null;
    this.state = "idle";
    this.ready = false;
  }

  sendPong(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
    } catch {
      // the close handler reconnects
    }
  }

  private clearTimers(): void {
    for (const timer of [this.reconnectTimer, this.pingTimer, this.readyTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.readyTimer = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = buildUpstreamUrl(this.upstream, this.serverId);
    const ws = new WebSocket(url, upstreamSocketOptions(this.timing));
    this.ws = ws;
    this.state = "connecting";
    this.ready = false;

    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.state = "connected";
      this.connectedAt = new Date();
      this.lastSeenAt = Date.now();
      this.attempt = 0;
      this.lastError = null;
      this.logger.info("upstream control connected", { upstream: this.upstream.name });
      this.pingTimer = setInterval(() => this.keepalive(ws), this.timing.pingIntervalMs);
      this.readyTimer = setTimeout(() => {
        if (this.ws === ws && !this.ready) {
          this.logger.warn(
            "upstream sent no control message; the daemon would reject this relay as incompatible",
            { upstream: this.upstream.name, waitedMs: this.timing.readyWarnMs },
          );
        }
      }, this.timing.readyWarnMs);
      this.ping(ws);
    });

    ws.on("pong", (payload: Buffer) => {
      if (this.ws !== ws) return;
      this.lastSeenAt = Date.now();
      this.answerPing(payload);
    });

    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      this.lastSeenAt = Date.now();
      const message = parseControlMessage(data);
      if (!message) return;
      if (!this.ready) {
        this.ready = true;
        this.readySince = Date.now();
      }
      this.onMessage(this.upstream, message);
    });

    ws.on("error", (error) => {
      if (this.ws !== ws) return;
      this.lastError = error.message;
      this.logger.warn("upstream control error", { upstream: this.upstream.name, error: error.message });
    });

    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.state = "down";
      // Time spent unready keeps counting across failed reconnects; it restarts only when a relay
      // that was ready drops.
      if (this.ready) this.unreadySince = Date.now();
      this.ready = false;
      this.readySince = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.pingTimer = null;
      this.readyTimer = null;
      this.outstandingPing = null; // a ping cut off by a disconnect is not a lost ping
      if (this.stopped) return;
      this.logger.warn("upstream control disconnected", {
        upstream: this.upstream.name,
        code,
        reason: reason.toString(),
      });
      this.scheduleReconnect();
    });
  }

  /** The round trip of the control socket's pings, for the status. */
  pingStat(): LatencyStat {
    return this.pingWindow.stat();
  }

  /** What the priority rules need to know about this socket. */
  facts(now: number): { ready: boolean; readyForMs: number | null; unreadyForMs: number | null } {
    const ready = this.state === "connected" && this.ready;
    return {
      ready,
      readyForMs: ready && this.readySince !== null ? now - this.readySince : null,
      unreadyForMs: ready ? null : now - this.unreadySince,
    };
  }

  private ping(ws: WebSocket): void {
    // The previous ping got no answer before this one is due: that is a lost ping.
    if (this.outstandingPing) this.pingWindow.record(null);
    // The sequence number rides in the payload, which a pong must echo, so a late pong for an
    // earlier ping cannot be taken for the answer to this one.
    this.pingSeq += 1;
    this.outstandingPing = { seq: this.pingSeq, sentAt: performance.now() };
    try {
      ws.ping(String(this.pingSeq));
    } catch {
      ws.terminate();
    }
  }

  private answerPing(payload: Buffer): void {
    const outstanding = this.outstandingPing;
    if (!outstanding) return;
    const echoed = payload.toString();
    // A relay that does not echo the payload still answers the one ping that is outstanding.
    if (echoed !== "" && echoed !== String(outstanding.seq)) return;
    this.pingWindow.record(performance.now() - outstanding.sentAt);
    this.outstandingPing = null;
  }

  private keepalive(ws: WebSocket): void {
    if (this.stopped || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    const silentForMs = Date.now() - this.lastSeenAt;
    if (silentForMs > this.timing.staleTimeoutMs) {
      this.logger.warn("upstream control stale, reconnecting", {
        upstream: this.upstream.name,
        silentForMs,
      });
      ws.terminate();
      return;
    }
    this.ping(ws);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.attempt += 1;
    const delay = Math.min(this.timing.reconnectMaxMs, this.timing.reconnectBaseMs * this.attempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

/** Pipes one daemon data socket to the matching data socket on one real relay. */
class DataPipe {
  private readonly up: WebSocket;
  private readonly pending: PendingFrame[] = [];
  private openTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private lastSeenAt = 0;
  /**
   * Staleness is only enforced once this socket has answered a ping. The stock daemon never
   * pings data sockets, so a relay is not known to answer them; a relay that never does must
   * not have its healthy, quiet sessions killed.
   */
  private pongSeen = false;
  private done = false;

  constructor(
    private readonly daemonWs: WebSocket,
    readonly upstream: Upstream,
    readonly connectionId: string,
    serverId: string,
    private readonly timing: Timing,
    private readonly logger: Logger,
    private readonly onDone: (pipe: DataPipe) => void,
  ) {
    this.up = new WebSocket(buildUpstreamUrl(upstream, serverId, connectionId), upstreamSocketOptions(timing));
  }

  start(): void {
    const { daemonWs, up } = this;

    this.openTimer = setTimeout(() => {
      if (up.readyState !== WebSocket.OPEN) {
        this.logger.warn("upstream data socket open timeout", this.fields());
        up.terminate();
      }
    }, this.timing.dataOpenTimeoutMs);

    up.on("open", () => {
      if (this.openTimer) clearTimeout(this.openTimer);
      this.openTimer = null;
      this.lastSeenAt = Date.now();
      this.keepaliveTimer = setInterval(() => this.keepalive(), this.timing.pingIntervalMs);
      this.logger.info("upstream data connected", this.fields());
      for (const frame of this.pending.splice(0)) up.send(frame.data, { binary: frame.isBinary });
    });

    up.on("pong", () => {
      this.pongSeen = true;
      this.lastSeenAt = Date.now();
    });

    up.on("message", (data, isBinary) => {
      this.lastSeenAt = Date.now();
      if (daemonWs.readyState === WebSocket.OPEN) daemonWs.send(data, { binary: isBinary });
    });

    up.on("error", (error) => {
      this.logger.warn("upstream data error", { ...this.fields(), error: error.message });
    });

    up.on("close", (code, reason) => {
      this.logger.info("upstream data disconnected", { ...this.fields(), code, reason: reason.toString() });
      closeQuietly(daemonWs, code, reason.toString() || "Upstream data socket closed");
      this.finish();
    });

    daemonWs.on("message", (data, isBinary) => {
      if (up.readyState === WebSocket.OPEN) {
        up.send(data, { binary: isBinary });
        return;
      }
      if (up.readyState !== WebSocket.CONNECTING) return;
      if (this.pending.length >= MAX_PENDING_FRAMES) {
        closeQuietly(daemonWs, 1011, "Too many frames buffered while connecting upstream");
        up.terminate();
        return;
      }
      this.pending.push({ data, isBinary });
    });

    daemonWs.on("close", (code, reason) => {
      closeQuietly(up, code, reason.toString() || "Daemon data socket closed");
      // A socket still connecting cannot be closed gracefully.
      if (up.readyState === WebSocket.CONNECTING) up.terminate();
      this.finish();
    });

    daemonWs.on("error", (error) => {
      this.logger.warn("daemon data error", { ...this.fields(), error: error.message });
    });
  }

  close(code: number, reason: string): void {
    closeQuietly(this.daemonWs, code, reason);
    closeQuietly(this.up, code, reason);
    if (this.up.readyState === WebSocket.CONNECTING) this.up.terminate();
  }

  /**
   * A relay that vanishes without closing its sockets would otherwise leave this pipe open
   * for as long as the network takes to give up. The daemon would keep believing the client
   * is connected, and the 90 second reconnect grace for its session would never start.
   * Closing the pipe is what lets the daemon see the disconnect.
   */
  private keepalive(): void {
    const { up } = this;
    if (up.readyState !== WebSocket.OPEN) return;
    const silentForMs = Date.now() - this.lastSeenAt;
    if (this.pongSeen && silentForMs > this.timing.staleTimeoutMs) {
      this.logger.warn("upstream data socket silent, closing it", { ...this.fields(), silentForMs });
      up.terminate();
      return;
    }
    try {
      up.ping();
    } catch {
      up.terminate();
    }
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    if (this.openTimer) clearTimeout(this.openTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.openTimer = null;
    this.keepaliveTimer = null;
    this.onDone(this);
  }

  private fields(): Record<string, unknown> {
    return { upstream: this.upstream.name, connectionId: this.connectionId };
  }
}

/** What the control session needs to know about the proxy's relays, which can change while it runs. */
interface RelaySource {
  upstreams(): Upstream[];
  preference(): Preference;
}

/**
 * The daemon's control connection, fanned out to the relays that should be open right now.
 *
 * Which relays those are is decided by `decide()` (see priority.ts) and re-checked every second.
 * Opening a relay registers the daemon with it; closing one only stops new connections arriving
 * through it. Sessions already running through a relay that is closed keep running until their
 * phone leaves, which is what lets the app move over by itself without a hard cut.
 */
class ControlSession {
  private readonly controls = new Map<string, UpstreamControl>();
  /** Relays given up on, with the time they are tried again. */
  private readonly retestAt = new Map<string, number>();
  private fallbackActive = false;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    readonly daemonWs: WebSocket,
    readonly serverId: string,
    private readonly source: RelaySource,
    private readonly timing: Timing,
    private readonly logger: Logger,
    private readonly onClosed: (session: ControlSession) => void,
  ) {}

  start(): void {
    this.daemonWs.on("message", (data) => {
      // The daemon answers relay pings with pongs; it never needs anything else from us.
      const message = parseControlMessage(data);
      if (message?.type === "ping") this.sendToDaemon({ type: "pong", ts: Date.now() });
    });
    this.daemonWs.on("error", (error) => {
      this.logger.warn("daemon control error", { error: error.message });
    });
    this.daemonWs.on("close", (code, reason) => {
      this.logger.info("daemon control disconnected", { code, reason: reason.toString() });
      this.shutdown();
      this.onClosed(this);
    });

    // The daemon drops a control socket that stays silent for 8s. An empty sync is a
    // no-op for it, and it keeps the daemon connected while the relays are still dialing.
    this.sendToDaemon({ type: "sync", connectionIds: [] });
    this.reconcile();
    this.reconcileTimer = setInterval(() => this.reconcile(), this.timing.reconcileIntervalMs);
  }

  close(code: number, reason: string): void {
    closeQuietly(this.daemonWs, code, reason);
    this.shutdown();
  }

  /** Whether the others are up because the preferred relay is not serving. */
  get fallback(): boolean {
    return this.fallbackActive;
  }

  controlFor(name: string): UpstreamControl | undefined {
    return this.controls.get(name);
  }

  nextRetestAt(name: string): number | null {
    return this.retestAt.get(name) ?? null;
  }

  factsFor(upstream: Upstream, now: number): RelayFacts {
    const control = this.controls.get(upstream.name);
    const state = control?.facts(now);
    return {
      name: upstream.name,
      registered: control !== undefined,
      ready: state?.ready ?? false,
      readyForMs: state?.readyForMs ?? null,
      unreadyForMs: state?.unreadyForMs ?? null,
      nextRetestAt: this.retestAt.get(upstream.name) ?? null,
    };
  }

  /** Make the set of open relays match what the rules say it should be. Safe to call at any time. */
  reconcile(now = Date.now()): void {
    if (this.closed) return;
    const upstreams = this.source.upstreams();
    const preference = this.source.preference();
    const names = new Set(upstreams.map((upstream) => upstream.name));

    // A relay taken out of the list is closed at once.
    for (const [name, control] of this.controls) {
      if (names.has(name)) continue;
      control.stop();
      this.controls.delete(name);
    }
    // Only the preferred relay is ever "given up on"; a leftover mark would mislabel it after the preference moves.
    for (const name of [...this.retestAt.keys()]) {
      if (!names.has(name) || preference.mode !== "preferred" || preference.preferred !== name) this.retestAt.delete(name);
    }
    // A relay that is serving again is no longer down.
    for (const name of [...this.retestAt.keys()]) {
      if (this.controls.get(name)?.facts(now).ready) this.retestAt.delete(name);
    }

    const decision = decide({
      now,
      preference,
      relays: upstreams.map((upstream) => this.factsFor(upstream, now)),
      fallbackActive: this.fallbackActive,
      timing: this.priorityTiming(),
    });
    this.fallbackActive = decision.fallbackActive;

    if (decision.declareDown) {
      const name = decision.declareDown;
      this.controls.get(name)?.stop();
      this.controls.delete(name);
      this.retestAt.set(name, now + this.timing.retestMs);
      this.logger.warn("preferred relay is not serving; trying it again later", {
        upstream: name,
        retestInMs: this.timing.retestMs,
      });
    }

    const wanted = new Set(decision.register);
    for (const upstream of upstreams) {
      const open = this.controls.has(upstream.name);
      if (wanted.has(upstream.name) && !open) this.open(upstream);
      else if (!wanted.has(upstream.name) && open) this.standBy(upstream.name);
    }
  }

  private priorityTiming(): PriorityTiming {
    const { graceMs, failoverAfterMs, stableMs, retestMs, settleMs } = this.timing;
    return { graceMs, failoverAfterMs, stableMs, retestMs, settleMs };
  }

  private open(upstream: Upstream): void {
    const control = new UpstreamControl(upstream, this.serverId, this.timing, this.logger, (source, message) =>
      this.fromUpstream(source, message),
    );
    this.controls.set(upstream.name, control);
    control.start();
  }

  /** Stop registering with a relay. Sessions already running through it are left alone. */
  private standBy(name: string): void {
    this.controls.get(name)?.stop();
    this.controls.delete(name);
    this.logger.info("relay on standby", { upstream: name });
  }

  private shutdown(): void {
    this.closed = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    for (const control of this.controls.values()) control.stop();
    this.controls.clear();
  }

  private sendToDaemon(message: Record<string, unknown>): void {
    if (this.daemonWs.readyState !== WebSocket.OPEN) return;
    try {
      this.daemonWs.send(JSON.stringify(message));
    } catch {
      // the close handler cleans up
    }
  }

  private fromUpstream(source: Upstream, message: ControlMessage): void {
    switch (message.type) {
      case "ping":
        this.controls.get(source.name)?.sendPong();
        return;
      case "pong":
        return;
      case "sync":
        this.sendToDaemon({
          type: "sync",
          connectionIds: message.connectionIds.map((id) => prefixConnectionId(source.name, id)),
        });
        return;
      case "connected":
      case "disconnected":
        this.sendToDaemon({
          type: message.type,
          connectionId: prefixConnectionId(source.name, message.connectionId),
        });
        return;
    }
  }
}

export class FanoutProxy {
  private readonly timing: Timing;
  private readonly logger: Logger;
  private readonly httpServer: http.Server;
  private readonly wss: WebSocketServer;
  private readonly upstreamsByName = new Map<string, Upstream>();
  private readonly pipes = new Set<DataPipe>();
  private readonly probes = new Map<string, LatencyProbe>();
  private upstreams: Upstream[] = [];
  private preference: Preference;
  private control: ControlSession | null = null;
  private boundAddress: AddressInfo | null = null;

  constructor(private readonly options: FanoutProxyOptions) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.logger = options.logger;
    this.preference = options.preference ?? { mode: "auto", preferred: null };
    this.addUpstreams(options.upstreams);

    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.httpServer = http.createServer((request, response) => this.handleHttp(request, response));
    this.httpServer.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
  }

  get port(): number {
    return this.boundAddress?.port ?? this.options.port;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.httpServer.once("error", onError);
      this.httpServer.listen(this.options.port, this.options.host, () => {
        this.httpServer.off("error", onError);
        this.boundAddress = this.httpServer.address() as AddressInfo;
        resolve();
      });
    });
    this.httpServer.on("error", (error) => {
      this.logger.warn("proxy server error", { error: error.message });
    });
  }

  /**
   * Called when someone is looking at the status. Each relay's /health is requested at most
   * every `latencyMinIntervalMs`, and never while nothing asks, so an idle machine sends nothing
   * to a relay beyond the daemon's own connections.
   */
  touch(): void {
    for (const probe of this.probes.values()) probe.sampleIfDue();
  }

  /**
   * Change the relay list or the preference while running. A relay that is gone has its running
   * sessions closed. One that is new is picked up by the next check of which relays should be open,
   * which is made straight away.
   */
  applyConfig(next: { upstreams: Upstream[]; preference: Preference }): void {
    const current = new Map(this.upstreams.map((upstream) => [upstream.name, upstream]));
    // A relay whose name, address and TLS flag are unchanged keeps its object, and with it its probe history.
    const kept = next.upstreams.map((upstream) => {
      const existing = current.get(upstream.name);
      return existing && existing.endpoint === upstream.endpoint && existing.useTls === upstream.useTls ? existing : upstream;
    });
    for (const old of this.upstreams) {
      if (!kept.includes(old)) this.dropUpstream(old.name);
    }
    this.addUpstreams(kept.filter((upstream) => !this.upstreams.includes(upstream)));
    this.upstreams = kept;
    this.preference = next.preference;
    this.control?.reconcile();
  }

  private addUpstreams(added: Upstream[]): void {
    for (const upstream of added) {
      this.upstreamsByName.set(upstream.name, upstream);
      this.probes.set(
        upstream.name,
        new LatencyProbe(createHealthClient(upstream, this.timing.latencyTimeoutMs), this.timing.latencyMinIntervalMs),
      );
    }
    this.upstreams = [...this.upstreams, ...added];
  }

  private dropUpstream(name: string): void {
    this.probes.get(name)?.close();
    this.probes.delete(name);
    this.upstreamsByName.delete(name);
    for (const pipe of [...this.pipes]) {
      if (pipe.upstream.name === name) pipe.close(1001, "Relay removed");
    }
  }

  async stop(): Promise<void> {
    for (const probe of this.probes.values()) probe.close();
    this.control?.close(1001, "Proxy stopping");
    this.control = null;
    for (const pipe of [...this.pipes]) pipe.close(1001, "Proxy stopping");
    this.pipes.clear();
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
      this.httpServer.closeAllConnections();
    });
  }

  status(): ProxyStatus {
    const control = this.control;
    const now = Date.now();
    const preferredName = this.preference.mode === "preferred" ? this.preference.preferred : null;
    return {
      status: "ok",
      listening: `${this.options.host}:${this.port}`,
      daemonConnected: control !== null,
      serverId: control?.serverId ?? null,
      preference: this.preference,
      fallbackActive: control?.fallback ?? false,
      upstreams: this.upstreams.map((upstream) => {
        const entry = control?.controlFor(upstream.name);
        const probe = this.probes.get(upstream.name)?.snapshot();
        const retestAt = control?.nextRetestAt(upstream.name) ?? null;
        return {
          name: upstream.name,
          endpoint: upstream.endpoint,
          state: entry?.state ?? "idle",
          ready: entry?.ready ?? false,
          connectedAt: entry?.connectedAt?.toISOString() ?? null,
          lastError: entry?.lastError ?? null,
          dataSockets: [...this.pipes].filter((pipe) => pipe.upstream.name === upstream.name).length,
          latency: {
            request: probe?.request ?? { ...EMPTY_STAT },
            ping: entry?.pingStat() ?? { ...EMPTY_STAT },
            connectMs: probe?.connectMs ?? null,
            error: probe?.error ?? null,
          },
          priority: {
            role: control ? roleOf(control.factsFor(upstream, now)) : "standby",
            preferred: upstream.name === preferredName,
            nextRetestAt: retestAt !== null ? new Date(retestAt).toISOString() : null,
          },
        };
      }),
    };
  }

  private handleHttp(request: http.IncomingMessage, response: http.ServerResponse): void {
    if (!this.isLoopbackRequest(request)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if (request.method === "GET" && request.url?.split("?")[0] === "/health") {
      this.touch();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(this.status()));
      return;
    }
    response.writeHead(404).end("Not found");
  }

  /**
   * The proxy is unauthenticated and bound to loopback. Browsers can still be tricked
   * into dialing loopback sockets (cross-site WebSockets, DNS rebinding), so a request
   * with an Origin header or a non-loopback Host header is refused. The daemon sends neither.
   */
  private isLoopbackRequest(request: http.IncomingMessage): boolean {
    if (request.headers.origin) return false;
    const host = request.headers.host ?? "";
    const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
    return LOOPBACK_HOST_HEADERS.has(hostname);
  }

  private reject(socket: Duplex, status: number, message: string): void {
    socket.write(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
    );
    socket.destroy();
  }

  private handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.isLoopbackRequest(request)) {
      this.reject(socket, 403, "Forbidden");
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      this.reject(socket, 400, "Bad request");
      return;
    }
    if (url.pathname !== "/ws") {
      this.reject(socket, 404, "Not found");
      return;
    }
    const serverId = url.searchParams.get("serverId")?.trim();
    const connectionId = url.searchParams.get("connectionId")?.trim() || undefined;
    if (url.searchParams.get("role") !== "server" || !serverId) {
      this.reject(socket, 400, "Only role=server connections with a serverId are supported");
      return;
    }
    if ((url.searchParams.get("v") ?? "2") !== "2") {
      this.reject(socket, 400, "Only relay protocol v2 is supported");
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      if (connectionId) this.acceptData(ws, serverId, connectionId);
      else this.acceptControl(ws, serverId);
    });
  }

  private acceptControl(ws: WebSocket, serverId: string): void {
    // Same rule as a real relay: one control socket per server, the newest wins.
    this.control?.close(1008, "Replaced by new connection");
    const source: RelaySource = {
      upstreams: () => this.upstreams,
      preference: () => this.preference,
    };
    const session = new ControlSession(ws, serverId, source, this.timing, this.logger, (closed) => {
      if (this.control === closed) this.control = null;
    });
    this.control = session;
    this.logger.info("daemon control connected", { serverId });
    session.start();
  }

  private acceptData(ws: WebSocket, serverId: string, prefixedId: string): void {
    const parsed = parsePrefixedConnectionId(prefixedId);
    const upstream = parsed ? this.upstreamsByName.get(parsed.upstream) : undefined;
    if (!parsed || !upstream) {
      this.logger.warn("daemon data socket for an unknown upstream", { connectionId: prefixedId });
      closeQuietly(ws, 1008, "Unknown upstream");
      return;
    }
    const pipe = new DataPipe(ws, upstream, parsed.connectionId, serverId, this.timing, this.logger, (done) => {
      this.pipes.delete(done);
    });
    this.pipes.add(pipe);
    pipe.start();
  }
}
