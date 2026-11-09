import { BOT_LABEL, defaultModelId, type Bot } from "./bot";

/** Label on chats started by a routine, carrying the routine id. */
export const ROUTINE_LABEL = "paseo-bots.routine";
/** Longest title Paseo accepts (protocol/agent-title-limits.ts). */
const MAX_TITLE_CHARS = 200;

/** Older chats were titled "[Bot Name] …"; places grouped by bot show them without the prefix. */
export function displayTitle(title: string | null | undefined): string {
  return (title ?? "").replace(/^\[[^\]]*\]\s*/, "") || "New chat";
}

const normalize = (path: string | null | undefined) => (path ?? "").replace(/\/+$/, "");

// The part of Paseo's API these helpers use. Shared code may only import the plugin SDK's
// root, so the app and the server pass their Paseo API in, and it's checked against this.

interface ChatWorkspace {
  id: string;
  projectRootPath: string;
  workspaceDirectory?: string;
  title?: string | null;
}

interface WorkspaceHandle {
  readonly id: string;
  current(): ChatWorkspace | null;
  refresh(): Promise<ChatWorkspace | null>;
  setTitle(title: string): Promise<unknown>;
  readonly agents: {
    create(options: {
      config: { provider: string };
      labels: Record<string, string>;
      prompt: string;
      title?: string;
    }): Promise<{ readonly id: string }>;
  };
}

interface ChatAgent {
  id: string;
  updatedAt: string;
  archivedAt?: string | null;
}

type AgentListOptions = {
  filter: { labels?: Record<string, string>; projectKeys?: string[]; includeArchived?: boolean };
  sort?: { key: "updated_at"; direction: "desc" }[];
  page?: { limit: number };
};

export interface ChatApi {
  readonly projects: { list(): Promise<{ projects: { projectKey?: string; projectRootPath: string }[] }> };
  readonly workspaces: {
    list(): Promise<{ entries: ChatWorkspace[] }>;
    ref(workspace: string | ChatWorkspace): WorkspaceHandle;
    open(path: string): Promise<WorkspaceHandle>;
  };
  readonly providers: { snapshot(): Promise<{ entries: { provider: string; models?: { id: string; isDefault?: boolean; isSelectable?: boolean }[] }[] }> };
}

/** The bot's workspace: the one in its folder, or a new one, which makes the folder the bot's own project. */
async function botWorkspace(api: ChatApi, home: string): Promise<{ handle: WorkspaceHandle; title: string | null }> {
  const { entries } = await api.workspaces.list();
  const mine = entries.find((workspace) => workspaceFolder(workspace) === normalize(home));
  if (mine) return { handle: api.workspaces.ref(mine), title: mine.title ?? null };
  const handle = await api.workspaces.open(home);
  const snapshot = handle.current() ?? (await handle.refresh());
  return { handle, title: snapshot?.title ?? null };
}

/** Finds or creates the bot's workspace (in `home`, its folder) and keeps its title in step with the bot's name. */
export async function ensureBotWorkspace(api: ChatApi, bot: Pick<Bot, "name">, home: string): Promise<WorkspaceHandle> {
  const { handle, title } = await botWorkspace(api, home);
  if (title !== bot.name) await handle.setTitle(bot.name);
  return handle;
}

/** The folder a workspace runs in. */
export function workspaceFolder(workspace: Pick<ChatWorkspace, "workspaceDirectory" | "projectRootPath">): string {
  return normalize(workspace.workspaceDirectory ?? workspace.projectRootPath);
}

/** Renames the bot's workspace after the bot is renamed; does nothing before it has one. */
export async function syncBotWorkspaceTitle(api: ChatApi, bot: Pick<Bot, "name">, home: string): Promise<void> {
  const { entries } = await api.workspaces.list();
  const mine = entries.find((workspace) => workspaceFolder(workspace) === normalize(home));
  if (mine && mine.title !== bot.name) await api.workspaces.ref(mine).setTitle(bot.name);
}

/**
 * A bot's chats, newest first: the ones in its own project (`home`, its folder,
 * when it has one) and older ones labelled with it, from the shared Bots project
 * or a working folder it used to have.
 */
export async function listBotChats<Agent extends ChatAgent>(
  api: { readonly projects: ChatApi["projects"]; readonly agents: { list(options: AgentListOptions): Promise<{ entries: { agent: Agent }[] }> } },
  botId: string,
  home: string | null,
  options: { includeArchived?: boolean; limit?: number } = {},
): Promise<Agent[]> {
  const query = (filter: AgentListOptions["filter"]) =>
    api.agents.list({ filter: { ...filter, includeArchived: options.includeArchived ?? false }, sort: [{ key: "updated_at", direction: "desc" }], ...(options.limit ? { page: { limit: options.limit } } : {}) });
  const project = home ? (await api.projects.list()).projects.find((entry) => normalize(entry.projectRootPath) === normalize(home)) : undefined;
  const [labelled, own] = await Promise.all([query({ labels: { [BOT_LABEL]: botId } }), project?.projectKey ? query({ projectKeys: [project.projectKey] }) : null]);
  const chats = new Map<string, Agent>();
  for (const { agent } of [...(own?.entries ?? []), ...labelled.entries]) chats.set(agent.id, agent);
  return [...chats.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, options.limit ?? Infinity);
}

export interface StartChatInput {
  bot: Bot;
  /** The bot's folder (ensureBotHome). */
  home: string;
  prompt: string;
  /** Defaults to Paseo's own title derived from the prompt. */
  title?: string;
  labels?: Record<string, string>;
}

/**
 * Starts a chat (a thread in the bot's workspace) and sends the first message.
 * Used by the app, the routine scheduler and bots asking each other. The
 * plugin's agent.create hook gives every new agent in the bot's folder the
 * bot's configuration, so this only names the provider and model, which the
 * SDK needs, and labels the chat.
 */
export async function startBotChat(api: ChatApi, input: StartChatInput): Promise<string> {
  const { bot } = input;
  const model = bot.model ?? (await resolveDefaultModel(api, bot.provider));
  const workspace = await ensureBotWorkspace(api, bot, input.home);
  const agent = await workspace.agents.create({
    config: { provider: `${bot.provider}/${model}` },
    labels: { [BOT_LABEL]: bot.id, ...input.labels },
    prompt: input.prompt,
    ...(input.title ? { title: input.title.slice(0, MAX_TITLE_CHARS) } : {}),
  });
  return agent.id;
}

async function resolveDefaultModel(api: ChatApi, provider: string): Promise<string> {
  const snapshot = await api.providers.snapshot();
  const entry = snapshot.entries.find((candidate) => candidate.provider === provider);
  const model = defaultModelId(entry?.models ?? []);
  if (!model) throw new Error(`${provider} has no models available. Pick a model in the bot's settings.`);
  return model;
}
