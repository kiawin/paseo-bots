// Temporary QA evidence for kiawin/paseo-bots feat/bots-as-workspaces. Not committed.
import { lstat, mkdir, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { buildAgentRoute } from "../support/helpers/mock-agent";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";

test.use({ video: { mode: "on", size: { width: 1280, height: 860 } }, viewport: { width: 1280, height: 860 } });

const OUT = process.env.BOTS_QA_OUT!;
const PLUGIN = process.env.BOTS_PLUGIN_DIR!;
const NOW = new Date().toISOString();

function bot(id: string, name: string, seed: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    title: "",
    description: "",
    avatar: { seed, palette: null, shape: "circle", imageUrl: null },
    provider: "mock",
    model: "e2e-fast-stream",
    modeId: "load-test",
    thinkingOptionId: null,
    soul: "",
    mcpServerIds: [],
    alwaysAllow: [],
    skillIds: [],
    apps: [],
    appRules: {},
    contactBots: "ask",
    routines: [],
    playbooks: [],
    pinned: false,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

async function findFile(root: string, name: string): Promise<string | null> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = await findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

test("paseo-bots: bots as workspaces", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const consoleLines: string[] = [];
  page.on("console", (message) => {
    if (/paseo-bots|header/i.test(message.text())) consoleLines.push(`${message.type()}: ${message.text()}`);
  });
  const home = process.env.E2E_PASEO_HOME!;
  const xdg = process.env.XDG_CONFIG_HOME!;
  expect(xdg).toContain("scratchpad/qa/xdg");
  const shot = async (name: string) => {
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    await testInfo.attach(name, { path: file, contentType: "image/png" });
  };
  const pause = (ms: number) => page.waitForTimeout(ms);

  // A 0.2 install: Scout has a folder in the shared Bots project, with memory and a playbook.
  const legacy = path.join(home, "plugin-data", "paseo-bots", "shared", "Bots", "bot-scout");
  await mkdir(path.join(legacy, "memory"), { recursive: true });
  await writeFile(path.join(legacy, "MEMORY.md"), "- Prefers short answers\n- Weekly report goes out on Fridays\n");
  // Scout runs on Claude: Paseo's test providers take no MCP servers, and the bot's chats carry the plugin's.
  const scout = bot("bot-scout", "Scout", "scout-7", {
    provider: "claude",
    model: null,
    modeId: null,
    title: "Research assistant",
    soul: "Answer in three bullet points or fewer.",
    playbooks: [{ id: "pb-1", name: "Weekly report", triggers: ["weekly report", "friday report"], instructions: "1. Collect this week's notes.\n2. Summarise them in five bullets.\n3. Send it to the user." }],
    pinned: true,
  });
  const ada = bot("bot-ada", "Ada", "ada-3", { title: "Inbox triage" });
  await mkdir(path.join(home, "plugin-settings", "paseo-bots"), { recursive: true });
  await writeFile(path.join(home, "plugin-settings", "paseo-bots", "bots.json"), JSON.stringify({ version: 3, values: { bots: [scout, ada], history: [] } }));

  const client = (await connectNewWorkspaceDaemonClient({ ownProjects: false })) as any;
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installDirectoryPlugin(PLUGIN);

  // The plugin moves Scout's folder at startup and leaves a link at the old path.
  const scoutHome = path.join(xdg, "paseo", "bots", "scout");
  await expect.poll(async () => (await lstat(path.join(scoutHome, ".bot-id")).catch(() => null)) !== null, { timeout: 60_000 }).toBe(true);
  const migration = {
    linkAtOldPath: await readlink(legacy),
    memory: await readFile(path.join(scoutHome, "MEMORY.md"), "utf8"),
    runbooks: await readdir(path.join(scoutHome, "runbooks")),
    files: (await readdir(scoutHome)).sort(),
  };
  expect(migration.linkAtOldPath).toBe(scoutHome);
  expect(migration.runbooks).toEqual(["weekly-report.md"]);
  await writeFile(path.join(OUT, "migration.json"), JSON.stringify(migration, null, 2));

  await gotoAppShell(page);
  await expect(page.getByText("Scout", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await pause(1500);
  await shot("01-sidebar-bots-section");

  // The Bots screen: roster, teams and settings; chats now live in Paseo.
  await page.getByText("Bots", { exact: true }).first().click();
  await pause(2500);
  await shot("02-bots-screen");

  // Picking a bot in the sidebar opens its own project and workspace, with the Bot panel.
  await page.getByText("Scout", { exact: true }).first().click();
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 60_000 });
  await expect(page.getByText("Runbooks", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await pause(3000);
  await shot("03-bot-workspace-with-panel");
  // The avatar button in the workspace header opens the panel again after it's closed.
  await page.getByRole("button", { name: "Scout", exact: true }).last().hover().catch(() => undefined);

  await page.getByText("Runbooks", { exact: true }).first().click();
  await expect(page.getByText("weekly-report", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await pause(1000);
  await shot("04-runbooks-section");

  // A new agent in the bot's folder becomes the bot (agent.create hook), however it starts.
  const workspaces = (await client.fetchWorkspaces()).entries as { id: string; workspaceDirectory?: string; projectRootPath: string }[];
  const workspace = workspaces.find((entry) => (entry.workspaceDirectory ?? entry.projectRootPath).replace(/\/+$/, "") === scoutHome);
  expect(workspace).toBeTruthy();
  const agent = await client.createAgent({ provider: "claude", cwd: scoutHome, workspaceId: workspace!.id, title: "New agent from Paseo", initialPrompt: "Without using any tools, in one short line: who are you, and what does your Soul tell you about answer length?" });
  await page.goto(buildAgentRoute(workspace!.id, agent.id));
  const finished = await client.waitForFinish(agent.id, 180_000);
  const record = await findFile(home, `${agent.id}.json`);
  const stored = record ? JSON.parse(await readFile(record, "utf8")) : {};
  const config = stored.config ?? stored;
  const hook = {
    agentId: agent.id,
    startedWith: "provider claude, the workspace folder, a prompt; no bot settings, no labels",
    status: finished.status,
    lastMessage: finished.lastMessage,
    labels: stored.labels ?? {},
    systemPromptStartsWith: String(config.systemPrompt ?? "").slice(0, 300),
    mcpServers: Object.keys(config.mcpServers ?? {}),
    preapproved: (config.toolPolicy?.preapproved ?? []).map((grant: { server: string; tool: string }) => `${grant.server}/${grant.tool}`),
  };
  await writeFile(path.join(OUT, "hook-config.json"), JSON.stringify(hook, null, 2));
  expect(hook.systemPromptStartsWith).toContain("You are Scout");
  expect(hook.mcpServers).toContain("bots");
  await pause(2500);
  await shot("05-new-agent-is-the-bot");
  await writeFile(path.join(OUT, "console.txt"), consoleLines.join("\n"));
  // The bot project is the plugin's; it stays after the test, which the harness reports as a leak.
  const projects = (await client.listProjects()).projects as { projectId: string; projectRootPath: string }[];
  for (const project of projects.filter((entry) => entry.projectRootPath.startsWith(xdg))) await client.removeProject?.(project.projectId).catch(() => undefined);
});
