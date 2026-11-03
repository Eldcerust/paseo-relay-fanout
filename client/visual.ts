import type { PluginTheme } from "@getpaseo/plugin";
import { Platform } from "react-native";
import type { Tone } from "./view-model";

/** Measured from the Paseo host UI: 6/8/12 corners, 14px body text, 12px secondary, 11px labels. */
export const radius = { sm: 6, md: 8, lg: 12 } as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/** Monospace is for endpoints and ids only. */
export const MONO_FONT = Platform.OS === "ios" ? "ui-monospace" : "monospace";

/** Smallest comfortable tap target, applied on compact layouts. */
export const MIN_TOUCH = 44;

export function toneColor(theme: PluginTheme, tone: Tone): string {
  switch (tone) {
    case "ok":
      return theme.colors.statusSuccess;
    case "warn":
      return theme.colors.statusWarning;
    case "bad":
      return theme.colors.statusDanger;
    case "idle":
      return theme.colors.foregroundMuted;
  }
}
