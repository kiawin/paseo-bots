import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import { BOT_LABEL, botSettings, type Bot } from "../shared/bot";
import { botWorkspacesRpc } from "../shared/rpc";
import { aggregateBuckets, chatBucket, type ChatBucket } from "../shared/sidebar";
import { Avatar, AvatarTheme } from "./Avatar";
import { useChatInvalidation } from "./data";
import { errorText, nativeTokens, type NativeTokens } from "./native";

/** Bots listed in the sidebar before the rest are left to the Bots screen. */
const MAX_ROWS = 8;

/**
 * The Bots section of Paseo's left sidebar: a row for the Bots screen, then one
 * per bot with its avatar and a dot while one of its chats is working or needs
 * the user. A bot's row opens its workspace with its panel. Bot projects still
 * show under Projects too.
 */
export function SidebarSection({ theme, currentScreen, openScreen, openBot }: PluginSidebarItemProps & { openBot(botId: string): Promise<void> }) {
  const tokens = nativeTokens(theme.colors);
  const toast = useToast();
  const settings = useSettings(botSettings);
  const bots = settings.status === "ready" ? settings.values.bots.filter((bot) => !bot.archived).sort((a, b) => Number(b.pinned) - Number(a.pinned)) : [];
  const shown = bots.slice(0, MAX_ROWS);
  const status = useBotStatus(shown);
  const hidden = bots.length - shown.length;
  return (
    <AvatarTheme dark={tokens.dark}>
      <SidebarRow
        id="bots"
        icon="Bot"
        label={hidden > 0 ? `Bots (${hidden} more)` : "Bots"}
        active={currentScreen?.screenId === "bots"}
        onPress={() => openScreen({ screenId: "bots" })}
      />
      {shown.map((bot) => (
        <SidebarRow
          key={bot.id}
          id={`bot-${bot.id}`}
          icon={({ size }) => <Avatar avatar={bot.avatar} size={size} />}
          label={bot.name || "Untitled bot"}
          onPress={() => void openBot(bot.id).catch((error: unknown) => toast.error(`Couldn't open ${bot.name}: ${errorText(error)}`))}
          trailing={<StatusDot tokens={tokens} bucket={status.get(bot.id) ?? "done"} />}
        />
      ))}
    </AvatarTheme>
  );
}

/** Each bot's most urgent chat state: its workspace's agents, and older chats labelled with it. */
function useBotStatus(bots: readonly Bot[]): Map<string, ChatBucket> {
  useChatInvalidation();
  const paseo = usePaseo();
  const workspaces = useRpc(botWorkspacesRpc);
  const ids = bots.map((bot) => bot.id).join(",");
  const status = useQuery({
    queryKey: ["paseo-bots", "chats", "sidebar", ids],
    enabled: bots.length > 0,
    queryFn: async () => {
      const [{ workspaces: owned }, { entries }] = await Promise.all([workspaces({}), paseo.agents.list({ scope: "active" })]);
      const botOfWorkspace = new Map(owned.map((entry) => [entry.workspaceId, entry.botId]));
      const buckets = new Map<string, ChatBucket[]>();
      for (const { agent } of entries) {
        const botId = (agent.workspaceId ? botOfWorkspace.get(agent.workspaceId) : undefined) ?? agent.labels?.[BOT_LABEL];
        if (botId) buckets.set(botId, [...(buckets.get(botId) ?? []), chatBucket(agent)]);
      }
      return new Map([...buckets].map(([botId, list]) => [botId, aggregateBuckets(list)]));
    },
  });
  return status.data ?? new Map();
}

function StatusDot({ tokens, bucket }: { tokens: NativeTokens; bucket: ChatBucket }) {
  const color = bucket === "running" ? tokens.statusDotRunning : bucket === "needs_input" || bucket === "attention" ? tokens.statusDotWarning : bucket === "failed" ? tokens.statusDotDanger : null;
  return color ? <View accessibilityLabel={bucket === "running" ? "Working" : "Needs you"} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color, marginRight: 8 }} /> : null;
}
