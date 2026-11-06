import { applyBotConfig, claudeBotArgs, type BotSessionConfig, type McpServerConfig } from "../shared/bot";
import { botIdAt } from "./bot-home";
import type { BotsHost } from "./host";
import { systemPrompt } from "./prompt";
import type { Relay } from "./relay";

/** Paseo's terminal.create.before request, from Paseo versions that have the hook. */
export interface TerminalRequest {
  readonly cwd: string;
  readonly workspaceId: string;
  name?: string;
  command?: string;
  args?: string[];
  env: Record<string, string>;
}

type Cli = "claude" | "codex";

/** The agent CLI a terminal runs, from its program: "claude", "/usr/bin/codex", "codex.cmd". */
export function terminalCli(command: string | undefined): Cli | null {
  const name = command?.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat)$/i, "");
  return name === "claude" || name === "codex" ? name : null;
}

/**
 * terminal.create.before: a Claude Code or Codex terminal opened in a bot's
 * folder (the workspace's terminal profiles) runs as the bot. It gets the
 * bot's persona, instructions, memory, skills and runbooks, its MCP servers
 * and connected apps, the tools it may use without asking, and skips the
 * user's own CLI setup, as the bot's chats do. The model, mode and thinking
 * apply when the CLI is the bot's provider. The plugin's own tools stay out:
 * their proposals and requests to other bots are answered in a Paseo chat.
 */
export async function botTerminal(host: BotsHost, relay: Relay, request: TerminalRequest): Promise<TerminalRequest | undefined> {
  const cli = terminalCli(request.command);
  if (!cli) return undefined;
  const botId = await botIdAt(request.cwd);
  if (!botId) return undefined;
  const bot = await host.bot(botId);
  if (!bot || bot.archived) return undefined;
  const library = await host.library();
  const prompt = await systemPrompt({ bot, terminal: true }, library, host.paseo, await host.values());
  const apps = bot.apps.length ? await relay.mountApps(bot.id) : null;
  const own = bot.provider === cli;
  const config = applyBotConfig(
    { provider: cli, cwd: request.cwd } as BotSessionConfig,
    own ? bot : { ...bot, provider: cli, model: null, modeId: null, thinkingOptionId: null },
    library,
    prompt.systemPrompt,
    { apps },
    { codexFeatures: true },
  );
  return { ...request, args: [...(request.args ?? []), ...(cli === "claude" ? claudeCliArgs(config) : codexCliArgs(config))] };
}

function grants(config: BotSessionConfig): { server: string; tool: string }[] {
  return config.toolPolicy?.preapproved ?? [];
}

/** Claude Code flags for a bot's config (from applyBotConfig). */
export function claudeCliArgs(config: BotSessionConfig): string[] {
  const args: string[] = [];
  if (config.model) args.push("--model", config.model);
  if (config.modeId) args.push("--permission-mode", config.modeId);
  if (config.thinkingOptionId && config.thinkingOptionId !== "off") args.push("--effort", config.thinkingOptionId);
  if (config.systemPrompt) args.push("--append-system-prompt", config.systemPrompt);
  // The bot's server configs are Claude Code's own .mcp.json shapes.
  args.push("--mcp-config", JSON.stringify({ mcpServers: config.mcpServers ?? {} }));
  const allowed = grants(config).map((grant) => `mcp__${grant.server}__${grant.tool}`);
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  for (const [flag, value] of Object.entries(claudeBotArgs(config.cwd))) args.push(`--${flag}`, ...(value === null ? [] : [value]));
  return args;
}

/** Paseo's Codex modes as the CLI's sandbox and approval flags. */
const CODEX_MODES: Record<string, string[]> = {
  "read-only": ["--sandbox", "read-only", "--ask-for-approval", "on-request"],
  auto: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
  "auto-review": ["--sandbox", "workspace-write", "--ask-for-approval", "on-request", "-c", 'approvals_reviewer="auto_review"'],
  "full-access": ["--sandbox", "danger-full-access", "--ask-for-approval", "never"],
};

/** A TOML value for Codex's `-c key=value`; JSON strings, numbers and booleans are valid TOML. */
export function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)} = ${toml(entry)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

function codexMcpServer(server: McpServerConfig, approved: string[]): Record<string, unknown> {
  const base = server.type === "stdio" ? { command: server.command, args: server.args, env: server.env } : { url: server.url, http_headers: server.headers };
  return approved.length ? { ...base, tools: Object.fromEntries(approved.map((tool) => [tool, { approval_mode: "approve" }])) } : base;
}

/** Codex CLI flags for a bot's config (from applyBotConfig). */
export function codexCliArgs(config: BotSessionConfig): string[] {
  const args: string[] = [];
  if (config.model) args.push("--model", config.model);
  if (config.modeId && CODEX_MODES[config.modeId]) args.push(...CODEX_MODES[config.modeId]!);
  if (config.thinkingOptionId) args.push("-c", `model_reasoning_effort=${toml(config.thinkingOptionId)}`);
  if (config.systemPrompt) args.push("-c", `developer_instructions=${toml(config.systemPrompt)}`);
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    const approved = grants(config).flatMap((grant) => (grant.server === name ? [grant.tool] : []));
    // Codex splits the key on dots; MCP server names are [A-Za-z0-9_-] (MCP_NAME).
    args.push("-c", `mcp_servers.${name}=${toml(codexMcpServer(server, approved))}`);
  }
  const features = (config.providerOptions?.features ?? {}) as Record<string, unknown>;
  for (const [feature, on] of Object.entries(features)) args.push("-c", `features.${feature}=${toml(on)}`);
  return args;
}
