import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { nativeTokens } from "../native";
import { ui } from "../typography";

type Colors = PluginTheme["colors"];

/** Paseo's LoadingSpinner: an ActivityIndicator, scaled for sizes under the platform's small one. */
export function Spinner({ color, size = 20 }: { color: string; size?: number }) {
  const scale = size / 20;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator size="small" color={color} style={scale === 1 ? undefined : { transform: [{ scale }] }} />
    </View>
  );
}

/** The buttons under a permission or proposal card (agent-stream/view.tsx PermissionRequestCard). */
export function CardButton({ colors, label, icon, primary = false, busy = false, spinning = false, onPress }: { colors: Colors; label: string; icon: string; primary?: boolean; busy?: boolean; spinning?: boolean; onPress(): void }) {
  const [hovered, setHovered] = useState(false);
  const tint = primary ? colors.foreground : colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={busy}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 6,
        alignItems: "center",
        borderWidth: 1,
        backgroundColor: hovered ? colors.surface2 : colors.surface1,
        borderColor: nativeTokens(colors).borderAccent,
        opacity: pressed ? 0.9 : 1,
      })}
    >
      {spinning ? (
        <Spinner color={tint} />
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name={icon} size={14} color={tint} />
          <Text style={{ fontSize: ui(14), color: tint }}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}
