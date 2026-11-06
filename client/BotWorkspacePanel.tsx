import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { EMPTY_LIBRARY } from "../shared/bot";
import { workspaceBotRpc } from "../shared/rpc";
import { useStartSetup } from "./actions";
import { AvatarTheme } from "./Avatar";
import { nativeTokens } from "./native";
import { BotPanel, type SectionId } from "./panel/BotPanel";
import { ui } from "./typography";
import { useBotEditor } from "./useBotEditor";
import { MenuProvider } from "./ui/Menu";
import { useTooltipTheme } from "./ui/Tooltip";

export const BOT_PANEL_ID = "bot";

/** The bot's own settings, memory, routines and runbooks, beside its chats in its Paseo workspace. */
export function BotWorkspacePanel(props: PluginWorkspacePanelProps) {
  const { colors } = props.theme;
  useTooltipTheme(colors);
  return (
    <MenuProvider colors={colors} compact={props.layout.compact}>
      <AvatarTheme dark={nativeTokens(colors).dark}>
        <BotWorkspaceContent {...props} />
      </AvatarTheme>
    </MenuProvider>
  );
}

function BotWorkspaceContent({ theme, layout, host, navigation, workspaceId }: PluginWorkspacePanelProps) {
  const { colors } = theme;
  const workspaceBot = useRpc(workspaceBotRpc);
  const owner = useQuery({ queryKey: ["paseo-bots", "workspace-bot", workspaceId], staleTime: 60_000, queryFn: () => workspaceBot({ workspaceId }) });
  const { settings, drafts, flush, patchBot } = useBotEditor();
  const startSetup = useStartSetup(navigation, flush);
  const toast = useToast();
  const [section, setSection] = useState<SectionId | null>(null);
  const [version, setVersion] = useState(0);

  if (owner.isLoading || settings.status === "loading") {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.foregroundMuted} accessibilityLabel="Loading bot" />
      </View>
    );
  }
  const saved = settings.status === "ready" ? settings.values.bots.find((entry) => entry.id === owner.data?.botId) : undefined;
  const bot = saved ? (drafts[saved.id] ?? saved) : undefined;
  if (!bot || settings.status !== "ready") {
    return (
      <View style={{ flex: 1, padding: 24 }}>
        <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>This workspace isn't a bot's. Open Bots and pick one to see its panel.</Text>
      </View>
    );
  }
  return (
    <BotPanel
      key={`${bot.id}:${version}`}
      colors={colors}
      compact={layout.compact}
      bottomInset={0}
      bot={bot}
      localHost={{ id: host.id, label: host.label }}
      history={settings.values.history}
      library={settings.values.library ?? EMPTY_LIBRARY}
      groups={settings.values.groups ?? []}
      section={section}
      onSection={setSection}
      onClose={() => setSection(null)}
      onPatch={(patch) => patchBot(bot.id, patch)}
      flush={flush}
      onRestore={(snapshot) => {
        patchBot(bot.id, snapshot);
        setVersion((current) => current + 1);
        toast.show("Restored. Undo it from History if needed.", { variant: "success" });
      }}
      onSetup={() => void startSetup(bot)}
      onOpenChat={(chatId) => navigation?.openAgent({ agentId: chatId })}
    />
  );
}
