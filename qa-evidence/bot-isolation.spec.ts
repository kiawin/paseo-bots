// Temporary QA for kiawin/paseo-bots spike/bot-claude-isolation. Not committed.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { buildAgentRoute } from "../support/helpers/mock-agent";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";

test.use({ video: { mode: "on", size: { width: 1280, height: 860 } }, viewport: { width: 1280, height: 860 } });

const OUT = process.env.BOTS_QA_OUT!;
const PLUGIN = process.env.BOTS_PLUGIN_DIR!;
const NOW = new Date().toISOString();
const QUESTION =
  "The code word is PELICAN. Without using any tools: on line 1, if your instructions contain a markdown heading that begins with '## Code search', quote that heading verbatim, else write NONE. " +
  "On line 2, list the names of the MCP servers whose tools you can call, comma-separated.";

test("paseo-bots: bot Claude chats skip the user's Claude Code setup", async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  const home = process.env.E2E_PASEO_HOME!;
  const xdg = process.env.XDG_CONFIG_HOME!;
  expect(xdg).toContain(".cache/paseo-bots-qa/xdg");
  const shot = async (name: string) => {
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    await testInfo.attach(name, { path: file, contentType: "image/png" });
  };

  const scout = {
    id: "bot-scout", name: "Scout", title: "Research assistant", description: "",
    avatar: { seed: "scout-7", palette: null, shape: "circle", imageUrl: null },
    provider: "claude", model: null, modeId: null, thinkingOptionId: null,
    soul: "Answer briefly.", mcpServerIds: [], alwaysAllow: [], skillIds: [], apps: [], appRules: {},
    contactBots: "ask", routines: [], playbooks: [], pinned: true, archived: false, createdAt: NOW, updatedAt: NOW,
  };
  await mkdir(path.join(home, "plugin-settings", "paseo-bots"), { recursive: true });
  await writeFile(path.join(home, "plugin-settings", "paseo-bots", "bots.json"), JSON.stringify({ version: 3, values: { bots: [scout], history: [] } }));

  const client = (await connectNewWorkspaceDaemonClient({ ownProjects: false })) as any;
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installDirectoryPlugin(PLUGIN);

  // A plain Claude agent in an ordinary project: the user's own Claude Code setup applies.
  const project = await seedWorkspace({ repoPrefix: "isolation-control-" });
  const plain = await client.createAgent({ provider: "claude", cwd: project.repoPath, workspaceId: project.workspaceId, title: "Plain agent", initialPrompt: QUESTION });

  // Scout's workspace, opened from the sidebar like a user would.
  await gotoAppShell(page);
  await page.getByText("Scout", { exact: true }).first().click();
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 60_000 });
  const scoutHome = path.join(xdg, "paseo", "bots", "scout");
  const workspace = ((await client.fetchWorkspaces()).entries as { id: string; workspaceDirectory?: string; projectRootPath: string }[]).find(
    (entry) => (entry.workspaceDirectory ?? entry.projectRootPath).replace(/\/+$/, "") === scoutHome,
  );
  expect(workspace).toBeTruthy();
  const bot = await client.createAgent({ provider: "claude", cwd: scoutHome, workspaceId: workspace!.id, title: "Scout chat", initialPrompt: QUESTION });

  const [plainDone, botDone] = await Promise.all([client.waitForFinish(plain.id, 240_000), client.waitForFinish(bot.id, 240_000)]);

  // Resume: reopen the bot's session the way Paseo does after a restart, then ask about the first turn.
  await client.refreshAgent(bot.id);
  await client.sendMessage(bot.id, "Without using any tools: what was the code word in my first message? Reply with the word only.");
  const resumed = await client.waitForFinish(bot.id, 240_000);

  const result = {
    plain: { status: plainDone.status, reply: plainDone.lastMessage },
    bot: { status: botDone.status, reply: botDone.lastMessage },
    botAfterRefresh: { status: resumed.status, reply: resumed.lastMessage },
  };
  await writeFile(path.join(OUT, "isolation.json"), JSON.stringify(result, null, 2));

  await page.goto(buildAgentRoute(project.workspaceId, plain.id));
  await page.waitForTimeout(3000);
  await shot("06-plain-agent-sees-user-setup");
  await page.goto(buildAgentRoute(workspace!.id, bot.id));
  await page.waitForTimeout(3000);
  await shot("07-bot-chat-isolated-and-resumed");

  expect(String(plainDone.lastMessage)).toContain("## Code search");
  expect(String(botDone.lastMessage)).toMatch(/NONE/);
  expect(String(botDone.lastMessage)).not.toMatch(/caveman|context-mode|cloudflare/i);
  expect(String(resumed.lastMessage)).toMatch(/PELICAN/i);

  // The bot project is the plugin's; remove it so the harness doesn't report a leak.
  for (const entry of ((await client.listProjects()).projects as { projectId: string; projectRootPath: string }[]).filter((item) => item.projectRootPath.startsWith(xdg))) {
    await client.removeProject?.(entry.projectId).catch(() => undefined);
  }
  await project.cleanup?.();
});
