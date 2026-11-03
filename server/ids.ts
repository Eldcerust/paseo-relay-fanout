/**
 * Connection ids are minted by each relay, so two relays can hand out the same
 * id. The proxy tells the daemon `<upstream>:<id>` and splits it again when the
 * daemon opens the matching data socket. The daemon treats the id as opaque.
 */
export function prefixConnectionId(upstreamName: string, connectionId: string): string {
  return `${upstreamName}:${connectionId}`;
}

export interface ParsedConnectionId {
  upstream: string;
  connectionId: string;
}

export function parsePrefixedConnectionId(value: string): ParsedConnectionId | null {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  return { upstream: value.slice(0, separator), connectionId: value.slice(separator + 1) };
}
