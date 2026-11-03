import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  createClientChannel,
  createDaemonChannel,
  exportPublicKey,
  generateKeyPair,
  type EncryptedChannel,
} from "@getpaseo/relay";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Logger, Timing } from "../server/proxy";

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined };

export const fastTiming: Partial<Timing> = {
  pingIntervalMs: 100,
  staleTimeoutMs: 2_000,
  reconnectBaseMs: 40,
  reconnectMaxMs: 120,
  handshakeTimeoutMs: 1_000,
  dataOpenTimeoutMs: 1_500,
  readyWarnMs: 500,
  latencyMinIntervalMs: 40,
  latencyTimeoutMs: 800,
  // The preferred-relay rules, shrunk so a whole failure and recovery fits in a few seconds.
  graceMs: 700,
  failoverAfterMs: 150,
  stableMs: 300,
  retestMs: 900,
  settleMs: 250,
  reconcileIntervalMs: 30,
};

export async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

interface TransportMessage {
  data: string | ArrayBuffer;
  isBinary: boolean;
}

/** Adapts a ws socket to the relay package's Transport, queueing frames until a handler is set. */
export function wsTransport(ws: WebSocket) {
  const queue: TransportMessage[] = [];
  let handler: ((message: TransportMessage) => void) | null = null;
  const transport = {
    send: (data: string | ArrayBuffer) => ws.send(data),
    close: (code?: number, reason?: string) => ws.close(code, reason),
    get onmessage() {
      return handler;
    },
    set onmessage(next: ((message: TransportMessage) => void) | null) {
      handler = next;
      while (handler && queue.length > 0) handler(queue.shift()!);
    },
    onclose: null as ((code: number, reason: string) => void) | null,
    onerror: null as ((error: Error) => void) | null,
  };
  ws.on("message", (data, isBinary) => {
    const buffer = toBuffer(data);
    const message: TransportMessage = {
      data: isBinary ? new Uint8Array(buffer).buffer : buffer.toString("utf8"),
      isBinary,
    };
    if (handler) handler(message);
    else queue.push(message);
  });
  ws.on("close", (code, reason) => transport.onclose?.(code, reason.toString()));
  ws.on("error", (error) => transport.onerror?.(error));
  return transport;
}

interface BufferedFrame {
  data: Buffer;
  isBinary: boolean;
}

/**
 * A relay that follows the v2 server semantics of the official one: one control socket
 * per server (newest wins), one data socket per connection id, frames buffered until the
 * data socket appears. It mints sequential ids (`conn_1`, `conn_2`), so two instances
 * deliberately hand out identical ids.
 */
export class FakeRelay {
  control: WebSocket | null = null;
  controlConnects = 0;
  readonly controlMessages: Array<Record<string, unknown>> = [];
  readonly data = new Map<string, WebSocket>();
  readonly clients = new Map<string, WebSocket>();
  private readonly pending = new Map<string, BufferedFrame[]>();
  /** Slows down accepting server data sockets, so the proxy's upstream stays "connecting". */
  dataUpgradeDelayMs = 0;
  private sequence = 0;
  private readonly server = http.createServer();
  private readonly wss: WebSocketServer;

  /**
   * `answerPings: false` models a relay that never replies to protocol pings, which nothing
   * obliges a relay to do on a data socket.
   */
  /** How many times something tried to register as the server, whether or not it was let in. */
  controlAttempts = 0;
  /** Drop every attempt to register as the server, as a relay that is up but broken would. */
  refuseControl = false;
  /** How long GET /health takes to answer, and with which status. */
  healthDelayMs = 0;
  healthStatus = 200;
  healthRequests = 0;
  private readonly pongDelayMs: number | undefined;

  /**
   * `pongDelayMs` answers protocol pings on control sockets after a fixed delay, so a ping
   * round trip is predictable.
   */
  constructor(
    readonly name: string,
    options: { answerPings?: boolean; pongDelayMs?: number } = {},
  ) {
    this.pongDelayMs = options.pongDelayMs;
    this.wss = new WebSocketServer({
      noServer: true,
      autoPong: options.answerPings !== false && options.pongDelayMs === undefined,
    });
    this.server.on("request", (request, response) => {
      if (request.url?.split("?")[0] !== "/health") {
        response.writeHead(404).end();
        return;
      }
      this.healthRequests += 1;
      setTimeout(() => {
        response.writeHead(this.healthStatus, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: this.healthStatus === 200 ? "ok" : "error", version: "fake" }));
      }, this.healthDelayMs);
    });
    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://relay.test");
      const role = url.searchParams.get("role");
      const connectionId = url.searchParams.get("connectionId");
      if (role === "server" && !connectionId) {
        this.controlAttempts += 1;
        if (this.refuseControl) {
          socket.destroy();
          return;
        }
      }
      const accept = () =>
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          if (role === "server" && !connectionId) this.attachControl(ws);
          else if (role === "server" && connectionId) this.attachData(ws, connectionId);
          else this.attachClient(ws, connectionId ?? undefined);
        });
      if (role === "server" && connectionId && this.dataUpgradeDelayMs > 0) {
        setTimeout(accept, this.dataUpgradeDelayMs);
      } else {
        accept();
      }
    });
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  get listening(): boolean {
    return this.server.listening;
  }

  async listen(port = 0): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    return this.port;
  }

  async close(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate();
    this.control = null;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  /**
   * Make every server data socket go silent without closing it: the relay stops reading, so
   * it answers nothing and the TCP connection stays open. This is how a network path that
   * dies without a FIN looks to the other end.
   */
  freezeData(): void {
    for (const ws of this.data.values()) ws.pause();
  }

  /** Drop the daemon-facing control socket, as a relay restart would. */
  dropControl(): void {
    this.control?.terminate();
  }

  notifyControl(message: Record<string, unknown>): void {
    this.control?.send(JSON.stringify(message));
  }

  private attachControl(ws: WebSocket): void {
    this.control?.close(1008, "Replaced by new connection");
    this.control = ws;
    this.controlConnects += 1;
    if (this.pongDelayMs !== undefined) {
      const delay = this.pongDelayMs;
      ws.on("ping", (payload) => {
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) ws.pong(payload);
        }, delay);
      });
    }
    ws.on("message", (data) => {
      try {
        this.controlMessages.push(JSON.parse(toBuffer(data).toString("utf8")));
      } catch {
        // protocol-level frames only
      }
    });
    ws.on("close", () => {
      if (this.control === ws) this.control = null;
    });
    ws.send(JSON.stringify({ type: "sync", connectionIds: [...this.clients.keys()] }));
  }

  private attachData(ws: WebSocket, connectionId: string): void {
    this.data.get(connectionId)?.close(1008, "Replaced by new connection");
    this.data.set(connectionId, ws);
    ws.on("message", (data, isBinary) => {
      const client = this.clients.get(connectionId);
      if (client?.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    ws.on("close", () => {
      if (this.data.get(connectionId) === ws) this.data.delete(connectionId);
      this.clients.get(connectionId)?.close(1012, "Server disconnected");
    });
    for (const frame of this.pending.get(connectionId) ?? []) ws.send(frame.data, { binary: frame.isBinary });
    this.pending.delete(connectionId);
  }

  private attachClient(ws: WebSocket, requestedId?: string): void {
    this.sequence += 1;
    const connectionId = requestedId ?? `conn_${this.sequence}`;
    this.clients.set(connectionId, ws);
    ws.on("message", (data, isBinary) => {
      const target = this.data.get(connectionId);
      if (target?.readyState === WebSocket.OPEN) {
        target.send(data, { binary: isBinary });
        return;
      }
      const frames = this.pending.get(connectionId) ?? [];
      frames.push({ data: toBuffer(data), isBinary });
      this.pending.set(connectionId, frames);
    });
    ws.on("close", () => {
      this.clients.delete(connectionId);
      this.data.get(connectionId)?.close(1001, "Client disconnected");
      this.notifyControl({ type: "disconnected", connectionId });
    });
    this.notifyControl({ type: "connected", connectionId });
  }

  /** Open a raw client socket, as a phone would. */
  async connectClient(serverId: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws?serverId=${serverId}&role=client&v=2`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return ws;
  }
}

export type DataHandler = (ws: WebSocket, connectionId: string) => void;

/** Mirrors the daemon's relay transport: one control socket, one data socket per connection. */
export class FakeDaemon {
  readonly controlMessages: Array<Record<string, unknown>> = [];
  readonly dataSockets = new Map<string, WebSocket>();
  control: WebSocket | null = null;
  controlCloseCode: number | null = null;

  constructor(
    private readonly proxyPort: number,
    readonly serverId: string,
    private readonly onData: DataHandler,
  ) {}

  get dataIds(): string[] {
    return [...this.dataSockets.keys()].sort();
  }

  async start(): Promise<void> {
    const ws = new WebSocket(
      `ws://127.0.0.1:${this.proxyPort}/ws?serverId=${this.serverId}&role=server&v=2`,
    );
    this.control = ws;
    ws.on("message", (data) => {
      const message = JSON.parse(toBuffer(data).toString("utf8")) as Record<string, unknown>;
      this.controlMessages.push(message);
      if (message.type === "sync") {
        for (const id of message.connectionIds as string[]) this.ensureData(id);
      } else if (message.type === "connected") {
        this.ensureData(message.connectionId as string);
      } else if (message.type === "disconnected") {
        this.dataSockets.get(message.connectionId as string)?.close(1001, "Client disconnected");
      }
    });
    ws.on("close", (code) => {
      this.controlCloseCode = code;
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    // The real daemon terminates the socket unless a control message arrives quickly.
    await waitFor(() => this.controlMessages.length > 0, "the first control message from the proxy");
  }

  stop(): void {
    this.control?.terminate();
    for (const ws of this.dataSockets.values()) ws.terminate();
    this.dataSockets.clear();
  }

  closeData(connectionId: string, code = 1001): void {
    this.dataSockets.get(connectionId)?.close(code, "Closed by daemon");
  }

  private ensureData(connectionId: string): void {
    if (this.dataSockets.has(connectionId)) return;
    const ws = new WebSocket(
      `ws://127.0.0.1:${this.proxyPort}/ws?serverId=${this.serverId}&role=server&v=2&connectionId=${encodeURIComponent(connectionId)}`,
    );
    this.dataSockets.set(connectionId, ws);
    ws.on("open", () => this.onData(ws, connectionId));
    ws.on("close", () => {
      if (this.dataSockets.get(connectionId) === ws) this.dataSockets.delete(connectionId);
    });
    ws.on("error", () => undefined);
  }
}

/** Daemon data handler: answer with the same frame, keeping its text or binary type. */
export const rawEcho: DataHandler = (ws) => {
  ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
};

/** Daemon data handler: real end-to-end encrypted channel that upper-cases what it receives. */
export function encryptedUpperCase(daemonKeyPair: ReturnType<typeof generateKeyPair>): DataHandler {
  return (ws) => {
    const holder: { channel?: EncryptedChannel } = {};
    void createDaemonChannel(wsTransport(ws), daemonKeyPair, {
      onmessage: (data) => {
        if (typeof data === "string") void holder.channel?.send(data.toUpperCase());
      },
    }).then((channel) => {
      holder.channel = channel;
    });
  };
}

/** A phone: dials a relay, runs the real E2EE client handshake and sends one request. */
export async function encryptedRequest(
  relay: FakeRelay,
  serverId: string,
  daemonPublicKeyB64: string,
  text: string,
): Promise<string> {
  const ws = await relay.connectClient(serverId);
  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`no encrypted reply via ${relay.name}`)), 4_000);
    const holder: { channel?: EncryptedChannel } = {};
    void createClientChannel(wsTransport(ws), daemonPublicKeyB64, {
      onopen: () => void holder.channel?.send(text),
      onmessage: (data) => {
        clearTimeout(timeout);
        ws.close();
        resolve(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
      },
      onerror: reject,
    }).then((channel) => {
      holder.channel = channel;
    }, reject);
  });
}

export function newKeyPair() {
  const keyPair = generateKeyPair();
  return { keyPair, publicKeyB64: exportPublicKey(keyPair.publicKey) };
}

/** Status code of a refused WebSocket upgrade, or 101 if it was accepted. */
export async function upgradeStatus(
  url: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const ws = new WebSocket(url, { headers });
  return await new Promise<number>((resolve) => {
    ws.once("open", () => {
      ws.terminate();
      resolve(101);
    });
    ws.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
      ws.terminate();
    });
    ws.once("error", () => resolve(0));
  });
}
