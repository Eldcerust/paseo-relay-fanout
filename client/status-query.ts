import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { pairingRpc, statusRpc } from "../shared/status";

export const PAIRING_QUERY_KEY = ["relay-fanout", "pairing"] as const;
export const STATUS_QUERY_PREFIX = ["relay-fanout", "status"] as const;

/**
 * `measure` is true only for the open screen. It asks the plugin to refresh each relay's latency,
 * which sends a request to every relay, so the sidebar dot polls without it. The two are separate
 * cache entries because they ask different questions.
 */
export function useFanoutStatus(refetchIntervalMs: number, measure = false) {
  const readStatus = useRpc(statusRpc);
  return useQuery({
    queryKey: [...STATUS_QUERY_PREFIX, measure] as const,
    queryFn: () => readStatus({ measure }),
    refetchInterval: refetchIntervalMs,
    retry: false,
  });
}

export function usePairingLinks() {
  const readPairing = useRpc(pairingRpc);
  return useQuery({
    queryKey: PAIRING_QUERY_KEY,
    queryFn: () => readPairing({}),
    staleTime: 60_000,
    retry: false,
  });
}
