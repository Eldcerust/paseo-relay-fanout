import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const upstreamStateSchema = z.enum(["idle", "connecting", "connected", "down"]);

const latencyStatSchema = z.object({
  /** Whether the most recent sample was answered; null until there is one. */
  lastOk: z.boolean().nullable(),
  lastMs: z.number().nullable(),
  avgMs: z.number().nullable(),
  minMs: z.number().nullable(),
  maxMs: z.number().nullable(),
  answered: z.number(),
  lost: z.number(),
});

const latencySchema = z.object({
  /** Round trip of GET /health to the relay, over a kept-alive connection. */
  request: latencyStatSchema,
  /** WebSocket ping on the control socket. An edge such as Cloudflare can answer this itself. */
  ping: latencyStatSchema,
  connectMs: z.number().nullable(),
  error: z.string().nullable(),
});

const upstreamStatusSchema = z.object({
  name: z.string(),
  endpoint: z.string(),
  state: upstreamStateSchema,
  /** The relay has sent at least one control message on the current connection. */
  ready: z.boolean(),
  connectedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  dataSockets: z.number(),
  /** Optional so a newer screen still works against an older plugin and the reverse. */
  latency: latencySchema.optional(),
});

/** Live state of the proxy, as the sidebar and the screen show it. */
export const statusRpc = defineRpc({
  name: "relay-fanout.status",
  // `measure` asks the plugin to refresh each relay's latency. Only the open screen sets it, so the
  // sidebar dot's background polling never sends a request to a relay.
  input: z.object({ measure: z.boolean().optional() }),
  output: z.object({
    listening: z.string(),
    daemonConnected: z.boolean(),
    serverId: z.string().nullable(),
    upstreams: z.array(upstreamStatusSchema),
    configPath: z.string(),
    configSource: z.enum(["file", "default"]),
  }),
});

const pairingLinkSchema = z.object({
  name: z.string(),
  endpoint: z.string(),
  link: z.string(),
});

/** One pairing link per relay, built from the daemon's public identity. */
export const pairingRpc = defineRpc({
  name: "relay-fanout.pairing",
  input: z.object({}),
  output: z.discriminatedUnion("available", [
    z.object({ available: z.literal(true), links: z.array(pairingLinkSchema) }),
    z.object({ available: z.literal(false), reason: z.string() }),
  ]),
});

export type PluginStatus = z.output<typeof statusRpc.output>;
export type UpstreamView = PluginStatus["upstreams"][number];
export type UpstreamState = z.output<typeof upstreamStateSchema>;
export type UpstreamLatencyView = NonNullable<UpstreamView["latency"]>;
export type LatencyStatView = UpstreamLatencyView["request"];
export type PairingResult = z.output<typeof pairingRpc.output>;
