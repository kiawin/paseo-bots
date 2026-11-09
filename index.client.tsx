import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { BotsSurface } from "./client/BotsSurface";
import { BOT_PANEL_ID, BotWorkspacePanel } from "./client/BotWorkspacePanel";
import { installBotHeaderButtons } from "./client/header-buttons";
import { SidebarSection } from "./client/SidebarSection";
import { NativeConnectCard } from "./client/cards/ConnectCard";
import { ProposalCard } from "./client/cards/ProposalCard";
import { RoutineRunCard } from "./client/cards/RoutineRunCard";
import { requestIntent } from "./client/intent";
import { BotsSettings } from "./client/settings/BotsSettings";
import { installTooltips } from "./client/ui/Tooltip";
import { appSignIns } from "./shared/apps";
import { proposalIdOf } from "./shared/proposals";
import { APP_SIGN_IN_CARD, AppSignInSchema, botWorkspaceRpc, chatBotRpc, helloRpc, ROUTINE_RUN_CARD, RoutineRunCardSchema } from "./shared/rpc";
import { LEARN_COMMAND, learnPrompt } from "./shared/skills";

export default function contribute(client: PluginClientContext) {
  // Hands the daemon side its Paseo API so bot routines can run.
  void client.rpc(helloRpc, {}).catch(() => {});
  const removeTooltips = installTooltips();
  // A bot opens in its own workspace with its panel in the explorer column; an open panel is focused, not doubled.
  const showPanel = (workspaceId: string) => client.openPanel(BOT_PANEL_ID, { workspaceId, location: "explorer" });
  client.addWorkspacePanel({ id: BOT_PANEL_ID, title: "Bot", icon: "Bot", locations: ["explorer", "workspace"], Component: BotWorkspacePanel });
  const headerButtons = installBotHeaderButtons(client, showPanel);
  // Opening a bot may have just made its workspace, which then gets its header button.
  const openBotPanel = (workspaceId: string) => {
    showPanel(workspaceId);
    headerButtons.refresh();
  };
  client.addScreen({ id: "bots", title: "Bots", Component: (props) => <BotsSurface {...props} openBotPanel={openBotPanel} /> });
  const openBot = async (botId: string) => openBotPanel((await client.rpc(botWorkspaceRpc, { botId })).workspaceId);
  client.addSidebarHeaderItem({ id: "bots", title: "Bots", Component: (props) => <SidebarSection {...props} openBot={openBot} /> });
  client.addSettingsScreen({ id: "bots", title: "Bots", icon: "Bot", Component: BotsSettings });
  client.addCommandCenterItem({
    id: "open-bots",
    title: "Open Bots",
    icon: "Bot",
    keywords: ["bot", "assistant", "persona"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "bots" });
    },
  });
  client.addCommandCenterItem({
    id: "new-bot",
    title: "New bot",
    icon: "Plus",
    keywords: ["bot", "create", "assistant"],
    context: "global",
    onSelect({ openScreen }) {
      requestIntent({ kind: "new-bot" });
      openScreen({ screenId: "bots" });
    },
  });
  // Bot chats opened in Paseo's own agent view get the same /learn and skill cards.
  client.addSlashCommand({
    ...LEARN_COMMAND,
    context: "agent",
    async onSubmit({ agent, args, paseo }) {
      if (!(await client.rpc(chatBotRpc, { agentId: agent.id })).botId) throw new Error("/learn works in bot chats.");
      await paseo.agents.ref(agent.id).send(learnPrompt(args));
    },
  });
  client.addTimelineTransformer({
    id: "proposals",
    query: { itemType: "tool_call" },
    transform({ item }) {
      const proposalId = proposalIdOf(item);
      return proposalId ? { items: [{ type: "plugin", kind: "proposal", version: 1, data: { proposalId } }] } : undefined;
    },
  });
  client.addTimelineRenderer({
    kind: "proposal",
    version: 1,
    schema: z.object({ proposalId: z.string() }),
    Component: ({ item, agentId, theme, layout }) => <ProposalCard colors={theme.colors} compact={layout.compact} proposalId={item.data.proposalId} agentId={agentId} />,
  });
  // A bot's request to connect an app, in Paseo's view too.
  client.addTimelineTransformer({
    id: "app-sign-ins",
    query: { itemType: "tool_call" },
    transform({ item }) {
      const signIns = appSignIns(item);
      return signIns.length ? { items: signIns.map((data) => ({ type: "plugin", ...APP_SIGN_IN_CARD, data })) } : undefined;
    },
  });
  client.addTimelineRenderer({
    ...APP_SIGN_IN_CARD,
    schema: AppSignInSchema,
    Component: ({ item, agentId, timestamp, theme }) => <NativeConnectCard colors={theme.colors} signIn={item.data} since={timestamp.getTime()} agentId={agentId} />,
  });
  // A routine's results chat opened in Paseo's view shows its run cards too (no navigation there).
  client.addTimelineRenderer({
    ...ROUTINE_RUN_CARD,
    schema: RoutineRunCardSchema,
    Component: ({ item, theme }) => <RoutineRunCard colors={theme.colors} card={item.data} />,
  });
  return () => {
    headerButtons.remove();
    removeTooltips();
  };
}
