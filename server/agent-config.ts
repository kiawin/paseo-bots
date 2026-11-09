import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { applyBotConfig, type BotSessionConfig } from "../shared/bot";
import { newUuid } from "../shared/uuid";
import { botIdAt } from "./bot-home";
import type { BotsHost } from "./host";
import { systemPrompt } from "./prompt";
import type { Relay } from "./relay";

/** Carries a new chat's tools key from agent.create to agent.session_open, where Paseo names the agent. */
const CHAT_KEY_ENV = "PASEO_BOTS_CHAT";

type CreateRequest = PluginBeforeRequests["agent.create"];

/**
 * agent.create: every new agent in a bot's folder becomes that bot, however it
 * was started (the Bots screen, a routine, another bot, or Paseo's own New
 * agent). It gets the bot's provider, model, mode and thinking, its system
 * prompt (persona, instructions, memory, skills, runbooks), its MCP servers,
 * the plugin's tools and connected apps, and the tools it may use without
 * asking. Paseo waits for this on every new agent on the host, so any other
 * folder returns at once.
 */
export async function botAgentConfig(host: BotsHost, relay: Relay, request: CreateRequest, options: { codexFeatures?: boolean } = {}): Promise<CreateRequest | undefined> {
  const botId = await botIdAt(request.config.cwd);
  if (!botId) return undefined;
  const bot = await host.bot(botId);
  if (!bot || bot.archived) return undefined;
  const library = await host.library();
  const prompt = await systemPrompt({ bot }, library, host.paseo, await host.values());
  const chatKey = newUuid();
  const plugin = { tools: await relay.mountTools(bot.id, chatKey), apps: bot.apps.length ? await relay.mountApps(bot.id) : null };
  // Paseo's MCP server configs are the same shapes as the bot's.
  const config = applyBotConfig(request.config as typeof request.config & BotSessionConfig, bot, library, prompt.systemPrompt, plugin, options);
  return { config, env: { ...request.env, [CHAT_KEY_ENV]: chatKey } };
}

/** agent.session_open: pairs a new chat's tools key with the agent Paseo created. */
export async function nameBotChat(relay: Relay, request: PluginBeforeRequests["agent.session_open"]): Promise<void> {
  const chatKey = request.env[CHAT_KEY_ENV];
  if (chatKey && request.reason === "create") await relay.chats.set(chatKey, request.agentId);
}
