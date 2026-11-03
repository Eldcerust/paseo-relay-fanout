import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import type { Upstream } from "./config";

export const LATENCY_WINDOW = 20;

export interface LatencyStat {
  /** Whether the most recent sample was answered. Null until there is a sample. */
  lastOk: boolean | null;
  /** The most recent answered sample. */
  lastMs: number | null;
  avgMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  answered: number;
  lost: number;
}

export const EMPTY_STAT: LatencyStat = {
  lastOk: null,
  lastMs: null,
  avgMs: null,
  minMs: null,
  maxMs: null,
  answered: 0,
  lost: 0,
};

const round1 = (value: number) => Math.round(value * 10) / 10;

/** The last N samples of a round trip; `null` is a sample that got no answer. */
export class LatencyWindow {
  private readonly samples: Array<number | null> = [];

  constructor(private readonly size = LATENCY_WINDOW) {}

  record(ms: number | null): void {
    this.samples.push(ms === null ? null : round1(ms));
    if (this.samples.length > this.size) this.samples.shift();
  }

  stat(): LatencyStat {
    if (this.samples.length === 0) return { ...EMPTY_STAT };
    const answered = this.samples.filter((sample): sample is number => sample !== null);
    const newest = this.samples[this.samples.length - 1];
    const lastAnswered = [...answered].pop() ?? null;
    return {
      lastOk: newest !== null,
      lastMs: lastAnswered,
      avgMs: answered.length ? round1(answered.reduce((sum, value) => sum + value, 0) / answered.length) : null,
      minMs: answered.length ? Math.min(...answered) : null,
      maxMs: answered.length ? Math.max(...answered) : null,
      answered: answered.length,
      lost: this.samples.length - answered.length,
    };
  }
}

export interface HealthResult {
  ms: number;
  /** False when the request had to open a new connection, so its time includes TCP and TLS setup. */
  reusedSocket: boolean;
}

export interface HealthClient {
  request(): Promise<HealthResult>;
  close(): void;
}

/**
 * GET /health over a kept-alive connection. This goes through the same address the daemon
 * uses, and a relay's HTTP side is answered by the relay itself (or by whatever fronts it, as
 * with a Cloudflare tunnel), unlike a WebSocket ping, which an edge can answer on its own.
 */
export function createHealthClient(upstream: Upstream, timeoutMs: number): HealthClient {
  const transport = upstream.useTls ? https : http;
  const agent = new transport.Agent({ keepAlive: true, maxSockets: 1 });
  const url = new URL(`${upstream.useTls ? "https" : "http"}://${upstream.endpoint}/health`);

  const once = () =>
    new Promise<HealthResult>((resolve, reject) => {
      const started = performance.now();
      const request = transport.get(
        url,
        { agent, headers: { "user-agent": "paseo-relay-fanout", accept: "application/json" } },
        (response) => {
          response.resume();
          response.on("end", () => {
            if (!response.statusCode || response.statusCode < 200 || response.statusCode > 299) {
              reject(new Error(`HTTP ${response.statusCode ?? "?"}`));
              return;
            }
            resolve({ ms: performance.now() - started, reusedSocket: request.reusedSocket === true });
          });
          response.on("error", reject);
        },
      );
      request.setTimeout(timeoutMs, () => request.destroy(new Error(`no answer within ${timeoutMs} ms`)));
      request.on("error", reject);
    });

  return {
    async request() {
      try {
        return await once();
      } catch (error) {
        // A kept-alive connection the relay closed in the meantime fails once, then works.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ECONNRESET" || code === "EPIPE") return await once();
        throw error;
      }
    },
    close() {
      agent.destroy();
    },
  };
}

/**
 * Samples one relay's /health, but only when asked and not more often than `minIntervalMs`.
 * Nothing is sent while nobody is looking at the status, which keeps a third party's relay quiet.
 */
export class LatencyProbe {
  private readonly window = new LatencyWindow();
  private connectMs: number | null = null;
  private error: string | null = null;
  private inflight = false;
  private lastStartedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly client: HealthClient,
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  sampleIfDue(): void {
    if (this.inflight || this.now() - this.lastStartedAt < this.minIntervalMs) return;
    void this.sample();
  }

  snapshot(): { request: LatencyStat; connectMs: number | null; error: string | null } {
    return { request: this.window.stat(), connectMs: this.connectMs, error: this.error };
  }

  close(): void {
    this.client.close();
  }

  private async sample(): Promise<void> {
    this.inflight = true;
    this.lastStartedAt = this.now();
    try {
      let result = await this.client.request();
      if (!result.reusedSocket) {
        // A cold request includes connection setup. Keep that apart so it cannot pass for the round
        // trip, then take one warm sample straight away instead of waiting for the next interval.
        this.connectMs = round1(result.ms);
        result = await this.client.request();
      }
      if (result.reusedSocket) this.window.record(result.ms);
      else this.connectMs = round1(result.ms); // a relay that never keeps connections alive
      this.error = null;
    } catch (error) {
      this.window.record(null);
      this.error = (error as Error).message;
    } finally {
      this.inflight = false;
    }
  }
}
