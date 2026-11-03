import { View } from "react-native";

interface StatusDotProps {
  color: string;
  label: string;
  size?: number;
}

/** A small filled circle; the label is what a screen reader announces. */
export function StatusDot({ color, label, size = 8 }: StatusDotProps) {
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }}
    />
  );
}
