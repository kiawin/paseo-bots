import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexCliArgs, terminalCli, toml } from "../server/terminal";
import { fakeHost, makeBot } from "./helpers";

describe("terminals in a bot's folder", () => {
  let paseoHome: string;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "paseo-bots-terminal-"));
    process.env.PASEO_HOME = paseoHome;
    process.env.XDG_CONFIG_HOME = join(paseoHome, "config");
  });

  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(paseoHome, { recursive: true, force: true });
  });

  async function setup() {
    const { botTerminal } = await import("../server/terminal");
    const { ensureBotHome } = await import("../server/bot-home");
    const bot = makeBot({ id: "bot-s", name: "Scout", provider: "claude", model: "opus", modeId: "acceptEdits", soul: "Be brief." });
    const host = fakeHost([bot]);
    const relay = { mountApps: async () => null } as never as Parameters<typeof botTerminal>[1];
    const { path } = await ensureBotHome(bot);
    return { botTerminal, host, relay, path };
  }

  const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it("runs Claude Code as the bot, without the user's setup or the plugin's tools", async () => {
    const { botTerminal, host, relay, path } = await setup();
    const result = await botTerminal(host, relay, { cwd: path, workspaceId: "w", command: "claude", args: ["--verbose"], env: {} });
    const args = result!.args!;
    expect(args[0]).toBe("--verbose");
    expect(value(args, "--model")).toBe("opus");
    expect(value(args, "--permission-mode")).toBe("acceptEdits");
    expect(value(args, "--append-system-prompt")).toContain("You are Scout");
    expect(value(args, "--append-system-prompt")).not.toContain("propose_changes");
    expect(JSON.parse(value(args, "--mcp-config")!)).toEqual({ mcpServers: {} });
    expect(value(args, "--setting-sources")).toBe("project,local");
    expect(args).toContain("--strict-mcp-config");
    expect(JSON.parse(value(args, "--settings")!)).toMatchObject({ autoMemoryEnabled: false });
  });

  it("gives a Codex terminal the bot's persona but not the Claude bot's model", async () => {
    const { botTerminal, host, relay, path } = await setup();
    const result = await botTerminal(host, relay, { cwd: path, workspaceId: "w", command: "/usr/local/bin/codex", env: {} });
    const args = result!.args!;
    expect(args).not.toContain("--model");
    expect(args.find((arg) => arg.startsWith("developer_instructions="))).toContain("You are Scout");
    expect(args).toEqual(expect.arrayContaining(["features.plugins=false", "features.hooks=false", "features.memories=false", "features.apps=false"]));
  });

  it("leaves shells, other programs and other folders alone", async () => {
    const { botTerminal, host, relay, path } = await setup();
    expect(await botTerminal(host, relay, { cwd: path, workspaceId: "w", env: {} })).toBeUndefined();
    expect(await botTerminal(host, relay, { cwd: path, workspaceId: "w", command: "htop", env: {} })).toBeUndefined();
    expect(await botTerminal(host, relay, { cwd: paseoHome, workspaceId: "w", command: "claude", env: {} })).toBeUndefined();
  });
});

describe("agent CLI flags", () => {
  it("knows the agent CLIs by program name", () => {
    expect(["claude", "/opt/bin/codex", "C:\\Tools\\claude.exe", "codex.cmd", "bash", undefined].map(terminalCli)).toEqual(["claude", "codex", "claude", "codex", null, null]);
  });

  it("writes Codex config values as TOML", () => {
    expect(toml('say "hi"\nnow')).toBe('"say \\"hi\\"\\nnow"');
    expect(toml({ url: "http://x", http_headers: { "X-Key": "k" }, args: undefined })).toBe('{"url" = "http://x", "http_headers" = {"X-Key" = "k"}}');
    expect(toml(["a", 1, false])).toBe('["a", 1, false]');
  });

  it("gives Codex the bot's servers, approvals and mode", () => {
    const args = codexCliArgs({
      provider: "codex",
      model: "gpt-5.5",
      modeId: "full-access",
      thinkingOptionId: "high",
      mcpServers: { notes: { type: "stdio", command: "notes-mcp", args: ["--ro"], env: {} } },
      toolPolicy: { preapproved: [{ kind: "mcp", server: "notes", tool: "read" }] },
    });
    expect(args).toEqual([
      "--model",
      "gpt-5.5",
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "never",
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'mcp_servers.notes={"command" = "notes-mcp", "args" = ["--ro"], "env" = {}, "tools" = {"read" = {"approval_mode" = "approve"}}}',
    ]);
  });
});
