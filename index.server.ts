import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { botHomeOf, botIdAt, ensureBotHome, migrateBotHomes, migrateLegacyHome, migrateRenamedPluginData, writeBotIcon } from "./server/bot-home";
import { turnEnded, turnStarted } from "./server/activity";
import { botAgentConfig, nameBotChat } from "./server/agent-config";
import { CommandAllowlist } from "./server/commands";
import { MemoryJournal } from "./server/journal";
import { deleteLogDay, listLogDays, listMemory, readLogDay, readMemory } from "./server/memory";
import { systemPrompt } from "./server/prompt";
import { botRunbooks, deleteRunbook, readRunbook, writeRunbook } from "./server/runbooks";
import { RoutineScheduler } from "./server/scheduler";
import { exportBot, exportTeam, importBot, importTeam } from "./server/share";
import { deleteSkill, importSkills, migrateBotSkills, readSkill, writeSkill } from "./server/library";
import { probeMcpServer } from "./server/mcp-probe";
import { generateAvatar, imageStatus, removeImageKey, setImageKey } from "./server/images";
import { mcpSources } from "./server/mcp-sources";
import { accounts, appTools, catalog, connect, disconnect, removeKey, renameAccount, setKey, status as appsStatus } from "./server/composio";
import { BotsHost } from "./server/host";
import { Relay } from "./server/relay";
import { acceptProposal, dismissProposal, getProposal } from "./server/proposals";
import { BOT_TOOLS } from "./server/tools";
import { botSettings, EMPTY_LIBRARY } from "./shared/bot";
import { ensureBotWorkspace, syncBotWorkspaceTitle, workspaceFolder } from "./shared/chat";
import { shellCommand } from "./shared/commands";
import {
  commandAllowRpc,
  commandListRpc,
  commandRemoveRpc,
  ensureBotHomeRpc,
  exportBotRpc,
  exportTeamRpc,
  helloRpc,
  importBotRpc,
  importTeamRpc,
  memoryDeleteRpc,
  memoryJournalRpc,
  memoryListRpc,
  memoryLogDeleteRpc,
  memoryLogRpc,
  memoryReadRpc,
  memoryUndoRpc,
  memoryWriteRpc,
  mcpProbeRpc,
  mcpSourcesRpc,
  proposalAcceptRpc,
  proposalDismissRpc,
  proposalGetRpc,
  appsAccountsRpc,
  avatarGenerateRpc,
  avatarKeyStatusRpc,
  avatarRemoveKeyRpc,
  avatarSetKeyRpc,
  botHomeRpc,
  botWorkspaceRpc,
  botWorkspacesRpc,
  chatBotRpc,
  workspaceBotRpc,
  appsCatalogRpc,
  appsConnectRpc,
  appsDisconnectRpc,
  appsRenameRpc,
  appsToolsRpc,
  appsRemoveKeyRpc,
  appsSetKeyRpc,
  appsStatusRpc,
  routineRunNowRpc,
  runbookDeleteRpc,
  runbookListRpc,
  runbookReadRpc,
  runbookWriteRpc,
  routineStatusRpc,
  routineWebhookRpc,
  skillDeleteRpc,
  skillImportRpc,
  skillReadRpc,
  skillWriteRpc,
  systemPromptRpc,
} from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  try {
    migrateRenamedPluginData();
  } catch (error) {
    console.error("paseo-bots: couldn't move the data of the old paseo-bot plugin", error);
  }
  const settings = server.registerSettings(botSettings);
  const library = async () => {
    const state = await settings.read();
    return state.status === "ready" ? (state.values.library ?? EMPTY_LIBRARY) : EMPTY_LIBRARY;
  };
  const host = new BotsHost(settings);
  // Older folders move first: "home" to "Bots", skills into the library, then each bot to its own folder.
  void migrateLegacyHome()
    .then(migrateBotSkills)
    .then(async () => migrateBotHomes(await host.bots()))
    .catch((error: unknown) => console.error("paseo-bots: couldn't move the bots' folders", error));
  // A bot's project follows its name and avatar.
  const stopSync = settings.subscribe(async (state) => {
    if (state.status !== "ready") return;
    for (const bot of state.values.bots) {
      const home = botHomeOf(bot.id);
      if (!home) continue;
      await writeBotIcon(home, bot.avatar).catch((error: unknown) => console.error(`paseo-bots: couldn't update ${bot.name}'s icon`, error));
      if (host.paseo && bot.name.trim()) await syncBotWorkspaceTitle(host.paseo, bot, home).catch(() => undefined);
    }
  });
  /** The bot's folder, created on first use. */
  const homeOf = async (botId: string) => {
    const bot = await host.bot(botId);
    if (!bot) throw new Error("This bot no longer exists.");
    return (await ensureBotHome(bot)).path;
  };
  // Bots' tools and connected apps go through this relay; it reads the saved settings on every call.
  const relay = new Relay(host, BOT_TOOLS);
  void relay.start().catch((error: unknown) => console.error("paseo-bots: couldn't start the relay", error));
  const scheduler = new RoutineScheduler(host, relay);
  const journal = new MemoryJournal();
  const commands = new CommandAllowlist();
  // Every handler and hook receives the plugin's Paseo API; features that start chats need it.
  const attach = ({ paseo }: PluginHandlerContext) => host.attach(paseo);

  server.handle(helloRpc, (_input, context) => {
    attach(context);
    return { scheduler: scheduler.running };
  });
  server.handle(ensureBotHomeRpc, async ({ botId }, context) => {
    attach(context);
    return { path: await homeOf(botId) };
  });
  server.handle(botHomeRpc, ({ botId }) => ({ path: botHomeOf(botId) }));
  server.handle(botWorkspaceRpc, async ({ botId }, context) => {
    attach(context);
    const bot = await host.bot(botId);
    if (!bot) throw new Error("This bot no longer exists.");
    const home = await ensureBotHome(bot);
    return { workspaceId: (await ensureBotWorkspace(context.paseo, bot, home.path)).id };
  });
  server.handle(botWorkspacesRpc, async (_input, context) => {
    attach(context);
    const { entries } = await context.paseo.workspaces.list();
    const workspaces: { botId: string; name: string; avatar: (typeof bots)[number]["avatar"]; workspaceId: string }[] = [];
    const bots = await host.bots();
    for (const bot of bots) {
      const home = botHomeOf(bot.id);
      const workspace = home && !bot.archived ? entries.find((entry) => workspaceFolder(entry) === home) : undefined;
      if (workspace) workspaces.push({ botId: bot.id, name: bot.name, avatar: bot.avatar, workspaceId: workspace.id });
    }
    return { workspaces };
  });
  server.handle(workspaceBotRpc, async ({ workspaceId }, context) => {
    attach(context);
    const workspace = (await context.paseo.workspaces.list()).entries.find((entry) => entry.id === workspaceId);
    return { botId: workspace ? await botIdAt(workspaceFolder(workspace)) : null };
  });
  server.handle(chatBotRpc, async ({ agentId }, context) => {
    attach(context);
    return { botId: (await host.chatOf(agentId))?.botId ?? null };
  });
  server.handle(systemPromptRpc, async (input, context) => systemPrompt(input, await library(), context.paseo, await host.values()));
  server.handle(memoryListRpc, ({ botId }) => listMemory(botId));
  server.handle(memoryReadRpc, ({ botId, name }) => readMemory(botId, name));
  server.handle(memoryWriteRpc, async ({ botId, name, text }) => {
    await homeOf(botId);
    await journal.write(botId, name, text);
    return { ok: true };
  });
  server.handle(memoryDeleteRpc, async ({ botId, name }) => {
    await journal.write(botId, name, null);
    return { ok: true };
  });
  server.handle(memoryJournalRpc, async ({ botId }) => ({
    entries: (await journal.list(botId)).map(({ before, ...entry }) => ({ ...entry, canUndo: entry.kind === "created" || before !== null })),
  }));
  server.handle(memoryUndoRpc, async ({ botId, id }) => {
    await journal.undo(botId, id);
    return { ok: true };
  });
  server.handle(memoryLogRpc, async ({ botId, day }) => ({ ...(await listLogDays(botId)), text: day ? (await readLogDay(botId, day)).text : null }));
  server.handle(runbookListRpc, async ({ botId }) => {
    const bot = await host.bot(botId);
    if (!bot) return { folder: null, runbooks: [] };
    const { folder, runbooks } = await botRunbooks(bot);
    return { folder, runbooks: runbooks.map(({ file, description }) => ({ file, description })) };
  });
  server.handle(runbookReadRpc, async ({ botId, file }) => {
    const bot = await host.bot(botId);
    const seed = bot && !botHomeOf(botId) ? (await botRunbooks(bot)).runbooks.find((entry) => entry.file === file) : undefined;
    return seed ? { text: seed.text ?? "" } : readRunbook(botId, file);
  });
  server.handle(runbookWriteRpc, async ({ botId, file, text }) => {
    await homeOf(botId);
    await writeRunbook(botId, file, text);
    return { ok: true };
  });
  server.handle(runbookDeleteRpc, async ({ botId, file }) => {
    await homeOf(botId);
    await deleteRunbook(botId, file);
    return { ok: true };
  });
  server.handle(memoryLogDeleteRpc, ({ botId, day }) => deleteLogDay(botId, day));
  server.handle(skillImportRpc, importSkills);
  server.handle(skillReadRpc, readSkill);
  server.handle(skillWriteRpc, writeSkill);
  server.handle(skillDeleteRpc, deleteSkill);
  server.handle(mcpProbeRpc, probeMcpServer);
  server.handle(mcpSourcesRpc, () => mcpSources());
  server.handle(avatarKeyStatusRpc, () => imageStatus());
  server.handle(avatarSetKeyRpc, setImageKey);
  server.handle(avatarRemoveKeyRpc, () => removeImageKey());
  server.handle(avatarGenerateRpc, generateAvatar);
  server.handle(appsStatusRpc, () => appsStatus());
  server.handle(appsSetKeyRpc, setKey);
  server.handle(appsRemoveKeyRpc, () => removeKey());
  server.handle(appsCatalogRpc, () => catalog());
  server.handle(appsAccountsRpc, accounts);
  server.handle(appsConnectRpc, connect);
  server.handle(appsDisconnectRpc, disconnect);
  server.handle(appsRenameRpc, renameAccount);
  server.handle(appsToolsRpc, appTools);
  server.handle(proposalGetRpc, async ({ id }) => ({ proposal: await getProposal(id) }));
  server.handle(proposalAcceptRpc, ({ id }) => acceptProposal(id));
  server.handle(proposalDismissRpc, async ({ id }) => ({ proposal: await dismissProposal(id) }));
  server.handle(routineStatusRpc, (_input, context) => {
    attach(context);
    return scheduler.status();
  });
  server.handle(routineRunNowRpc, ({ botId, routineId }, context) => {
    attach(context);
    return scheduler.runNow(botId, routineId);
  });
  server.handle(routineWebhookRpc, ({ routineId, rotate }) => scheduler.webhookUrl(routineId, rotate));
  server.handle(commandListRpc, async ({ botId }) => ({ rules: await commands.list(botId) }));
  server.handle(commandAllowRpc, async ({ botId, command, cwd }) => ({ rule: await commands.add(botId, command, cwd) }));
  server.handle(commandRemoveRpc, async ({ botId, id }) => ({ ok: await commands.remove(botId, id) }));
  server.handle(exportBotRpc, async (input) => exportBot(input, await library()));
  server.handle(importBotRpc, importBot);
  server.handle(exportTeamRpc, async (input) => exportTeam(input, await library()));
  server.handle(importTeamRpc, importTeam);
  server.before("agent.create", async ({ request }, context) => {
    host.attach(context.paseo);
    return botAgentConfig(host, relay, request);
  });
  server.before("agent.session_open", async ({ request }) => {
    await nameBotChat(relay, request).catch((error: unknown) => console.error("paseo-bots: couldn't name a chat's tools", error));
  });
  server.on("agent.turn_started", async (event, context) => {
    host.attach(context.paseo);
    await turnStarted(host, journal, event).catch((error: unknown) => console.error("paseo-bots: couldn't check memory before a turn", error));
  });
  // A bot's saved commands (exact command, exact folder) are approved here instead of asking.
  server.on("agent.permission_requested", async ({ agent, request }, context) => {
    host.attach(context.paseo);
    const shell = shellCommand(request, agent.cwd);
    if (!shell) return;
    const chat = await host.chatOf(agent.id);
    if (!chat || !(await commands.matches(chat.botId, shell.command, shell.cwd))) return;
    await context.paseo.agents
      .ref(agent.id)
      .respondToPermission({ requestId: request.id, response: { behavior: "allow" } })
      .catch((error: unknown) => console.error("paseo-bots: couldn't approve an allowed command", error));
  });
  server.on("agent.turn_ended", async (event, context) => {
    host.attach(context.paseo);
    await turnEnded(host, journal, scheduler, event).catch((error: unknown) => console.error("paseo-bots: couldn't record a turn", error));
  });

  return () => {
    stopSync();
    scheduler.stop();
    relay.stop();
  };
}
