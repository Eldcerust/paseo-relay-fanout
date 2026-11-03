import type { PluginStatus, UpstreamLatencyView, UpstreamView } from "../shared/status";

/** ok = green, warn = amber, bad = red, idle = neutral. */
export type Tone = "ok" | "warn" | "bad" | "idle";

export interface Summary {
  tone: Tone;
  title: string;
  detail: string | null;
}

export interface UpstreamLine {
  label: string;
  tone: Tone;
  detail: string | null;
}

/** A relay that is connected but silent this long is probably not a Paseo relay. */
export const READY_GRACE_MS = 10_000;

export function formatSince(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

/** "in 45s", "in 2m", "in 1h". Null when there is no usable time or it has already passed. */
export function formatUntil(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.ceil((then - now) / 1000);
  if (seconds <= 0) return "any moment";
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${Math.ceil(minutes / 60)}h`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** 0.6 -> "<1 ms", 2.44 -> "2.4 ms", 73.4 -> "73 ms", 1242 -> "1.2 s", 12400 -> "12 s". */
export function formatMs(ms: number): string {
  if (ms < 1) return "<1 ms";
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

export interface LatencyRow {
  /** "Request", "Socket ping" or "Connect". */
  label: string;
  /** "59 ms", "Measuring" or "No answer". */
  value: string;
  /** The latest sample failed, so the value is drawn as a problem. */
  bad: boolean;
  /** Spread over the recent samples, and how many failed. */
  detail: string | null;
}

export interface LatencyLines {
  rows: LatencyRow[];
  /** Why the last request failed. */
  error: string | null;
  /** Shown when the request and the ping disagree enough that a reader should know. */
  note: string | null;
}

/** The two measures are at least this far apart, in ratio and in time, before a note is shown. */
const DISAGREE_RATIO = 3;
const DISAGREE_MS = 100;

function describeStat(label: string, stat: UpstreamLatencyView["request"]): LatencyRow | null {
  const total = stat.answered + stat.lost;
  if (total === 0) return null;
  const spread =
    stat.answered >= 2 && stat.avgMs !== null && stat.minMs !== null && stat.maxMs !== null
      ? `avg ${formatMs(stat.avgMs)} · best ${formatMs(stat.minMs)} · worst ${formatMs(stat.maxMs)}`
      : null;
  const failed = stat.lost > 0 ? `${stat.lost} of ${total} ${label === "Request" ? "failed" : "lost"}` : null;
  const detail = [spread, failed].filter((part): part is string => part !== null).join(" · ") || null;
  if (stat.lastOk === false || stat.lastMs === null) return { label, value: "No answer", bad: true, detail };
  return { label, value: formatMs(stat.lastMs), bad: false, detail };
}

/**
 * Two measures, shown side by side and not ranked. "Request" is the round trip of a GET /health
 * to the relay. "Socket ping" is a WebSocket ping on the control socket, the same kind of path
 * the sessions use. Either can be answered early or take a faster route: an edge such as Cloudflare
 * answers pings itself, and a tunnel with several connections can send one request down a quick
 * connection while the long-lived socket sits on a slow one. On the home relay's tunnel they
 * disagreed in both directions on different days, so neither is presented as "the" latency.
 */
export function describeLatency(latency: UpstreamLatencyView | undefined): LatencyLines | null {
  if (!latency) return null;
  const { request, ping, connectMs } = latency;

  const rows: LatencyRow[] = [];
  const requestRow = describeStat("Request", request);
  rows.push(requestRow ?? { label: "Request", value: "Measuring", bad: false, detail: null });
  const pingRow = describeStat("Socket ping", ping);
  if (pingRow) rows.push(pingRow);
  if (connectMs !== null) rows.push({ label: "Connect", value: formatMs(connectMs), bad: false, detail: null });

  let note: string | null = null;
  if (request.lastMs !== null && ping.lastMs !== null && request.lastOk !== false && ping.lastOk !== false) {
    const [low, high] = request.lastMs < ping.lastMs ? [request.lastMs, ping.lastMs] : [ping.lastMs, request.lastMs];
    if (high >= low * DISAGREE_RATIO && high - low >= DISAGREE_MS) {
      note = "The request and the socket ping disagree. A tunnel or edge can answer one early or on a faster route, so read both.";
    }
  }

  return { rows, error: request.lastOk === false ? latency.error : null, note };
}

/** Context the screen knows but a single relay's status does not. */
export interface UpstreamContext {
  /** The daemon is talking to the proxy. When false, a standby role is not a choice. */
  daemonConnected?: boolean;
  /** The preferred relay is unavailable, so the others are serving in its place. */
  fallbackActive?: boolean;
}

/** The one-line state of a single relay. */
export function describeUpstream(upstream: UpstreamView, now: number, context: UpstreamContext = {}): UpstreamLine {
  const connected = context.daemonConnected ?? true;
  const priority = upstream.priority;

  // A relay left out on purpose must not read like one that failed.
  if (priority && connected) {
    if (priority.role === "standby") {
      return {
        label: "Standby",
        tone: "idle",
        detail: "Closed while the preferred relay serves. It opens if that relay fails.",
      };
    }
    if (priority.role === "down") {
      const when = formatUntil(priority.nextRetestAt, now);
      const reason = upstream.lastError ? `${upstream.lastError}. ` : "";
      return { label: "Retrying", tone: "bad", detail: `${reason}Next try ${when ?? "shortly"}.` };
    }
  }

  const line = describeState(upstream, now);
  if (!priority || !connected) return line;

  const tag = priority.preferred ? "Preferred" : context.fallbackActive ? "Fallback" : null;
  if (!tag) return line;
  return { ...line, detail: line.detail ? `${tag} · ${line.detail}` : tag };
}

function describeState(upstream: UpstreamView, now: number): UpstreamLine {
  switch (upstream.state) {
    case "connected": {
      const since = formatSince(upstream.connectedAt, now);
      const connectedMs = upstream.connectedAt ? now - Date.parse(upstream.connectedAt) : 0;
      if (!upstream.ready) {
        return connectedMs > READY_GRACE_MS
          ? {
              label: "No reply",
              tone: "warn",
              detail: "Connected, but the relay has sent no control message. The daemon would reject it as incompatible.",
            }
          : { label: "Connecting", tone: "idle", detail: "Waiting for the relay's first message." };
      }
      const sessions = upstream.dataSockets === 0 ? "no sessions" : plural(upstream.dataSockets, "session");
      return {
        label: "Connected",
        tone: "ok",
        detail: since ? `Up ${since === "just now" ? "just now" : `for ${since}`} · ${sessions}` : sessions,
      };
    }
    case "connecting":
      return { label: "Connecting", tone: "idle", detail: null };
    case "down":
      return {
        label: "Down",
        tone: "bad",
        detail: upstream.lastError ? `${upstream.lastError}. Retrying.` : "Retrying.",
      };
    case "idle":
      return { label: "Not registered", tone: "idle", detail: "The daemon is not connected to the proxy." };
  }
}

/**
 * The headline for the whole plugin. `unreachable` means the status request itself failed,
 * which is different from the proxy reporting that something is down.
 */
export function summarize(status: PluginStatus | undefined, unreachable: boolean, now: number): Summary {
  if (unreachable) {
    return {
      tone: "bad",
      title: "Proxy not answering",
      detail: "The plugin did not respond. Check it with `paseo plugin ls`.",
    };
  }
  if (!status) return { tone: "idle", title: "Checking relays", detail: null };

  if (!status.daemonConnected) {
    return {
      tone: "warn",
      title: "Daemon not using the proxy",
      detail: `Set daemon.relay.endpoint to ${status.listening} with TLS off, then restart the daemon.`,
    };
  }

  if (status.preference?.mode === "preferred") {
    return summarizePreferred(status, status.preference.preferred, now);
  }

  const total = status.upstreams.length;
  const lines = status.upstreams.map((upstream) => describeUpstream(upstream, now));
  const healthy = lines.filter((line) => line.tone === "ok").length;

  if (healthy === total) {
    return { tone: "ok", title: total === 1 ? "Relay connected" : `All ${total} relays connected`, detail: null };
  }
  const missing = status.upstreams
    .filter((_, index) => lines[index]?.tone !== "ok")
    .map((upstream) => upstream.name)
    .join(", ");
  if (healthy === 0) {
    return { tone: "bad", title: "No relay connected", detail: `Not connected: ${missing}.` };
  }
  return { tone: "warn", title: `${healthy} of ${total} relays connected`, detail: `Not connected: ${missing}.` };
}

/**
 * In preferred mode most relays are meant to be closed, so counting "connected" relays would show a
 * permanent warning. What matters is whether the preferred relay is serving, and if not, whether a
 * fallback took over.
 */
function summarizePreferred(status: PluginStatus, preferredName: string | null, now: number): Summary {
  const preferred =
    status.upstreams.find((upstream) => upstream.name === preferredName) ??
    status.upstreams.find((upstream) => upstream.priority?.preferred);
  if (!preferred) {
    const names = status.upstreams.map((upstream) => upstream.name).join(", ");
    return {
      tone: "bad",
      title: "Preferred relay is not in the list",
      detail: `Configured preference "${preferredName ?? "none"}", but the relays are ${names}. Pick a relay again.`,
    };
  }

  const fallbacks = status.upstreams.filter(
    (upstream) => upstream.name !== preferred.name && upstream.priority?.role === "active",
  );
  const total = status.upstreams.length;

  if (preferred.ready) {
    return {
      tone: "ok",
      title: `Preferred relay ${preferred.name} connected`,
      detail: status.fallbackActive
        ? "The fallbacks stay open until it has been stable for a few more seconds."
        : total > 1
          ? "The other relays are standing by and open only if it fails."
          : null,
    };
  }

  if (fallbacks.length > 0) {
    const names = fallbacks.map((upstream) => upstream.name).join(", ");
    return {
      tone: "warn",
      title: fallbacks.length === 1 ? `Using fallback relay ${names}` : `Using ${fallbacks.length} fallback relays`,
      detail: `${preferred.name} is unavailable. It is retried every 2 minutes.`,
    };
  }

  if (preferred.priority?.role === "down") {
    const when = formatUntil(preferred.priority.nextRetestAt, now);
    return {
      tone: "bad",
      title: `Preferred relay ${preferred.name} is down`,
      detail: `No fallback is serving either. Next try ${when ?? "shortly"}.`,
    };
  }

  return {
    tone: "warn",
    title: `Waiting for ${preferred.name}`,
    detail: "The fallbacks open if it does not answer.",
  };
}
