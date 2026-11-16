import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pluginDataPath } from "./bot-home";

const MAX_KEYS = 5000;

/**
 * Which chat each tools address belongs to. The agent.create hook builds a
 * chat's tools address before Paseo names the agent, so the address carries a
 * key of its own, and agent.session_open pairs the key with the agent's id.
 * Older chats' addresses carry their agent id, which isn't a key here.
 */
export class ChatKeys {
  private keys: Promise<Map<string, string>> | null = null;
  private saving: Promise<unknown> = Promise.resolve();

  private path(): string {
    return join(pluginDataPath(), "chat-keys.json");
  }

  private load(): Promise<Map<string, string>> {
    this.keys ??= readFile(this.path(), "utf8").then(
      (text) => new Map(Object.entries(JSON.parse(text) as Record<string, string>)),
      () => new Map<string, string>(),
    );
    return this.keys;
  }

  async set(key: string, agentId: string): Promise<void> {
    const keys = await this.load();
    keys.set(key, agentId);
    for (const oldest of keys.keys()) {
      if (keys.size <= MAX_KEYS) break;
      keys.delete(oldest);
    }
    const save = this.saving.then(async () => {
      await mkdir(pluginDataPath(), { recursive: true });
      await writeFile(this.path(), JSON.stringify(Object.fromEntries(keys)), { encoding: "utf8", mode: 0o600 });
    });
    this.saving = save.catch(() => undefined);
    await save;
  }

  /** The agent a tools address belongs to: the paired agent, or the address itself for older chats. */
  async agentOf(key: string): Promise<string> {
    return (await this.load()).get(key) ?? key;
  }
}
