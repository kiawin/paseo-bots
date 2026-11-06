// Temporary QA for kiawin/paseo-bots: Codex bot chats and bot terminals. Not committed.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { buildAgentRoute } from "../support/helpers/mock-agent";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";

test.use({ video: { mode: "on", size: { width: 1280, height: 860 } }, viewport: { width: 1280, height: 860 } });

const OUT = process.env.BOTS_QA_OUT!;
const PLUGIN = process.env.BOTS_PLUGIN_DIR!;
const NOW = new Date().toISOString();
const QUESTION =
  "Do not run shell commands. Check every tool you have, including MCP tools you can find with tool search. " +
  "Reply with two lines. Line 1: your name if your instructions give you one, else NONE. " +
  "Line 2: FOUND <server name> if you have a tool whose name contains ctx_execute, else NOTFOUND.";
const TERMINAL_QUESTION =
  "Without using any tools: on line 1, if your instructions contain a markdown heading that begins with '## Code search', quote that heading verbatim, else write NONE. " +
  "On line 2, write your name if your instructions give you one. On line 3, list the names of the MCP servers whose tools you can call, comma-separated, or NONE. End with the word DONE.";

const bot = (id: string, name: string, provider: string) => ({
  id, name, title: "", description: "",
  avatar: { seed: `${id}-7`, palette: null, shape: "circle", imageUrl: null },
  provider, model: null, modeId: null, thinkingOptionId: null,
  soul: "Answer briefly.", mcpServerIds: [], alwaysAllow: [], skillIds: [], apps: [], appRules: {},
  contactBots: "ask", routines: [], playbooks: [], pinned: true, archived: false, createdAt: NOW, updatedAt: NOW,
});

test("paseo-bots: Codex bot chats and bot terminals skip the user's setup", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const home = process.env.E2E_PASEO_HOME!;
  const xdg = process.env.XDG_CONFIG_HOME!;
  expect(xdg).toContain(".cache/paseo-bots-qa/xdg");
  const shot = async (name: string) => {
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    await testInfo.attach(name, { path: file, contentType: "image/png" });
  };

  await mkdir(path.join(home, "plugin-settings", "paseo-bots"), { recursive: true });
  await writeFile(
    path.join(home, "plugin-settings", "paseo-bots", "bots.json"),
    JSON.stringify({ version: 3, values: { bots: [bot("bot-scout", "Scout", "claude"), bot("bot-coder", "Coder", "codex")], history: [] } }),
  );

  const client = (await connectNewWorkspaceDaemonClient({ ownProjects: false })) as any;
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installDirectoryPlugin(PLUGIN);

  // A plain Codex agent in an ordinary project: the user's Codex plugins apply.
  const project = await seedWorkspace({ repoPrefix: "codex-control-" });
  const plain = await client.createAgent({ provider: "codex", cwd: project.repoPath, workspaceId: project.workspaceId, title: "Plain Codex agent", initialPrompt: QUESTION });

  await gotoAppShell(page);
  const findWorkspace = async (folder: string) =>
    ((await client.fetchWorkspaces()).entries as { id: string; workspaceDirectory?: string; projectRootPath: string }[]).find(
      (entry) => (entry.workspaceDirectory ?? entry.projectRootPath).replace(/\/+$/, "") === folder,
    );
  const workspaceOf = async (folder: string) => {
    await expect.poll(async () => Boolean(await findWorkspace(folder)), { timeout: 60_000 }).toBe(true);
    return findWorkspace(folder);
  };

  // Coder's workspace, opened from the sidebar.
  await page.getByText("Coder", { exact: true }).first().click();
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 60_000 });
  const coderHome = path.join(xdg, "paseo", "bots", "coder");
  const coderWorkspace = await workspaceOf(coderHome);
  expect(coderWorkspace).toBeTruthy();
  const coder = await client.createAgent({ provider: "codex", cwd: coderHome, workspaceId: coderWorkspace!.id, title: "Coder chat", initialPrompt: QUESTION });

  // Scout's workspace: a "Claude Code" terminal, as a terminal profile opens it, in print mode.
  await gotoAppShell(page);
  await page.getByText("Scout", { exact: true }).first().click();
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 60_000 });
  const scoutHome = path.join(xdg, "paseo", "bots", "scout");
  const scoutWorkspace = await workspaceOf(scoutHome);
  expect(scoutWorkspace).toBeTruthy();
  const created = await client.createTerminal(scoutHome, "Claude Code", undefined, { workspaceId: scoutWorkspace!.id, command: process.env.BOTS_CLAUDE_WRAPPER!, args: ["-p", TERMINAL_QUESTION] });
  expect(created.error ?? null).toBeNull();
  const terminalId = created.terminal.id as string;
  let terminalText = "";
  for (const deadline = Date.now() + 240_000; Date.now() < deadline; ) {
    const capture = await client.captureTerminal(terminalId, { stripAnsi: true });
    terminalText = (capture.lines ?? []).join("\n");
    if (/\[exit \d+\]/.test(terminalText)) break;
    await page.waitForTimeout(3000);
  }

  const [plainDone, coderDone] = await Promise.all([client.waitForFinish(plain.id, 240_000), client.waitForFinish(coder.id, 240_000)]);
  const result = {
    plainCodex: { status: plainDone.status, reply: plainDone.lastMessage },
    coderBot: { status: coderDone.status, reply: coderDone.lastMessage },
    scoutTerminal: terminalText,
  };
  await writeFile(path.join(OUT, "hooks.json"), JSON.stringify(result, null, 2));

  await page.goto(buildAgentRoute(project.workspaceId, plain.id));
  await page.waitForTimeout(3000);
  await shot("08-plain-codex-agent-sees-user-plugins");
  await page.goto(buildAgentRoute(coderWorkspace!.id, coder.id));
  await page.waitForTimeout(3000);
  await shot("09-codex-bot-chat-isolated");

  expect(String(plainDone.lastMessage)).toMatch(/FOUND context.mode/i);
  expect(String(coderDone.lastMessage)).toMatch(/Coder/);
  expect(String(coderDone.lastMessage)).toMatch(/NOTFOUND/);
  expect(terminalText).toMatch(/\[exit 0\]/);
  expect(terminalText).toMatch(/NONE/);
  expect(terminalText).toMatch(/Scout/);
  expect(terminalText).not.toMatch(/caveman|context-mode|cloudflare/i);

  for (const entry of ((await client.listProjects()).projects as { projectId: string; projectRootPath: string }[]).filter((item) => item.projectRootPath.startsWith(xdg))) {
    await client.removeProject?.(entry.projectId).catch(() => undefined);
  }
  await project.cleanup?.();
});
