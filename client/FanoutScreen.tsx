import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Loading, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginStatus } from "../shared/status";
import { StatusDot } from "./StatusDot";
import { useFanoutStatus, usePairingLinks } from "./status-query";
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
  };
}

type Styles = ReturnType<typeof createStyles>;

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

function RelayCard({
  upstream,
  now,
  styles,
  theme,
}: {
  upstream: PluginStatus["upstreams"][number];
  now: number;
  styles: Styles;
  theme: PluginTheme;
}) {
  const line = describeUpstream(upstream, now);
  const latency = describeLatency(upstream.latency);
  return (
    <View style={styles.card}>
      <View style={styles.rowTop}>
        <Text numberOfLines={1} style={styles.name}>
          {upstream.name}
        </Text>
        <Pill text={line.label} tone={line.tone} theme={theme} />
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
  const now = Date.now();

  if (query.isPending) return <Loading />;

  const summary = summarize(query.data, query.isError, now);
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <SummaryCard status={query.data} summary={summary} styles={styles} theme={theme} />
      {query.data ? (
        <>
          <View style={{ gap: space.sm }}>
            <Text accessibilityRole="header" style={styles.section}>
              Relays
            </Text>
            {query.data.upstreams.map((upstream) => (
              <RelayCard key={upstream.name} upstream={upstream} now={now} styles={styles} theme={theme} />
            ))}
          </View>
          <PairingSection styles={styles} />
        </>
      ) : null}
    </ScrollView>
  );
}
