import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeHost, makeBot } from "./helpers";

describe("bot chats started anywhere", () => {
  let paseoHome: string;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "paseo-bots-hook-"));
    process.env.PASEO_HOME = paseoHome;
    process.env.XDG_CONFIG_HOME = join(paseoHome, "config");
  });

  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(paseoHome, { recursive: true, force: true });
  });

  async function setup() {
    const { botAgentConfig, nameBotChat } = await import("../server/agent-config");
    const { ensureBotHome } = await import("../server/bot-home");
    const { ChatKeys } = await import("../server/chat-keys");
    const bot = makeBot({ id: "bot-s", name: "Scout", model: "opus", modeId: "default", soul: "Be brief." });
    const host = fakeHost([bot, makeBot({ id: "bot-a", name: "Archived", archived: true })]);
    const relay = {
      chats: new ChatKeys(),
      mountTools: async (botId: string, key: string) => ({ type: "http" as const, url: `http://127.0.0.1:1/bots/${botId}/${key}`, headers: {} }),
      mountApps: async () => null,
    };
    const { path } = await ensureBotHome(bot);
    return { botAgentConfig, nameBotChat, ensureBotHome, host, relay: relay as never as Parameters<typeof botAgentConfig>[1], chats: relay.chats, path };
  }

  it("gives an agent in a bot's folder the bot's config, and leaves other agents alone", async () => {
    const { botAgentConfig, host, relay, path, ensureBotHome } = await setup();
    const result = await botAgentConfig(host, relay, { config: { provider: "claude", cwd: path, model: "sonnet" }, env: { KEEP: "1" } });
    expect(result?.config).toMatchObject({ provider: "claude", cwd: path, model: "opus", modeId: "default" });
    expect(result?.config.systemPrompt).toContain("You are Scout");
    expect(result?.config.systemPrompt).toContain("Be brief.");
    expect(result?.config.systemPrompt).toContain(join(path, "runbooks"));
    const key = result!.env!.PASEO_BOTS_CHAT!;
    expect(result?.env).toEqual({ KEEP: "1", PASEO_BOTS_CHAT: key });
    expect(result?.config.mcpServers?.bots).toMatchObject({ url: `http://127.0.0.1:1/bots/bot-s/${key}` });
    expect(result?.config.toolPolicy?.preapproved.some((grant) => grant.server === "bots")).toBe(true);

    expect(await botAgentConfig(host, relay, { config: { provider: "claude", cwd: paseoHome } })).toBeUndefined();
    const archived = await ensureBotHome(makeBot({ id: "bot-a", name: "Archived" }));
    expect(await botAgentConfig(host, relay, { config: { provider: "claude", cwd: archived.path } })).toBeUndefined();
  });

  it("pairs a new chat's tools key with its agent id", async () => {
    const { botAgentConfig, nameBotChat, host, relay, chats, path } = await setup();
    const result = await botAgentConfig(host, relay, { config: { provider: "claude", cwd: path } });
    const key = result!.env!.PASEO_BOTS_CHAT!;
    const open = { agentId: "agent-1", workspaceId: null, provider: "claude", cwd: path, title: null, labels: {}, tools: [], mcpServers: {}, purpose: "interactive" as const };
    await nameBotChat(relay, { ...open, reason: "resume", env: { PASEO_BOTS_CHAT: key } });
    expect(await chats.agentOf(key)).toBe(key);
    await nameBotChat(relay, { ...open, reason: "create", env: { PASEO_BOTS_CHAT: key } });
    expect(await chats.agentOf(key)).toBe("agent-1");
    // Older chats' addresses carry their agent id.
    expect(await chats.agentOf("old-agent")).toBe("old-agent");
    const { ChatKeys } = await import("../server/chat-keys");
    expect(await new ChatKeys().agentOf(key)).toBe("agent-1");
  });
});
