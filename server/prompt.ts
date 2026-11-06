import { join } from "node:path";
import type { PaseoApi } from "./paseo";
import { recentWork } from "../shared/activity";
import { paseoToolsState, type PaseoToolsConfig } from "../shared/paseo-tools";
import type { AppAccount, PromptApp } from "../shared/apps";
import { accounts, catalog, readState } from "./composio";
import { botSkills, composeSystemPrompt, promptSections, type Bot, type BotGroup, type BotSettingsValues, type Library, type PromptContext } from "../shared/bot";
import { teamOf, teamPrompt } from "../shared/groups";
import { linkBotSkills, skillSha } from "./library";
import { injectedMemory, MAIN_MEMORY, memoryFolder, recentLogEntries } from "./memory";
import { listRunbooks, runbooksFolder } from "./runbooks";
import { BOT_GENUI_INSTRUCTIONS } from "../shared/genui-instructions";

/**
 * The connected apps a bot may use right now (allowed for it and signed in on
 * this host), with their accounts when it picks one of several, and its limits.
 */
async function botApps(bot: Bot): Promise<PromptApp[]> {
  if (bot.apps.length === 0 || !(await readState()).apiKey) return [];
  const connected = (await accounts().catch(() => ({ accounts: [] as AppAccount[] }))).accounts.filter((account) => account.status === "connected");
  const slugs = bot.apps.filter((slug) => connected.some((account) => account.slug === slug));
  if (slugs.length === 0) return [];
  const names = new Map((await catalog().catch(() => ({ apps: [] }))).apps.map((app) => [app.slug, app.name]));
  return slugs.map((slug) => {
    const rule = bot.appRules[slug];
    // A bot kept to one account doesn't pick; the relay fills it in.
    const mine = rule?.account ? [] : connected.filter((account) => account.slug === slug);
    return { name: names.get(slug) ?? slug, accounts: mine.length > 1 ? mine.map((account) => ({ account: account.alias ?? account.id, name: account.name })) : [], tools: rule?.tools ?? "all" };
  });
}

export interface ChatStart {
  /** The bot's team and every bot, when it's on one. */
  team?: { group: BotGroup; bots: Bot[] };
}

export async function promptContext(bot: Bot, library: Library, paseoTools: boolean, start: ChatStart = {}): Promise<PromptContext> {
  const team = start.team ? teamPrompt(start.team.group, bot, start.team.bots) : null;
  // Only skills whose SKILL.md is still what the user reviewed.
  const skills: typeof library.skills = [];
  for (const skill of botSkills(bot, library)) {
    if (skill.reviewedSha === undefined || (skill.reviewedSha !== null && (await skillSha(skill.id)) === skill.reviewedSha)) skills.push(skill);
  }
  const paths = await linkBotSkills(
    bot.id,
    skills.map((skill) => skill.id),
  );
  return {
    memory: await injectedMemory(bot.id),
    memoryPath: join(memoryFolder(bot.id), MAIN_MEMORY),
    recentWork: recentWork(await recentLogEntries(bot.id, 3), new Date()),
    runbooksPath: runbooksFolder(bot.id),
    runbooks: await listRunbooks(bot.id),
    team,
    skills: skills.map((skill) => ({ name: skill.id, description: skill.description, path: paths.get(skill.id)! })),
    paseoTools,
    botTools: true,
    apps: await botApps(bot),
  };
}

/** Whether this host gives the provider's agents Paseo's tools. Assumes yes when the config can't be read. */
async function paseoToolsOn(paseo: PaseoApi | null, provider: string): Promise<boolean> {
  if (!paseo) return true;
  try {
    const { config } = await paseo.config.get();
    return paseoToolsState(config as PaseoToolsConfig, provider).on;
  } catch {
    return true;
  }
}

/** The system prompt for a new chat; `settings` supplies the bot's team. */
export async function systemPrompt({ bot }: { bot: Bot }, library: Library, paseo: PaseoApi | null, settings?: BotSettingsValues | null) {
  const group = teamOf(bot.id, settings?.groups ?? []);
  const start: ChatStart = group && settings ? { team: { group, bots: settings.bots } } : {};
  const context = await promptContext(bot, library, await paseoToolsOn(paseo, bot.provider), start);
  return {
    systemPrompt: [composeSystemPrompt(bot, context), BOT_GENUI_INSTRUCTIONS].join("\n\n"),
    sections: promptSections(bot, context),
  };
}
