import { usePaseo, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import type { Bot } from "../shared/bot";
import { startBotChat } from "../shared/chat";
import { ensureBotHomeRpc } from "../shared/rpc";
import { errorText } from "./native";

const SETUP_PROMPT =
  "Let's set you up. Interview me one short question at a time about what I want from you, how I like to work, and what you should never do. " +
  "Then propose standing instructions for yourself and a starting MEMORY.md. Write the memory file once I confirm, and give me the instructions to paste into your Soul settings.";

/** "Set up with the bot": a new chat in the bot's workspace that starts the interview, opened in Paseo. */
export function useStartSetup(navigation: PluginSurfaceProps["navigation"], flush: () => Promise<void>) {
  const paseo = usePaseo();
  const ensureHome = useRpc(ensureBotHomeRpc);
  const toast = useToast();
  return async (bot: Bot) => {
    try {
      await flush();
      const home = await ensureHome({ botId: bot.id });
      const agentId = await startBotChat(paseo, { bot, home: home.path, prompt: SETUP_PROMPT });
      navigation?.openAgent({ agentId });
    } catch (error) {
      toast.error(`Couldn't start the setup chat: ${errorText(error)}`);
    }
  };
}
