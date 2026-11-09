import type { Bot } from "../shared/bot";
import { startBotChat } from "../shared/chat";
import { ensureBotHome } from "./bot-home";
import type { BotsHost } from "./host";

/**
 * Starts a chat for a bot on this host, in its folder; the agent.create hook
 * gives it the bot's configuration. Routines and requests from other bots
 * start chats with it.
 */
export async function startChat(host: BotsHost, bot: Bot, input: { prompt: string; title: string; labels: Record<string, string> }): Promise<string> {
  const paseo = host.requirePaseo();
  const home = await ensureBotHome(bot);
  return startBotChat(paseo, { bot, home: home.path, prompt: input.prompt, title: input.title, labels: input.labels });
}
