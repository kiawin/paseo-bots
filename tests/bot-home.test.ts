import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeBot } from "./helpers";

describe("bot folders", () => {
  let paseoHome: string;
  let config: string;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "paseo-bots-home-"));
    config = await mkdtemp(join(tmpdir(), "paseo-bots-xdg-"));
    process.env.PASEO_HOME = paseoHome;
    process.env.XDG_CONFIG_HOME = config;
  });

  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(paseoHome, { recursive: true, force: true });
    await rm(config, { recursive: true, force: true });
  });

  it("names folders after the bot and keeps the name once given", async () => {
    const { botHomeOf, botsRoot, ensureBotHome, folderName } = await import("../server/bot-home");
    expect(folderName("Café Bot!")).toBe("cafe-bot");
    expect(folderName("  ")).toBe("bot");
    expect(botsRoot()).toBe(join(config, "paseo", "bots"));
    expect(botHomeOf("bot-1")).toBeNull();
    const { path } = await ensureBotHome(makeBot({ id: "bot-1", name: "Scout" }));
    expect(path).toBe(join(botsRoot(), "scout"));
    expect(await readFile(join(path, ".bot-id"), "utf8")).toBe("bot-1\n");
    // Renamed later: same folder.
    expect((await ensureBotHome(makeBot({ id: "bot-1", name: "Ranger" }))).path).toBe(path);
    // Another bot with the same name gets its own.
    const [a, b] = await Promise.all([ensureBotHome(makeBot({ id: "bot-2", name: "Scout" })), ensureBotHome(makeBot({ id: "bot-3", name: "Scout" }))]);
    expect([a.path, b.path]).toEqual([join(botsRoot(), "scout-2"), join(botsRoot(), "scout-3")]);
  });

  it("moves a folder from the shared Bots project and leaves a link", async () => {
    const { botDataPath, ensureBotHome, legacyBotsPath, migrateBotHomes } = await import("../server/bot-home");
    const legacy = join(legacyBotsPath(), "bot-ops");
    await mkdir(join(legacy, "memory"), { recursive: true });
    await writeFile(join(legacy, "MEMORY.md"), "remember\n");
    // Before the move, its files are read where they are.
    expect(botDataPath("bot-ops")).toBe(legacy);
    await migrateBotHomes([makeBot({ id: "bot-ops", name: "Ops" }), makeBot({ id: "bot-new", name: "New" })]);
    const home = join(config, "paseo", "bots", "ops");
    expect(botDataPath("bot-ops")).toBe(home);
    expect(await readFile(join(home, "MEMORY.md"), "utf8")).toBe("remember\n");
    expect(await readlink(legacy)).toBe(home);
    // A bot without an old folder gets none until it needs one.
    expect(await lstat(join(config, "paseo", "bots", "new")).catch(() => null)).toBeNull();
    // Running it again changes nothing.
    await migrateBotHomes([makeBot({ id: "bot-ops", name: "Ops" })]);
    expect((await ensureBotHome(makeBot({ id: "bot-ops", name: "Ops" }))).path).toBe(home);
  });

  it("takes over files written before the bot had a folder", async () => {
    const { botDataPath, ensureBotHome } = await import("../server/bot-home");
    const pending = botDataPath("bot-p");
    await mkdir(pending, { recursive: true });
    await writeFile(join(pending, "MEMORY.md"), "imported\n");
    const { path } = await ensureBotHome(makeBot({ id: "bot-p", name: "Imported" }));
    expect(await readFile(join(path, "MEMORY.md"), "utf8")).toBe("imported\n");
    expect(await lstat(pending).catch(() => null)).toBeNull();
  });

  it("writes the avatar as the project icon", async () => {
    const { ensureBotHome, writeBotIcon } = await import("../server/bot-home");
    const bot = makeBot({ id: "bot-i", name: "Icon" });
    const { path } = await ensureBotHome(bot);
    expect(await readFile(join(path, "icon.svg"), "utf8")).toMatch(/^<svg [^>]*><clipPath/);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeBotIcon(path, { ...bot.avatar, imageUrl: `data:image/png;base64,${png.toString("base64")}` });
    expect(await readFile(join(path, "icon.png"))).toEqual(png);
    expect(await lstat(join(path, "icon.svg")).catch(() => null)).toBeNull();
  });

  it("finds the bot a folder belongs to, through the old links too", async () => {
    const { botIdAt, ensureBotHome, legacyBotsPath } = await import("../server/bot-home");
    await mkdir(join(legacyBotsPath(), "bot-l"), { recursive: true });
    const { path } = await ensureBotHome(makeBot({ id: "bot-l", name: "Linked" }));
    await mkdir(join(path, "sub"));
    expect(await botIdAt(path)).toBe("bot-l");
    expect(await botIdAt(join(path, "sub"))).toBe("bot-l");
    expect(await botIdAt(join(legacyBotsPath(), "bot-l"))).toBe("bot-l");
    expect(await botIdAt(paseoHome)).toBeNull();
  });

  it("tells a chat's bot by its folder, or by its label for older chats", async () => {
    const { ensureBotHome } = await import("../server/bot-home");
    const { fakeHost } = await import("./helpers");
    const { path } = await ensureBotHome(makeBot({ id: "bot-f", name: "Folder" }));
    const agents: Record<string, { id: string; cwd: string; labels: Record<string, string>; title: string | null }> = {
      started: { id: "started", cwd: path, labels: {}, title: "From Paseo" },
      old: { id: "old", cwd: "/somewhere/else", labels: { "paseo-bots.bot": "bot-x" }, title: null },
      other: { id: "other", cwd: "/somewhere/else", labels: {}, title: null },
    };
    const host = fakeHost([]);
    host.attach({ agents: { ref: (id: string) => ({ refresh: async () => ({ agent: agents[id] }) }) } } as never);
    expect((await host.chatOf("started"))?.botId).toBe("bot-f");
    expect((await host.chatOf("old"))?.botId).toBe("bot-x");
    expect(await host.chatOf("other")).toBeNull();
  });
});

describe("listBotChats", () => {
  it("merges the bot's project chats with older labelled ones, newest first", async () => {
    const { listBotChats } = await import("../shared/chat");
    const calls: unknown[] = [];
    const api = {
      projects: { list: async () => ({ projects: [{ projectKey: "k-scout", projectRootPath: "/bots/scout/" }] }) },
      agents: {
        list: async (options: { filter: { labels?: Record<string, string>; projectKeys?: string[] } }) => {
          calls.push(options.filter);
          return options.filter.projectKeys
            ? { entries: [{ agent: { id: "a", updatedAt: "2026-11-02T00:00:00Z" } }, { agent: { id: "b", updatedAt: "2026-11-03T00:00:00Z" } }] }
            : { entries: [{ agent: { id: "b", updatedAt: "2026-11-03T00:00:00Z" } }, { agent: { id: "c", updatedAt: "2026-11-01T00:00:00Z" } }] };
        },
      },
    };
    expect((await listBotChats(api, "bot-1", "/bots/scout")).map((chat) => chat.id)).toEqual(["b", "a", "c"]);
    // Without a folder, only labelled chats.
    calls.length = 0;
    expect((await listBotChats(api, "bot-1", null)).map((chat) => chat.id)).toEqual(["b", "c"]);
    expect(calls).toEqual([{ labels: { "paseo-bots.bot": "bot-1" }, includeArchived: false }]);
  });
});
