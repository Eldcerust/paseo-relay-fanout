import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Loading, Modal, ScrollView, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  addRelayRpc,
  editRelayRpc,
  exportConfigRpc,
  importConfigRpc,
  preferenceRpc,
  removeRelayRpc,
  reorderRelaysRpc,
  type ConfigSummaryView,
  type PluginStatus,
} from "../shared/status";
import { SortableList, type DragHandle } from "./SortableList";
import { StatusDot } from "./StatusDot";
import { PAIRING_QUERY_KEY, STATUS_QUERY_PREFIX, useFanoutStatus, usePairingLinks } from "./status-query";
import { describeLatency, describeUpstream, latencyHeadline, statusTag, summarize } from "./view-model";
import { MIN_TOUCH, MONO_FONT, radius, space, toneColor } from "./visual";

type Upstream = PluginStatus["upstreams"][number];

function createStyles(theme: PluginTheme, compact: boolean) {
  const pad = compact ? space.lg : space.xl;
  const rowHeight = compact ? 60 : 56;
  return {
    rowHeight,
    compact,
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
    error: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 18 },
    dim: { opacity: 0.45 },
    grow: { flex: 1 },

    // The relays header: title on the left, the mode switch and the add button on the right.
    listHeader: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: space.sm,
    },
    listHeaderActions: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm },
    segment: {
      flexDirection: "row" as const,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      padding: 2,
    },
    segmentOption: {
      minHeight: compact ? 36 : 28,
      justifyContent: "center" as const,
      paddingHorizontal: space.md,
      borderRadius: radius.sm,
    },
    segmentOptionOn: { backgroundColor: theme.colors.accent },
    segmentText: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
    segmentTextOn: { color: theme.colors.accentForeground },

    // One relay: a drag handle, the card, then the icon buttons outside it.
    relayRow: { flexDirection: "row" as const, alignItems: "stretch" as const, gap: 2, minHeight: rowHeight },
    handle: { width: 24, alignItems: "center" as const, justifyContent: "center" as const },
    relayCard: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: compact ? space.sm : space.md,
      paddingHorizontal: compact ? 10 : space.md,
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: radius.lg,
    },
    relayCardTop: { borderColor: theme.colors.accent },
    rank: {
      width: 22,
      height: 22,
      borderRadius: 11,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: theme.colors.surface2,
    },
    rankTop: { backgroundColor: theme.colors.accent },
    rankText: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "700" as const },
    rankTextTop: { color: theme.colors.accentForeground },
    relayText: { flex: 1, minWidth: 0, gap: 2 },
    nameRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    name: { flexShrink: 1, color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
    endpoint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16, fontFamily: MONO_FONT },
    relayLatency: { alignItems: "flex-end" as const, justifyContent: "center" as const, flexShrink: 0 },
    latency: { color: theme.colors.foreground, fontSize: compact ? 17 : 20, fontWeight: "700" as const, lineHeight: 24 },
    latencyBad: { color: theme.colors.statusDanger },
    latencyPending: { color: theme.colors.foregroundMuted, fontWeight: "400" as const },
    latencyTag: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 14 },
    iconButton: {
      width: compact ? 36 : 34,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      borderRadius: radius.md,
    },
    iconButtonOn: { backgroundColor: theme.colors.surface2 },
    iconButtonArmed: { backgroundColor: theme.colors.statusDanger },
    // Beside a form the icons keep their own size instead of stretching to the form's height.
    iconButtonFixed: { alignSelf: "flex-start" as const, height: compact ? MIN_TOUCH : 36 },
    // The width of the drag handle and its gap, so a form lines up with the cards around it.
    handleIndent: { marginLeft: 24 + 2 },

    // A relay being edited, or added: the fields take the card's place.
    formBox: {
      flex: 1,
      minWidth: 0,
      gap: space.xs,
      padding: space.md,
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.accent,
      borderWidth: 1,
      borderRadius: radius.lg,
    },
    formFields: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm },
    formFieldsStacked: { gap: space.sm },
    nameInput: { width: 140 },

    footer: { flexDirection: "row" as const, gap: space.sm },
    button: {
      minHeight: compact ? MIN_TOUCH : 34,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: space.sm,
      paddingHorizontal: space.lg,
      borderRadius: radius.md,
      backgroundColor: theme.colors.accent,
    },
    buttonText: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "600" as const },
    outlineButton: {
      minHeight: compact ? MIN_TOUCH : 34,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: space.sm,
      paddingHorizontal: space.lg,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    outlineText: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
    ghostButton: {
      minHeight: compact ? MIN_TOUCH : 34,
      justifyContent: "center" as const,
      paddingHorizontal: space.md,
    },
    ghostText: { color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "600" as const },

    // Inside the popups.
    dialog: { gap: space.md },
    dialogActions: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "flex-end" as const,
      gap: space.sm,
    },
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
    textarea: {
      minHeight: 160,
      paddingHorizontal: space.sm,
      paddingVertical: 8,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
      color: theme.colors.foreground,
      fontSize: 12,
      lineHeight: 17,
      fontFamily: MONO_FONT,
      textAlignVertical: "top" as const,
    },
    hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
  };
}

type Styles = ReturnType<typeof createStyles>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** A bare icon beside a relay card. The label is what a screen reader announces. */
function IconButton({
  icon,
  label,
  color,
  disabled,
  armed,
  fixed,
  onPress,
  styles,
}: {
  icon: string;
  label: string;
  color: string;
  disabled?: boolean;
  /** Keep a set height, for use beside a form. */
  fixed?: boolean;
  /** Pressed once already: filled, so the next press is understood as the confirmation. */
  armed?: boolean;
  onPress(): void;
  styles: Styles;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.iconButton,
        pressed || hovered ? styles.iconButtonOn : null,
        armed ? styles.iconButtonArmed : null,
        fixed ? styles.iconButtonFixed : null,
        disabled ? styles.dim : null,
      ]}
    >
      <Icon name={icon} size={18} color={color} />
    </Pressable>
  );
}

/** Auto keeps every relay open. Priority ranks them by their order in the list. */
function ModeSwitch({
  priority,
  disabled,
  onChange,
  styles,
}: {
  priority: boolean;
  disabled: boolean;
  onChange(priority: boolean): void;
  styles: Styles;
}) {
  const option = (label: string, value: boolean) => {
    const on = priority === value;
    return (
      <Pressable
        accessibilityRole="radio"
        accessibilityLabel={value ? "Priority order" : "Auto"}
        accessibilityState={{ selected: on, disabled }}
        disabled={disabled || on}
        onPress={() => onChange(value)}
        style={[styles.segmentOption, on ? styles.segmentOptionOn : null, disabled ? styles.dim : null]}
      >
        <Text style={[styles.segmentText, on ? styles.segmentTextOn : null]}>{label}</Text>
      </Pressable>
    );
  };
  return (
    <View accessibilityRole="radiogroup" style={styles.segment}>
      {option("Auto", false)}
      {option("Priority", true)}
    </View>
  );
}

function RelayRow({
  upstream,
  index,
  count,
  priorityMode,
  now,
  daemonConnected,
  fallbackActive,
  canRemove,
  armed,
  handle,
  dragging,
  onPair,
  onEdit,
  onRemove,
  styles,
  theme,
}: {
  upstream: Upstream;
  index: number;
  count: number;
  priorityMode: boolean;
  now: number;
  daemonConnected: boolean;
  fallbackActive: boolean;
  canRemove: boolean;
  /** The trash icon was pressed once; the next press removes the relay. */
  armed: boolean;
  handle: DragHandle;
  dragging: boolean;
  onPair(): void;
  onEdit(): void;
  onRemove(): void;
  styles: Styles;
  theme: PluginTheme;
}) {
  const line = describeUpstream(upstream, now, { daemonConnected, fallbackActive });
  const headline = latencyHeadline(upstream.latency);
  const detail = describeLatency(upstream.latency);
  const tag = statusTag(line);
  const top = priorityMode && index === 0;
  const showHandle = priorityMode && count > 1;

  const spoken = [
    upstream.name,
    upstream.endpoint,
    priorityMode ? `priority ${index + 1} of ${count}` : null,
    line.label,
    line.detail,
    detail ? detail.rows.map((row) => `${row.label} ${row.value}`).join(", ") : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(". ");

  return (
    <View style={styles.relayRow}>
      {showHandle ? (
        <View
          {...handle.panHandlers}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={`Reorder ${upstream.name}, priority ${index + 1} of ${count}`}
          accessibilityActions={[
            { name: "decrement", label: "Move up" },
            { name: "increment", label: "Move down" },
          ]}
          onAccessibilityAction={(event) => handle.moveBy(event.nativeEvent.actionName === "decrement" ? -1 : 1)}
          style={[styles.handle, handle.style]}
        >
          <Icon name="GripVertical" size={18} color={dragging ? theme.colors.accent : theme.colors.foregroundMuted} />
        </View>
      ) : null}

      <View
        accessible
        accessibilityLabel={spoken}
        style={[styles.relayCard, top || dragging ? styles.relayCardTop : null]}
      >
        {priorityMode && !styles.compact ? (
          <View style={[styles.rank, top ? styles.rankTop : null]}>
            <Text style={[styles.rankText, top ? styles.rankTextTop : null]}>{index + 1}</Text>
          </View>
        ) : null}
        <View style={styles.relayText}>
          <View style={styles.nameRow}>
            <Text numberOfLines={1} style={styles.name}>
              {upstream.name}
            </Text>
            <StatusDot color={toneColor(theme, line.tone)} label={line.label} size={8} />
          </View>
          <Text numberOfLines={1} style={styles.endpoint}>
            {upstream.endpoint}
          </Text>
        </View>
        <View style={styles.relayLatency}>
          {headline ? (
            <Text
              numberOfLines={1}
              style={[
                styles.latency,
                headline.kind === "bad" ? styles.latencyBad : null,
                headline.kind === "pending" ? styles.latencyPending : null,
              ]}
            >
              {headline.text}
            </Text>
          ) : null}
          {tag ? <Text style={styles.latencyTag}>{tag}</Text> : null}
        </View>
      </View>

      <IconButton
        icon="Globe"
        label={`Copy the pairing link for ${upstream.name}`}
        color={theme.colors.foregroundMuted}
        onPress={onPair}
        styles={styles}
      />
      <IconButton
        icon="Pencil"
        label={`Edit ${upstream.name}`}
        color={theme.colors.foregroundMuted}
        onPress={onEdit}
        styles={styles}
      />
      <IconButton
        icon="Trash2"
        label={
          !canRemove
            ? `${upstream.name} cannot be removed, the proxy needs one relay`
            : armed
              ? `Confirm removing ${upstream.name}`
              : `Remove ${upstream.name}`
        }
        color={armed ? theme.colors.surface0 : theme.colors.statusDanger}
        disabled={!canRemove}
        armed={armed}
        onPress={onRemove}
        styles={styles}
      />
    </View>
  );
}

function Dialog({ title, onClose, children, styles }: { title: string; onClose(): void; children: ReactNode; styles: Styles }) {
  return (
    <Modal title={title} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <View style={styles.dialog}>{children}</View>
      </Modal.Content>
    </Modal>
  );
}

function ErrorLine({ message, styles }: { message: string | null; styles: Styles }) {
  return message ? (
    <Text accessibilityLiveRegion="polite" style={styles.error}>
      {message}
    </Text>
  ) : null;
}

/**
 * The name and address of a relay, edited in place of its card (or in a new row when adding), with
 * save and cancel beside it. It answers a refusal in the row, next to the field that caused it.
 */
function RelayForm({
  mode,
  initialName,
  initialAddress,
  compact,
  indent,
  onSubmit,
  onCancel,
  styles,
  theme,
}: {
  mode: "add" | "edit";
  initialName: string;
  initialAddress: string;
  compact: boolean;
  /** Leave room for the drag handle the cards have, so the form lines up with them. */
  indent: boolean;
  onSubmit(name: string, address: string): Promise<string | null>;
  onCancel(): void;
  styles: Styles;
  theme: PluginTheme;
}) {
  const [name, setName] = useState(initialName);
  const [address, setAddress] = useState(initialAddress);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const empty = address.trim() === "";
  const noun = mode === "add" ? "relay" : initialName;

  async function submit() {
    if (busy) return;
    if (empty) {
      setError("Enter the relay's address.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // A refusal comes back as a message; success comes back as null and closes the form.
      const refusal = await onSubmit(name.trim(), address.trim());
      if (refusal) setError(refusal);
    } catch (issue) {
      setError(`The plugin did not answer: ${messageOf(issue)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.relayRow, indent ? styles.handleIndent : null]}>
      <View style={styles.formBox}>
        <View style={compact ? styles.formFieldsStacked : styles.formFields}>
          <TextInput
            accessibilityLabel={mode === "add" ? "Relay name, optional" : "Relay name"}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={mode === "add" ? "name (optional)" : "name"}
            placeholderTextColor={styles.hint.color}
            value={name}
            onChangeText={setName}
            onSubmitEditing={() => void submit()}
            returnKeyType="done"
            style={[styles.input, compact ? null : styles.nameInput]}
          />
          <TextInput
            accessibilityLabel="Relay address"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus={mode === "add"}
            placeholder="wss://relay.example.org or host:port"
            placeholderTextColor={styles.hint.color}
            value={address}
            onChangeText={setAddress}
            onSubmitEditing={() => void submit()}
            returnKeyType="done"
            style={[styles.input, compact ? null : styles.grow]}
          />
        </View>
        {error ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error}
          </Text>
        ) : mode === "add" ? (
          <Text style={styles.hint}>A missing port is refused. Port 443 means TLS. The new relay goes last.</Text>
        ) : (
          <Text style={styles.hint}>Changing the address reconnects this relay. Renaming keeps its place.</Text>
        )}
      </View>
      <IconButton
        icon="Check"
        label={mode === "add" ? "Add relay" : `Save the changes to ${noun}`}
        color={theme.colors.statusSuccess}
        disabled={busy || empty}
        fixed
        onPress={() => void submit()}
        styles={styles}
      />
      <IconButton
        icon="X"
        label={mode === "add" ? "Cancel adding a relay" : `Cancel editing ${noun}`}
        color={theme.colors.foregroundMuted}
        disabled={busy}
        fixed
        onPress={onCancel}
        styles={styles}
      />
    </View>
  );
}

function ImportDialog({ onClose, onChanged, styles }: { onClose(): void; onChanged(): Promise<void>; styles: Styles }) {
  const importConfig = useRpc(importConfigRpc);
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ summary: ConfigSummaryView; restartRequired: boolean } | null>(null);

  function edit(value: string) {
    setText(value);
    setPreview(null);
    setError(null);
  }

  async function send(apply: boolean) {
    if (busy || text.trim() === "") return;
    setError(null);
    setBusy(true);
    try {
      const result = await importConfig({ json: text, apply });
      if (!result.ok) {
        setPreview(null);
        setError(result.error);
        return;
      }
      if (!result.applied) {
        setPreview({ summary: result.summary, restartRequired: result.restartRequired });
        return;
      }
      const count = result.summary.relays.length;
      toast.show(`Imported ${count} relay${count === 1 ? "" : "s"}`, { variant: "success" });
      await onChanged();
      onClose();
    } catch (issue) {
      setError(`The plugin did not answer: ${messageOf(issue)}`);
    } finally {
      setBusy(false);
    }
  }

  const empty = text.trim() === "";
  return (
    <Dialog title="Import a config" onClose={onClose} styles={styles}>
      <Text style={styles.muted}>
        Paste the JSON from an export. Check it first: nothing changes until you replace the config.
      </Text>
      <TextInput
        accessibilityLabel="Config JSON"
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        multiline
        placeholder={'{\n  "upstreams": [ { "name": "official", "endpoint": "relay.paseo.sh:443" } ]\n}'}
        placeholderTextColor={styles.hint.color}
        value={text}
        onChangeText={edit}
        style={styles.textarea}
      />
      {preview ? (
        <View style={{ gap: 2 }}>
          <MetaRow label="Relays" value={preview.summary.relays.map((relay) => relay.name).join(", ")} styles={styles} />
          <MetaRow
            label="Priority"
            value={preview.summary.preference.mode === "preferred" ? "in the order shown" : "auto"}
            styles={styles}
          />
          <MetaRow label="Proxy" value={`${preview.summary.listen.host}:${preview.summary.listen.port}`} styles={styles} />
          {preview.restartRequired ? (
            <Text style={styles.hint}>The proxy address changes, so the new address is used the next time the plugin starts.</Text>
          ) : null}
        </View>
      ) : null}
      <ErrorLine message={error} styles={styles} />
      <View style={styles.dialogActions}>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel importing" disabled={busy} onPress={onClose} style={styles.ghostButton}>
          <Text style={styles.ghostText}>Cancel</Text>
        </Pressable>
        {preview ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Replace the config with this file"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => void send(true)}
            style={[styles.button, busy ? styles.dim : null]}
          >
            <Text style={styles.buttonText}>{busy ? "Replacing" : "Replace config"}</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Check the pasted config"
            accessibilityState={{ disabled: busy || empty }}
            disabled={busy || empty}
            onPress={() => void send(false)}
            style={[styles.button, busy || empty ? styles.dim : null]}
          >
            <Text style={styles.buttonText}>{busy ? "Checking" : "Check"}</Text>
          </Pressable>
        )}
      </View>
    </Dialog>
  );
}

export function FanoutScreen({ theme, layout }: PluginScreenProps) {
  const query = useFanoutStatus(2_000, true);
  const pairing = usePairingLinks();
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const queryClient = useQueryClient();
  const setPreference = useRpc(preferenceRpc);
  const reorderRelays = useRpc(reorderRelaysRpc);
  const addRelay = useRpc(addRelayRpc);
  const editRelay = useRpc(editRelayRpc);
  const removeRelay = useRpc(removeRelayRpc);
  const exportConfig = useRpc(exportConfigRpc);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // The relay whose trash icon was pressed once. A second press removes it; waiting backs out.
  const [armed, setArmed] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // The order just dropped, shown until the plugin has saved it, so the row does not jump back.
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const now = Date.now();

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), 5_000);
    return () => clearTimeout(timer);
  }, [armed]);

  const status = query.data;
  const upstreams = useMemo(() => {
    const list = status?.upstreams ?? [];
    if (!localOrder) return list;
    const byName = new Map(list.map((upstream) => [upstream.name, upstream]));
    const ordered = localOrder.map((name) => byName.get(name)).filter((upstream): upstream is Upstream => upstream !== undefined);
    return ordered.length === list.length ? ordered : list;
  }, [status, localOrder]);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: STATUS_QUERY_PREFIX });
    await queryClient.invalidateQueries({ queryKey: PAIRING_QUERY_KEY });
  }

  async function changeMode(priority: boolean) {
    const first = upstreams[0];
    if (priority && !first) return;
    setBusy(true);
    try {
      const result = await setPreference(priority ? { mode: "preferred", preferred: first!.name } : { mode: "auto" });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.show(priority ? `${first!.name} is first in line` : "Auto: each device picks the fastest relay", {
        variant: "success",
      });
      await refresh();
    } catch (issue) {
      toast.error(`Could not change the mode: ${messageOf(issue)}`);
    } finally {
      setBusy(false);
    }
  }

  async function reorder(names: string[]) {
    setLocalOrder(names);
    setBusy(true);
    try {
      const result = await reorderRelays({ names });
      if (!result.ok) toast.error(result.error);
    } catch (issue) {
      toast.error(`Could not save the order: ${messageOf(issue)}`);
    } finally {
      await refresh();
      setLocalOrder(null);
      setBusy(false);
    }
  }

  /** Each form answers with a refusal to show in its row, or null once the change is saved. */
  async function submitAdd(name: string, address: string): Promise<string | null> {
    const result = await addRelay({ address, name: name || undefined });
    if (!result.ok) return result.error;
    toast.show(`Added relay ${result.name ?? ""}`.trim(), { variant: "success" });
    setAdding(false);
    await refresh();
    return null;
  }

  async function submitEdit(upstream: Upstream, name: string, address: string): Promise<string | null> {
    const result = await editRelay({
      name: upstream.name,
      newName: name === "" || name === upstream.name ? undefined : name,
      address: address === upstream.endpoint ? undefined : address,
    });
    if (!result.ok) return result.error;
    toast.show(`Updated ${result.name ?? upstream.name}`, { variant: "success" });
    setEditing(null);
    await refresh();
    return null;
  }

  async function pressTrash(name: string) {
    if (armed !== name) {
      setArmed(name);
      toast.show(`Press the trash icon again to remove ${name}`, { variant: "warning" });
      return;
    }
    setArmed(null);
    setBusy(true);
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

  async function copyPairingLink(name: string) {
    const links = pairing.data;
    if (!links) {
      toast.error(pairing.isError ? "Could not prepare the pairing links." : "The pairing links are still being prepared.");
      return;
    }
    if (!links.available) {
      toast.error(links.reason);
      return;
    }
    const entry = links.links.find((candidate) => candidate.name === name);
    if (!entry) {
      toast.error(`There is no pairing link for ${name} yet.`);
      return;
    }
    try {
      await copyText(entry.link);
      toast.show(`Pairing link for ${name} copied`, { variant: "success" });
    } catch {
      toast.error("Copying is not available here");
    }
  }

  async function exportToClipboard() {
    setBusy(true);
    try {
      const result = await exportConfig({});
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      try {
        await copyText(result.json);
        toast.show("Config copied", { variant: "success" });
      } catch {
        toast.error(`Copying is not available here. The config was saved to ${result.path}`);
      }
    } catch (issue) {
      toast.error(`Could not export the config: ${messageOf(issue)}`);
    } finally {
      setBusy(false);
    }
  }

  if (query.isPending) return <Loading />;

  const summary = summarize(status, query.isError, now);
  const priorityMode = status?.preference?.mode === "preferred";
  const formOpen = adding || editing !== null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <SummaryCard status={status} summary={summary} styles={styles} theme={theme} />
      {status ? (
        <>
          <View style={{ gap: space.sm }}>
            <View style={styles.listHeader}>
              <Text accessibilityRole="header" style={styles.section}>
                Relays
              </Text>
              <View style={styles.listHeaderActions}>
                <ModeSwitch priority={priorityMode} disabled={busy} onChange={(priority) => void changeMode(priority)} styles={styles} />
                <IconButton
                  icon="Plus"
                  label="Add a relay"
                  color={theme.colors.foreground}
                  disabled={busy || adding}
                  onPress={() => {
                    setEditing(null);
                    setArmed(null);
                    setAdding(true);
                  }}
                  styles={styles}
                />
              </View>
            </View>
            <Text style={styles.muted}>
              {priorityMode
                ? "Drag to set the order. The first relay is used while it works, and the others take over in turn if it fails."
                : "Every relay stays connected, and each device uses the fastest one it can reach."}
            </Text>
            {adding ? (
              <RelayForm
                mode="add"
                initialName=""
                initialAddress=""
                compact={layout.compact}
                indent={priorityMode && upstreams.length > 1}
                onSubmit={submitAdd}
                onCancel={() => setAdding(false)}
                styles={styles}
                theme={theme}
              />
            ) : null}
            <SortableList
              items={upstreams}
              getKey={(upstream) => upstream.name}
              rowHeight={styles.rowHeight}
              gap={space.sm}
              enabled={priorityMode && !busy && !formOpen && upstreams.length > 1}
              onReorder={(names) => void reorder(names)}
              renderRow={(upstream, index, handle, dragging) =>
                editing === upstream.name ? (
                  <RelayForm
                    mode="edit"
                    initialName={upstream.name}
                    initialAddress={upstream.endpoint}
                    compact={layout.compact}
                    indent={priorityMode && upstreams.length > 1}
                    onSubmit={(name, address) => submitEdit(upstream, name, address)}
                    onCancel={() => setEditing(null)}
                    styles={styles}
                    theme={theme}
                  />
                ) : (
                  <RelayRow
                    upstream={upstream}
                    index={index}
                    count={upstreams.length}
                    priorityMode={priorityMode}
                    now={now}
                    daemonConnected={status.daemonConnected}
                    fallbackActive={status.fallbackActive === true}
                    canRemove={upstreams.length > 1 && !busy}
                    armed={armed === upstream.name}
                    handle={handle}
                    dragging={dragging}
                    onPair={() => void copyPairingLink(upstream.name)}
                    onEdit={() => {
                      setAdding(false);
                      setArmed(null);
                      setEditing(upstream.name);
                    }}
                    onRemove={() => void pressTrash(upstream.name)}
                    styles={styles}
                    theme={theme}
                  />
                )
              }
            />
          </View>
          <View style={styles.footer}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Export the config to the clipboard"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => void exportToClipboard()}
              style={[styles.outlineButton, layout.compact ? styles.grow : null, busy ? styles.dim : null]}
            >
              <Icon name="Copy" size={16} color={theme.colors.foreground} />
              <Text style={styles.outlineText}>Export</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Import a config"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => setImporting(true)}
              style={[styles.outlineButton, layout.compact ? styles.grow : null, busy ? styles.dim : null]}
            >
              <Icon name="Upload" size={16} color={theme.colors.foreground} />
              <Text style={styles.outlineText}>Import</Text>
            </Pressable>
          </View>
        </>
      ) : null}

      {importing ? <ImportDialog onClose={() => setImporting(false)} onChanged={refresh} styles={styles} /> : null}
    </ScrollView>
  );
}
