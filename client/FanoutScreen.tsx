import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Loading, ScrollView, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { addRelayRpc, preferenceRpc, removeRelayRpc, type PluginStatus } from "../shared/status";
import { StatusDot } from "./StatusDot";
import { PAIRING_QUERY_KEY, STATUS_QUERY_PREFIX, useFanoutStatus, usePairingLinks } from "./status-query";
import { describeLatency, describeUpstream, summarize, type Tone } from "./view-model";
import { MIN_TOUCH, MONO_FONT, radius, space, toneColor } from "./visual";

function createStyles(theme: PluginTheme, compact: boolean) {
  const pad = compact ? space.lg : space.xl;
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: pad, gap: compact ? space.md : space.lg },
    card: {
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: radius.lg,
      padding: compact ? space.md : space.lg,
      gap: space.sm,
    },
    headline: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm },
    title: { flexShrink: 1, color: theme.colors.foreground, fontSize: compact ? 18 : 20, fontWeight: "600" as const },
    body: { color: theme.colors.foreground, fontSize: 14, lineHeight: 20 },
    muted: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 },
    section: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      fontWeight: "600" as const,
      letterSpacing: 0.5,
      textTransform: "uppercase" as const,
    },
    metaRow: { flexDirection: "row" as const, gap: space.md },
    metaLabel: { width: 56, color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
    metaValue: { flex: 1, color: theme.colors.foreground, fontSize: 12, lineHeight: 18, fontFamily: MONO_FONT },
    rowTop: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: space.sm },
    name: { flexShrink: 1, color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
    endpoint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18, fontFamily: MONO_FONT },
    error: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 18 },
    latencyBlock: {
      gap: 2,
      marginTop: space.xs,
      paddingTop: space.sm,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    latencyRow: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "baseline" as const,
      columnGap: space.sm,
    },
    latencyLabel: { width: 84, color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
    latencyValue: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
    latencyBad: { color: theme.colors.statusDanger, fontSize: 15, fontWeight: "600" as const },
    button: {
      minHeight: compact ? MIN_TOUCH : 32,
      justifyContent: "center" as const,
      paddingHorizontal: space.md,
      borderRadius: radius.md,
      backgroundColor: theme.colors.accent,
    },
    buttonText: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "600" as const },
    grow: { flex: 1 },
    actionRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: space.sm,
      marginTop: space.xs,
    },
    actionGroup: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm },
    smallButton: {
      minHeight: compact ? MIN_TOUCH : 30,
      justifyContent: "center" as const,
      alignItems: "center" as const,
      paddingHorizontal: space.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: theme.colors.statusSuccess,
      backgroundColor: theme.colors.surface2,
    },
    smallButtonOn: { backgroundColor: theme.colors.statusSuccess },
    smallButtonText: { color: theme.colors.statusSuccess, fontSize: 12, fontWeight: "600" as const },
    smallButtonTextOn: { color: theme.colors.surface0 },
    dim: { opacity: 0.55 },
    removeButton: {
      minHeight: compact ? MIN_TOUCH : 30,
      justifyContent: "center" as const,
      paddingHorizontal: space.sm,
    },
    removeText: { color: theme.colors.statusDanger, fontSize: 12, fontWeight: "600" as const },
    input: {
      minHeight: compact ? MIN_TOUCH : 36,
      paddingHorizontal: space.sm,
      paddingVertical: 6,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
      color: theme.colors.foreground,
      fontSize: 14,
    },
    formRow: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      alignItems: compact ? ("stretch" as const) : ("center" as const),
      gap: space.sm,
    },
    nameInput: compact ? { alignSelf: "stretch" as const } : { width: 140 },
    hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
  };
}

type Styles = ReturnType<typeof createStyles>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Pill({ text, tone, theme }: { text: string; tone: Tone; theme: PluginTheme }) {
  const filled = tone !== "idle";
  return (
    <View
      style={{
        flexShrink: 0,
        borderRadius: radius.sm,
        paddingHorizontal: space.sm - 2,
        paddingVertical: 2,
        backgroundColor: filled ? toneColor(theme, tone) : theme.colors.surface2,
      }}
    >
      <Text
        numberOfLines={1}
        style={{
          color: filled ? theme.colors.surface0 : theme.colors.foregroundMuted,
          fontSize: 11,
          lineHeight: 16,
          fontWeight: "600",
        }}
      >
        {text}
      </Text>
    </View>
  );
}

function SummaryCard({
  status,
  summary,
  styles,
  theme,
}: {
  status: PluginStatus | undefined;
  summary: ReturnType<typeof summarize>;
  styles: Styles;
  theme: PluginTheme;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.headline}>
        <StatusDot color={toneColor(theme, summary.tone)} label={summary.title} size={10} />
        <Text accessibilityRole="header" style={styles.title}>
          {summary.title}
        </Text>
      </View>
      {summary.detail ? <Text style={styles.muted}>{summary.detail}</Text> : null}
      {status ? (
        <View style={{ gap: 2, marginTop: space.xs }}>
          <MetaRow label="Proxy" value={status.listening} styles={styles} />
          <MetaRow label="Daemon" value={status.serverId ?? "not connected"} styles={styles} />
          <MetaRow
            label="Config"
            value={status.configSource === "file" ? status.configPath : "defaults (official relay only)"}
            styles={styles}
          />
        </View>
      ) : null}
    </View>
  );
}

function MetaRow({ label, value, styles }: { label: string; value: string; styles: Styles }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

function PriorityCard({
  status,
  busy,
  onAuto,
  styles,
  theme,
}: {
  status: PluginStatus;
  busy: boolean;
  onAuto(): void;
  styles: Styles;
  theme: PluginTheme;
}) {
  const preference = status.preference;
  const auto = !preference || preference.mode === "auto";
  const preferred = preference?.preferred ?? null;
  return (
    <View style={styles.card}>
      <View style={styles.rowTop}>
        <View style={styles.grow}>
          <Text style={styles.name}>Auto</Text>
          <Text style={styles.muted}>
            {auto
              ? "Every relay stays connected. Each device uses the fastest one it can reach."
              : preferred
                ? `Preferred relay: ${preferred}.`
                : "No relay is preferred."}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Use Auto relay selection"
          accessibilityState={{ selected: auto, disabled: busy || auto }}
          disabled={busy || auto}
          onPress={onAuto}
          style={[styles.smallButton, auto ? styles.smallButtonOn : null, busy ? styles.dim : null]}
        >
          <Text style={[styles.smallButtonText, auto ? styles.smallButtonTextOn : null]}>{auto ? "On" : "Use"}</Text>
        </Pressable>
      </View>
      {auto ? null : (
        <Text style={styles.muted}>
          Only the preferred relay is registered. If it fails, the fastest healthy relay takes over, and the preferred
          one is retried every 2 minutes.
        </Text>
      )}
    </View>
  );
}

function RelayCard({
  upstream,
  now,
  daemonConnected,
  fallbackActive,
  canRemove,
  confirmingRemove,
  busy,
  onPrefer,
  onAskRemove,
  onRemove,
  styles,
  theme,
}: {
  upstream: PluginStatus["upstreams"][number];
  now: number;
  daemonConnected: boolean;
  fallbackActive: boolean;
  canRemove: boolean;
  confirmingRemove: boolean;
  busy: boolean;
  onPrefer(name: string): void;
  onAskRemove(name: string): void;
  onRemove(name: string): void;
  styles: Styles;
  theme: PluginTheme;
}) {
  const line = describeUpstream(upstream, now, { daemonConnected, fallbackActive });
  const latency = describeLatency(upstream.latency);
  const priority = upstream.priority;
  const preferred = priority?.preferred === true;
  return (
    <View style={styles.card}>
      <View style={styles.rowTop}>
        <Text numberOfLines={1} style={styles.name}>
          {upstream.name}
        </Text>
        <View style={styles.actionGroup}>
          <Pill text={line.label} tone={line.tone} theme={theme} />
        </View>
      </View>
      <Text style={styles.endpoint}>{upstream.endpoint}</Text>
      {line.detail ? <Text style={styles.muted}>{line.detail}</Text> : null}
      {latency ? (
        <View style={styles.latencyBlock}>
          {latency.rows.map((row) => (
            <View key={row.label} style={styles.latencyRow}>
              <Text style={styles.latencyLabel}>{row.label}</Text>
              <Text
                accessibilityLabel={`${upstream.name} ${row.label} ${row.value}`}
                style={row.bad ? styles.latencyBad : styles.latencyValue}
              >
                {row.value}
              </Text>
              {row.detail ? <Text style={styles.muted}>{row.detail}</Text> : null}
            </View>
          ))}
          {latency.error ? <Text style={styles.error}>{latency.error}</Text> : null}
          {latency.note ? <Text style={styles.muted}>{latency.note}</Text> : null}
        </View>
      ) : null}
      <View style={styles.actionRow}>
        <View style={styles.actionGroup}>
          {priority ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={preferred ? `${upstream.name} is the preferred relay` : `Prefer ${upstream.name}`}
              accessibilityState={{ selected: preferred, disabled: busy || preferred }}
              disabled={busy || preferred}
              onPress={() => onPrefer(upstream.name)}
              style={[styles.smallButton, preferred ? styles.smallButtonOn : null, busy ? styles.dim : null]}
            >
              <Text style={[styles.smallButtonText, preferred ? styles.smallButtonTextOn : null]}>
                {preferred ? "Preferred" : "Prefer"}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {canRemove ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={confirmingRemove ? `Confirm removing ${upstream.name}` : `Remove ${upstream.name}`}
            disabled={busy}
            onPress={() => (confirmingRemove ? onRemove(upstream.name) : onAskRemove(upstream.name))}
            style={[styles.removeButton, busy ? styles.dim : null]}
          >
            <Text style={styles.removeText}>{confirmingRemove ? "Confirm remove" : "Remove"}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function AddRelaySection({
  onChanged,
  styles,
}: {
  onChanged(): Promise<void>;
  styles: Styles;
}) {
  const addRelay = useRpc(addRelayRpc);
  const toast = useToast();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy || address.trim() === "") return;
    setError(null);
    setBusy(true);
    try {
      const result = await addRelay({ address, name: name.trim() || undefined });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAddress("");
      setName("");
      toast.show(`Added relay ${result.name ?? ""}`.trim(), { variant: "success" });
      await onChanged();
    } catch (issue) {
      setError(`The plugin did not answer: ${messageOf(issue)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: space.sm }}>
      <Text accessibilityRole="header" style={styles.section}>
        Add a relay
      </Text>
      <View style={styles.card}>
        <Text style={styles.muted}>
          Paste an address. The relay is opened while the plugin runs, and each device can pair with it from the list
          below.
        </Text>
        <View style={styles.formRow}>
          <TextInput
            accessibilityLabel="Relay address"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="wss://relay.example.org or host:port"
            placeholderTextColor={styles.hint.color}
            value={address}
            onChangeText={setAddress}
            onSubmitEditing={() => void submit()}
            returnKeyType="done"
            style={[styles.input, styles.grow]}
          />
          <TextInput
            accessibilityLabel="Relay name, optional"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="name (optional)"
            placeholderTextColor={styles.hint.color}
            value={name}
            onChangeText={setName}
            onSubmitEditing={() => void submit()}
            returnKeyType="done"
            style={[styles.input, styles.nameInput]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add relay"
            accessibilityState={{ disabled: busy || address.trim() === "" }}
            disabled={busy || address.trim() === ""}
            onPress={() => void submit()}
            style={[styles.button, busy || address.trim() === "" ? styles.dim : null]}
          >
            <Text style={styles.buttonText}>{busy ? "Adding" : "Add relay"}</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>
          A missing port is refused. Port 443 means TLS. A name is made from the address when left blank.
        </Text>
        {error ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function PairingSection({ styles }: { styles: Styles }) {
  const pairing = usePairingLinks();
  const toast = useToast();

  async function copy(name: string, link: string) {
    try {
      await copyText(link);
      toast.show(`Pairing link for ${name} copied`, { variant: "success" });
    } catch {
      toast.error("Copying is not available here");
    }
  }

  return (
    <View style={{ gap: space.sm }}>
      <Text accessibilityRole="header" style={styles.section}>
        Pair a device
      </Text>
      <View style={styles.card}>
        <Text style={styles.muted}>
          Each relay needs its own link. Copy one, then open it on the device or paste it under Add host.
        </Text>
        {pairing.isPending ? <Text style={styles.muted}>Preparing links</Text> : null}
        {pairing.isError ? <Text style={styles.error}>Could not prepare the pairing links.</Text> : null}
        {pairing.data && !pairing.data.available ? <Text style={styles.error}>{pairing.data.reason}</Text> : null}
        {pairing.data?.available
          ? pairing.data.links.map((entry) => (
              <View key={entry.name} style={styles.rowTop}>
                <View style={{ flexShrink: 1, gap: 2 }}>
                  <Text numberOfLines={1} style={styles.name}>
                    {entry.name}
                  </Text>
                  <Text numberOfLines={1} style={styles.endpoint}>
                    {entry.endpoint}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Copy pairing link for ${entry.name}`}
                  onPress={() => void copy(entry.name, entry.link)}
                  style={styles.button}
                >
                  <Text style={styles.buttonText}>Copy link</Text>
                </Pressable>
              </View>
            ))
          : null}
      </View>
    </View>
  );
}

export function FanoutScreen({ theme, layout }: PluginScreenProps) {
  const query = useFanoutStatus(2_000, true);
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const queryClient = useQueryClient();
  const setPreference = useRpc(preferenceRpc);
  const removeRelay = useRpc(removeRelayRpc);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const now = Date.now();

  useEffect(() => {
    if (!confirmRemove) return;
    const timer = setTimeout(() => setConfirmRemove(null), 5_000);
    return () => clearTimeout(timer);
  }, [confirmRemove]);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: STATUS_QUERY_PREFIX });
    await queryClient.invalidateQueries({ queryKey: PAIRING_QUERY_KEY });
  }

  async function chooseAuto() {
    setBusy(true);
    try {
      const result = await setPreference({ mode: "auto" });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.show("Auto: each device picks the fastest relay", { variant: "success" });
      await refresh();
    } catch (issue) {
      toast.error(`Could not change the preference: ${messageOf(issue)}`);
    } finally {
      setBusy(false);
    }
  }

  async function prefer(name: string) {
    setBusy(true);
    try {
      const result = await setPreference({ mode: "preferred", preferred: name });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.show(`${name} is now the preferred relay`, { variant: "success" });
      await refresh();
    } catch (issue) {
      toast.error(`Could not change the preference: ${messageOf(issue)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    setBusy(true);
    setConfirmRemove(null);
    try {
      const result = await removeRelay({ name });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.show(`Removed relay ${name}`, { variant: "success" });
      await refresh();
    } catch (issue) {
      toast.error(`Could not remove the relay: ${messageOf(issue)}`);
    } finally {
      setBusy(false);
    }
  }

  if (query.isPending) return <Loading />;

  const summary = summarize(query.data, query.isError, now);
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <SummaryCard status={query.data} summary={summary} styles={styles} theme={theme} />
      {query.data ? (
        <>
          <View style={{ gap: space.sm }}>
            <Text accessibilityRole="header" style={styles.section}>
              Priority
            </Text>
            <PriorityCard status={query.data} busy={busy} onAuto={() => void chooseAuto()} styles={styles} theme={theme} />
          </View>
          <View style={{ gap: space.sm }}>
            <Text accessibilityRole="header" style={styles.section}>
              Relays
            </Text>
            {query.data.upstreams.map((upstream) => (
              <RelayCard
                key={upstream.name}
                upstream={upstream}
                now={now}
                daemonConnected={query.data.daemonConnected}
                fallbackActive={query.data.fallbackActive === true}
                canRemove={query.data.upstreams.length > 1}
                confirmingRemove={confirmRemove === upstream.name}
                busy={busy}
                onPrefer={(name) => void prefer(name)}
                onAskRemove={setConfirmRemove}
                onRemove={(name) => void remove(name)}
                styles={styles}
                theme={theme}
              />
            ))}
          </View>
          <AddRelaySection onChanged={refresh} styles={styles} />
          <PairingSection styles={styles} />
        </>
      ) : null}
    </ScrollView>
  );
}
